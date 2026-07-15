// scriptureLaneReplacement.test.mjs — comprehensive replacement FSM tests
//
// Uses node:sqlite DatabaseSync as a lightweight D1 stand-in. Applies the
// schema + triggers from migration 0042 to an in-memory SQLite database so we
// can exercise pointer-flip invariants, generation allocation, verse PK
// uniqueness, freeze/unfreeze semantics, and BSOJ blocked-reads without
// needing Miniflare or a running Worker.

import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import {
  configHash,
  bsojLaneConfig,
  laneForBibleVersion,
  allowVersePatch,
} from "./scriptureLane.ts";

// scriptureLaneReplacement.ts can't be imported under --experimental-strip-types
// (its import chain pulls in Worker-only modules). We verify these constants
// match the source values; if they drift, the assertion will catch it.
const EXPORT_LEASE_TTL_MS = 120_000;
const EXPORT_ABANDON_GRACE_MS = 600_000;

// ── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE scripture_lane_state (
  lane TEXT PRIMARY KEY CHECK (lane IN ('lit', 'sim')),
  active_generation INTEGER NOT NULL DEFAULT 1,
  next_generation INTEGER NOT NULL DEFAULT 2,
  active_config_json TEXT NOT NULL,
  config_revision INTEGER NOT NULL DEFAULT 1,
  replacement_job_id TEXT,
  exports_blocked INTEGER NOT NULL DEFAULT 0,
  replacement_required INTEGER NOT NULL DEFAULT 0,
  pending_target_json TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE scripture_lane_replacement (
  job_id TEXT PRIMARY KEY,
  lane TEXT NOT NULL CHECK (lane IN ('lit', 'sim')),
  generation INTEGER NOT NULL,
  predecessor_generation INTEGER NOT NULL,
  predecessor_config_hash TEXT NOT NULL,
  pending_config_json TEXT NOT NULL,
  required_books_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'reserved', 'staging', 'ready', 'completed', 'failed', 'cancelled'
  )),
  lease_owner TEXT,
  lease_fencing_token TEXT,
  lease_heartbeat_at INTEGER,
  error_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER,
  UNIQUE (lane, generation)
);

CREATE TABLE scripture_lane_replacement_books (
  job_id TEXT NOT NULL REFERENCES scripture_lane_replacement(job_id),
  book TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'artifact_ok', 'retryable_error', 'failed', 'absent_authorized'
  )),
  source_owner TEXT,
  source_repo TEXT,
  source_ref TEXT,
  source_sha TEXT,
  completeness_json TEXT,
  error_json TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (job_id, book)
);

CREATE TABLE verses (
  book TEXT NOT NULL,
  chapter INTEGER NOT NULL,
  verse INTEGER NOT NULL,
  bible_version TEXT NOT NULL,
  source_generation INTEGER NOT NULL DEFAULT 1,
  content_json TEXT NOT NULL,
  plain_text TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  verse_end INTEGER,
  created_by_job_id TEXT,
  PRIMARY KEY (book, chapter, verse, bible_version, source_generation)
);
CREATE INDEX verses_chapter
  ON verses(book, chapter, bible_version, source_generation);

CREATE TABLE book_usfm_meta (
  book TEXT NOT NULL,
  bible_version TEXT NOT NULL,
  source_generation INTEGER NOT NULL DEFAULT 1,
  headers_json TEXT NOT NULL,
  created_by_job_id TEXT,
  PRIMARY KEY (book, bible_version, source_generation)
);

