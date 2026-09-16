// Internal translate runner — Cloudflare Workflow (docs/translate-internal-runner.md §B).
//
// Runs the bp-assistant `translate` pipeline inside this Worker for orgs that
// bring their own provider key. One instance per pipeline_jobs row
// (`translate-${workspace}-${jobId}`); one durable step per batch so a
// provider hiccup retries that batch instead of restarting the run.
//
// Step list (retry policy in brackets):
//   1. guard-and-source   [3 × 5s exp]   cancel check → fetch source TSV → slice/select
//                                        → buildBatches → R2 work/batch-NN.tsv
//   2. context            [3 × 5s exp]   context pack + scripture → R2 batch-NN-pack.md/-task.json
//   3. batch-NN × N       [2 × 30s exp,   cancel check → R2 output-reuse → decrypt key (step-local)
//                          25 min timeout] → draft+repair (llm.runBatch) → R2 batch-NN-out.tsv
//   4. merge-report       [3 × 5s exp]   whole-range checks → merge into target book →
//                                        R2 out/<file> + out/translate-report → wf_status done
//   5. record-failure     (catch-all)    wf_status failed {errorKind, error}, scrubbed
//
// The bodies live in translate/workflowSteps.ts so they are unit-testable
// without a Workflows runtime; this file only maps them onto step.do and
// decides retryable vs NonRetryableError.
//
// D1 contract: this Workflow writes ONLY current_skill / current_status /
// updated_at / wf_status_json (status.writeWfStatus). State transitions and
// output_json stay owned by pipelines.ts pollPipelineJob.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "./index";
import { workspaceEnv, primeWorkspaces } from "./workspaces.ts";
import {
  batchStep,
  classifyStepError,
  contextStep,
  guardAndSourceStep,
  mergeReportStep,
  recordFailure,
  resolveWorkflowWorkspaceFresh,
  retryableStepError,
  type BatchStepResult,
  type StepDeps,
  type TranslateWorkflowParams,
} from "./translate/workflowSteps.ts";
import { batchNn } from "./translate/storage.ts";

export type { TranslateWorkflowParams } from "./translate/workflowSteps.ts";

// Infra steps (DCS fetches, R2 puts, D1 reads): same policy as ExportWorkflow.
const INFRA_RETRY = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } } as const;
// LLM steps (design §B step 3): two retries, 30s → 60s, and a 25-minute cap
// per attempt — llm.callProvider already bounds a single completion at 10 min
// and the draft+repair loop makes at most 2 completions (plus a low-effort
// truncation retry).
const BATCH_RETRY = { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" }, timeout: "25 minutes" } as const;

/**
 * Run a step body, converting deterministic failures into NonRetryableError so
 * the engine fails the instance instead of spending the retry budget (and, for
 * batch steps, more of the org's money) on a request that cannot succeed. The
 * `[kind] ` prefix survives the engine's rethrow into run() so record-failure
 * can still name the kind (workflowSteps.classifyStepError) — it is written on
 * BOTH paths, because a rate_limited failure that exhausts its retries needs
 * its kind recorded just as much as a deterministic one does.
 *
 * NO second constructor argument to NonRetryableError. Its runtime class is
 * `constructor(message, name = "NonRetryableError") { super(message); this.name = name; }`
 * and the Workflows engine decides fatality with
 * `err.name === "NonRetryableError" || err.message.startsWith("NonRetryableError")`.
 * Passing the kind as the name therefore made the engine treat every
 * deterministic failure as an ordinary error and RETRY it — re-billing the org
 * for a request that cannot succeed. The kind rides in the message instead.
 */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const c = classifyStepError(err);
    if (c.retryable) throw retryableStepError(c);
    throw new NonRetryableError(`[${c.errorKind}] ${c.message}`);
  }
}

export type TranslateWorkflowResult = {
  jobId: string;
  workspace: string;
  batchCount: number;
  rowCount: number;
  bookFile: string;
  reportFile: string;
  calls: number;
  costUsd: number | null;
};

export class TranslateWorkflow extends WorkflowEntrypoint<Env, TranslateWorkflowParams> {
  async run(event: WorkflowEvent<TranslateWorkflowParams>, step: WorkflowStep): Promise<TranslateWorkflowResult> {
    const params = event.payload;

    // deps is built BEFORE the workspace resolve so a refusal there can still
    // be recorded. It used to throw with no deps in scope, which left
    // wf_status_json NULL and the row sitting in 'running' until the
    // stale-dispatch sweep expired it. Until the re-point below, db/blobs are
    // the RAW (default) bindings: writeWfStatus is an UPDATE keyed by job_id, so
    // against the wrong tenant's D1 it simply changes no rows.
    const deps: StepDeps = {
      db: this.env.DB,
      blobs: this.env.BLOBS,
      workspaceSlug: "",
      wrappingKey: this.env.AI_KEY_WRAPPING_KEY,
      startedAt: new Date(event.timestamp).toISOString(),
    };

    // Workflows don't inherit the per-request env clone that index.ts's fetch
    // wrapper builds, so this.env is the RAW Worker env — this.env.DB would be
    // the default binding regardless of which org queued the run. Re-point it
    // once, here, exactly as ExportWorkflow does (STATE.md lesson). Unlike the
    // export, params.workspace is mandatory: a translate run reads an org's
    // provider key and writes that org's job row, so "fall back to the default
    // workspace" is a cross-tenant bug, not a convenience.
    await primeWorkspaces(this.env);
    let ws;
    try {
      ws = await resolveWorkflowWorkspaceFresh(this.env, params);
    } catch (err) {
      const c = classifyStepError(err);
      try {
        await recordFailure(deps, params, err);
      } catch {
        /* best-effort, exactly like the record-failure step below */
      }
      throw new NonRetryableError(`[${c.errorKind}] ${c.message}`);
    }
    (this as unknown as { env: Env }).env = workspaceEnv(this.env, ws);
    deps.db = this.env.DB;
    deps.blobs = this.env.BLOBS;
    deps.workspaceSlug = this.env.WORKSPACE_SLUG ?? ws.slug;

    try {
      const src = await step.do("guard-and-source", INFRA_RETRY, () => guarded(() => guardAndSourceStep(deps, params)));

      const ctx = await step.do("context", INFRA_RETRY, () => guarded(() => contextStep(deps, params, src.batchCount)));

      const results: BatchStepResult[] = [];
      for (let i = 0; i < src.batchCount; i++) {
        results.push(await step.do(`batch-${batchNn(i)}`, BATCH_RETRY, () => guarded(() => batchStep(deps, params, i, src.batchCount))));
      }

      const merged = await step.do("merge-report", INFRA_RETRY, () => guarded(() => mergeReportStep(deps, params, src, ctx, results)));

      return {
        jobId: params.jobId,
        workspace: ws.slug,
        batchCount: src.batchCount,
        rowCount: merged.rowCount,
        bookFile: merged.bookFile,
        reportFile: merged.reportFile,
        calls: merged.calls,
        costUsd: merged.costUsd,
      };
    } catch (err) {
      // Catch-all, like exportWorkflow's `${stepName}-record-fail`: best-effort,
      // never lets the recording error mask the real one, then rethrows so the
      // instance reports errored (pollPipelineJob reads wf_status_json, not the
      // instance status, so the rethrow is for operators, not the UI).
      try {
        await step.do("record-failure", async () => recordFailure(deps, params, err));
      } catch {
        /* best-effort */
      }
      throw err;
    }
  }
}
