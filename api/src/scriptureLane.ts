// Authoritative per-lane scripture state: generations, freezes, permissions.
// Generation / locks / write guards ALWAYS read D1 directly — never the
// 60s project-config isolate cache.

import type { Env } from "./index";
import type { ProjectConfig } from "./projectConfig.ts";
import { getProjectConfig, PRESETS } from "./projectConfig.ts";
import type { RepoRef } from "./repoUrl.ts";

export type LaneKey = "lit" | "sim";

export interface LaneExport {
  owner: string;
  repo: string;
  baseRef: string;
  branchPolicy: "contributor_book_branch";
}

export interface ScriptureLaneConfig {
  label: string;
  source: RepoRef;
  export: LaneExport | null;
  textReadOnly: boolean;
  alignmentWritable: boolean;
}

export interface LaneStateRow {
  lane: LaneKey;
  active_generation: number;
  next_generation: number;
  active_config_json: string;
  config_revision: number;
  replacement_job_id: string | null;
  /** Mutual-exclusion token: `lease:<id>` or `job:<id>`. NULL when free. */
  exclusive_owner: string | null;
  exports_blocked: number;
  replacement_required: number;
  pending_target_json: string | null;
  updated_at: number;
}

export function bibleVersionForLane(lane: LaneKey): "ULT" | "UST" {
  return lane === "lit" ? "ULT" : "UST";
}

export function laneForBibleVersion(bv: string): LaneKey | null {
  const u = bv.toUpperCase();
  if (u === "ULT") return "lit";
  if (u === "UST") return "sim";
  return null;
}

export function defaultLaneConfig(cfg: ProjectConfig, lane: LaneKey): ScriptureLaneConfig {
  const repo = lane === "lit" ? cfg.repos.lit : cfg.repos.sim;
  const label = lane === "lit" ? cfg.litLabel : cfg.simLabel;
  const source: RepoRef = { owner: cfg.org, repo, ref: "master" };
  const textReadOnly = Boolean((cfg as ProjectConfig & { laneTextReadOnly?: Partial<Record<LaneKey, boolean>> }).laneTextReadOnly?.[lane])
    || (cfg.preset === "ar-bsoj");
  // BSOJ AVD/NAV: text locked, alignment writable. Other presets fully editable.
  const alignmentWritable = true;
  const exportTarget: LaneExport | null = {
    owner: cfg.exportOrg || cfg.org,
    repo,
    baseRef: "master",
    branchPolicy: "contributor_book_branch",
  };
  // Locked text (e.g. AVD/NAV): force export destination == source so the
  // nightly path never commits to a divergent fork without a text-equality gate.
  const exportCfg: LaneExport | null = textReadOnly
    ? {
        owner: source.owner,
        repo: source.repo,
        baseRef: source.ref,
        branchPolicy: "contributor_book_branch",
      }
    : exportTarget;
  return {
    label,
    source,
    export: exportCfg,
    textReadOnly,
    alignmentWritable: textReadOnly ? true : alignmentWritable,
  };
}

/** Correct BSOJ preset lane configs (AVD/NAV). */
export function bsojLaneConfig(lane: LaneKey): ScriptureLaneConfig {
  if (lane === "lit") {
    return {
      label: "AVD",
      source: { owner: "BSOJ", repo: "ar_avd", ref: "master" },
      export: { owner: "BSOJ", repo: "ar_avd", baseRef: "master", branchPolicy: "contributor_book_branch" },
      textReadOnly: true,
      alignmentWritable: true,
    };
  }
  return {
    label: "NAV",
    source: { owner: "BSOJ", repo: "ar_nav", ref: "master" },
    export: { owner: "BSOJ", repo: "ar_nav", baseRef: "master", branchPolicy: "contributor_book_branch" },
    textReadOnly: true,
    alignmentWritable: true,
  };
}

export function parseLaneConfig(json: string): ScriptureLaneConfig {
  return JSON.parse(json) as ScriptureLaneConfig;
}

export function configHash(cfg: ScriptureLaneConfig): string {
  return JSON.stringify({
    label: cfg.label,
    source: cfg.source,
    export: cfg.export,
    textReadOnly: cfg.textReadOnly,
    alignmentWritable: cfg.alignmentWritable,
  });
}

export async function getLaneState(env: Env, lane: LaneKey): Promise<LaneStateRow | null> {
  try {
    return await env.DB
      .prepare(`SELECT * FROM scripture_lane_state WHERE lane = ?1`)
      .bind(lane)
      .first<LaneStateRow>();
  } catch {
    return null;
  }
}

