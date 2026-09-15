// llm.ts — direct (non-agentic) LLM path for the translate runner.
//
// Ported from bp-assistant src/lib/translate-llm.js (issue #445, design §A /
// §F step 2). ONE completion call per batch against a caller-supplied API key,
// every input inlined in the prompt, the output extracted from the reply and
// handed to core.validateBatchOutput — the same deterministic checks and
// repair pass the bot runs.
//
// What changed from the bot (and why):
//   - No filesystem: prompt inputs come from core.buildBatchArtifacts (logical
//     file names, no absolute paths) and the output is returned, not written.
//   - No in-process backoff/sleep loop (translate-llm.js:486-522). Every
//     provider failure is classified into TranslateProviderError with a
//     `retryable` flag; the Workflow step retries the retryable ones
//     (rate_limited, provider_overloaded, timeout, network_error) and fails
//     fast on the rest. The one same-call fallback the bot has — a truncated
//     reply with thinking enabled is re-run once with thinking dropped — is
//     kept, because it changes the request shape rather than waiting.
//   - `_setTestHooks` is replaced by an injected `transport` (and, for the
//     Anthropic adapter, an injected client factory) so tests never touch the
//     network and production code has no hook to disable it.
//   - The API key is a per-call argument. It is never read from env, never
//     stored on a module-level object, and every thrown message passes
//     through scrubSecrets(msg, [apiKey]).
//   - `redact()` is the bot's run-logs.js SECRET_PATTERNS pass only — the
//     env-value pass has no meaning in a Worker.
//   - Only the Anthropic adapter is implemented. openai/xai/gemini throw
//     provider_not_supported_internal so the dispatcher keeps proxying them.
//
// Anthropic request shape follows the claude-api skill (2026-09-15):
// messages.stream() + finalMessage() (long max_tokens requires streaming),
// thinking {type:"adaptive"} + output_config.effort on Claude Opus 5 /
// Sonnet 5; Haiku 4.5 rejects adaptive thinking and effort, so those params
// are omitted for it. The SDK (0.126.0) lists Cloudflare Workers among its
// supported runtimes (README "Requirements").

import Anthropic from "@anthropic-ai/sdk";
import { assertProviderModel, estimateCost, type TokenUsage } from "./providerCatalog.ts";
import { systemPromptFor, BEGIN_OUTPUT, END_OUTPUT } from "./prompts/index.ts";
import { validateBatchOutput, type BatchArtifacts, type TsvResource } from "./core.ts";
import type { TsvRow } from "./tsvCodec.ts";
import type { CheckResult } from "./checks.ts";

export { BEGIN_OUTPUT, END_OUTPUT };

export const MAX_OUTPUT_TOKENS = 32000;
// The pipeline passes a 20-minute agentic budget; a single completion that has
// not returned in 10 minutes is hung, not slow.
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;
// 1 draft + 1 repair pass (translate-pipeline.js MAX_BATCH_ATTEMPTS).
export const MAX_BATCH_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Provider-side failures the Workflow step should retry (instance hibernates between tries). */
export const RETRYABLE_CODES = new Set(["rate_limited", "provider_overloaded", "timeout", "network_error"] as const);
/** Deterministic failures: retrying the same request would only spend money again. */
export const NON_RETRYABLE_CODES = new Set([
  "invalid_key", "model_not_found", "context_too_long", "output_too_long", "empty_output",
  "provider_error", "provider_not_supported_internal", "checks_failed",
] as const);

export type RetryableCode = typeof RETRYABLE_CODES extends Set<infer T> ? T : never;
export type NonRetryableCode = typeof NON_RETRYABLE_CODES extends Set<infer T> ? T : never;
export type ProviderErrorCode = RetryableCode | NonRetryableCode;

export function isRetryableCode(code: string): boolean {
  return (RETRYABLE_CODES as Set<string>).has(code);
}

export class TranslateProviderError extends Error {
  code: ProviderErrorCode;
  /** Same as `code`; the field the bot's job records surface. */
  errorKind: ProviderErrorCode;
  provider: string;
  retryable: boolean;
  status?: number | null;
  retryAfterSeconds?: number | null;

