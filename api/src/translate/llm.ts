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
//     through scrubSecrets(msg, [apiKey]). A foreign error is never attached
//     to a thrown TranslateProviderError as-is: sanitizeCause rebuilds it as
//     a plain Error carrying only the class name and the scrubbed message,
//     so nothing that walks a cause chain can reach an unscrubbed message,
//     stack or property.
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
  /** Raw transport results that were paid for before the failure (priced into `llmCalls` by runOne). */
  transportResults?: TransportResult[];
  /** Priced calls made before the failure, so the report still accounts for spent tokens. */
  llmCalls?: LlmCall[];

  constructor(
    code: ProviderErrorCode,
    provider: string,
    message: string,
    { status, retryAfterSeconds, cause, transportResults }: {
      status?: number | null; retryAfterSeconds?: number | null; cause?: unknown; transportResults?: TransportResult[];
    } = {},
  ) {
    super(message, cause !== undefined ? { cause: sanitizeCause(cause) } : undefined);
    this.name = "TranslateProviderError";
    this.code = code;
    this.errorKind = code;
    this.provider = provider;
    this.retryable = isRetryableCode(code);
    if (status != null) this.status = status;
    if (retryAfterSeconds != null) this.retryAfterSeconds = retryAfterSeconds;
    if (transportResults && transportResults.length) this.transportResults = transportResults;
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

// The error plus its `cause` chain (bounded). The SDK's MessageStream re-wraps
// any non-Anthropic failure as AnthropicError(message) with `.cause` = the raw
// error (MessageStream.js:53-55), and undici/workerd put their codes one level
// deeper still (cause.cause.code) — so a two-level look-up misses them.
function causeChain(err: AnyErr): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  let cur: unknown = err;
  for (let i = 0; cur && typeof cur === "object" && i < 6; i++) {
    out.push(cur as Record<string, any>);
    cur = (cur as Record<string, any>).cause;
  }
  return out;
}

function errorText(err: AnyErr): string {
  if (!err) return "";
  const parts = [
    err.message,
    ...causeChain(err).slice(1).map((c) => c.message),
    err.error?.message,
    err.error?.error?.message,
    err.response?.data?.error?.message,
  ];
  return parts.filter((p) => typeof p === "string" && p).join(" | ");
}

// Connection-level failures (DNS, reset, refused, broken pipe, undici's own
// UND_ERR_* codes) surface via `.code` somewhere on the cause chain — never as
// an HTTP status — so they need their own check rather than riding the
// status/text heuristics below.
const NETWORK_ERROR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"]);
function isNetworkErrorCode(code: unknown): boolean {
  return typeof code === "string" && (NETWORK_ERROR_CODES.has(code) || code.startsWith("UND_ERR_"));
}
function networkCodeOf(err: AnyErr): string {
  for (const c of causeChain(err)) {
    if (isNetworkErrorCode(c.code)) return c.code;
  }
  return "";
}
// workerd reports a dropped socket without any code ("Network connection
// lost."), undici says "fetch failed" / "terminated", and the SDK's stream
// reader says "stream ended without producing a Message" when the connection
// drops mid-stream. All status-less, all worth a retry.
const NETWORK_TEXT_RE = /network connection lost|\bterminated\b|fetch failed|stream ended|request ended without sending/i;

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
  // 413 request_too_large is the transport-level form of "prompt too big".
  if (status === 413 || (status === 400 && /context|token limit|too long|too many tokens|maximum.{0,20}tokens|exceeds/i.test(tag))) {
    return { code: "context_too_long", status };
  }
  if (isNetworkErrorCode(networkCodeOf(e))) {
    return { code: "network_error", status };
  }
  if (status == null && NETWORK_TEXT_RE.test(tag)) {
    return { code: "network_error", status };
  }
  return { code: "provider_error", status };
}

/**
 * Rebuild a foreign error into a plain, scrubbed one before it is attached as
 * a `cause`. The raw object must never travel: its `message`, its `stack` and
 * its own properties can each carry the API key verbatim (a provider that
 * echoes the key back is exactly what the secret-hygiene tests simulate), so
 * anything that walks a cause chain — a recursive logger, a serializer,
 * persisted Workflow state — would surface the credential even though the
 * outer message was scrubbed. Rebuild rather than scrub in place, following
 * sanitizeBatchError: a scrubbed `message` on the original object still leaves
 * the original `stack` and every other own property behind. What survives is
 * the class name and the scrubbed message text — enough to debug, nothing
 * carrying unscrubbed text and no inherited stack.
 */
function sanitizeCause(err: unknown, extraSecrets: readonly (string | null | undefined)[] = []): Error | undefined {
  if (err === null || err === undefined) return undefined;
  const isObj = typeof err === "object" || typeof err === "function";
  const own = isObj ? String((err as Record<string, any>).name || "") : "";
  const ctor = isObj ? String((err as Record<string, any>).constructor?.name || "") : "";
  // `name` is inherited as "Error" by subclasses that do not set it, so the
  // constructor name is the more specific one in that case — and the reverse
  // for `Object.assign(new Error(…), { name: "AbortError" })`.
  const name = (own && own !== "Error" ? own : ctor || own) || (isObj ? "Error" : typeof err);
  const safe = new Error(scrubSecrets(errorText(err as AnyErr) || String(err), extraSecrets).slice(0, 200));
  safe.name = scrubSecrets(name, extraSecrets).slice(0, 80);
  return safe;
}