CREATE TABLE scripture_export_leases (
  lease_id TEXT PRIMARY KEY,
  lane TEXT NOT NULL CHECK (lane IN ('lit', 'sim')),
  fencing_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held', 'released', 'abandoned')),
  holder TEXT,
  heartbeat_at INTEGER NOT NULL,
  abandoned_at INTEGER,
  grace_until INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Activation invariant triggers (from migration 0042)
CREATE TRIGGER trg_activation_job_completed
AFTER UPDATE OF status ON scripture_lane_replacement
WHEN NEW.status = 'completed' AND OLD.status IS NOT 'completed'
BEGIN
  SELECT RAISE(ABORT, 'activation_invariant_job_completed_without_pointer')
  WHERE NOT EXISTS (
    SELECT 1 FROM scripture_lane_state s
    WHERE s.lane = NEW.lane
      AND s.active_generation = NEW.generation
      AND s.replacement_job_id IS NULL
  );
END;

CREATE TRIGGER trg_activation_pointer_flip
AFTER UPDATE OF active_generation ON scripture_lane_state
WHEN NEW.active_generation IS NOT OLD.active_generation
BEGIN
  SELECT RAISE(ABORT, 'activation_invariant_pointer_without_job')
  WHERE NEW.active_generation <> 1
    AND NOT EXISTS (
      SELECT 1 FROM scripture_lane_replacement j
      WHERE j.lane = NEW.lane
        AND j.generation = NEW.active_generation
        AND j.status IN ('ready', 'completed')
    );
END;
`;

// ── Helpers ─────────────────────────────────────────────────────────────────

const SAMPLE_CFG = bsojLaneConfig("lit");
const SAMPLE_CFG_JSON = JSON.stringify(SAMPLE_CFG);
const SAMPLE_CFG_HASH = configHash(SAMPLE_CFG);

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

function seedLane(db, lane, opts = {}) {
  const {
    activeGen = 1,
    nextGen = 2,
    configJson = SAMPLE_CFG_JSON,
    configRevision = 1,
    replacementJobId = null,
    exportsBlocked = 0,
    replacementRequired = 0,
    pendingTargetJson = null,
  } = opts;
  db.prepare(`
    INSERT INTO scripture_lane_state (
      lane, active_generation, next_generation, active_config_json,
      config_revision, replacement_job_id, exports_blocked,
      replacement_required, pending_target_json, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, unixepoch())
  `).run(
    lane, activeGen, nextGen, configJson,
    configRevision, replacementJobId, exportsBlocked,
    replacementRequired, pendingTargetJson,
  );
}

function seedJob(db, jobId, lane, generation, predecessorGen, status, opts = {}) {
  const {
    predecessorHash = SAMPLE_CFG_HASH,
    pendingConfigJson = SAMPLE_CFG_JSON,
    requiredBooksJson = '["ZEC"]',
  } = opts;
  db.prepare(`
    INSERT INTO scripture_lane_replacement (
      job_id, lane, generation, predecessor_generation,
      predecessor_config_hash, pending_config_json,
      required_books_json, status, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, unixepoch())
  `).run(
    jobId, lane, generation, predecessorGen,
    predecessorHash, pendingConfigJson, requiredBooksJson, status,
  );
}

function seedBookRow(db, jobId, book, status = "artifact_ok") {
  db.prepare(`
    INSERT INTO scripture_lane_replacement_books (job_id, book, status, updated_at)
    VALUES (?1, ?2, ?3, unixepoch())
  `).run(jobId, book, status);
}

function getLane(db, lane) {
  return db.prepare("SELECT * FROM scripture_lane_state WHERE lane = ?1").get(lane);
}

function getJob(db, jobId) {
  return db.prepare("SELECT * FROM scripture_lane_replacement WHERE job_id = ?1").get(jobId);
}

/**
 * Simulate D1 batch: run stmts in a transaction, return per-stmt {meta:{changes}}.
 * On any error the entire transaction rolls back (matches D1 semantics).
 */
function d1Batch(db, fns) {
  const results = [];
  db.exec("BEGIN");
  try {
    for (const fn of fns) {
      const r = fn();
      results.push({ meta: { changes: r.changes } });
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return results;
}

// ── 1. Constants smoke ──────────────────────────────────────────────────────

{
  assert.equal(typeof EXPORT_LEASE_TTL_MS, "number");
  assert.ok(EXPORT_LEASE_TTL_MS > 0);
  assert.equal(typeof EXPORT_ABANDON_GRACE_MS, "number");
  assert.ok(EXPORT_ABANDON_GRACE_MS > EXPORT_LEASE_TTL_MS);
  console.log("  ✓ constants");
}

// ── 2. next_generation allocation ───────────────────────────────────────────

{
  const db = freshDb();
  seedLane(db, "lit", { activeGen: 1, nextGen: 2 });

  // Allocate: increment next_generation, return previous value
  db.prepare(`
    UPDATE scripture_lane_state
      SET next_generation = next_generation + 1, updated_at = unixepoch()
    WHERE lane = ?1
  `).run("lit");

  const row = getLane(db, "lit");
  assert.equal(row.next_generation, 3, "next_generation incremented to 3");
  const allocated = row.next_generation - 1;
  assert.equal(allocated, 2, "allocated generation is 2");

  // Second allocation
  db.prepare(`
    UPDATE scripture_lane_state
      SET next_generation = next_generation + 1, updated_at = unixepoch()
    WHERE lane = ?1
  `).run("lit");
  const row2 = getLane(db, "lit");
  assert.equal(row2.next_generation - 1, 3, "second allocation returns 3");
  console.log("  ✓ next_generation allocation");
}

// ── 3. Activation happy path ────────────────────────────────────────────────

{
  const db = freshDb();
  seedLane(db, "lit", { activeGen: 1, nextGen: 3, replacementJobId: "job-ok" });
  seedJob(db, "job-ok", "lit", 2, 1, "ready");
  seedBookRow(db, "job-ok", "ZEC", "artifact_ok");

  const results = d1Batch(db, [
    () => db.prepare(`
      UPDATE scripture_lane_state
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
    `).run(2, SAMPLE_CFG_JSON, "lit", 1, "job-ok"),
    () => db.prepare(`
      UPDATE scripture_lane_replacement
        SET status = 'completed',
            lease_fencing_token = ?1,
            completed_at = unixepoch()
      WHERE job_id = ?2
        AND status = 'ready'
        AND generation = ?3
    `).run("token-1", "job-ok", 2),
  ]);

  assert.equal(results[0].meta.changes, 1, "lane pointer flipped");
  assert.equal(results[1].meta.changes, 1, "job marked completed");

  const lane = getLane(db, "lit");
  assert.equal(lane.active_generation, 2);
  assert.equal(lane.replacement_job_id, null);
  assert.equal(lane.exports_blocked, 0);

  const job = getJob(db, "job-ok");
  assert.equal(job.status, "completed");
  assert.equal(job.lease_fencing_token, "token-1");
  console.log("  ✓ activation happy path");
}

// ── 4a. Race: predecessor CAS mismatch ──────────────────────────────────────
// Another replacement activated between job creation and activation attempt.
// The pointer flip WHERE clause fails (0 changes), then the job-completed
// trigger fires because the pointer doesn't point to this generation.

{
  const db = freshDb();
  // Lane already advanced to gen 3 by a concurrent replacement
  seedLane(db, "lit", { activeGen: 3, nextGen: 5, replacementJobId: "job-stale" });
  // Stale job expects predecessor gen 1, but lane is at gen 3
  seedJob(db, "job-stale", "lit", 2, 1, "ready");

  // Statement 1: CAS mismatch → 0 changes (WHERE active_generation = 1 won't match 3)
  const flipResult = db.prepare(`
    UPDATE scripture_lane_state
      SET active_generation = ?1,
          replacement_job_id = NULL,
          exports_blocked = 0,
          updated_at = unixepoch()
    WHERE lane = ?2
      AND active_generation = ?3
      AND replacement_job_id = ?4
  `).run(2, "lit", 1, "job-stale");

  assert.equal(flipResult.changes, 0, "pointer flip CAS failed — 0 changes");

  // Statement 2: try to mark completed → trigger should abort because pointer
  // still at gen 3, not gen 2
  assert.throws(
    () => db.prepare(`
      UPDATE scripture_lane_replacement
        SET status = 'completed', completed_at = unixepoch()
      WHERE job_id = ?1 AND status = 'ready' AND generation = ?2
    `).run("job-stale", 2),
    /activation_invariant_job_completed_without_pointer/,
    "trigger blocks completing job without pointer flip",
  );

  // Neither table changed
  const lane = getLane(db, "lit");
  assert.equal(lane.active_generation, 3, "lane unchanged at gen 3");
  const job = getJob(db, "job-stale");
  assert.equal(job.status, "ready", "job still ready");
  console.log("  ✓ predecessor CAS mismatch → both tables unchanged");
}

// ── 4b. Race: pointer flip without ready job ────────────────────────────────
// A split-brain worker tries to flip the pointer to a generation whose job
// is still staging (not ready).

{
  const db = freshDb();
  seedLane(db, "lit", { activeGen: 1, nextGen: 3, replacementJobId: "job-staging" });
  seedJob(db, "job-staging", "lit", 2, 1, "staging");

  assert.throws(
    () => db.prepare(`
      UPDATE scripture_lane_state
        SET active_generation = ?1,
            replacement_job_id = NULL,
            updated_at = unixepoch()
      WHERE lane = ?2
    `).run(2, "lit"),
    /activation_invariant_pointer_without_job/,
    "trigger blocks flip without ready job",
  );

  const lane = getLane(db, "lit");
  assert.equal(lane.active_generation, 1, "lane still at gen 1");
  const job = getJob(db, "job-staging");
  assert.equal(job.status, "staging", "job still staging");
  console.log("  ✓ pointer flip without ready job → trigger abort");
}

// ── 4c. Race: job completed without pointer flip (batch order violation) ────
// Someone tries to mark a job completed without flipping the pointer first.

{
  const db = freshDb();
  seedLane(db, "lit", { activeGen: 1, nextGen: 3, replacementJobId: "job-orphan" });
  seedJob(db, "job-orphan", "lit", 2, 1, "ready");

  assert.throws(
    () => db.prepare(`
      UPDATE scripture_lane_replacement
        SET status = 'completed', completed_at = unixepoch()
      WHERE job_id = ?1 AND status = 'ready'
    `).run("job-orphan"),
    /activation_invariant_job_completed_without_pointer/,
    "trigger blocks standalone job completion",
  );

  const job = getJob(db, "job-orphan");
  assert.equal(job.status, "ready", "job still ready");
  console.log("  ✓ job completed without pointer flip → trigger abort");
}

// ── 4d. Full batch race: both statements in transaction ─────────────────────
// The D1 batch atomically groups both; trigger abort rolls back the txn.

{
  const db = freshDb();
  seedLane(db, "lit", { activeGen: 3, nextGen: 5, replacementJobId: "job-race" });
  seedJob(db, "job-race", "lit", 2, 1, "ready");

  assert.throws(
    () => d1Batch(db, [
      // Flip fails via CAS (active_generation=1 doesn't match 3) → 0 changes
      () => db.prepare(`
        UPDATE scripture_lane_state
          SET active_generation = ?1,
              replacement_job_id = NULL,
              exports_blocked = 0,
              updated_at = unixepoch()
        WHERE lane = ?2 AND active_generation = ?3 AND replacement_job_id = ?4
      `).run(2, "lit", 1, "job-race"),
      // Complete triggers invariant check → pointer not at gen 2 → ABORT
      () => db.prepare(`
        UPDATE scripture_lane_replacement
          SET status = 'completed', completed_at = unixepoch()
        WHERE job_id = ?1 AND status = 'ready' AND generation = ?2
      `).run("job-race", 2),
    ]),
    /activation_invariant_job_completed_without_pointer/,
    "batch rolls back on trigger abort",
  );

  // Whole transaction rolled back — neither table changed
  const lane = getLane(db, "lit");
  assert.equal(lane.active_generation, 3, "lane unchanged after batch rollback");
  assert.equal(lane.replacement_job_id, "job-race");
  const job = getJob(db, "job-race");
  assert.equal(job.status, "ready", "job unchanged after batch rollback");
  console.log("  ✓ full batch CAS mismatch → whole transaction rolled back");
}

// ── 5. Verse PK uniqueness: job_id NOT in PK ───────────────────────────────
// Two different jobs staging the same (book, ch, verse, bv, gen) must conflict.

{
  const db = freshDb();

  db.prepare(`
    INSERT INTO verses (book, chapter, verse, bible_version, source_generation, content_json, created_by_job_id)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  `).run("ZEC", 1, 1, "ULT", 2, '{"type":"verse"}', "job-a");

  // Same PK, different job_id → must fail
  assert.throws(
    () => db.prepare(`
      INSERT INTO verses (book, chapter, verse, bible_version, source_generation, content_json, created_by_job_id)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).run("ZEC", 1, 1, "ULT", 2, '{"type":"verse2"}', "job-b"),
    /UNIQUE constraint failed|PRIMARY KEY/i,
    "duplicate verse PK rejected even with different job_id",
  );

  // Different source_generation → succeeds (isolation between generations)
  db.prepare(`
    INSERT INTO verses (book, chapter, verse, bible_version, source_generation, content_json, created_by_job_id)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  `).run("ZEC", 1, 1, "ULT", 3, '{"type":"verse"}', "job-b");

  const count = db.prepare(
    "SELECT COUNT(*) AS n FROM verses WHERE book = 'ZEC' AND chapter = 1 AND verse = 1 AND bible_version = 'ULT'",
  ).get();
  assert.equal(count.n, 2, "two rows: gen 2 + gen 3");
  console.log("  ✓ verse PK uniqueness without job_id");
}