/**
 * Ensure both lanes have rows. For ar-bsoj with existing ULT/UST verses,
 * sets replacement_required and stores mandatory AVD/NAV pending target;
 * active_config stays as provenance for quarantined gen-1 and reads are blocked.
 */
/** Canonical active config for a lane under the given project preset. */
export function desiredLaneConfig(cfg: ProjectConfig, lane: LaneKey): ScriptureLaneConfig {
  return cfg.preset === "ar-bsoj" ? bsojLaneConfig(lane) : defaultLaneConfig(cfg, lane);
}

export function sameLaneSource(a: ScriptureLaneConfig, b: ScriptureLaneConfig): boolean {
  return (
    a.source.owner === b.source.owner &&
    a.source.repo === b.source.repo &&
    (a.source.ref || "master") === (b.source.ref || "master")
  );
}

export type LaneReconcilePlan =
  | { action: "install"; config: ScriptureLaneConfig }
  | { action: "quarantine"; provenance: ScriptureLaneConfig; pending: ScriptureLaneConfig };

/**
 * Decide how an existing lane row should look after a project-preset change.
 * Content under a mismatched source identity must not silently keep serving
 * (or advertise) the previous org's repos — force replacement into `desired`.
 */
export function planLaneReconcile(
  current: ScriptureLaneConfig,
  desired: ScriptureLaneConfig,
  verseCount: number,
): LaneReconcilePlan {
  if (verseCount === 0 || sameLaneSource(current, desired)) {
    return { action: "install", config: desired };
  }
  return {
    action: "quarantine",
    provenance: {
      label: "LEGACY",
      source: current.source,
      export: null,
      textReadOnly: true,
      alignmentWritable: false,
    },
    pending: desired,
  };
}