  constructor(
    code: ProviderErrorCode,
    provider: string,
    message: string,
    { status, retryAfterSeconds, cause }: { status?: number | null; retryAfterSeconds?: number | null; cause?: unknown } = {},
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "TranslateProviderError";
    this.code = code;
    this.errorKind = code;
    this.provider = provider;
    this.retryable = isRetryableCode(code);
    if (status != null) this.status = status;
    if (retryAfterSeconds != null) this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// Secret scrubbing (bp-assistant run-logs.js SECRET_PATTERNS, verbatim)
// ---------------------------------------------------------------------------

type Replacement = string | ((...m: string[]) => string);
const SECRET_PATTERNS: [RegExp, Replacement][] = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, "[redacted:anthropic-key]"],
  // Modern OpenAI-style keys (sk-proj-…, sk-ant-api03-…) carry hyphens and
  // underscores in the body, not just alnum — the plain alnum pattern missed them.
  [/sk-[A-Za-z0-9_-]{20,}/g, "[redacted:api-key]"],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted:github-token]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted:github-pat]"],
  [/xai-[A-Za-z0-9_-]{16,}/g, "[redacted:xai-key]"],
  [/AIza[A-Za-z0-9_-]{20,}/g, "[redacted:google-key]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted:jwt]"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "[redacted:auth-header]"],
  // KEY=value / "token": "value" style assignments of credential-named fields.
  // The separator allows a quote on either side of the delimiter so the JSON
  // form (`"api_key": "…"`) matches too, not just the shell form.
  [/\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL))\b("?\s*[:=]\s*"?)([^\s"',;]{8,})/gi,
    (_m: string, name: string, sep: string) => `${name}${sep}[redacted]`],
];

/** Pattern-based redaction of well-known credential shapes. */
export function redactSecretPatterns(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) {
    out = typeof replacement === "string"
      ? out.replace(re, replacement)
      : out.replace(re, replacement as (...args: string[]) => string);
  }
  return out;
}

/**
 * Pattern-based secret scrubbing plus literal removal of any extra secrets the
 * caller knows about — the API key is passed in explicitly because it comes
 * from the org's stored config, not the environment.
 */