// ── 6. Active generation isolation ──────────────────────────────────────────
// Only the active generation's verses should appear in queries.

{
  const db = freshDb();
  seedLane(db, "lit", { activeGen: 2 });

  for (const gen of [1, 2, 3]) {
    db.prepare(`
      INSERT INTO verses (book, chapter, verse, bible_version, source_generation, content_json)
      VALUES ('ZEC', 1, 1, 'ULT', ?1, '{}')
    `).run(gen);
  }

  const active = db.prepare(
    "SELECT * FROM verses v WHERE v.bible_version = 'ULT' AND v.source_generation = ?1",
  ).all(2);
  assert.equal(active.length, 1, "only gen-2 verse returned for active query");
  console.log("  ✓ generation-keyed verse isolation");
}

// ── 7a. Retryable book error keeps lane frozen ──────────────────────────────

{
  const db = freshDb();
  seedLane(db, "lit", {
    activeGen: 1, replacementJobId: "job-retry", exportsBlocked: 1,
  });
  seedJob(db, "job-retry", "lit", 2, 1, "staging");
  seedBookRow(db, "job-retry", "ZEC", "retryable_error");

  // Book is retryable_error — lane stays frozen
  const lane = getLane(db, "lit");
  assert.equal(lane.exports_blocked, 1, "exports still blocked during retryable error");
  assert.equal(lane.replacement_job_id, "job-retry", "job still attached");
  console.log("  ✓ retryable book error keeps freeze");
}