export async function ensureLaneState(env: Env): Promise<void> {
  const cfg = await getProjectConfig(env);
  for (const lane of ["lit", "sim"] as LaneKey[]) {
    const existing = await getLaneState(env, lane);
    if (existing) continue;

    const bv = bibleVersionForLane(lane);
    let verseCount = 0;
    try {
      const row = await env.DB
        .prepare(
          `SELECT COUNT(*) AS n FROM verses
            WHERE bible_version = ?1 AND source_generation = 1`,
        )
        .bind(bv)
        .first<{ n: number }>();
      verseCount = row?.n ?? 0;
    } catch {
      // pre-migration / empty
    }

    let activeCfg: ScriptureLaneConfig;
    let replacementRequired = 0;
    let pendingTarget: string | null = null;
    let exportsBlocked = 0;

    if (cfg.preset === "ar-bsoj") {
      const correct = bsojLaneConfig(lane);
      if (verseCount > 0) {
        // Populated under wrong glt/gst: quarantine gen-1; do not activate AVD/NAV yet.
        activeCfg = {
          label: "LEGACY",
          source: { owner: "BSOJ", repo: lane === "lit" ? "ar_glt" : "ar_gst", ref: "master" },
          export: null,
          textReadOnly: true,
          alignmentWritable: false,
        };
        replacementRequired = 1;
        pendingTarget = JSON.stringify(correct);
        exportsBlocked = 1;
      } else {
        activeCfg = correct;
      }
    } else {
      activeCfg = defaultLaneConfig(cfg, lane);
    }

    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO scripture_lane_state (
           lane, active_generation, next_generation, active_config_json,
           config_revision, replacement_job_id, exports_blocked,
           replacement_required, pending_target_json, updated_at
         ) VALUES (?1, 1, 2, ?2, 1, NULL, ?3, ?4, ?5, unixepoch())`,
      )
      .bind(lane, JSON.stringify(activeCfg), exportsBlocked, replacementRequired, pendingTarget)
      .run();
  }
}

/**
 * Rewrite both lane rows to match `cfg` after an admin project-mode switch.
 * `ensureLaneState` only INSERT OR IGNOREs — without this, the first preset's
 * quarantine (e.g. BSOJ LEGACY glt/gst + AVD/NAV pending) sticks forever and
 * surfaces under every later preset.
 *
 * Throws `lane_busy:<lane>` when a replacement job or exclusive lease is held.
 */
export async function reconcileLaneStateForPreset(env: Env, cfg: ProjectConfig): Promise<void> {
  await ensureLaneState(env);
  for (const lane of ["lit", "sim"] as LaneKey[]) {
    const row = await getLaneState(env, lane);
    if (!row) throw new Error(`lane_state_missing:${lane}`);
    if (row.replacement_job_id || row.exclusive_owner) {
      throw new Error(`lane_busy:${lane}`);
    }

    const bv = bibleVersionForLane(lane);
    let verseCount = 0;
    try {
      const countRow = await env.DB
        .prepare(`SELECT COUNT(*) AS n FROM verses WHERE bible_version = ?1`)
        .bind(bv)
        .first<{ n: number }>();
      verseCount = countRow?.n ?? 0;
    } catch {
      verseCount = 0;
    }

    const current = parseLaneConfig(row.active_config_json);
    const desired = desiredLaneConfig(cfg, lane);
    const plan = planLaneReconcile(current, desired, verseCount);

    if (plan.action === "install") {
      await env.DB
        .prepare(
          `UPDATE scripture_lane_state SET
             active_config_json = ?2,
             config_revision = config_revision + 1,
             replacement_required = 0,
             pending_target_json = NULL,
             exports_blocked = 0,
             updated_at = unixepoch()
           WHERE lane = ?1
             AND replacement_job_id IS NULL
             AND exclusive_owner IS NULL`,
        )
        .bind(lane, JSON.stringify(plan.config))
        .run();
    } else {
      await env.DB
        .prepare(
          `UPDATE scripture_lane_state SET
             active_config_json = ?2,
             config_revision = config_revision + 1,
             replacement_required = 1,
             pending_target_json = ?3,
             exports_blocked = 1,
             updated_at = unixepoch()
           WHERE lane = ?1
             AND replacement_job_id IS NULL
             AND exclusive_owner IS NULL`,
        )
        .bind(lane, JSON.stringify(plan.provenance), JSON.stringify(plan.pending))
        .run();
    }

    const after = await getLaneState(env, lane);
    if (
      !after ||
      after.replacement_job_id ||
      after.exclusive_owner ||
      (plan.action === "install" && after.replacement_required) ||
      (plan.action === "quarantine" && !after.replacement_required)
    ) {
      // Lost the race to a lease/job, or UPDATE matched 0 rows.
      throw new Error(`lane_busy:${lane}`);
    }
  }
}

export async function requireLaneState(env: Env, lane: LaneKey): Promise<LaneStateRow> {
  await ensureLaneState(env);
  const row = await getLaneState(env, lane);
  if (!row) throw new Error(`lane_state_missing:${lane}`);
  return row;
}

/**
 * Clear a lane freeze whose replacement_job_id points at a missing
 * scripture_lane_replacement row (Worker died between CAS freeze and job
 * INSERT). Only reclaim after a grace window so a live startReplacement that
 * has frozen but not yet inserted its job row is not cleared mid-flight.
 * Returns true when an orphan was cleared.
 */
export const ORPHAN_RESERVATION_GRACE_SECONDS = 60;

export async function recoverOrphanedReservation(
  env: Env,
  lane: LaneKey,
): Promise<boolean> {
  const row = await getLaneState(env, lane);
  if (!row?.replacement_job_id) return false;
  const job = await env.DB.prepare(
    `SELECT 1 AS ok FROM scripture_lane_replacement WHERE job_id = ?1`,
  )
    .bind(row.replacement_job_id)
    .first();
  if (job) return false;
  // Grace: freeze bumps updated_at; do not reclaim during the legitimate
  // gap between CAS freeze and job INSERT.
  const age = Math.floor(Date.now() / 1000) - (row.updated_at ?? 0);
  if (age < ORPHAN_RESERVATION_GRACE_SECONDS) return false;
  await env.DB.prepare(
    `UPDATE scripture_lane_state
        SET replacement_job_id = NULL,
            exclusive_owner = NULL,
            exports_blocked = CASE WHEN replacement_required = 1 THEN 1 ELSE 0 END,
            updated_at = unixepoch()
      WHERE lane = ?1 AND replacement_job_id = ?2
        AND updated_at <= unixepoch() - ?3`,
  )
    .bind(lane, row.replacement_job_id, ORPHAN_RESERVATION_GRACE_SECONDS)
    .run();
  return true;
}

export function activeLaneConfig(row: LaneStateRow): ScriptureLaneConfig {
  return parseLaneConfig(row.active_config_json);
}

export type LaneWriteGate = {
  ok: true;
  generation: number;
  config: ScriptureLaneConfig;
  configRevision: number;
} | {
  ok: false;
  error: string;
  status: 403 | 409;
  detail?: Record<string, unknown>;
}

/** Uncached D1 write guard for verse / pipeline / import / export mutation. */
export async function assertLaneWritable(
  env: Env,
  lane: LaneKey,
  purpose: "verse_edit" | "alignment_edit" | "import" | "reimport" | "pipeline" | "export_lease" | "config_patch",
): Promise<LaneWriteGate> {
  // Heal an orphan freeze before treating the lane as frozen.
  await recoverOrphanedReservation(env, lane);

  const row = await requireLaneState(env, lane);
  const config = activeLaneConfig(row);

  if (row.replacement_required && purpose !== "config_patch") {
    // Only the replacement workflow may proceed; block normal mutations/reads side-channels.
    if (purpose !== "import") {
      return {
        ok: false,
        error: "lane_replacement_required",
        status: 409,
        detail: { lane, pendingTarget: row.pending_target_json },
      };
    }
  }

  if (row.replacement_job_id) {
    return {
      ok: false,
      error: "lane_replacement_in_progress",
      status: 409,
      detail: { lane, jobId: row.replacement_job_id },
    };
  }

  if (row.exports_blocked && purpose === "export_lease") {
    return { ok: false, error: "exports_blocked", status: 409, detail: { lane } };
  }

  // Interactive text edits AND AI pipeline writes that change verse content both
  // honor textReadOnly. Pipelines that would rewrite AVD/NAV body text must not
  // bypass the lock matrix (alignment-only lanes stay alignmentWritable-gated).
  if ((purpose === "verse_edit" || purpose === "pipeline") && config.textReadOnly) {
    return { ok: false, error: "scripture_text_read_only", status: 403, detail: { lane, repo: repoRefKey(config) } };
  }
  if (purpose === "alignment_edit" && !config.alignmentWritable) {
    return { ok: false, error: "scripture_alignment_read_only", status: 403, detail: { lane } };
  }
  if ((purpose === "verse_edit" || purpose === "alignment_edit") && config.textReadOnly && !config.alignmentWritable) {
    return { ok: false, error: "scripture_fully_locked", status: 403, detail: { lane } };
  }

  return {
    ok: true,
    generation: row.active_generation,
    config,
    configRevision: row.config_revision,
  };
}

function repoRefKey(cfg: ScriptureLaneConfig): string {
  return `${cfg.source.owner}/${cfg.source.repo}`;
}

/** Permission matrix check for a PATCH intent. */
export function allowVersePatch(
  config: ScriptureLaneConfig,
  intent: "text_edit" | "find_replace" | "section_edit" | "alignment_edit",
): { ok: true } | { ok: false; error: string } {
  const { textReadOnly, alignmentWritable } = config;
  if (!textReadOnly && alignmentWritable) return { ok: true };
  if (textReadOnly && alignmentWritable) {
    if (intent === "alignment_edit") return { ok: true };
    return { ok: false, error: "scripture_text_read_only" };
  }
  if (!textReadOnly && !alignmentWritable) {
    if (intent === "alignment_edit") return { ok: false, error: "scripture_alignment_read_only" };
    return { ok: true };
  }
  // text locked + alignment locked
  return { ok: false, error: "scripture_fully_locked" };
}

/**
 * SQL fragment helper: verses for active generation of a lane bible_version.
 * Caller must bind bible_version and generation.
 */
export function activeVersesWhere(alias = "v"): string {
  return `${alias}.source_generation = ?`;
}

export async function activeGenerationForBibleVersion(
  env: Env,
  bibleVersion: string,
): Promise<number | null> {
  const lane = laneForBibleVersion(bibleVersion);
  if (!lane) return null; // UHB/UGNT — no lane generation (use 1 sentinel for OL)
  const row = await requireLaneState(env, lane);
  if (row.replacement_required) return null; // blocked reads
  return row.active_generation;
}

/** For OL (UHB/UGNT) we store generation 1 always. */
export function origSourceGeneration(): number {
  return 1;
}

export async function allocateGeneration(env: Env, lane: LaneKey): Promise<number> {
  // next_generation = next FREE. Increment and return the previous value in a
  // single atomic statement — a separate UPDATE + SELECT can race two callers
  // onto the same generation. D1/SQLite (>=3.35) supports UPDATE … RETURNING.
  const row = await env.DB
    .prepare(
      `UPDATE scripture_lane_state
          SET next_generation = next_generation + 1, updated_at = unixepoch()
        WHERE lane = ?1
        RETURNING next_generation`,
    )
    .bind(lane)
    .first<{ next_generation: number }>();
  if (!row) throw new Error(`lane_state_missing:${lane}`);
  return row.next_generation - 1;
}

export async function snapshotRequiredBooks(
  env: Env,
  bibleVersion: string,
  generation: number,
): Promise<{ books: string[] }> {
  // Required books = whatever has verse content in the generation being replaced.
  // `verses` is the sole authoritative signal for "what's active in this lane" —
  // book_usfm_meta is enrichment written alongside verses during staging, not an
  // independent membership signal. Consulting it here previously either hard-blocked
  // the replacement on a mismatch (deadlocking the workflow meant to fix inconsistent
  // content) or, if merely unioned in, would force staging/waiving of books that were
  // never really part of the lane (a stray meta row with no matching verses). Books
  // the new source can't supply still surface later as retryable/waivable per-book
  // staging errors — this only decides what to *ask* the new source for.
  const verses = await env.DB
    .prepare(
      `SELECT DISTINCT book FROM verses
        WHERE bible_version = ?1 AND source_generation = ?2
        ORDER BY book`,
    )
    .bind(bibleVersion, generation)
    .all<{ book: string }>();
  return { books: verses.results.map((r) => r.book) };
}

/**
 * Stale staging reclaim window (seconds): a Worker that died mid-stage/copy
 * loses its per-book claim after this, so a fresh claim may take over. Single
 * source of truth — the replacement FSM's stageBook imports this too.
 */
export const STAGING_CLAIM_STALE_SECONDS = 600;

/**
 * Verses copied per statement in copyBookForward. Each chunk is one server-side
 * INSERT ... SELECT subrequest (rows never pass through the Worker), so a large
 * book (e.g. Psalms, ~2.5k verses) still costs only a handful of subrequests —
 * well under Cloudflare's ~1000-subrequest cap.
 */
const CARRY_FORWARD_CHUNK = 500;

/** book_resource_syncs `resource` key for a lane's scripture text. */
function laneScriptureResource(lane: LaneKey): "ult" | "ust" {
  return lane === "lit" ? "ult" : "ust";
}

interface CarryForwardJobRow {
  lane: LaneKey;
  generation: number;
  predecessor_generation: number;
  status: string;
}

/**
 * Carry a book's predecessor-generation scripture content FORWARD into a
 * replacement job's fresh generation, so activating a SUBSET replacement does
 * not leave un-selected books empty (issue #94; the JOL/MAL trap — a fresh
 * generation starts empty, stageBook writes only staged books, so any book
 * neither staged nor carried is silently deleted on the pointer flip).
 *
 * This is the copy counterpart to stageBook and reuses the SAME discipline:
 * a unique `staging_claim_token` per claim, `stillOurs()` re-checks between
 * destructive writes, and token-gated deletes — but the source is the
 * predecessor generation already in D1, not a DCS fetch. All copies are
 * server-side INSERT ... SELECT (verse bodies never pass through the Worker),
 * chunked to stay under the subrequest cap.
 *
 * - Idempotent: a completed carry-forward re-run is a no-op (the book row is no
 *   longer claimable); a reset-and-rerun re-deletes this job's partial
 *   destination rows and re-copies to an identical, complete result. Each chunk
 *   also skips verses already present at the destination (NOT EXISTS), so a
 *   crash mid-copy is resumed rather than double-inserted.
 * - FAILS CLOSED (like stageBook's `incomplete_usfm` shrink-guard): if the
 *   destination ends up with fewer verses than the predecessor had, the book is
 *   left in `retryable_error` — never `carried_forward` — so a partial copy can
 *   never be activated.
 *
 * PR-1 (issue #94): DORMANT. Nothing calls this yet; startReplacement / routes
 * / UI wiring is PR-2. Requires migration 0059 (`mode` column, `carried_forward`
 * status).
 */
export async function copyBookForward(
  env: Env,
  jobId: string,
  book: string,
): Promise<{ status: string }> {
  const job = await env.DB
    .prepare(
      `SELECT lane, generation, predecessor_generation, status
         FROM scripture_lane_replacement WHERE job_id = ?1`,
    )
    .bind(jobId)
    .first<CarryForwardJobRow>();
  if (!job) throw Object.assign(new Error("job_not_found"), { status: 404 });
  if (job.status !== "reserved" && job.status !== "staging") {
    throw Object.assign(new Error("job_not_stageable"), {
      status: 409,
      detail: { status: job.status },
    });
  }

  const lane = job.lane as LaneKey;
  const bv = bibleVersionForLane(lane);
  const destGen = job.generation;
  const predGen = job.predecessor_generation;
  const scriptureResource = laneScriptureResource(lane);

  // Claim the book row with a unique token (same CAS UPDATE … RETURNING as
  // stageBook). Reclaim a stale `staging` row after STAGING_CLAIM_STALE_SECONDS.
  // Stamp mode='carry_forward' so the row records HOW this book reached the new
  // generation.
  const claimToken = crypto.randomUUID();
  const claimed = await env.DB
    .prepare(
      `UPDATE scripture_lane_replacement_books
          SET status = 'staging', mode = 'carry_forward',
              updated_at = unixepoch(), error_json = NULL,
              staging_claim_token = ?4
        WHERE job_id = ?1 AND book = ?2
          AND (
            status IN ('pending', 'retryable_error', 'failed')
            OR (status = 'staging' AND updated_at < unixepoch() - ?3)
          )
        RETURNING book`,
    )
    .bind(jobId, book, STAGING_CLAIM_STALE_SECONDS, claimToken)
    .first<{ book: string }>();
  if (!claimed) {
    const cur = await env.DB
      .prepare(
        `SELECT status FROM scripture_lane_replacement_books WHERE job_id = ?1 AND book = ?2`,
      )
      .bind(jobId, book)
      .first<{ status: string }>();
    return { status: cur?.status ?? "skipped" };
  }

  const stillOurs = async (): Promise<boolean> => {
    const row = await env.DB
      .prepare(
        `SELECT 1 FROM scripture_lane_replacement_books
          WHERE job_id = ?1 AND book = ?2 AND staging_claim_token = ?3`,
      )
      .bind(jobId, book, claimToken)
      .first();
    return !!row;
  };

  // Transition the job to staging on the first book (mirror stageBook).
  if (job.status === "reserved") {
    await env.DB
      .prepare(
        `UPDATE scripture_lane_replacement SET status = 'staging'
          WHERE job_id = ?1 AND status = 'reserved'`,
      )
      .bind(jobId)
      .run();
  }

  if (!(await stillOurs())) return { status: "lost_claim" };

  // Token-gated pre-delete of any partial copy this job already wrote for the
  // book × DESTINATION generation. verses/book_usfm_meta are attributable via
  // created_by_job_id; book_resource_syncs has no such column, but the whole
  // destination generation belongs to this job so scoping by (book, resource,
  // source_generation = destGen) is safe. Predecessor rows are NEVER touched.
  await env.DB.batch([
    env.DB
      .prepare(
        `DELETE FROM verses
          WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3
            AND created_by_job_id = ?4
            AND EXISTS (
              SELECT 1 FROM scripture_lane_replacement_books
               WHERE job_id = ?4 AND book = ?1 AND staging_claim_token = ?5
            )`,
      )
      .bind(book, bv, destGen, jobId, claimToken),
    env.DB
      .prepare(
        `DELETE FROM book_usfm_meta
          WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3
            AND created_by_job_id = ?4
            AND EXISTS (
              SELECT 1 FROM scripture_lane_replacement_books
               WHERE job_id = ?4 AND book = ?1 AND staging_claim_token = ?5
            )`,
      )
      .bind(book, bv, destGen, jobId, claimToken),
    env.DB
      .prepare(
        `DELETE FROM book_resource_syncs
          WHERE book = ?1 AND resource = ?2 AND source_generation = ?3
            AND EXISTS (
              SELECT 1 FROM scripture_lane_replacement_books
               WHERE job_id = ?4 AND book = ?1 AND staging_claim_token = ?5
            )`,
      )
      .bind(book, scriptureResource, destGen, jobId, claimToken),
  ]);

  // Predecessor size — the completeness bar the copy must clear.
  const predCount = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM verses
        WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3`,
    )
    .bind(book, bv, predGen)
    .first<{ n: number }>();
  const predecessorVerses = predCount?.n ?? 0;

  // Chunked, server-side INSERT ... SELECT. NOT EXISTS makes each chunk skip
  // rows already copied (idempotent, crash-resume-safe); LIMIT bounds each
  // statement and the loop runs ceil(verses / CHUNK) times.
  // Copy version / updated_by / updated_at FORWARD, not just content. A carried
  // book may contain translator-edited verses (updated_by set, version > 1);
  // dropping updated_by would land them with updated_by NULL, and reimport's
  // `updated_by IS NULL` overwrite-guard would then treat those edits as pristine
  // and clobber the very content carry-forward exists to protect. (This is why
  // copyBookForward does NOT mirror stageBook's column list — staged rows are
  // fresh upstream, carried rows carry edit provenance.)
  const copyStmt = env.DB.prepare(
    `INSERT INTO verses (
       book, chapter, verse, verse_end, bible_version, source_generation,
       content_json, plain_text, version, updated_by, updated_at, created_by_job_id
     )
     SELECT src.book, src.chapter, src.verse, src.verse_end, src.bible_version, ?4,
            src.content_json, src.plain_text, src.version, src.updated_by, src.updated_at, ?5
       FROM verses src
      WHERE src.book = ?1 AND src.bible_version = ?2 AND src.source_generation = ?3
        AND NOT EXISTS (
          SELECT 1 FROM verses d
           WHERE d.book = src.book AND d.chapter = src.chapter AND d.verse = src.verse
             AND d.bible_version = src.bible_version AND d.source_generation = ?4
        )
        AND EXISTS (
          SELECT 1 FROM scripture_lane_replacement_books
           WHERE job_id = ?5 AND book = ?1 AND staging_claim_token = ?6
        )
      ORDER BY src.chapter, src.verse
      LIMIT ?7`,
  );
  for (;;) {
    if (!(await stillOurs())) return { status: "lost_claim" };
    const r = await copyStmt
      .bind(book, bv, predGen, destGen, jobId, claimToken, CARRY_FORWARD_CHUNK)
      .run();
    if ((r.meta?.changes ?? 0) === 0) break;
  }

  // Carry the book header + scripture watermark forward too (single statements,
  // token-gated). Without the book_resource_syncs watermark the export
  // freshness gate would treat the copied book as un-synced under the new
  // generation and could refetch/revert it.
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT OR REPLACE INTO book_usfm_meta (
           book, bible_version, source_generation, headers_json, created_by_job_id
         )
         SELECT book, bible_version, ?4, headers_json, ?5
           FROM book_usfm_meta
          WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3
            AND EXISTS (
              SELECT 1 FROM scripture_lane_replacement_books
               WHERE job_id = ?5 AND book = ?1 AND staging_claim_token = ?6
            )`,
      )
      .bind(book, bv, predGen, destGen, jobId, claimToken),
    env.DB
      .prepare(
        `INSERT OR REPLACE INTO book_resource_syncs (
           book, resource, source_generation, source_owner, source_repo, source_ref,
           source_sha, synced_at, origin
         )
         SELECT book, resource, ?4, source_owner, source_repo, source_ref,
                source_sha, unixepoch(), origin
           FROM book_resource_syncs
          WHERE book = ?1 AND resource = ?2 AND source_generation = ?3
            AND EXISTS (
              SELECT 1 FROM scripture_lane_replacement_books
               WHERE job_id = ?5 AND book = ?1 AND staging_claim_token = ?6
            )`,
      )
      .bind(book, scriptureResource, predGen, destGen, jobId, claimToken),
  ]);

  // Fail closed: a destination shorter than the predecessor must never activate.
  const destCount = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM verses
        WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3
          AND created_by_job_id = ?4`,
    )
    .bind(book, bv, destGen, jobId)
    .first<{ n: number }>();
  const copied = destCount?.n ?? 0;

  if (copied < predecessorVerses) {
    await env.DB
      .prepare(
        `UPDATE scripture_lane_replacement_books
            SET status = 'retryable_error',
                error_json = ?1,
                updated_at = unixepoch()
          WHERE job_id = ?2 AND book = ?3 AND staging_claim_token = ?4`,
      )
      .bind(
        JSON.stringify({
          error: "incomplete_carry_forward",
          copied,
          predecessor: predecessorVerses,
          predecessorGeneration: predGen,
          generation: destGen,
        }),
        jobId,
        book,
        claimToken,
      )
      .run();
    return { status: "retryable_error" };
  }

  const ok = await env.DB
    .prepare(
      `UPDATE scripture_lane_replacement_books
          SET status = 'carried_forward',
              mode = 'carry_forward',
              completeness_json = ?1,
              error_json = NULL,
              updated_at = unixepoch()
        WHERE job_id = ?2 AND book = ?3 AND staging_claim_token = ?4`,
    )
    .bind(
      JSON.stringify({
        verses: copied,
        predecessorVerses,
        carriedForward: true,
        predecessorGeneration: predGen,
      }),
      jobId,
      book,
      claimToken,
    )
    .run();
  if ((ok.meta?.changes ?? 0) !== 1) return { status: "lost_claim" };

  return { status: "carried_forward" };
}

