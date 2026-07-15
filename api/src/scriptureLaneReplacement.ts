// Scripture lane replacement FSM — stages new-generation verses into D1
// without touching active rows, then atomically flips the generation pointer.
//
// Lifecycle: reserved → staging → ready → completed  (happy path)
//            reserved → staging → failed              (unrecoverable)
//            reserved → cancelled                     (user abort)
//
// Export fencing: while a replacement job is active the lane's exports_blocked
// flag is raised. Export leases use a renewable fencing token so a split-brain
// Worker can't complete a stale export after a replacement activated.

import type { Env } from "./index";
import type { LaneKey, ScriptureLaneConfig } from "./scriptureLane";
import {
  allocateGeneration,
  bibleVersionForLane,
  configHash,
  getLaneState,
  parseLaneConfig,
  requireLaneState,
  snapshotRequiredBooks,
} from "./scriptureLane";
import { dcsRawUrl, fetchText, BOOK_NUMBERS, fileCommitSha } from "./dcsSources";
import { extractVersesForRange, extractUsfmHeaders } from "./importParsers";

// ── Constants ────────────────────────────────────────────────────────────────

export const EXPORT_LEASE_TTL_MS = 120_000;
export const EXPORT_ABANDON_GRACE_MS = 600_000;

const CHUNK = 80;

// ── Job types ────────────────────────────────────────────────────────────────

export type ReplacementStatus =
  | "reserved"
  | "staging"
  | "ready"
  | "completed"
  | "failed"
  | "cancelled";

export interface ReplacementJob {
  job_id: string;
  lane: LaneKey;
  generation: number;
  predecessor_generation: number;
  predecessor_config_hash: string;
  pending_config_json: string;
  required_books_json: string;
  status: ReplacementStatus;
  lease_owner: string | null;
  lease_fencing_token: string | null;
  lease_heartbeat_at: number | null;
  error_json: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface ReplacementBookRow {
  job_id: string;
  book: string;
  status: string;
  source_owner: string | null;
  source_repo: string | null;
  source_ref: string | null;
  source_sha: string | null;
  completeness_json: string | null;
  error_json: string | null;
  updated_at: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function jobId(): string {
  return crypto.randomUUID();
}

async function getJob(env: Env, id: string): Promise<ReplacementJob | null> {
  return env.DB
    .prepare(`SELECT * FROM scripture_lane_replacement WHERE job_id = ?1`)
    .bind(id)
    .first<ReplacementJob>();
}

async function getJobBooks(env: Env, id: string): Promise<ReplacementBookRow[]> {
  const rs = await env.DB
    .prepare(`SELECT * FROM scripture_lane_replacement_books WHERE job_id = ?1 ORDER BY book`)
    .bind(id)
    .all<ReplacementBookRow>();
  return rs.results;
}

// ── 1. startReplacement ──────────────────────────────────────────────────────

export async function startReplacement(
  env: Env,
  lane: LaneKey,
  pendingConfig: ScriptureLaneConfig,
  confirm: boolean,
): Promise<{ job: ReplacementJob; books: ReplacementBookRow[] }> {
  const row = await requireLaneState(env, lane);

  // CAS: no open job
  if (row.replacement_job_id) {
    throw Object.assign(new Error("replacement_already_active"), {
      status: 409,
      detail: { lane, jobId: row.replacement_job_id },
    });
  }
  if (!confirm) {
    throw Object.assign(new Error("confirmation_required"), { status: 400 });
  }

  const generation = await allocateGeneration(env, lane);
  const bv = bibleVersionForLane(lane);
  const snap = await snapshotRequiredBooks(env, bv, row.active_generation);
  if ("error" in snap) {
    throw Object.assign(new Error(snap.error), { status: 422 });
  }

  const id = jobId();
  const predecessorHash = configHash(parseLaneConfig(row.active_config_json));

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO scripture_lane_replacement (
         job_id, lane, generation, predecessor_generation,
         predecessor_config_hash, pending_config_json,
         required_books_json, status, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'reserved', unixepoch())`,
    ).bind(
      id, lane, generation, row.active_generation,
      predecessorHash, JSON.stringify(pendingConfig),
      JSON.stringify(snap.books),
    ),
    // Freeze lane: set replacement_job_id, block exports.
    // Do NOT clear replacement_required yet — only activation clears it.
    env.DB.prepare(
      `UPDATE scripture_lane_state
          SET replacement_job_id = ?1, exports_blocked = 1, updated_at = unixepoch()
        WHERE lane = ?2`,
    ).bind(id, lane),
  ];

  // Insert per-book rows
  for (const book of snap.books) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO scripture_lane_replacement_books (job_id, book, status, updated_at)
         VALUES (?1, ?2, 'pending', unixepoch())`,
      ).bind(id, book),
    );
  }

  await env.DB.batch(stmts);

  const job = await getJob(env, id);
  if (!job) throw new Error("job_insert_failed");
  const books = await getJobBooks(env, id);
  return { job, books };
}

