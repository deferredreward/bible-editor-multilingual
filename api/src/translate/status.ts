// pipeline_jobs.wf_status_json — the internal runner's status channel
// (docs/translate-internal-runner.md §B, §C; migration 0073).
//
// The Fly bot reports progress through GET /api/pipeline/:id, a StatusResponse
// that pollPipelineJob (pipelines.ts) parses. The in-Worker TranslateWorkflow
// has no HTTP surface, so it writes the same shape into one D1 column and step 5
// (readInternalStatus) synthesizes the StatusResponse from the row. Keeping the
// bot's field names means lines :795-1060 of pollPipelineJob stay untouched.
//
// Ownership contract (design §B): the Workflow writes ONLY current_skill,
// current_status, updated_at and wf_status_json. It must never write `state`
// (pollAllNonTerminal polls state='running'; transitions belong to
// pollPipelineJob) or `output_json` (`output_json IS NULL` is the
// not-yet-imported flag). writeWfStatus is the single writer and its UPDATE
// names exactly those four columns.

export type WfState = "running" | "done" | "failed";

/** Same keys as the bot's serializeCheckpoint `current` (api/pipeline.js). */
export type WfCurrent = {
  chapter: number;
  skill: string;
  status: string;
  startedAt?: string;
  errorKind?: string;
  error?: string;
};

/** One editor-delivery manifest entry (translate-pipeline.js:831-840). */
export type WfOutputEntry = {
  delivery: "editor";
  type: string;
  repo?: string;
  path?: string;
  file: string;
};

export type WfStatus = {
  version: 1;
  runner: "internal";
  state: WfState;
  current: WfCurrent;
  updatedAt: string;
  output?: WfOutputEntry[];
};

// The bot truncates progress lines to 120 chars before they reach a checkpoint.
const MAX_STATUS_CHARS = 120;
// error_message-sized: the UI shows it in a chip; the full message is in the log.
const MAX_ERROR_CHARS = 1000;

function clip(s: unknown, max: number): string {
  return String(s ?? "").slice(0, max);
}

export type StatusScope = { chapter: number; skill: string; startedAt: string };

export function runningStatus(scope: StatusScope, status: string, now: Date = new Date()): WfStatus {
  return {
    version: 1,
    runner: "internal",
    state: "running",
    current: { chapter: scope.chapter, skill: scope.skill, status: clip(status, MAX_STATUS_CHARS), startedAt: scope.startedAt },
    updatedAt: now.toISOString(),
  };
}

export function doneStatus(scope: StatusScope, output: WfOutputEntry[], now: Date = new Date()): WfStatus {
  return {
    version: 1,
    runner: "internal",
    state: "done",
    current: { chapter: scope.chapter, skill: scope.skill, status: "done", startedAt: scope.startedAt },
    updatedAt: now.toISOString(),
    output,
  };
}

/** `error` must already be scrubbed by the caller (llm.scrubSecrets with the batch key). */
export function failedStatus(scope: StatusScope, errorKind: string, error: string, now: Date = new Date()): WfStatus {
  return {
    version: 1,
    runner: "internal",
    state: "failed",
    current: {
      chapter: scope.chapter,
      skill: scope.skill,
      status: "failed",
      startedAt: scope.startedAt,
      errorKind: clip(errorKind, MAX_STATUS_CHARS),
      error: clip(error, MAX_ERROR_CHARS),
    },
    updatedAt: now.toISOString(),
  };
}

/**
 * The two-entry editor-delivery manifest the bot records on its done checkpoint
 * (translate-pipeline.js:831-840): the merged resource file and the report.
 * `file` is the retrieval key — for the internal runner, the path under out/.
 */
export function buildEditorManifest({ resourceType, targetOrg, repoName, bookFile, reportFile }: {
  resourceType: string;
  targetOrg: string;
  repoName: string;
  bookFile: string;
  reportFile: string;
}): WfOutputEntry[] {
  return [
    { delivery: "editor", type: resourceType, repo: `${targetOrg}/${repoName}`, path: bookFile, file: bookFile },
    { delivery: "editor", type: "report", file: reportFile },
  ];
}

/** The slice of D1Database the writer needs; tests pass a node:sqlite adapter. */
export interface StatusDb {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<{ meta: { changes: number } }> } };
}

/**
 * THE single writer. Exactly four columns, by design — see the header. Returns
 * false when the row is gone (a cancelled-and-purged job), which callers treat
 * as "stop", not as an error.
 */
export async function writeWfStatus(db: StatusDb, jobId: string, status: WfStatus): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE pipeline_jobs
          SET current_skill = ?2, current_status = ?3, updated_at = unixepoch(), wf_status_json = ?4
        WHERE job_id = ?1`,
    )
    .bind(jobId, status.current.skill, status.current.status, JSON.stringify(status))
    .run();
  return res.meta.changes > 0;
}

/** Tolerant reader: null for NULL / malformed / not-ours (so a poller falls back cleanly). */
export function parseWfStatus(json: string | null | undefined): WfStatus | null {
  if (!json) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.runner !== "internal" || (o.state !== "running" && o.state !== "done" && o.state !== "failed")) return null;
  if (!o.current || typeof o.current !== "object") return null;
  return o as unknown as WfStatus;
}