export interface ReplacementBookPlan {
  /** Books to stage from the NEW source (book row `mode='staged'`). */
  staged: string[];
  /** Books to copy forward from the predecessor generation (`mode='carry_forward'`). */
  carryForward: string[];
}

/**
 * Decide, for a replacement job, which of the current generation's books are
 * re-staged from the new source and which are carried forward unchanged
 * (issue #94, selective replacement).
 *
 * `requiredBooks` is the full set of books with active verses
 * (`snapshotRequiredBooks`). Every one MUST land in exactly one bucket — a book
 * left in neither is emptied on the generation flip (the JOL/MAL data-loss trap
 * that carry-forward exists to prevent).
 *
 * `replaceBooks` is the optional caller selection = the books to stage from the
 * new source:
 *  - `undefined` → replace ALL (`staged = requiredBooks`, none carried). This is
 *    byte-for-byte the pre-#94 whole-lane replacement, so any caller that does
 *    not pass a selection is completely unchanged.
 *  - provided → MUST be a subset of `requiredBooks`. An unknown book throws
 *    (`unknown_books`, 400) rather than being silently dropped, so a UI can never
 *    believe it replaced a book that was actually ignored. The complement of the
 *    selection is carried forward.
 *
 * Both buckets preserve `requiredBooks` order for deterministic book-row
 * insertion and status display.
 */