// ── 2. stageBook ─────────────────────────────────────────────────────────────

export async function stageBook(
  env: Env,
  jobId: string,
  book: string,
): Promise<{ status: string }> {
  const job = await getJob(env, jobId);
  if (!job) throw Object.assign(new Error("job_not_found"), { status: 404 });
  if (job.status !== "reserved" && job.status !== "staging") {
    throw Object.assign(new Error("job_not_stageable"), { status: 409, detail: { status: job.status } });
  }

  const pendingCfg: ScriptureLaneConfig = JSON.parse(job.pending_config_json);
  const { owner, repo, ref } = pendingCfg.source;
  const num = BOOK_NUMBERS[book];
  if (!num) {
    throw Object.assign(new Error("unknown_book"), { status: 400 });
  }

  const usfmPath = `${num}-${book}.usfm`;
  const url = dcsRawUrl(env, owner, repo, usfmPath);

  // Transition to staging on first book
  if (job.status === "reserved") {
    await env.DB.prepare(
      `UPDATE scripture_lane_replacement SET status = 'staging' WHERE job_id = ?1 AND status = 'reserved'`,
    ).bind(jobId).run();
  }

  let rawUsfm: string | null;
  try {
    rawUsfm = await fetchText(url);
  } catch {
    rawUsfm = null;
  }

  if (!rawUsfm) {
    await env.DB.prepare(
      `UPDATE scripture_lane_replacement_books
          SET status = 'retryable_error',
              error_json = ?1,
              updated_at = unixepoch()
        WHERE job_id = ?2 AND book = ?3`,
    ).bind(JSON.stringify({ error: "fetch_failed", url }), jobId, book).run();
    return { status: "retryable_error" };
  }

  // Validate parse
  let verses: ReturnType<typeof extractVersesForRange>;
  let headers: unknown[] | null;
  try {
    headers = extractUsfmHeaders(rawUsfm);
    verses = extractVersesForRange(rawUsfm, 1, 999);
  } catch (e) {
    await env.DB.prepare(
      `UPDATE scripture_lane_replacement_books
          SET status = 'retryable_error',
              error_json = ?1,
              updated_at = unixepoch()
        WHERE job_id = ?2 AND book = ?3`,
    ).bind(
      JSON.stringify({ error: "parse_failed", message: e instanceof Error ? e.message : String(e) }),
      jobId, book,
    ).run();
    return { status: "retryable_error" };
  }

  if (verses.length === 0) {
    await env.DB.prepare(
      `UPDATE scripture_lane_replacement_books
          SET status = 'retryable_error',
              error_json = ?1,
              updated_at = unixepoch()
        WHERE job_id = ?2 AND book = ?3`,
    ).bind(JSON.stringify({ error: "empty_usfm", url }), jobId, book).run();
    return { status: "retryable_error" };
  }

  // Insert verses with source_generation = job.generation, created_by_job_id = jobId
  const bv = bibleVersionForLane(job.lane);
  const stmt = env.DB.prepare(
    `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, source_generation, content_json, plain_text, created_by_job_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  );
  for (let i = 0; i < verses.length; i += CHUNK) {
    const slice = verses.slice(i, i + CHUNK);
    await env.DB.batch(
      slice.map((v) =>
        stmt.bind(book, v.chapter, v.verse, v.verseEnd, bv, job.generation, v.contentJson, v.plainText, jobId),
      ),
    );
  }

  // Store headers
  if (headers) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO book_usfm_meta (book, bible_version, source_generation, headers_json, created_by_job_id)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(book, bv, job.generation, JSON.stringify(headers), jobId).run();
  }

  // Record SHA
  const sha = await fileCommitSha(env, owner, repo, usfmPath);

  await env.DB.prepare(
    `UPDATE scripture_lane_replacement_books
        SET status = 'artifact_ok',
            source_owner = ?1, source_repo = ?2, source_ref = ?3,
            source_sha = ?4,
            completeness_json = ?5,
            error_json = NULL,
            updated_at = unixepoch()
      WHERE job_id = ?6 AND book = ?7`,
  ).bind(
    owner, repo, ref, sha,
    JSON.stringify({ verses: verses.length, bytes: rawUsfm.length }),
    jobId, book,
  ).run();

  return { status: "artifact_ok" };
}

// ── 3. markReadyIfComplete ───────────────────────────────────────────────────

export async function markReadyIfComplete(
  env: Env,
  jobId: string,
): Promise<{ ready: boolean; pending: string[] }> {
  const books = await getJobBooks(env, jobId);
  const pending: string[] = [];
  for (const b of books) {
    if (b.status !== "artifact_ok" && b.status !== "absent_authorized") {
      pending.push(b.book);
    }
  }
  if (pending.length > 0) return { ready: false, pending };

  await env.DB.prepare(
    `UPDATE scripture_lane_replacement SET status = 'ready' WHERE job_id = ?1 AND status IN ('reserved', 'staging')`,
  ).bind(jobId).run();
  return { ready: true, pending: [] };
}

// ── 4. activateReplacement ───────────────────────────────────────────────────

export async function activateReplacement(
  env: Env,
  jobId: string,
  fencingToken: string,
): Promise<{ activated: boolean }> {
  const job = await getJob(env, jobId);
  if (!job) throw Object.assign(new Error("job_not_found"), { status: 404 });

  // Idempotent success
  if (job.status === "completed") return { activated: true };

  if (job.status !== "ready") {
    throw Object.assign(new Error("job_not_ready"), { status: 409, detail: { status: job.status } });
  }

  // Export-fencing drain — never flip the pointer while an export might still be
  // mid-DCS-commit. A fresh held lease means an exporter owns the lane right now;
  // an abandoned lease still inside its grace window means a recently-dead
  // exporter's in-flight commit could still land. Reject in both cases so the
  // admin retries once the lane is quiescent.
  if (await hasHeldExportLease(env, job.lane)) {
    throw Object.assign(new Error("export_lease_held"), { status: 409, detail: { lane: job.lane } });
  }
  if (!(await waitAbandonedGrace(env, job.lane))) {
    throw Object.assign(new Error("export_lease_grace"), { status: 409, detail: { lane: job.lane } });
  }

  const pending = JSON.parse(job.pending_config_json) as ScriptureLaneConfig;

  // Stamp the activation fencing token on the ready job so the CAS batch below
  // can bind the pointer-flip and completion to *this* activation attempt.
  await env.DB.prepare(
    `UPDATE scripture_lane_replacement
        SET lease_fencing_token = ?1
      WHERE job_id = ?2 AND status = 'ready'`,
  ).bind(fencingToken, job.job_id).run();

  // Atomic batch: pointer flip + job completion. The triggers in migration 0042
  // enforce the ordering invariants; the EXISTS clauses bind both writes to a
  // ready job carrying this activation token so a stale caller can't flip.
  const results = await env.DB.batch([
    // Flip active_generation; clear freeze; clear replacement_required.
    env.DB.prepare(
      `UPDATE scripture_lane_state
          SET active_generation = ?1,
              active_config_json = ?2,
              config_revision = config_revision + 1,
              replacement_job_id = NULL,
              exports_blocked = 0,
              replacement_required = 0,
              pending_target_json = NULL,
              updated_at = unixepoch()
        WHERE lane = ?3
          AND active_generation = ?4
          AND replacement_job_id = ?5
          AND EXISTS (
            SELECT 1 FROM scripture_lane_replacement j
            WHERE j.job_id = ?5
              AND j.status = 'ready'
              AND j.lease_fencing_token = ?6
              AND j.generation = ?1
          )`,
    ).bind(
      job.generation,
      JSON.stringify(pending),
      job.lane,
      job.predecessor_generation,
      job.job_id,
      fencingToken,
    ),
    // Mark job completed. Trigger validates the pointer was flipped first; the
    // EXISTS re-confirms the lane now points at this generation so completion
    // can't land if the flip above CAS-failed.
    env.DB.prepare(
      `UPDATE scripture_lane_replacement
          SET status = 'completed',
              lease_fencing_token = ?1,
              completed_at = unixepoch()
        WHERE job_id = ?2
          AND status = 'ready'
          AND lease_fencing_token = ?1
          AND generation = ?3
          AND EXISTS (
            SELECT 1 FROM scripture_lane_state s
            WHERE s.lane = ?4
              AND s.active_generation = ?3
              AND s.replacement_job_id IS NULL
          )`,
    ).bind(fencingToken, job.job_id, job.generation, job.lane),
  ]);

  const laneFlipped = results[0].meta.changes > 0;
  const jobCompleted = results[1].meta.changes > 0;

  if (!laneFlipped || !jobCompleted) {
    throw Object.assign(new Error("activation_cas_failed"), {
      status: 409,
      detail: { laneFlipped, jobCompleted },
    });
  }

  return { activated: true };
}

// ── 5. cancelReplacement / failReplacement ───────────────────────────────────

export async function cancelReplacement(
  env: Env,
  jobId: string,
): Promise<void> {
  const job = await getJob(env, jobId);
  if (!job) throw Object.assign(new Error("job_not_found"), { status: 404 });
  if (job.status === "completed" || job.status === "cancelled") return;

  const lane = await getLaneState(env, job.lane);

  // Keep replacement_required if the lane had it before (BSOJ transitional).
  // On cancel of a user-started replacement, the lane still needs replacement
  // so we keep replacement_required=1 until a successful activation.
  const keepReplacementRequired = lane?.replacement_required ? 1 : 0;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE scripture_lane_replacement SET status = 'cancelled', completed_at = unixepoch()
        WHERE job_id = ?1 AND status NOT IN ('completed', 'cancelled')`,
    ).bind(jobId),
    env.DB.prepare(
      `UPDATE scripture_lane_state
          SET replacement_job_id = NULL,
              exports_blocked = ?1,
              updated_at = unixepoch()
        WHERE lane = ?2 AND replacement_job_id = ?3`,
    ).bind(keepReplacementRequired ? 1 : 0, job.lane, jobId),
  ]);
}