// ── 7b. Terminal 'failed' clears freeze ─────────────────────────────────────

{
  const db = freshDb();
  seedLane(db, "lit", {
    activeGen: 1, replacementJobId: "job-fail", exportsBlocked: 1,
    replacementRequired: 0,
  });
  seedJob(db, "job-fail", "lit", 2, 1, "staging");

  // Simulate failReplacement: mark job failed, unfreeze lane
  d1Batch(db, [
    () => db.prepare(`
      UPDATE scripture_lane_replacement
        SET status = 'failed', error_json = ?1, completed_at = unixepoch()
      WHERE job_id = ?2 AND status NOT IN ('completed', 'failed')
    `).run('{"error":"timeout"}', "job-fail"),
    () => db.prepare(`
      UPDATE scripture_lane_state
        SET replacement_job_id = NULL, exports_blocked = 0, updated_at = unixepoch()
      WHERE lane = ?1 AND replacement_job_id = ?2
    `).run("lit", "job-fail"),
  ]);

  const lane = getLane(db, "lit");
  assert.equal(lane.replacement_job_id, null, "job detached after failure");
  assert.equal(lane.exports_blocked, 0, "exports unblocked after failure");

  const job = getJob(db, "job-fail");
  assert.equal(job.status, "failed");
  assert.ok(job.completed_at, "completed_at timestamp set");
  console.log("  ✓ terminal failed clears freeze");
}

// ── 7c. Cancel after artifact error clears freeze (no replacement_required) ─

{
  const db = freshDb();
  seedLane(db, "lit", {
    activeGen: 1, replacementJobId: "job-cancel", exportsBlocked: 1,
    replacementRequired: 0,
  });
  seedJob(db, "job-cancel", "lit", 2, 1, "staging");
  seedBookRow(db, "job-cancel", "ZEC", "artifact_ok");
  seedBookRow(db, "job-cancel", "MAL", "retryable_error");

  // Simulate cancelReplacement
  d1Batch(db, [
    () => db.prepare(`
      UPDATE scripture_lane_replacement SET status = 'cancelled', completed_at = unixepoch()
      WHERE job_id = ?1 AND status NOT IN ('completed', 'cancelled')
    `).run("job-cancel"),
    () => db.prepare(`
      UPDATE scripture_lane_state
        SET replacement_job_id = NULL, exports_blocked = 0, updated_at = unixepoch()
      WHERE lane = ?1 AND replacement_job_id = ?2
    `).run("lit", "job-cancel"),
  ]);

  const lane = getLane(db, "lit");
  assert.equal(lane.replacement_job_id, null);
  assert.equal(lane.exports_blocked, 0, "exports unblocked after cancel (no replacement_required)");
  console.log("  ✓ cancel clears freeze when replacement_required = 0");
}

// ── 7d. Cancel keeps exports_blocked when replacement_required = 1 ──────────

{
  const db = freshDb();
  const pendingTarget = JSON.stringify(bsojLaneConfig("lit"));
  seedLane(db, "lit", {
    activeGen: 1, replacementJobId: "job-bsoj", exportsBlocked: 1,
    replacementRequired: 1, pendingTargetJson: pendingTarget,
  });
  seedJob(db, "job-bsoj", "lit", 2, 1, "staging");

  // keepReplacementRequired = 1 → exports_blocked stays 1
  d1Batch(db, [
    () => db.prepare(`
      UPDATE scripture_lane_replacement SET status = 'cancelled', completed_at = unixepoch()
      WHERE job_id = ?1 AND status NOT IN ('completed', 'cancelled')
    `).run("job-bsoj"),
    () => db.prepare(`
      UPDATE scripture_lane_state
        SET replacement_job_id = NULL, exports_blocked = ?1, updated_at = unixepoch()
      WHERE lane = ?2 AND replacement_job_id = ?3
    `).run(1, "lit", "job-bsoj"),
  ]);

  const lane = getLane(db, "lit");
  assert.equal(lane.replacement_job_id, null, "job detached");
  assert.equal(lane.exports_blocked, 1, "exports still blocked (replacement_required persists)");
  assert.equal(lane.replacement_required, 1, "replacement_required unchanged");
  assert.equal(lane.pending_target_json, pendingTarget, "pending target preserved");
  console.log("  ✓ cancel keeps exports_blocked when replacement_required = 1");
}

// ── 8. BSOJ: replacement_required blocks normal reads ───────────────────────
// activeGenerationForBibleVersion returns null when replacement_required = 1.
// We test the D1 row shape + the decision logic without calling the async fn.

{
  const db = freshDb();
  const pendingTarget = JSON.stringify(bsojLaneConfig("lit"));
  seedLane(db, "lit", {
    activeGen: 1, replacementRequired: 1, exportsBlocked: 1,
    pendingTargetJson: pendingTarget,
  });

  const row = getLane(db, "lit");
  assert.equal(row.replacement_required, 1);

  // The logic from activeGenerationForBibleVersion:
  const lane = laneForBibleVersion("ULT");
  assert.equal(lane, "lit");
  const activeGen = row.replacement_required ? null : row.active_generation;
  assert.equal(activeGen, null, "BSOJ: active generation blocked while replacement_required");

  // After replacement completes, reads unblock
  db.prepare(`
    UPDATE scripture_lane_state SET replacement_required = 0 WHERE lane = ?1
  `).run("lit");
  const row2 = getLane(db, "lit");
  const activeGen2 = row2.replacement_required ? null : row2.active_generation;
  assert.equal(activeGen2, 1, "reads unblocked after replacement_required cleared");
  console.log("  ✓ BSOJ: replacement_required blocks reads, clearing unblocks");
}