export function planReplacementBooks(
  requiredBooks: string[],
  replaceBooks?: string[],
): ReplacementBookPlan {
  if (replaceBooks === undefined) {
    return { staged: [...requiredBooks], carryForward: [] };
  }
  const required = new Set(requiredBooks);
  const unknown = replaceBooks.filter((b) => !required.has(b));
  if (unknown.length > 0) {
    throw Object.assign(new Error("unknown_books"), {
      status: 400,
      detail: { unknown, required: requiredBooks },
    });
  }
  const replace = new Set(replaceBooks);
  return {
    staged: requiredBooks.filter((b) => replace.has(b)),
    carryForward: requiredBooks.filter((b) => !replace.has(b)),
  };
}

/** DTO fields published with every lane-aware response. */
export function lanePublicState(row: LaneStateRow): Record<string, unknown> {
  return {
    lane: row.lane,
    activeGeneration: row.active_generation,
    configRevision: row.config_revision,
    replacementJobId: row.replacement_job_id,
    exportsBlocked: !!row.exports_blocked,
    replacementRequired: !!row.replacement_required,
    config: parseLaneConfig(row.active_config_json),
    pendingTarget: row.pending_target_json ? JSON.parse(row.pending_target_json) : null,
  };
}

/**
 * Older Workers never rewrote lane rows on preset switch, so a BSOJ quarantine
 * can stick under English presets. Heal when pending/active identity disagrees
 * with the current preset and no job/lease is held.
 */