export async function failReplacement(
  env: Env,
  jobId: string,
  errorDetail?: Record<string, unknown>,
): Promise<void> {
  const job = await getJob(env, jobId);
  if (!job) throw Object.assign(new Error("job_not_found"), { status: 404 });
  if (job.status === "completed" || job.status === "failed") return;

  const lane = await getLaneState(env, job.lane);
  const keepReplacementRequired = lane?.replacement_required ? 1 : 0;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE scripture_lane_replacement
          SET status = 'failed',
              error_json = ?1,
              completed_at = unixepoch()
        WHERE job_id = ?2 AND status NOT IN ('completed', 'failed')`,
    ).bind(errorDetail ? JSON.stringify(errorDetail) : null, jobId),
    env.DB.prepare(
      `UPDATE scripture_lane_state
          SET replacement_job_id = NULL,
              exports_blocked = ?1,
              updated_at = unixepoch()
        WHERE lane = ?2 AND replacement_job_id = ?3`,
    ).bind(keepReplacementRequired ? 1 : 0, job.lane, jobId),
  ]);
}

// ── 6. retryBook / waiveBook ─────────────────────────────────────────────────

export async function retryBook(
  env: Env,
  jobId: string,
  book: string,
): Promise<{ status: string }> {
  const job = await getJob(env, jobId);
  if (!job) throw Object.assign(new Error("job_not_found"), { status: 404 });
  if (job.status === "completed" || job.status === "cancelled" || job.status === "failed") {
    throw Object.assign(new Error("job_terminal"), { status: 409 });
  }

  // Reset to pending so stageBook can re-run
  await env.DB.prepare(
    `UPDATE scripture_lane_replacement_books
        SET status = 'pending', error_json = NULL, updated_at = unixepoch()
      WHERE job_id = ?1 AND book = ?2 AND status IN ('retryable_error', 'failed')`,
  ).bind(jobId, book).run();

  return stageBook(env, jobId, book);
}

export async function waiveBook(
  env: Env,
  jobId: string,
  book: string,
): Promise<void> {
  const job = await getJob(env, jobId);
  if (!job) throw Object.assign(new Error("job_not_found"), { status: 404 });
  if (job.status === "completed" || job.status === "cancelled" || job.status === "failed") {
    throw Object.assign(new Error("job_terminal"), { status: 409 });
  }

  await env.DB.prepare(
    `UPDATE scripture_lane_replacement_books
        SET status = 'absent_authorized', error_json = NULL, updated_at = unixepoch()
      WHERE job_id = ?1 AND book = ?2`,
  ).bind(jobId, book).run();
}

// ── 7. Export lease helpers ──────────────────────────────────────────────────

export async function acquireExportLease(
  env: Env,
  lane: LaneKey,
  holder: string,
): Promise<{ leaseId: string; fencingToken: string } | { error: string }> {
  const state = await requireLaneState(env, lane);
  if (state.exports_blocked) return { error: "exports_blocked" };
  if (state.replacement_job_id) return { error: "replacement_in_progress" };

  // Check for existing held leases
  const existing = await env.DB.prepare(
    `SELECT * FROM scripture_export_leases
      WHERE lane = ?1 AND status = 'held'
      ORDER BY heartbeat_at DESC LIMIT 1`,
  ).bind(lane).first<{ lease_id: string; heartbeat_at: number }>();

  if (existing) {
    const age = Date.now() - existing.heartbeat_at * 1000;
    if (age < EXPORT_LEASE_TTL_MS) {
      return { error: "lease_held" };
    }
    // Abandon stale lease
    await env.DB.prepare(
      `UPDATE scripture_export_leases
          SET status = 'abandoned', abandoned_at = unixepoch(),
              grace_until = unixepoch() + ?1
        WHERE lease_id = ?2 AND status = 'held'`,
    ).bind(Math.ceil(EXPORT_ABANDON_GRACE_MS / 1000), existing.lease_id).run();
  }

  const leaseId = crypto.randomUUID();
  const fencingToken = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO scripture_export_leases (lease_id, lane, fencing_token, status, holder, heartbeat_at)
     VALUES (?1, ?2, ?3, 'held', ?4, unixepoch())`,
  ).bind(leaseId, lane, fencingToken, holder).run();

  // Race guard (D1 has no cross-statement locking, so two Workers can both pass
  // the pre-insert check above and each insert a held lease). Pick a single
  // deterministic winner among the fresh held leases for this lane — the oldest,
  // ties broken by lease_id. If that winner isn't us, relinquish ours and bail
  // so at most one lease is ever treated as authoritative.
  const winner = await env.DB.prepare(
    `SELECT lease_id FROM scripture_export_leases
      WHERE lane = ?1 AND status = 'held' AND heartbeat_at * 1000 > ?2
      ORDER BY created_at ASC, lease_id ASC LIMIT 1`,
  ).bind(lane, Date.now() - EXPORT_LEASE_TTL_MS).first<{ lease_id: string }>();
  if (!winner || winner.lease_id !== leaseId) {
    await env.DB.prepare(
      `UPDATE scripture_export_leases SET status = 'released' WHERE lease_id = ?1 AND status = 'held'`,
    ).bind(leaseId).run();
    return { error: "lease_held" };
  }

  return { leaseId, fencingToken };
}