export function scrubSecrets(text: string, extraSecrets: readonly (string | null | undefined)[] = []): string {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const secret of extraSecrets) {
    if (typeof secret === "string" && secret.length >= 8 && out.includes(secret)) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return redactSecretPatterns(out);
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function block(title: string, body: string): string {
  return `# ${title}\n\n-----BEGIN ${title.toUpperCase()}-----\n${body}\n-----END ${title.toUpperCase()}-----`;
}

export type PromptInput = {
  skill: string;
  /** Verbatim task-file text (an object is stringified). */
  taskJson: string | object;
  packMarkdown: string;
  sourceText: string;
  previousOutput?: string | null;
  repairNote?: string | null;
};

/**
 * Build the {system, user} pair for one batch/article. `repairNote` set means
 * repair mode: `previousOutput` is inlined so the model can fix it in place.
 */
export function buildTranslatePrompt({ skill, taskJson, packMarkdown, sourceText, previousOutput, repairNote }: PromptInput): { system: string; user: string } {
  const system = systemPromptFor(skill);

  const taskText = typeof taskJson === "string" ? taskJson : JSON.stringify(taskJson, null, 2);
  const parts = [
    block("Task JSON", taskText.trim()),
    block("Context pack", String(packMarkdown || "").replace(/\s+$/, "")),
    block("Source content", String(sourceText || "").replace(/\s+$/, "")),
  ];

  if (repairNote) {
    if (previousOutput) parts.push(block("Previous output", String(previousOutput).replace(/\s+$/, "")));
    parts.push(`# Repair note\n\n${String(repairNote).trim()}`);
  }

  parts.push(`Now emit the complete output file between ${BEGIN_OUTPUT} and ${END_OUTPUT}.`);
  return { system, user: parts.join("\n\n") };
}

// ---------------------------------------------------------------------------
// Output extraction
// ---------------------------------------------------------------------------

/**
 * Pull the output-file content out of a reply. Sentinel markers are used rather
 * than a code fence because tA articles legitimately contain fenced blocks. The
 * LAST marker pair wins — the system prompt echoes the markers, and a model that
 * restates them before its real answer must not defeat extraction.
 */
export function extractOutput(text: unknown): string {
  const raw = String(text || "");
  const begin = raw.lastIndexOf(BEGIN_OUTPUT);
  if (begin !== -1) {
    const bodyStart = begin + BEGIN_OUTPUT.length;
    const end = raw.indexOf(END_OUTPUT, bodyStart);
    const body = end === -1 ? raw.slice(bodyStart) : raw.slice(bodyStart, end);
    return body.replace(/^\r?\n/, "").replace(/\s+$/, "");
  }

  const trimmed = raw.trim();
  const fenced = /^```[^\n]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  if (fenced) return fenced[1].replace(/\s+$/, "");
  return trimmed;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

type AnyErr = Record<string, any> | null | undefined;

function errorText(err: AnyErr): string {
  if (!err) return "";
  const parts = [
    err.message,
    err.cause?.message,
    err.error?.message,
    err.error?.error?.message,
    err.response?.data?.error?.message,
  ];
  return parts.filter(Boolean).join(" | ");
}

// Connection-level failures (DNS, reset, refused, broken pipe, undici's own
// UND_ERR_* codes) surface via err.code or the wrapped err.cause.code — never
// as an HTTP status — so they need their own check rather than riding the
// status/text heuristics below.
const NETWORK_ERROR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"]);
function isNetworkErrorCode(code: unknown): boolean {
  return typeof code === "string" && (NETWORK_ERROR_CODES.has(code) || code.startsWith("UND_ERR_"));
}

function errorType(err: AnyErr): string {
  return String(err?.error?.error?.type || err?.error?.type || err?.code || err?.error?.code || "");
}

function headerValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  const h = headers as Record<string, unknown> & { get?: (k: string) => unknown };
  if (typeof h.get === "function") {
    const v = h.get(name);
    return v == null ? null : String(v);
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lower) return v == null ? null : String(v);
  }
  return null;
}

function parseRetryAfter(err: AnyErr): number | null {
  const header = headerValue(err?.headers, "retry-after") || headerValue(err?.response?.headers, "retry-after");
  const fromHeader = Number(header);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return Math.ceil(fromHeader);

  // Gemini reports a RetryInfo detail as "retryDelay": "17s"; several providers
  // put "retry after N seconds" in the body message.
  const text = errorText(err);
  const m = /retry[-_ ]?(?:after|delay)"?\s*[:=]?\s*"?(\d+(?:\.\d+)?)s?/i.exec(text);
  if (m) return Math.ceil(Number(m[1]));
  return null;
}

export type Classification = { code: ProviderErrorCode; status: number | null; retryAfterSeconds?: number | null };

/**
 * Map a thrown provider error to one of the stable codes. Reads the fields the
 * Anthropic SDK's typed errors expose (`status`, `error` body, `headers`) and
 * the shapes the other providers' SDKs use, so it stays provider-agnostic.
 */
export function classifyProviderError(err: unknown): Classification {
  const e = (err ?? {}) as Record<string, any>;
  const status = Number(e.status || e.statusCode || e.response?.status) || null;
  const text = errorText(e);
  const type = errorType(e);
  const tag = `${type} ${text}`;

  if (e.name === "AbortError" || e.name === "TimeoutError"
      || e.code === "ETIMEDOUT" || e.code === "ECONNABORTED"
      || /\btimed?[ -]?out\b|\baborted\b/i.test(tag)) {
    return { code: "timeout", status };
  }
  if (status === 401 || status === 403
      || /authentication_error|permission_denied|invalid_api_key|api key not valid|incorrect api key|unauthorized/i.test(tag)) {
    return { code: "invalid_key", status };
  }
  if (status === 404
      || /not_found|model_not_found|does not exist|unknown .{0,20}model/i.test(tag)) {
    return { code: "model_not_found", status };
  }
  if (status === 429 || /rate_limit|resource_exhausted|too many requests|quota/i.test(tag)) {
    return { code: "rate_limited", status, retryAfterSeconds: parseRetryAfter(e) };
  }
  if (status === 500 || status === 502 || status === 503 || status === 504 || status === 529
      || /overloaded|unavailable|internal server error|server_error/i.test(tag)) {
    return { code: "provider_overloaded", status, retryAfterSeconds: parseRetryAfter(e) };
  }
  if (status === 400 && /context|token limit|too long|too many tokens|maximum.{0,20}tokens|exceeds/i.test(tag)) {
    return { code: "context_too_long", status };
  }
  const networkCode = (typeof e.code === "string" && e.code) || (typeof e.cause?.code === "string" && e.cause.code) || "";
  if (isNetworkErrorCode(networkCode)) {
    return { code: "network_error", status };
  }
  return { code: "provider_error", status };
}

function providerError(
  provider: string,
  code: ProviderErrorCode,
  message: unknown,
  apiKey: string | null | undefined,
  extra: { status?: number | null; retryAfterSeconds?: number | null; cause?: unknown } = {},
): TranslateProviderError {
  const scrubbed = scrubSecrets(String(message == null ? "" : message), apiKey ? [apiKey] : []);
  return new TranslateProviderError(code, provider, `${provider} ${code}: ${scrubbed.slice(0, 200)}`, extra);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type TransportRequest = {
  provider: string;
  model: string;
  system: string;
  user: string;
  /** Effort/thinking level: none | low | medium | high | xhigh | max. */
  thinking: string | null | undefined;
  apiKey: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type TransportUsage = { inputTokens: number; outputTokens: number };
export type TransportResult = { text: string; usage: TransportUsage; stopReason: string };
export type Transport = (req: TransportRequest) => Promise<TransportResult>;

const THINKING_EFFORT: Record<string, "low" | "medium" | "high" | null> = {
  none: null, low: "low", medium: "medium", high: "high", xhigh: "high", max: "high",
};

function effort(thinking: string | null | undefined): "low" | "medium" | "high" | null {
  if (!thinking || thinking === "none") return null;
  return Object.prototype.hasOwnProperty.call(THINKING_EFFORT, thinking) ? THINKING_EFFORT[thinking] : "medium";
}

/** The slice of the Anthropic client the adapter uses; tests inject a fake. */
export type ClaudeClientLike = {
  messages: {
    stream(
      params: Anthropic.MessageStreamParams,
      options?: { signal?: AbortSignal },
    ): { finalMessage(): Promise<Pick<Anthropic.Message, "content" | "usage" | "stop_reason">> };
  };
};
export type ClaudeClientFactory = (opts: { apiKey: string; timeout: number; maxRetries: 0 }) => ClaudeClientLike;

const defaultClaudeClient: ClaudeClientFactory = (opts) => new Anthropic(opts);

// Haiku 4.5 takes the legacy `thinking: {type:"enabled", budget_tokens}` shape
// and rejects `output_config.effort`; the runner only ever asks for 'medium',
// so on Haiku it simply runs without thinking rather than 400ing.
function supportsAdaptiveThinking(model: string): boolean {
  return !/^claude-haiku-4-5/.test(model);
}

/**
 * Anthropic Messages API adapter (translate-llm.js callClaude). Streaming, not
 * a plain create: the non-streaming endpoint rejects long max_tokens outright,
 * and whole-batch TSV output is exactly that shape. A fresh client per call:
 * the key is the org's, arrives per call, and is never cached on the module.
 */
export function makeClaudeTransport(clientFactory: ClaudeClientFactory = defaultClaudeClient): Transport {
  return async ({ model, system, user, thinking, apiKey, timeoutMs, signal }) => {
    const client = clientFactory({ apiKey, timeout: timeoutMs, maxRetries: 0 });

    const params: Anthropic.MessageStreamParams = {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    };
    const eff = effort(thinking);
    if (eff && supportsAdaptiveThinking(model)) {
      params.thinking = { type: "adaptive" };
      params.output_config = { effort: eff };
    }

    const stream = client.messages.stream(params, signal ? { signal } : undefined);
    const resp = await stream.finalMessage();
    const text = (resp.content || [])
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      text,
      usage: { inputTokens: resp.usage?.input_tokens || 0, outputTokens: resp.usage?.output_tokens || 0 },
      stopReason: resp.stop_reason || "unknown",
    };
  };
}

const ADAPTERS: Record<string, () => Transport> = {
  claude: () => makeClaudeTransport(),
};

/** In-Worker adapters. Everything not listed stays on the Fly proxy path. */
export function hasInternalAdapter(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, provider);
}

export function transportFor(provider: string): Transport {
  if (!hasInternalAdapter(provider)) {
    throw new TranslateProviderError("provider_not_supported_internal", provider,
      `${provider} provider_not_supported_internal: no in-Worker adapter for provider "${provider}" (internal runner supports: ${Object.keys(ADAPTERS).join(", ")})`);
  }
  return ADAPTERS[provider]();
}

// Per-provider stop reasons that mean "the model ran out of output budget".
export const TRUNCATED_STOP_REASONS: Record<string, readonly string[]> = {
  claude: ["max_tokens"],
  openai: ["max_output_tokens"],
  xai: ["length"],
  gemini: ["MAX_TOKENS"],
};

/**
 * One provider call with classification. No backoff here: a retryable failure
 * is thrown as TranslateProviderError{retryable:true} for the Workflow step to
 * retry. A truncated reply with thinking enabled is re-run once with thinking
 * dropped (a request-shape change, not a wait) before failing output_too_long.
 */
export async function callProvider(
  transport: Transport,
  { provider, model, system, user, thinking, apiKey, timeoutMs }: Omit<TransportRequest, "timeoutMs" | "signal"> & { timeoutMs?: number | null },
): Promise<TransportResult> {
  const budget = Math.min(Number(timeoutMs) || MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  let effectiveThinking = thinking;
  let retriedWithoutReasoning = false;

  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    let result: TransportResult;
    try {
      result = await transport({
        provider, model, system, user, thinking: effectiveThinking, apiKey,
        timeoutMs: budget,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = controller.signal.aborted;
      const { code, status, retryAfterSeconds } = aborted ? { code: "timeout" as const, status: null, retryAfterSeconds: null } : classifyProviderError(err);
      const message = aborted ? `no response within ${Math.round(budget / 1000)}s` : errorText(err as AnyErr) || String(err);
      throw providerError(provider, code, message, apiKey, { status, retryAfterSeconds, cause: err });
    }
    clearTimeout(timer);

    if ((TRUNCATED_STOP_REASONS[provider] || []).includes(result.stopReason)) {
      if (!retriedWithoutReasoning && effectiveThinking && effectiveThinking !== "none") {
        retriedWithoutReasoning = true;
        effectiveThinking = "none";
        continue;
      }
      throw providerError(provider, "output_too_long", `output truncated at ${MAX_OUTPUT_TOKENS} tokens (stop reason ${result.stopReason})`, apiKey);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Usage accounting (translate-pipeline.js newLlmUsage / addLlmCall)
// ---------------------------------------------------------------------------

export type LlmCall = { usage: TransportUsage; costUsd: number | null; model: string };

export type LlmUsage = {
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  // Stays null when no call could be priced from the catalog, so a missing
  // price is visible rather than reported as $0.
  estimatedCostUsd: number | null;
  calls: number;
};

export function newLlmUsage(provider: string, model: string | null | undefined): LlmUsage {
  return { provider, model: model || null, inputTokens: 0, outputTokens: 0, estimatedCostUsd: null, calls: 0 };
}

/** Fold one call ({ usage, costUsd, model }) into the accumulator. */
export function addLlmCall(acc: LlmUsage | null | undefined, call: LlmCall | null | undefined): void {
  if (!acc || !call) return;
  acc.calls += 1;
  if (call.model) acc.model = call.model;
  acc.inputTokens += call.usage?.inputTokens || 0;
  acc.outputTokens += call.usage?.outputTokens || 0;
  if (call.costUsd != null) acc.estimatedCostUsd = (acc.estimatedCostUsd || 0) + call.costUsd;
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

export type LlmDeps = {
  provider: string;
  model: string | null | undefined;
  /** The org's decrypted key for this call only. Never persisted by this module. */
  apiKey: string | null | undefined;
  thinking?: string | null;
  timeoutMs?: number | null;
  /** Injected for tests; defaults to the provider's in-Worker adapter. */
  transport?: Transport;
};

/**
 * One completion → extracted output text (bot: runOne, minus the file write).
 * Returns the output with a trailing newline, exactly as the bot wrote it.
 */
export async function runOne(deps: LlmDeps, input: PromptInput): Promise<{ output: string; call: LlmCall }> {
  const { provider, apiKey } = deps;
  // The SDK falls back to ANTHROPIC_API_KEY from the environment; the Worker
  // must never bill anything but the org's own key.
  if (!apiKey) throw providerError(provider, "invalid_key", "no API key supplied to the translate runner", null);
  let model: string;
  try {
    model = assertProviderModel(provider, deps.model);
  } catch (err) {
    throw providerError(provider, "model_not_found", (err as Error).message, apiKey);
  }
  const transport = deps.transport || transportFor(provider);

  const { system, user } = buildTranslatePrompt(input);
  const result = await callProvider(transport, {
    provider, model, system, user, thinking: deps.thinking, apiKey, timeoutMs: deps.timeoutMs,
  });

  const output = extractOutput(result.text);
  if (!output) {
    throw providerError(provider, "empty_output", "model returned no output between the sentinel markers", apiKey);
  }
  return {
    output: output.endsWith("\n") ? output : `${output}\n`,
    call: { usage: result.usage, costUsd: estimateCost(provider, model, result.usage as TokenUsage), model },
  };
}

export type RunBatchInput = BatchArtifacts & { batchRows: readonly TsvRow[] };
export type RunBatchOptions = { resource: TsvResource; skill: string };
export type RunBatchResult = {
  rows: TsvRow[];
  checks: CheckResult;
  attempts: number;
  /** The validated output file content (batch-NN-out.tsv). */
  outputText: string;
  llmCalls: LlmCall[];
};

/**
 * The draft + repair loop for one TSV batch (translate-pipeline.js runTsvBatch,
 * direct-provider branch). Attempt 1 drafts; if the deterministic checks fail,
 * attempt 2 re-runs with the violations and the previous output inlined. Still
 * failing after MAX_BATCH_ATTEMPTS → checks_failed (non-retryable: the same
 * prompt will fail the same way).
 */
export async function runBatch(deps: LlmDeps, artifacts: RunBatchInput, { resource, skill }: RunBatchOptions): Promise<RunBatchResult> {
  let lastChecks: CheckResult | null = null;
  let lastOutput: string | null = null;
  const llmCalls: LlmCall[] = [];
  const cols = resource.translateColumns.join(" + ");

  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
    const isRepair = attempt > 1 && lastChecks;
    const repairNote = isRepair
      ? `\n\nYour previous output FAILED deterministic validation. Violations:\n${
        lastChecks!.errors.map((e) => `- [${e.check}]${e.column ? ` (${e.column})` : ""} row ${e.rowId}: ${e.message}`).join("\n")
      }\nRewrite ${artifacts.names.outputFile} fixing every violation. Translate ONLY these columns: ${cols}. Every other column must be byte-identical to the source.`
      : "";

    const { output, call } = await runOne(deps, {
      skill,
      taskJson: artifacts.taskJson,
      packMarkdown: artifacts.packMarkdown,
      sourceText: artifacts.sourceTsv,
      previousOutput: isRepair ? lastOutput : null,
      repairNote: isRepair ? repairNote : null,
    });
    llmCalls.push(call);

    const { rows, checks } = validateBatchOutput(output, artifacts.batchRows, {
      parse: resource.codec.parse, checkOpts: resource.checkOpts,
    });
    if (checks.ok) return { rows, checks, attempts: attempt, outputText: output, llmCalls };
    lastChecks = checks;
    lastOutput = output;
  }
  const summary = lastChecks!.errors.slice(0, 5).map((e) => `[${e.check}] ${e.rowId}: ${e.message}`).join("; ");
  throw new TranslateProviderError("checks_failed", deps.provider,
    scrubSecrets(`batch ${artifacts.nn} still failing deterministic checks after repair pass: ${summary}`, [deps.apiKey]));
}