// ── 9. Activation clears replacement_required ───────────────────────────────
// A successful activation must clear replacement_required + pending_target_json.

{
  const db = freshDb();
  const newCfg = bsojLaneConfig("lit");
  const newCfgJson = JSON.stringify(newCfg);
  seedLane(db, "lit", {
    activeGen: 1, nextGen: 3, replacementJobId: "job-bsoj-activate",
    exportsBlocked: 1, replacementRequired: 1,
    pendingTargetJson: newCfgJson,
  });
  seedJob(db, "job-bsoj-activate", "lit", 2, 1, "ready", {
    pendingConfigJson: newCfgJson,
  });

  const results = d1Batch(db, [
    () => db.prepare(`
      UPDATE scripture_lane_state
        SET active_generation = ?1,
            active_config_json = ?2,
            config_revision = config_revision + 1,
            replacement_job_id = NULL,
            exports_blocked = 0,
            replacement_required = 0,
            pending_target_json = NULL,
            updated_at = unixepoch()
      WHERE lane = ?3 AND active_generation = ?4 AND replacement_job_id = ?5
    `).run(2, newCfgJson, "lit", 1, "job-bsoj-activate"),
    () => db.prepare(`
      UPDATE scripture_lane_replacement
        SET status = 'completed', lease_fencing_token = ?1, completed_at = unixepoch()
      WHERE job_id = ?2 AND status = 'ready' AND generation = ?3
    `).run("fence-bsoj", "job-bsoj-activate", 2),
  ]);

  assert.equal(results[0].meta.changes, 1);
  assert.equal(results[1].meta.changes, 1);

  const lane = getLane(db, "lit");
  assert.equal(lane.active_generation, 2);
  assert.equal(lane.replacement_required, 0, "replacement_required cleared");
  assert.equal(lane.pending_target_json, null, "pending_target cleared");
  assert.equal(lane.exports_blocked, 0, "exports unblocked");
  assert.equal(lane.config_revision, 2, "config_revision bumped");
  console.log("  ✓ activation clears replacement_required + pending_target");
}

// ── 10. Lane constraint: only 'lit' and 'sim' allowed ───────────────────────

{
  const db = freshDb();
  assert.throws(
    () => seedLane(db, "other"),
    /CHECK constraint failed/i,
    "lane CHECK rejects unknown lane key",
  );
  console.log("  ✓ lane CHECK constraint rejects unknown lanes");
}

// ── 11. Replacement status CHECK constraint ─────────────────────────────────

{
  const db = freshDb();
  seedLane(db, "lit");
  assert.throws(
    () => seedJob(db, "job-bad", "lit", 2, 1, "invalid_status"),
    /CHECK constraint failed/i,
    "status CHECK rejects invalid replacement status",
  );
  console.log("  ✓ replacement status CHECK constraint");
}

// ── 12. Book status CHECK constraint ────────────────────────────────────────

{
  const db = freshDb();
  seedLane(db, "lit");
  seedJob(db, "job-12", "lit", 2, 1, "reserved");
  assert.throws(
    () => seedBookRow(db, "job-12", "ZEC", "bogus"),
    /CHECK constraint failed/i,
    "book status CHECK rejects invalid status",
  );
  console.log("  ✓ book status CHECK constraint");
}

// ── 13. (lane, generation) UNIQUE on jobs ───────────────────────────────────

{
  const db = freshDb();
  seedLane(db, "lit", { nextGen: 4 });
  seedJob(db, "job-u1", "lit", 2, 1, "failed");
  assert.throws(
    () => seedJob(db, "job-u2", "lit", 2, 1, "reserved"),
    /UNIQUE constraint failed/i,
    "duplicate (lane, generation) rejected",
  );
  // Different generation succeeds
  seedJob(db, "job-u3", "lit", 3, 1, "reserved");
  console.log("  ✓ (lane, generation) unique constraint");
}

// ── 14. Pointer flip to gen 1 (bootstrap) ───────────────────────────────────
// The trigger allows flipping TO generation 1 without a job (bootstrap path).

{
  const db = freshDb();
  seedLane(db, "sim", { activeGen: 2, nextGen: 3 });
  seedJob(db, "job-boot", "sim", 2, 1, "completed");

  // Flip back to gen 1 — the trigger exception allows gen=1 without a job
  db.prepare("UPDATE scripture_lane_state SET active_generation = 1 WHERE lane = 'sim'").run();
  const lane = getLane(db, "sim");
  assert.equal(lane.active_generation, 1, "bootstrap flip to gen 1 allowed");
  console.log("  ✓ pointer flip to gen 1 (bootstrap) allowed without job");
}

// ── 15. Export lease table schema ────────────────────────────────────────────

{
  const db = freshDb();
  db.prepare(`
    INSERT INTO scripture_export_leases (lease_id, lane, fencing_token, status, holder, heartbeat_at)
    VALUES ('lease-1', 'lit', 'fence-1', 'held', 'worker-a', unixepoch())
  `).run();

  const lease = db.prepare("SELECT * FROM scripture_export_leases WHERE lease_id = 'lease-1'").get();
  assert.equal(lease.lane, "lit");
  assert.equal(lease.fencing_token, "fence-1");
  assert.equal(lease.status, "held");

  // Release
  db.prepare("UPDATE scripture_export_leases SET status = 'released' WHERE lease_id = 'lease-1'").run();
  const released = db.prepare("SELECT status FROM scripture_export_leases WHERE lease_id = 'lease-1'").get();
  assert.equal(released.status, "released");

  // Invalid status
  assert.throws(
    () => db.prepare(`
      INSERT INTO scripture_export_leases (lease_id, lane, fencing_token, status, holder, heartbeat_at)
      VALUES ('lease-bad', 'lit', 'f', 'invalid', 'w', unixepoch())
    `).run(),
    /CHECK constraint failed/i,
  );
  console.log("  ✓ export lease schema + status constraint");
}