function providerError(
  provider: string,
  code: ProviderErrorCode,
  message: unknown,
  apiKey: string | null | undefined,
  extra: { status?: number | null; retryAfterSeconds?: number | null; cause?: unknown; transportResults?: TransportResult[] } = {},
): TranslateProviderError {
  const secrets = apiKey ? [apiKey] : [];
  const scrubbed = scrubSecrets(String(message == null ? "" : message), secrets);
  // The literal key is only known here, so the cause is sanitised here too —
  // the constructor's own pass can strip patterns but not the org's key.
  const cause = sanitizeCause(extra.cause, secrets);
  return new TranslateProviderError(code, provider, `${provider} ${code}: ${scrubbed.slice(0, 200)}`, { ...extra, cause });
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

/** The level a truncated draft is retried at (see callProvider). */
export const TRUNCATION_RETRY_THINKING = "low";

export type CallOutcome = TransportResult & {
  /** Results that were paid for but superseded (the truncated first draft). */
  discarded: TransportResult[];
};

/**
 * One provider call with classification. No backoff here: a retryable failure
 * is thrown as TranslateProviderError{retryable:true} for the Workflow step to
 * retry. A truncated reply with thinking enabled is re-run once at LOW effort
 * (a request-shape change, not a wait) before failing output_too_long.
 *
 * Deliberate deviation from translate-llm.js:512-518, which retried with
 * `thinking = 'none'` and then OMITTED the thinking/output_config params. Per
 * the claude-api skill, omitting `thinking` on Claude Opus 5 / Sonnet 5 runs
 * adaptive thinking at the default effort `high` — i.e. the bot's "retry
 * without reasoning" retried a truncated medium draft with MORE thinking under
 * the same 32000-token cap. The skill also warns that `{type:"disabled"}` on
 * Opus 5 is rejected at effort xhigh/max and has two failure modes (tool calls
 * written into visible text, leaked thinking tags), recommending low/medium
 * effort instead. So the retry keeps adaptive thinking and lowers effort to
 * `low`. No retry when the model has no adaptive thinking (Haiku 4.5) or the
 * draft already ran at `low`/none — the same request would only truncate again.
 */
export async function callProvider(
  transport: Transport,
  { provider, model, system, user, thinking, apiKey, timeoutMs }: Omit<TransportRequest, "timeoutMs" | "signal"> & { timeoutMs?: number | null },
): Promise<CallOutcome> {
  const budget = Math.min(Number(timeoutMs) || MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  let effectiveThinking = thinking;
  let retriedAtLowEffort = false;
  const discarded: TransportResult[] = [];

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
      throw providerError(provider, code, message, apiKey, { status, retryAfterSeconds, cause: err, transportResults: discarded });
    }
    clearTimeout(timer);

    if ((TRUNCATED_STOP_REASONS[provider] || []).includes(result.stopReason)) {
      const currentEffort = effort(effectiveThinking);
      const canLower = supportsAdaptiveThinking(model) && currentEffort !== null && currentEffort !== TRUNCATION_RETRY_THINKING;
      if (!retriedAtLowEffort && canLower) {
        discarded.push(result);
        retriedAtLowEffort = true;
        effectiveThinking = TRUNCATION_RETRY_THINKING;
        continue;
      }
      throw providerError(provider, "output_too_long", `output truncated at ${MAX_OUTPUT_TOKENS} tokens (stop reason ${result.stopReason})`, apiKey,
        { transportResults: [...discarded, result] });
    }
    return { ...result, discarded };
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

export type RunOneResult = {
  /** The output with a trailing newline, exactly as the bot wrote it. */
  output: string;
  /** The call that produced `output`. */
  call: LlmCall;
  /** Paid-for calls superseded on the way (a truncated draft retried at low effort). */
  discardedCalls: LlmCall[];
};

/**
 * One completion → extracted output text (bot: runOne, minus the file write).
 * Every provider call that was billed is reported, either in the result or on
 * the thrown TranslateProviderError's `llmCalls`, so cost never under-counts.
 */
export async function runOne(deps: LlmDeps, input: PromptInput): Promise<RunOneResult> {
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
  const price = (r: TransportResult): LlmCall => ({ usage: r.usage, costUsd: estimateCost(provider, model, r.usage as TokenUsage), model });

  const { system, user } = buildTranslatePrompt(input);
  let outcome: CallOutcome;
  try {
    outcome = await callProvider(transport, {
      provider, model, system, user, thinking: deps.thinking, apiKey, timeoutMs: deps.timeoutMs,
    });
  } catch (err) {
    if (err instanceof TranslateProviderError && err.transportResults) err.llmCalls = err.transportResults.map(price);
    throw err;
  }

  const output = extractOutput(outcome.text);
  if (!output) {
    const empty = providerError(provider, "empty_output", "model returned no output between the sentinel markers", apiKey,
      { transportResults: [...outcome.discarded, outcome] });
    empty.llmCalls = empty.transportResults!.map(price);
    throw empty;
  }
  return {
    output: output.endsWith("\n") ? output : `${output}\n`,
    call: price(outcome),
    discardedCalls: outcome.discarded.map(price),
  };
}

export type RunBatchInput = BatchArtifacts & { batchRows: readonly TsvRow[] };
export type RunBatchOptions = {
  resource: TsvResource;
  skill: string;
  /**
   * A draft the caller already PAID for on an earlier step attempt, recovered
   * from durable storage, whose checks failed. Resuming from it starts the loop
   * at the repair pass, so a step retry after a transient failure that landed
   * AFTER a billed draft does not buy that draft a second time.
   */
  resume?: { output: string; checks: CheckResult } | null;
  /**
   * Awaited with every billed draft that failed validation, BEFORE the repair
   * call is made. This is the caller's chance to persist the draft durably —
   * nothing the org paid for should exist only in this isolate's memory. A
   * throw here aborts the batch (the caller decides how fatal that is) rather
   * than letting the loop spend another call on top of an unsaved one.
   */
  onFailedDraft?: (output: string, checks: CheckResult) => Promise<void>;
};
export type RunBatchResult = {
  rows: TsvRow[];
  checks: CheckResult;
  /** Draft/repair passes that produced a validated output (1 or 2), resumed ones included. */
  attempts: number;
  /**
   * Provider calls billed by THIS invocation, drafts discarded on truncation
   * included. Normally >= attempts; on a resumed batch it is one lower, because
   * the draft being resumed from was billed by an earlier step attempt.
   */
  calls: number;
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
 *
 * `resume` and `onFailedDraft` exist for one reason: a provider call is money,
 * and the caller runs inside a Workflow step that may be retried. Together they
 * make the draft survive the step — persisted before the repair call, handed
 * back on the next attempt — so a transient failure between the draft and the
 * step's completion costs the repair pass, not the draft as well.
 */
export async function runBatch(deps: LlmDeps, artifacts: RunBatchInput, { resource, skill, resume, onFailedDraft }: RunBatchOptions): Promise<RunBatchResult> {
  let lastChecks: CheckResult | null = resume?.checks ?? null;
  let lastOutput: string | null = resume?.output ?? null;
  const llmCalls: LlmCall[] = [];
  const cols = resource.translateColumns.join(" + ");

  // A resumed batch enters at the LAST attempt: the draft it resumes from was
  // already billed, so the budget this step has left is the repair pass, and
  // spending more than that is exactly the double-spend being avoided.
  for (let attempt = resume ? MAX_BATCH_ATTEMPTS : 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
    const isRepair = attempt > 1 && lastChecks;
    const repairNote = isRepair
      ? `\n\nYour previous output FAILED deterministic validation. Violations:\n${
        lastChecks!.errors.map((e) => `- [${e.check}]${e.column ? ` (${e.column})` : ""} row ${e.rowId}: ${e.message}`).join("\n")
      }\nRewrite ${artifacts.names.outputFile} fixing every violation. Translate ONLY these columns: ${cols}. Every other column must be byte-identical to the source.`
      : "";

    let one: RunOneResult;
    try {
      one = await runOne(deps, {
        skill,
        taskJson: artifacts.taskJson,
        packMarkdown: artifacts.packMarkdown,
        sourceText: artifacts.sourceTsv,
        previousOutput: isRepair ? lastOutput : null,
        repairNote: isRepair ? repairNote : null,
      });
    } catch (err) {
      // Calls billed by earlier attempts stay visible to the Workflow's accounting.
      if (err instanceof TranslateProviderError) err.llmCalls = [...llmCalls, ...(err.llmCalls || [])];
      throw err;
    }
    llmCalls.push(...one.discardedCalls, one.call);

    const { rows, checks } = validateBatchOutput(one.output, artifacts.batchRows, {
      parse: resource.codec.parse, checkOpts: resource.checkOpts,
    });
    if (checks.ok) return { rows, checks, attempts: attempt, calls: llmCalls.length, outputText: one.output, llmCalls };
    lastChecks = checks;
    lastOutput = one.output;
    // Persist the billed-but-invalid draft before spending anything else.
    if (attempt < MAX_BATCH_ATTEMPTS && onFailedDraft) await onFailedDraft(one.output, checks);
  }
  const summary = lastChecks!.errors.slice(0, 5).map((e) => `[${e.check}] ${e.rowId}: ${e.message}`).join("; ");
  const failed = new TranslateProviderError("checks_failed", deps.provider,
    scrubSecrets(`batch ${artifacts.nn} still failing deterministic checks after repair pass: ${summary}`, [deps.apiKey]));
  failed.llmCalls = llmCalls;
  throw failed;
}
