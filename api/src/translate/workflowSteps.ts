// TranslateWorkflow step bodies (docs/translate-internal-runner.md §B).
//
// Everything a `step.do` closure executes lives here, as plain async functions
// over an explicit `StepDeps` (D1 + R2 + fetch + transport), so the bodies run
// under the node strip-types test runner with a node:sqlite D1, a Map-backed
// BlobStore and a stub transport. translateWorkflow.ts is the thin
// WorkflowEntrypoint that wires these into steps with retry policy — it is the
// only file that imports `cloudflare:workers` / `cloudflare:workflows`.
//
// Contract with the rest of the app (design §B):
//   * D1 writes go through status.writeWfStatus only: current_skill,
//     current_status, updated_at, wf_status_json. Never state / output_json.
//   * Content lives in R2 under storage.ts's job prefix; step return values are
//     tiny (counts, shas, usage) because Cloudflare persists them.
//   * The org's API key exists only as a local const inside batchStep. It is
//     never returned, never written, and every error leaving that scope is
//     scrubbed of it (llm.scrubSecrets).
//   * Failures carry an errorKind. Deterministic ones are `retryable: false`
//     and the Workflow turns them into NonRetryableError; provider-side
//     transients (rate_limited, provider_overloaded, timeout, network_error)
//     and plain infrastructure errors propagate as-is so the step retries.

import type { Workspace } from "../workspaces.ts";
import { resolveWorkspace } from "../workspaces.ts";
import { getAiProviderConfig, resolveDispatchAi } from "../aiProvider.ts";
import { decryptApiKey } from "../aiKeyCrypto.ts";
import { resolveParams, type TranslateParams } from "./params.ts";
import {
  buildBatchArtifacts,
  buildBatches,
  buildTranslateReport,
  fetchResourceFile,
  mergeChapterIntoBook,
  renderBatchPack,
  selectRows,
  sliceChapterRows,
  tsvResource,
  updateRowsById,
  validateBatchOutput,
  type BatchMeta,
  type TsvResource,
} from "./core.ts";
import { loadContextPack, type FetchLike } from "./contextPack.ts";
import { buildScripturePack } from "./scripture.ts";
import { runChecks } from "./checks.ts";
import type { TsvRow } from "./tsvCodec.ts";
import {
  TranslateProviderError,
  addLlmCall,
  isRetryableCode,
  newLlmUsage,
  redactSecretPatterns,
  runBatch,
  scrubSecrets,
  transportFor,
  type Transport,
} from "./llm.ts";
import {
  batchFileNames,
  batchKeys,
  batchNn,
  getText,
  outKey,
  putText,
  reportFileName,
  type BlobStore,
} from "./storage.ts";
import {
  buildEditorManifest,
  doneStatus,
  failedStatus,
  runningStatus,
  writeWfStatus,
  type StatusScope,
} from "./status.ts";

// ---------------------------------------------------------------------------
// Params (persisted by Cloudflare — nothing secret, ever)
// ---------------------------------------------------------------------------

export type TranslateWorkflowParams = {
  jobId: string;
  /** REQUIRED. Workflows don't inherit the per-request env clone; this is how run() finds the org's D1. */
  workspace: string;
  userId: number;
  resourceType: string;
  book: string;
  startChapter: number;
  endChapter: number;
  verseStart?: number | null;
  verseEnd?: number | null;
  rowIds?: string[] | null;
  articleId?: string | null;
  articleUrl?: string | null;
  targetLang: string;
  direction: "ltr" | "rtl";
  sourceRef: string;
  contextRef?: string | null;
  literalRef?: string | null;
  simplifiedRef?: string | null;
  sourceLiteralRef: string;
  sourceSimplifiedRef: string;
  targetOrg: string;
  repoName: string;
  /** Provider + model only. The key is re-read from ai_provider_config inside each batch step. */
  provider: string;
  model: string;
  thinking: "medium";
};