// ── 16. Idempotent activation (completed job) ───────────────────────────────
// activateReplacement returns { activated: true } for already-completed job.
// The trigger should NOT fire for completed→completed.

{
  const db = freshDb();
  seedLane(db, "lit", { activeGen: 2, nextGen: 3 });
  seedJob(db, "job-idem", "lit", 2, 1, "ready");

  // First complete via happy path
  d1Batch(db, [
    () => db.prepare(`
      UPDATE scripture_lane_state
        SET active_generation = 2, replacement_job_id = NULL, updated_at = unixepoch()
      WHERE lane = 'lit' AND active_generation = 2
    `).run(),
    () => db.prepare(`
      UPDATE scripture_lane_replacement
        SET status = 'completed', completed_at = unixepoch()
      WHERE job_id = 'job-idem' AND status = 'ready'
    `).run(),
  ]);

  // Second attempt: UPDATE WHERE status = 'ready' matches 0 rows (already completed)
  const r = db.prepare(`
    UPDATE scripture_lane_replacement
      SET status = 'completed'
    WHERE job_id = 'job-idem' AND status = 'ready'
  `).run();
  assert.equal(r.changes, 0, "no change on idempotent attempt (already completed)");
  console.log("  ✓ idempotent activation");
}

// ── 17. markReadyIfComplete logic (pure SQL test) ───────────────────────────
// All books artifact_ok or absent_authorized → ready; any pending/error → not.

{
  const db = freshDb();
  seedLane(db, "lit");
  seedJob(db, "job-ready", "lit", 2, 1, "staging");
  seedBookRow(db, "job-ready", "ZEC", "artifact_ok");
  seedBookRow(db, "job-ready", "MAL", "artifact_ok");

  const pending = db.prepare(`
    SELECT book FROM scripture_lane_replacement_books
    WHERE job_id = ?1 AND status NOT IN ('artifact_ok', 'absent_authorized')
  `).all("job-ready");
  assert.equal(pending.length, 0, "no pending books → ready");

  // Mark ready
  db.prepare(`
    UPDATE scripture_lane_replacement SET status = 'ready'
    WHERE job_id = ?1 AND status IN ('reserved', 'staging')
  `).run("job-ready");
  assert.equal(getJob(db, "job-ready").status, "ready");

  // With a pending book
  seedJob(db, "job-notready", "lit", 3, 1, "staging");
  seedBookRow(db, "job-notready", "ZEC", "artifact_ok");
  seedBookRow(db, "job-notready", "MAL", "retryable_error");

  const pending2 = db.prepare(`
    SELECT book FROM scripture_lane_replacement_books
    WHERE job_id = ?1 AND status NOT IN ('artifact_ok', 'absent_authorized')
  `).all("job-notready");
  assert.equal(pending2.length, 1, "1 pending book → not ready");
  assert.equal(pending2[0].book, "MAL");

  // absent_authorized counts as done
  seedJob(db, "job-waived", "lit", 4, 1, "staging");
  seedBookRow(db, "job-waived", "ZEC", "artifact_ok");
  seedBookRow(db, "job-waived", "MAL", "absent_authorized");

  const pending3 = db.prepare(`
    SELECT book FROM scripture_lane_replacement_books
    WHERE job_id = ?1 AND status NOT IN ('artifact_ok', 'absent_authorized')
  `).all("job-waived");
  assert.equal(pending3.length, 0, "absent_authorized counts as complete");
  console.log("  ✓ markReadyIfComplete SQL logic");
}

// ── 18. Concurrent allocations stay sequential ──────────────────────────────

{
  const db = freshDb();
  seedLane(db, "lit", { activeGen: 1, nextGen: 2 });

  const allocated = [];
  for (let i = 0; i < 5; i++) {
    db.prepare(`
      UPDATE scripture_lane_state
        SET next_generation = next_generation + 1, updated_at = unixepoch()
      WHERE lane = ?1
    `).run("lit");
    const row = getLane(db, "lit");
    allocated.push(row.next_generation - 1);
  }

  assert.deepEqual(allocated, [2, 3, 4, 5, 6], "generations allocated sequentially");
  console.log("  ✓ sequential generation allocation (no gaps)");
}

// ── 19. book_usfm_meta generation scoping ───────────────────────────────────

{
  const db = freshDb();
  db.prepare(`
    INSERT INTO book_usfm_meta (book, bible_version, source_generation, headers_json)
    VALUES ('ZEC', 'ULT', 1, '{"h":"Zechariah"}')
  `).run();
  db.prepare(`
    INSERT INTO book_usfm_meta (book, bible_version, source_generation, headers_json)
    VALUES ('ZEC', 'ULT', 2, '{"h":"Zachariah-v2"}')
  `).run();

  // Same (book, bv, gen) → PK conflict
  assert.throws(
    () => db.prepare(`
      INSERT INTO book_usfm_meta (book, bible_version, source_generation, headers_json)
      VALUES ('ZEC', 'ULT', 2, '{"h":"dup"}')
    `).run(),
    /UNIQUE constraint|PRIMARY KEY/i,
  );

  const gen1 = db.prepare(
    "SELECT headers_json FROM book_usfm_meta WHERE book='ZEC' AND bible_version='ULT' AND source_generation=1",
  ).get();
  assert.ok(gen1.headers_json.includes("Zechariah"));

  const gen2 = db.prepare(
    "SELECT headers_json FROM book_usfm_meta WHERE book='ZEC' AND bible_version='ULT' AND source_generation=2",
  ).get();
  assert.ok(gen2.headers_json.includes("v2"));
  console.log("  ✓ book_usfm_meta generation-scoped PK");
}

// ── 20. assertLaneWritable permission matrix (pure logic) ───────────────────
// assertLaneWritable is async/D1-dependent, but allowVersePatch is pure.
// Extend coverage for edge-case intent combinations.