/** True when a fresh (heartbeat within TTL) held lease exists for the lane. */
export async function hasHeldExportLease(env: Env, lane: LaneKey): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM scripture_export_leases
      WHERE lane = ?1 AND status = 'held' AND heartbeat_at * 1000 > ?2
      LIMIT 1`,
  ).bind(lane, Date.now() - EXPORT_LEASE_TTL_MS).first();
  return !!row;
}

export async function renewExportLease(
  env: Env,
  leaseId: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE scripture_export_leases SET heartbeat_at = unixepoch()
      WHERE lease_id = ?1 AND status = 'held'`,
  ).bind(leaseId).run();
  return result.meta.changes > 0;
}

export async function releaseExportLease(
  env: Env,
  leaseId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE scripture_export_leases SET status = 'released' WHERE lease_id = ?1 AND status = 'held'`,
  ).bind(leaseId).run();
}

export async function verifyExportFencingToken(
  env: Env,
  lane: LaneKey,
  token: string,
): Promise<boolean> {
  // A blocked lane (replacement staging / freeze) invalidates every token —
  // an export must never mutate DCS while the lane is being replaced.
  const state = await getLaneState(env, lane);
  if (!state || state.exports_blocked) return false;

  // The token is valid only if it belongs to a lease that is still HELD (not
  // released or abandoned), carries this exact token, and whose heartbeat is
  // within the lease TTL. A released/expired lease can't authorize a mutation.
  const row = await env.DB.prepare(
    `SELECT heartbeat_at FROM scripture_export_leases
      WHERE lane = ?1 AND status = 'held' AND fencing_token = ?2
      ORDER BY heartbeat_at DESC LIMIT 1`,
  ).bind(lane, token).first<{ heartbeat_at: number }>();
  if (!row) return false;
  const age = Date.now() - row.heartbeat_at * 1000;
  return age < EXPORT_LEASE_TTL_MS;
}

export async function waitAbandonedGrace(
  env: Env,
  lane: LaneKey,
): Promise<boolean> {
  // Returns true if there are no abandoned leases still within grace period.
  const row = await env.DB.prepare(
    `SELECT 1 FROM scripture_export_leases
      WHERE lane = ?1 AND status = 'abandoned' AND grace_until > unixepoch()
      LIMIT 1`,
  ).bind(lane).first();
  return !row;
}

// ── Public query helpers ─────────────────────────────────────────────────────

export { getJob, getJobBooks };