/** Fold the flat params into the bot's resolved shape (defaults, names, mergeMode, skill). */
export function paramsToTranslateParams(p: TranslateWorkflowParams): TranslateParams {
  return resolveParams({
    resourceType: p.resourceType,
    book: p.book,
    startChapter: p.startChapter,
    endChapter: p.endChapter,
    verseStart: p.verseStart ?? null,
    verseEnd: p.verseEnd ?? null,
    rowIds: p.rowIds ?? null,
    articleId: p.articleId ?? null,
    articleUrl: p.articleUrl ?? null,
    targetLang: p.targetLang,
    targetOrg: p.targetOrg,
    repoName: p.repoName,
    sourceRef: p.sourceRef,
    contextRef: p.contextRef ?? null,
    sourceLiteralRef: p.sourceLiteralRef,
    sourceSimplifiedRef: p.sourceSimplifiedRef,
    literalRef: p.literalRef ?? null,
    simplifiedRef: p.simplifiedRef ?? null,
    direction: p.direction,
    jobId: p.jobId,
    provider: p.provider,
    model: p.model,
  });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A step failure with a machine-readable kind. `retryable: false` becomes NonRetryableError. */
export class TranslateStepError extends Error {
  errorKind: string;
  retryable: boolean;
  constructor(errorKind: string, message: string, { retryable = false, cause }: { retryable?: boolean; cause?: unknown } = {}) {
    super(`[${errorKind}] ${message}`, cause !== undefined ? { cause } : undefined);
    this.name = "TranslateStepError";
    this.errorKind = errorKind;
    this.retryable = retryable;
  }
}

export type StepFailure = { errorKind: string; message: string; retryable: boolean };

const KIND_TAG = /^\[([a-z][a-z0-9_]*)\]\s*/;

/**
 * Normalize anything a step threw. Workflows re-throws a step's final error
 * into run() after retries are exhausted, and only `message`/`name` reliably
 * survive that hop — so the kind is also carried as a `[kind] ` message prefix
 * (TranslateStepError and the NonRetryableError wrapper both write it).
 * Unknown errors default to RETRYABLE `internal_error`: a D1 or DCS hiccup
 * deserves the step's retry budget, and a deterministic bug still fails the
 * instance once that budget is spent.
 */
export function classifyStepError(err: unknown): StepFailure {
  const e = (err ?? {}) as Record<string, unknown>;
  const rawMessage = err instanceof Error ? err.message : String(err);
  if (err instanceof TranslateProviderError) {
    return { errorKind: err.code, message: redactSecretPatterns(rawMessage), retryable: err.retryable };
  }
  if (err instanceof TranslateStepError) {
    return { errorKind: err.errorKind, message: redactSecretPatterns(rawMessage.replace(KIND_TAG, "")), retryable: err.retryable };
  }
  const tagged = KIND_TAG.exec(rawMessage);
  if (tagged) {
    const kind = tagged[1];
    return { errorKind: kind, message: redactSecretPatterns(rawMessage.slice(tagged[0].length)), retryable: isRetryableCode(kind) };
  }
  if (typeof e.code === "string" && (isRetryableCode(e.code) || typeof e.retryable === "boolean")) {
    return { errorKind: e.code, message: redactSecretPatterns(rawMessage), retryable: e.retryable === true || isRetryableCode(e.code) };
  }
  return { errorKind: "internal_error", message: redactSecretPatterns(rawMessage), retryable: true };
}

// ---------------------------------------------------------------------------
// Workspace re-point (design §B first line; STATE.md Workflows env-clone lesson)
// ---------------------------------------------------------------------------

/**
 * The slug a queued run must resolve before touching any binding. Missing →
 * non-retryable: dispatch always sets it, so its absence is a caller bug, not
 * something a retry can fix. Unknown → non-retryable too: resolveWorkspace()
 * answers an unknown slug with list[0] (another tenant's D1), which is exactly
 * the wrong-tenant hole this guard exists to close.
 */
export function resolveWorkflowWorkspace(env: Parameters<typeof resolveWorkspace>[0], params: { workspace?: string | null } | null | undefined): Workspace {
  const slug = params?.workspace;
  if (!slug) throw new TranslateStepError("workspace_missing", "TranslateWorkflow requires params.workspace (set from env.WORKSPACE_SLUG at dispatch)");
  const ws = resolveWorkspace(env, slug);
  if (ws.slug !== slug) throw new TranslateStepError("workspace_unknown", `params.workspace "${slug}" is not a known workspace on this deployment`);
  return ws;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** The D1 subset the steps use (D1Database satisfies it; tests pass a node:sqlite adapter). */
export interface StepStmt {
  bind(...values: unknown[]): StepStmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface StepDb {
  prepare(sql: string): StepStmt;
}

export type StepDeps = {
  db: StepDb;
  blobs: BlobStore;
  /** The RESOLVED workspace slug (env.WORKSPACE_SLUG after re-point); prefixes every R2 key. */
  workspaceSlug: string;
  /** env.AI_KEY_WRAPPING_KEY — needed to decrypt the org's stored key. */
  wrappingKey: string | undefined;
  /** ISO timestamp of the Workflow event; surfaces as current.startedAt. */
  startedAt: string;
  /** Injected for tests; default = global fetch (DCS raw endpoints). */
  fetchImpl?: FetchLike;
  /** Injected for tests; default = the provider's in-Worker adapter. */
  transport?: Transport;
  now?: () => Date;
};

const LIVE_STATES = new Set(["running", "dispatching"]);

function scopeOf(p: TranslateParams, deps: StepDeps, chapter: number): StatusScope {
  return { chapter, skill: p.skill, startedAt: deps.startedAt };
}

async function progress(deps: StepDeps, jobId: string, p: TranslateParams, text: string): Promise<void> {
  await writeWfStatus(deps.db, jobId, runningStatus(scopeOf(p, deps, p.startChapter ?? 0), text, deps.now?.() ?? new Date()));
}

/**
 * Cooperative cancel (design §B): the cancel route only touches queued rows,
 * so a running job learns it was cancelled — or failed by the stale-dispatch
 * sweep — by re-reading its own row here, at step 1 and at the top of every
 * batch step. Missing row and non-live states are all non-retryable.
 */
export async function assertJobLive(deps: StepDeps, jobId: string): Promise<void> {
  const row = await deps.db.prepare(`SELECT state FROM pipeline_jobs WHERE job_id = ?1`).bind(jobId).first<{ state: string }>();
  if (!row) throw new TranslateStepError("job_missing", `pipeline_jobs row ${jobId} no longer exists`);
  if (row.state === "cancelled") throw new TranslateStepError("cancelled", `job ${jobId} was cancelled`);
  if (!LIVE_STATES.has(row.state)) throw new TranslateStepError("job_not_running", `job ${jobId} is '${row.state}', not running`);
}

async function readBatches(deps: StepDeps, jobId: string, batchCount: number, resource: TsvResource): Promise<TsvRow[][]> {
  const out: TsvRow[][] = [];
  for (let i = 0; i < batchCount; i++) {
    const nn = batchNn(i);
    const text = await getText(deps.blobs, batchKeys(deps.workspaceSlug, jobId, nn).source);
    if (text == null) throw new TranslateStepError("artifact_missing", `work/batch-${nn}.tsv is missing from R2 (guard-and-source did not persist it)`);
    out.push(resource.codec.parse(text));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 1: guard-and-source
// ---------------------------------------------------------------------------

export type GuardAndSourceResult = { batchCount: number; rowCount: number };

export async function guardAndSourceStep(deps: StepDeps, params: TranslateWorkflowParams): Promise<GuardAndSourceResult> {
  await assertJobLive(deps, params.jobId);
  const p = paramsToTranslateParams(params);
  if (p.family !== "tsv") {
    throw new TranslateStepError("resource_not_supported_internal", `${p.resourceType} (articles) is not yet supported by the internal runner`);
  }
  const resource = tsvResource(p.resourceType);
  const book = p.book!;

  const sourceText = await fetchResourceFile(p.sourceRef, resource.file(book), { fetchImpl: deps.fetchImpl });
  if (!sourceText) throw new TranslateStepError("source_not_found", `source not found: ${p.sourceRef} ${resource.file(book)}`);
  const allRows = resource.codec.parse(sourceText);
  let rows = sliceChapterRows(allRows, p.startChapter!, p.endChapter!);
  rows = selectRows(rows, { rowIds: p.rowIds, verseStart: p.verseStart, verseEnd: p.verseEnd });
  if (!rows.length) {
    const sel = p.rowIds ? `rowIds ${p.rowIds.join(",")}`
      : p.verseStart != null ? `${p.startChapter}:${p.verseStart}${p.verseEnd !== p.verseStart ? `-${p.verseEnd}` : ""}`
        : `${p.startChapter}-${p.endChapter}`;
    throw new TranslateStepError("no_source_rows", `no source rows for ${book} ${sel}`);
  }

  const batches = buildBatches(rows, { sizeOf: resource.sizeOf });
  for (let i = 0; i < batches.length; i++) {
    await putText(deps.blobs, batchKeys(deps.workspaceSlug, params.jobId, batchNn(i)).source, resource.codec.serialize(batches[i]));
  }
  await progress(deps, params.jobId, p,
    `source: ${rows.length} row(s) from ${p.sourceRef}${p.mergeMode === "by-id" ? " (by-id subset)" : ""} — ${batches.length} batch(es)`);
  return { batchCount: batches.length, rowCount: rows.length };
}

// ---------------------------------------------------------------------------
// Step 2: context
// ---------------------------------------------------------------------------

export type PerBatchContext = { slugs: string[]; templateFallbacks: string[] };
export type ContextResult = { contextSha: string | null; hasContent: boolean; perBatch: PerBatchContext[] };

export async function contextStep(deps: StepDeps, params: TranslateWorkflowParams, batchCount: number): Promise<ContextResult> {
  const p = paramsToTranslateParams(params);
  const resource = tsvResource(p.resourceType);
  const book = p.book!;
  const batches = await readBatches(deps, params.jobId, batchCount, resource);
  const rows = batches.flat();

  const pack = await loadContextPack(p.contextRef, { allowEmpty: !p.contextRefExplicit, fetchImpl: deps.fetchImpl });

  // Never fatal (translate-pipeline.js:411-424): a missing target Bible just
  // means the pack carries no scripture section.
  let scripture = null;
  try {
    scripture = await buildScripturePack({
      book, rows: rows as (TsvRow & { Reference: string })[],
      sourceLiteralRef: p.sourceLiteralRef,
      sourceSimplifiedRef: p.sourceSimplifiedRef,
      targetLiteralRef: p.targetLiteralRef,
      targetSimplifiedRef: p.targetSimplifiedRef,
    }, { fetchImpl: deps.fetchImpl });
  } catch {
    scripture = null;
  }

  const perBatch: PerBatchContext[] = [];
  for (let i = 0; i < batches.length; i++) {
    const batchRows = batches[i];
    const rendered = renderBatchPack({
      batchRows, pack, scripture,
      targetLang: p.targetLang, targetLangName: p.targetLangName, direction: p.direction, sourceLangName: p.sourceLangName,
    });
    const art = buildBatchArtifacts(i, {
      batchRows, packMarkdown: rendered.markdown,
      targetLang: p.targetLang, targetLangName: p.targetLangName, sourceLangName: p.sourceLangName,
      direction: p.direction, book, resource,
    });
    const keys = batchKeys(deps.workspaceSlug, params.jobId, art.nn);
    await putText(deps.blobs, keys.pack, art.packMarkdown);
    await putText(deps.blobs, keys.task, art.taskJson);
    perBatch.push({ slugs: rendered.slugs, templateFallbacks: rendered.templateFallbacks });
  }

  await progress(deps, params.jobId, p, pack.hasContent
    ? `context pack: ${p.contextRef}${pack.sha ? ` @ ${pack.sha.slice(0, 10)}` : ""} — ${pack.templates.size} templates, ${pack.terms.length} terms, ${pack.examples.length} examples`
    : `WARNING: no context pack at ${p.contextRef} — translating as a RAW BASELINE`);
  return { contextSha: pack.sha, hasContent: pack.hasContent, perBatch };
}

// ---------------------------------------------------------------------------
// Step 3: batch-NN
// ---------------------------------------------------------------------------

export type BatchStepResult = {
  nn: string;
  rowCount: number;
  /** Draft/repair passes (0 when a validated output was reused from R2). */
  attempts: number;
  /** Billed provider calls (>= attempts; 0 on reuse). */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  reused: boolean;
};

/** Scrub the key out of an error's message chain in place, then return it for rethrow. */
function scrubError(err: unknown, apiKey: string): unknown {
  let e: unknown = err;
  for (let depth = 0; e instanceof Error && depth < 5; depth++) {
    e.message = scrubSecrets(e.message, [apiKey]);
    e = (e as { cause?: unknown }).cause;
  }
  if (err instanceof Error) return err;
  return new Error(scrubSecrets(String(err), [apiKey]));
}

export async function batchStep(deps: StepDeps, params: TranslateWorkflowParams, index: number, batchCount: number): Promise<BatchStepResult> {
  const nn = batchNn(index);
  const total = String(batchCount).padStart(2, "0");
  await assertJobLive(deps, params.jobId);
  const p = paramsToTranslateParams(params);
  const resource = tsvResource(p.resourceType);
  const keys = batchKeys(deps.workspaceSlug, params.jobId, nn);

  const sourceTsv = await getText(deps.blobs, keys.source);
  if (sourceTsv == null) throw new TranslateStepError("artifact_missing", `work/batch-${nn}.tsv is missing from R2`);
  const batchRows = resource.codec.parse(sourceTsv);

  // Idempotency (translate-pipeline.js:449-454): a retried step — or a
  // re-created instance — must not pay for a batch that already validated.
  const existing = await getText(deps.blobs, keys.output);
  if (existing != null) {
    try {
      const prev = validateBatchOutput(existing, batchRows, { parse: resource.codec.parse, checkOpts: resource.checkOpts });
      if (prev.checks.ok) {
        await progress(deps, params.jobId, p, `batch ${nn}/${total} reused from previous attempt (checks ok)`);
        return { nn, rowCount: batchRows.length, attempts: 0, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null, reused: true };
      }
    } catch {
      /* unparseable leftover — retranslate */
    }
  }

  const packMarkdown = await getText(deps.blobs, keys.pack);
  const taskJson = await getText(deps.blobs, keys.task);
  if (packMarkdown == null || taskJson == null) throw new TranslateStepError("artifact_missing", `work/batch-${nn}-pack.md or -task.json is missing from R2`);

  // Key handling (design §B): re-read the org's config, decrypt here, keep the
  // plaintext in this scope only. The provider must still be the one dispatch
  // pinned in params — an admin switching providers mid-run must fail the job,
  // not bill a different vendor with a key meant for another.
  const row = await getAiProviderConfig(deps.db as unknown as D1Database);
  const ai = resolveDispatchAi(row, deps.wrappingKey);
  if (ai.kind !== "configured") {
    throw new TranslateStepError("ai_provider_unavailable", ai.kind === "error" ? ai.reason : "no BYO provider configured for this workspace");
  }
  if (ai.provider !== params.provider) {
    throw new TranslateStepError("ai_provider_changed", `ai_provider_config now names '${ai.provider}' but this job was dispatched for '${params.provider}'`);
  }
  let apiKey: string;
  try {
    apiKey = await decryptApiKey(deps.wrappingKey!, ai.ciphertext, ai.iv);
  } catch {
    throw new TranslateStepError("ai_provider_key_decrypt_failed", "stored provider key could not be decrypted (wrapping key rotated?)");
  }

  let result;
  try {
    const transport = deps.transport ?? transportFor(params.provider);
    result = await runBatch(
      { provider: params.provider, model: params.model, apiKey, thinking: p.thinking, transport },
      { nn, names: batchFileNames(nn), sourceTsv, packMarkdown, taskJson, batchRows },
      { resource, skill: p.skill },
    );
  } catch (err) {
    throw scrubError(err, apiKey);
  }

  await putText(deps.blobs, keys.output, result.outputText);
  await progress(deps, params.jobId, p, `batch ${nn}/${total} done (${batchRows.length} rows, ${result.attempts} attempt(s))`);

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = null;
  for (const c of result.llmCalls) {
    inputTokens += c.usage?.inputTokens || 0;
    outputTokens += c.usage?.outputTokens || 0;
    if (c.costUsd != null) costUsd = (costUsd ?? 0) + c.costUsd;
  }
  return { nn, rowCount: batchRows.length, attempts: result.attempts, calls: result.calls, inputTokens, outputTokens, costUsd, reused: false };
}

// ---------------------------------------------------------------------------
// Step 4: merge-report
// ---------------------------------------------------------------------------

export type MergeReportResult = {
  rowCount: number;
  bookFile: string;
  reportFile: string;
  warningCount: number;
  calls: number;
  costUsd: number | null;
};

export async function mergeReportStep(
  deps: StepDeps,
  params: TranslateWorkflowParams,
  batchCount: number,
  context: ContextResult,
  batchResults: readonly BatchStepResult[],
): Promise<MergeReportResult> {
  const p = paramsToTranslateParams(params);
  const resource = tsvResource(p.resourceType);
  const book = p.book!;
  const batches = await readBatches(deps, params.jobId, batchCount, resource);
  const sourceRows = batches.flat();

  const targetRows: TsvRow[] = [];
  for (let i = 0; i < batchCount; i++) {
    const nn = batchNn(i);
    const outText = await getText(deps.blobs, batchKeys(deps.workspaceSlug, params.jobId, nn).output);
    if (outText == null) throw new TranslateStepError("artifact_missing", `work/batch-${nn}-out.tsv is missing from R2`);
    targetRows.push(...validateBatchOutput(outText, batches[i], { parse: resource.codec.parse, checkOpts: resource.checkOpts }).rows);
  }

  // Whole-range validation (translate-pipeline.js:468-472).
  const checks = runChecks(sourceRows, targetRows, resource.checkOpts);
  if (!checks.ok) {
    const summary = checks.errors.slice(0, 5).map((e) => `[${e.check}] ${e.rowId}: ${e.message}`).join("; ");
    throw new TranslateStepError("checks_failed", `whole-range deterministic checks failed: ${summary}`);
  }

  // Merge into the whole-book target file (:477-486).
  const targetRepoRef = `${p.targetOrg}/${p.repoName}@master`;
  const existingBookText = await fetchResourceFile(targetRepoRef, resource.file(book), { fetchImpl: deps.fetchImpl });
  let bookText: string;
  try {
    bookText = p.mergeMode === "by-id"
      ? updateRowsById(existingBookText, targetRows, { parse: resource.codec.parse, serialize: resource.codec.serialize })
      : mergeChapterIntoBook(existingBookText, targetRows, {
        startChapter: p.startChapter!, endChapter: p.endChapter!, parse: resource.codec.parse, serialize: resource.codec.serialize,
      });
  } catch (err) {
    throw new TranslateStepError("merge_failed", err instanceof Error ? err.message : String(err));
  }

  const llm = newLlmUsage(params.provider, params.model);
  const batchMeta: BatchMeta[] = [];
  for (let i = 0; i < batchCount; i++) {
    const r = batchResults[i];
    const c = context.perBatch[i] ?? { slugs: [], templateFallbacks: [] };
    batchMeta.push({ nn: batchNn(i), rowCount: r?.rowCount ?? batches[i].length, attempts: r?.attempts ?? 0, templateFallbacks: c.templateFallbacks, slugs: c.slugs });
    if (r && r.calls > 0) {
      // One synthetic call per batch carrying the step's summed usage.
      addLlmCall(llm, { usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens }, costUsd: r.costUsd, model: params.model });
      llm.calls += r.calls - 1;
    }
  }

  const report = buildTranslateReport({
    resourceType: p.resourceType,
    book, startChapter: p.startChapter, endChapter: p.endChapter,
    targetLang: p.targetLang, sourceLang: p.sourceLang,
    sourceRef: p.sourceRef, contextRef: p.contextRef, contextSha: context.contextSha,
    targetOrg: p.targetOrg, targetRepo: p.repoName,
    jobId: params.jobId,
    batches: batchMeta, checks, llm,
    selection: { mergeMode: p.mergeMode, verseStart: p.verseStart ?? null, verseEnd: p.verseEnd ?? null, rowIds: p.rowIds ?? null },
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    generatedBy: "bible-editor/translate",
  });

  const bookFile = resource.file(book);
  const reportFile = reportFileName(p.startChapter!, p.endChapter!);
  await putText(deps.blobs, outKey(deps.workspaceSlug, params.jobId, bookFile), bookText);
  await putText(deps.blobs, outKey(deps.workspaceSlug, params.jobId, reportFile), JSON.stringify(report, null, 2));

  const manifest = buildEditorManifest({ resourceType: p.resourceType, targetOrg: p.targetOrg, repoName: p.repoName, bookFile, reportFile });
  await writeWfStatus(deps.db, params.jobId, doneStatus(scopeOf(p, deps, p.endChapter!), manifest, deps.now?.() ?? new Date()));

  return { rowCount: targetRows.length, bookFile, reportFile, warningCount: checks.warnings.length, calls: llm.calls, costUsd: llm.estimatedCostUsd };
}

// ---------------------------------------------------------------------------
// Catch-all: record-failure
// ---------------------------------------------------------------------------

/**
 * Write the failed status. Best-effort by contract (like exportWorkflow's
 * record-fail): never throws, so the original error stays the one the
 * instance reports. The message is pattern-scrubbed again here; the literal
 * batch key was already removed at the batchStep boundary.
 */
export async function recordFailure(deps: StepDeps, params: TranslateWorkflowParams, err: unknown): Promise<StepFailure> {
  const failure = classifyStepError(err);
  try {
    const p = paramsToTranslateParams(params);
    await writeWfStatus(deps.db, params.jobId, failedStatus(scopeOf(p, deps, p.startChapter ?? 0), failure.errorKind, failure.message, deps.now?.() ?? new Date()));
  } catch (e) {
    console.error("translate record-failure: could not write wf_status_json", { jobId: params.jobId, error: e instanceof Error ? e.message : String(e) });
  }
  return failure;
}