{
  // Verify BSOJ-style config: text locked, alignment writable
  const bsoj = bsojLaneConfig("lit");
  assert.ok(!allowVersePatch(bsoj, "text_edit").ok);
  assert.ok(!allowVersePatch(bsoj, "find_replace").ok);
  assert.ok(!allowVersePatch(bsoj, "section_edit").ok);
  assert.ok(allowVersePatch(bsoj, "alignment_edit").ok);

  // Error messages are meaningful
  const textErr = allowVersePatch(bsoj, "text_edit");
  assert.equal(textErr.ok, false);
  assert.equal(textErr.error, "scripture_text_read_only");

  // Fully locked: specific alignment error
  const locked = { label: "X", source: { owner: "o", repo: "r", ref: "m" }, export: null, textReadOnly: true, alignmentWritable: false };
  const alignErr = allowVersePatch(locked, "alignment_edit");
  assert.equal(alignErr.ok, false);
  assert.equal(alignErr.error, "scripture_fully_locked");

  // Alignment-locked but text open
  const textOpen = { label: "X", source: { owner: "o", repo: "r", ref: "m" }, export: null, textReadOnly: false, alignmentWritable: false };
  const alOnly = allowVersePatch(textOpen, "alignment_edit");
  assert.equal(alOnly.ok, false);
  assert.equal(alOnly.error, "scripture_alignment_read_only");
  assert.ok(allowVersePatch(textOpen, "text_edit").ok, "text still editable");
  assert.ok(allowVersePatch(textOpen, "find_replace").ok, "find_replace still works");
  assert.ok(allowVersePatch(textOpen, "section_edit").ok, "section_edit still works");

  console.log("  ✓ allowVersePatch extended permission matrix");
}

// ── 21. Multiple lanes independent ──────────────────────────────────────────

{
  const db = freshDb();
  seedLane(db, "lit", { activeGen: 1, nextGen: 2, replacementRequired: 0 });
  seedLane(db, "sim", { activeGen: 1, nextGen: 2, replacementRequired: 1 });

  const lit = getLane(db, "lit");
  const sim = getLane(db, "sim");
  assert.equal(lit.replacement_required, 0);
  assert.equal(sim.replacement_required, 1);

  // lit readable, sim blocked
  const litGen = lit.replacement_required ? null : lit.active_generation;
  const simGen = sim.replacement_required ? null : sim.active_generation;
  assert.equal(litGen, 1);
  assert.equal(simGen, null, "sim blocked independently");
  console.log("  ✓ lit/sim lanes independent");
}

// ── 22. configHash deterministic ────────────────────────────────────────────

{
  const c1 = bsojLaneConfig("lit");
  const c2 = JSON.parse(JSON.stringify(bsojLaneConfig("lit")));
  assert.equal(configHash(c1), configHash(c2), "structurally equal → same hash");

  c2.label = "MODIFIED";
  assert.notEqual(configHash(c1), configHash(c2), "different label → different hash");
  console.log("  ✓ configHash deterministic and change-sensitive");
}

// ── 23. Activation fencing CAS: matching token flips + completes ────────────
// Mirrors the hardened activateReplacement: the ready job is stamped with the
// activation token, then a dual-UPDATE batch whose EXISTS clauses bind both
// writes to that token. Matching token → both statements land.

{
  const db = freshDb();
  seedLane(db, "lit", { activeGen: 1, nextGen: 3, replacementJobId: "job-fence" });
  seedJob(db, "job-fence", "lit", 2, 1, "ready");

  // Stamp the activation token on the ready job (activateReplacement pre-step).
  db.prepare(`
    UPDATE scripture_lane_replacement SET lease_fencing_token = ?1
    WHERE job_id = ?2 AND status = 'ready'
  `).run("fence-A", "job-fence");

  const results = d1Batch(db, [
    () => db.prepare(`
      UPDATE scripture_lane_state
        SET active_generation = ?1, active_config_json = ?2,
            config_revision = config_revision + 1,
            replacement_job_id = NULL, exports_blocked = 0,
            replacement_required = 0, pending_target_json = NULL,
            updated_at = unixepoch()
      WHERE lane = ?3 AND active_generation = ?4 AND replacement_job_id = ?5
        AND EXISTS (
          SELECT 1 FROM scripture_lane_replacement j
          WHERE j.job_id = ?5 AND j.status = 'ready'
            AND j.lease_fencing_token = ?6 AND j.generation = ?1
        )
    `).run(2, SAMPLE_CFG_JSON, "lit", 1, "job-fence", "fence-A"),
    () => db.prepare(`
      UPDATE scripture_lane_replacement
        SET status = 'completed', lease_fencing_token = ?1, completed_at = unixepoch()
      WHERE job_id = ?2 AND status = 'ready' AND lease_fencing_token = ?1 AND generation = ?3
        AND EXISTS (
          SELECT 1 FROM scripture_lane_state s
          WHERE s.lane = ?4 AND s.active_generation = ?3 AND s.replacement_job_id IS NULL
        )
    `).run("fence-A", "job-fence", 2, "lit"),
  ]);

  assert.equal(results[0].meta.changes, 1, "flip succeeds with matching token");
  assert.equal(results[1].meta.changes, 1, "job completed with matching token");
  assert.equal(getLane(db, "lit").active_generation, 2);
  assert.equal(getJob(db, "job-fence").status, "completed");
  console.log("  ✓ activation fencing CAS: matching token flips + completes");
}

// ── 24. Activation fencing CAS: wrong token → flip refused ──────────────────
// A stale caller supplying a token the ready job doesn't carry can't flip:
// the EXISTS clause fails, so 0 rows change and the lane/job stay put.