export async function maybeHealLaneStateForPreset(env: Env, cfg: ProjectConfig): Promise<void> {
  await ensureLaneState(env);
  for (const lane of ["lit", "sim"] as LaneKey[]) {
    const row = await getLaneState(env, lane);
    if (!row || row.replacement_job_id || row.exclusive_owner) return;
    const desired = desiredLaneConfig(cfg, lane);
    const reference = row.replacement_required && row.pending_target_json
      ? (JSON.parse(row.pending_target_json) as ScriptureLaneConfig)
      : parseLaneConfig(row.active_config_json);
    if (!sameLaneSource(reference, desired)) {
      await reconcileLaneStateForPreset(env, cfg);
      return;
    }
  }
}

/** Materialize labels into ProjectConfig from active lane state (presentation). */
export async function overlayLaneLabels(env: Env, cfg: ProjectConfig): Promise<ProjectConfig> {
  await ensureLaneState(env);
  try {
    await maybeHealLaneStateForPreset(env, cfg);
  } catch {
    // Busy lanes: leave sticky state; admin must finish the job first.
  }
  const lit = await getLaneState(env, "lit");
  const sim = await getLaneState(env, "sim");
  if (!lit || !sim) return cfg;
  // Per-lane: while a lane is under BSOJ transitional freeze, do NOT publish
  // AVD/NAV as its presentation label (that would brand quarantined gen-1).
  // An already-activated sibling lane keeps its real label.
  const litCfg = parseLaneConfig(lit.active_config_json);
  const simCfg = parseLaneConfig(sim.active_config_json);
  // Per-lane populated flag (same count the config-apply 409 uses): the Setup
  // wizard locks a lane's source when it's populated so it can never propose a
  // source change (which would 409 lane_source_change_requires_migration).
  const [litVerses, simVerses] = await Promise.all([
    countLaneVerses(env, "lit"),
    countLaneVerses(env, "sim"),
  ]);
  return {
    ...cfg,
    litLabel: lit.replacement_required ? "…" : litCfg.label,
    simLabel: sim.replacement_required ? "…" : simCfg.label,
    repos: {
      ...cfg.repos,
      lit: litCfg.source.repo,
      sim: simCfg.source.repo,
    },
    org: litCfg.source.owner || cfg.org,
    laneState: {
      lit: { ...lanePublicState(lit), populated: litVerses > 0 },
      sim: { ...lanePublicState(sim), populated: simVerses > 0 },
    },
  } as ProjectConfig;
}

// Count verses for a lane's bible_version (ALL generations) — the same predicate
// applyProjectConfig uses to decide verseCount>0, so `populated` here agrees
// with whether a source change would be rejected.
async function countLaneVerses(env: Env, lane: LaneKey): Promise<number> {
  try {
    const row = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM verses WHERE bible_version = ?1`)
      .bind(bibleVersionForLane(lane))
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

// Re-export PRESETS touch for tests that seed BSOJ
void PRESETS;