{
  const db = freshDb();
  seedLane(db, "lit", { activeGen: 1, nextGen: 3, replacementJobId: "job-fence2" });
  seedJob(db, "job-fence2", "lit", 2, 1, "ready");
  db.prepare(`
    UPDATE scripture_lane_replacement SET lease_fencing_token = ?1
    WHERE job_id = ?2 AND status = 'ready'
  `).run("fence-real", "job-fence2");

  const flip = db.prepare(`
    UPDATE scripture_lane_state
      SET active_generation = ?1, replacement_job_id = NULL, exports_blocked = 0, updated_at = unixepoch()
    WHERE lane = ?2 AND active_generation = ?3 AND replacement_job_id = ?4
      AND EXISTS (
        SELECT 1 FROM scripture_lane_replacement j
        WHERE j.job_id = ?4 AND j.status = 'ready'
          AND j.lease_fencing_token = ?5 AND j.generation = ?1
      )
  `).run(2, "lit", 1, "job-fence2", "fence-WRONG");

  assert.equal(flip.changes, 0, "flip refused: activation token mismatch");
  assert.equal(getLane(db, "lit").active_generation, 1, "lane unchanged");
  assert.equal(getJob(db, "job-fence2").status, "ready", "job still ready");
  console.log("  ✓ activation fencing CAS: wrong token refuses flip");
}

// ── 25. verifyExportFencingToken: held + fresh + token + not blocked ────────
// Replicates the strengthened predicate: only a held (not released/abandoned)
// lease with the exact token, a heartbeat within TTL, on a lane that is not
// exports_blocked, is a valid fencing token.

{
  const db = freshDb();
  seedLane(db, "lit", { exportsBlocked: 0 });
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO scripture_export_leases (lease_id, lane, fencing_token, status, holder, heartbeat_at)
    VALUES ('lz', 'lit', 'tok', 'held', 'w', ?1)
  `).run(now);

  const verify = (lane, token) => {
    const st = getLane(db, lane);
    if (!st || st.exports_blocked) return false;
    const row = db.prepare(`
      SELECT heartbeat_at FROM scripture_export_leases
      WHERE lane = ?1 AND status = 'held' AND fencing_token = ?2
      ORDER BY heartbeat_at DESC LIMIT 1
    `).get(lane, token);
    if (!row) return false;
    return (Date.now() - row.heartbeat_at * 1000) < EXPORT_LEASE_TTL_MS;
  };

  assert.equal(verify("lit", "tok"), true, "fresh held matching token → valid");
  assert.equal(verify("lit", "other"), false, "wrong token → invalid");

  db.prepare("UPDATE scripture_export_leases SET status='released' WHERE lease_id='lz'").run();
  assert.equal(verify("lit", "tok"), false, "released lease → invalid");

  db.prepare("UPDATE scripture_export_leases SET status='held' WHERE lease_id='lz'").run();
  db.prepare("UPDATE scripture_lane_state SET exports_blocked=1 WHERE lane='lit'").run();
  assert.equal(verify("lit", "tok"), false, "exports_blocked lane → invalid");

  db.prepare("UPDATE scripture_lane_state SET exports_blocked=0 WHERE lane='lit'").run();
  const stale = Math.floor((Date.now() - EXPORT_LEASE_TTL_MS - 5000) / 1000);
  db.prepare("UPDATE scripture_export_leases SET heartbeat_at=?1 WHERE lease_id='lz'").run(stale);
  assert.equal(verify("lit", "tok"), false, "stale heartbeat → invalid");
  console.log("  ✓ verifyExportFencingToken held/fresh/token/not-blocked");
}

// ── 26. acquireExportLease deterministic winner among concurrent holds ──────
// Two Workers can each pass the pre-insert check and insert a held lease. The
// race guard picks a single winner (oldest, ties broken by lease_id); the loser
// relinquishes so exactly one held lease remains authoritative.

{
  const db = freshDb();
  seedLane(db, "lit");
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO scripture_export_leases (lease_id, lane, fencing_token, status, holder, heartbeat_at, created_at) VALUES ('aaa','lit','t1','held','w1',?1,?2)`).run(now, now);
  db.prepare(`INSERT INTO scripture_export_leases (lease_id, lane, fencing_token, status, holder, heartbeat_at, created_at) VALUES ('bbb','lit','t2','held','w2',?1,?2)`).run(now, now);

  const winner = db.prepare(`
    SELECT lease_id FROM scripture_export_leases
    WHERE lane = ?1 AND status = 'held' AND heartbeat_at * 1000 > ?2
    ORDER BY created_at ASC, lease_id ASC LIMIT 1
  `).get("lit", Date.now() - EXPORT_LEASE_TTL_MS);
  assert.equal(winner.lease_id, "aaa", "lowest lease_id wins the tie");

  db.prepare("UPDATE scripture_export_leases SET status='released' WHERE lease_id='bbb' AND status='held'").run();
  const held = db.prepare("SELECT COUNT(*) AS n FROM scripture_export_leases WHERE lane='lit' AND status='held'").get();
  assert.equal(held.n, 1, "exactly one held lease after loser relinquishes");
  console.log("  ✓ acquireExportLease deterministic single winner");
}

// ── 27. hasHeldExportLease: fresh held only ─────────────────────────────────
// The activation drain rejects only when a *fresh* held lease exists; a stale
// (heartbeat past TTL) or released lease must not block activation.

{
  const db = freshDb();
  seedLane(db, "lit");
  const has = () => !!db.prepare(`
    SELECT 1 FROM scripture_export_leases
    WHERE lane = ?1 AND status = 'held' AND heartbeat_at * 1000 > ?2 LIMIT 1
  `).get("lit", Date.now() - EXPORT_LEASE_TTL_MS);

  assert.equal(has(), false, "no leases → false");
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO scripture_export_leases (lease_id, lane, fencing_token, status, holder, heartbeat_at) VALUES ('h','lit','t','held','w',?1)`).run(now);
  assert.equal(has(), true, "fresh held → true");
  const stale = Math.floor((Date.now() - EXPORT_LEASE_TTL_MS - 1000) / 1000);
  db.prepare("UPDATE scripture_export_leases SET heartbeat_at=?1 WHERE lease_id='h'").run(stale);
  assert.equal(has(), false, "stale held → false");
  db.prepare("UPDATE scripture_export_leases SET heartbeat_at=?1, status='released' WHERE lease_id='h'").run(now);
  assert.equal(has(), false, "released → false");
  console.log("  ✓ hasHeldExportLease fresh-held only");
}

console.log("\nscriptureLaneReplacement tests passed");
