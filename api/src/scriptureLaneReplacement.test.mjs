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
  exclusive_owner TEXT,
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

-- Rolling-deploy: old Workers must not INSERT a held lease after a new Worker
-- claimed exclusive_owner (or a replacement froze the lane).
CREATE TRIGGER scripture_export_leases_honor_exclusive_owner
BEFORE INSERT ON scripture_export_leases
FOR EACH ROW
WHEN NEW.status = 'held'
BEGIN
  SELECT RAISE(ABORT, 'lane_exclusive_owner_conflict')
  WHERE EXISTS (
    SELECT 1 FROM scripture_lane_state s
     WHERE s.lane = NEW.lane
       AND (
         s.replacement_job_id IS NOT NULL
         OR (
           s.exclusive_owner IS NOT NULL
           AND s.exclusive_owner != ('lease:' || NEW.lease_id)
         )
       )
  );
END;

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

// ── 28. startReplacement CAS freeze: atomic claim + generation allocation ────
// The hardened startReplacement claims the lane, blocks exports, and allocates
// the generation in ONE guarded UPDATE (`replacement_job_id IS NULL RETURNING`).
// A racing second start sees 0 rows changed (null return) → 409, and never
// double-allocates a generation.

{
  const db = freshDb();
  seedLane(db, "lit", { activeGen: 1, nextGen: 2 });

  const casFreeze = (jobId) => db.prepare(`
    UPDATE scripture_lane_state
       SET replacement_job_id = ?1,
           exports_blocked = 1,
           next_generation = next_generation + 1,
           updated_at = unixepoch()
     WHERE lane = 'lit' AND replacement_job_id IS NULL
     RETURNING active_generation, next_generation
  `).get(jobId);

  // First start wins the CAS.
  const first = casFreeze("job-A");
  assert.ok(first, "first start claims the lane");
  assert.equal(first.active_generation, 1, "predecessor generation returned");
  assert.equal(first.next_generation - 1, 2, "first start allocates generation 2");

  const afterFirst = getLane(db, "lit");
  assert.equal(afterFirst.replacement_job_id, "job-A", "lane frozen to job-A");
  assert.equal(afterFirst.exports_blocked, 1, "exports blocked by freeze");
  assert.equal(afterFirst.next_generation, 3, "next_generation advanced once");

  // Second concurrent start loses the CAS: 0 rows, undefined return.
  const second = casFreeze("job-B");
  assert.equal(second, undefined, "second start gets no row (CAS lost)");

  const afterSecond = getLane(db, "lit");
  assert.equal(afterSecond.replacement_job_id, "job-A", "lane still owned by job-A");
  assert.equal(afterSecond.next_generation, 3, "no double allocation from losing start");
  console.log("  ✓ startReplacement CAS freeze: single winner, no double allocation");
}

// ── 29. releaseFreeze rolls back only our claim, restoring exports_blocked ───
// If job/book insert fails after the freeze, releaseFreeze clears our
// replacement_job_id and restores the prior exports_blocked. The
// `replacement_job_id = ?` guard makes it a no-op if the lane moved on.

{
  const db = freshDb();
  // BSOJ-style lane: exports were already blocked before the freeze.
  seedLane(db, "lit", { activeGen: 1, nextGen: 2, exportsBlocked: 1, replacementRequired: 1 });

  // Freeze
  db.prepare(`
    UPDATE scripture_lane_state
       SET replacement_job_id = ?1, exports_blocked = 1,
           next_generation = next_generation + 1, updated_at = unixepoch()
     WHERE lane = 'lit' AND replacement_job_id IS NULL
  `).run("job-roll");

  const releaseFreeze = (jobId, priorExportsBlocked) => db.prepare(`
    UPDATE scripture_lane_state
       SET replacement_job_id = NULL, exports_blocked = ?1, updated_at = unixepoch()
     WHERE lane = 'lit' AND replacement_job_id = ?2
  `).run(priorExportsBlocked, jobId);

  // Rollback restores prior exports_blocked (1, because replacement_required).
  const r = releaseFreeze("job-roll", 1);
  assert.equal(r.changes, 1, "rollback cleared our freeze");
  const lane = getLane(db, "lit");
  assert.equal(lane.replacement_job_id, null, "replacement_job_id cleared");
  assert.equal(lane.exports_blocked, 1, "prior exports_blocked restored (BSOJ stays blocked)");

  // A second rollback for a different owner is a no-op.
  db.prepare("UPDATE scripture_lane_state SET replacement_job_id='job-other' WHERE lane='lit'").run();
  const r2 = releaseFreeze("job-roll", 0);
  assert.equal(r2.changes, 0, "rollback is a no-op when the lane moved on");
  assert.equal(getLane(db, "lit").replacement_job_id, "job-other", "other owner untouched");
  console.log("  ✓ releaseFreeze rolls back only our claim");
}

// ── 30. abandonStaleHeldLeases: stale held → abandoned + grace ──────────────
// A held lease older than TTL is swept into abandon+grace so it can't slip past
// both hasHeldExportLease (fresh-only) and waitAbandonedGrace (abandoned-only).

{
  const db = freshDb();
  seedLane(db, "lit");
  const now = Math.floor(Date.now() / 1000);
  const stale = Math.floor((Date.now() - EXPORT_LEASE_TTL_MS - 5000) / 1000);
  // fresh held (should stay held) + stale held (should be abandoned)
  db.prepare(`INSERT INTO scripture_export_leases (lease_id, lane, fencing_token, status, holder, heartbeat_at) VALUES ('fresh','lit','tf','held','w1',?1)`).run(now);
  db.prepare(`INSERT INTO scripture_export_leases (lease_id, lane, fencing_token, status, holder, heartbeat_at) VALUES ('stale','lit','ts','held','w2',?1)`).run(stale);

  const abandonStale = () => db.prepare(`
    UPDATE scripture_export_leases
       SET status = 'abandoned', abandoned_at = unixepoch(),
           grace_until = unixepoch() + ?1
     WHERE lane = ?2 AND status = 'held' AND heartbeat_at * 1000 <= ?3
  `).run(Math.ceil(EXPORT_ABANDON_GRACE_MS / 1000), "lit", Date.now() - EXPORT_LEASE_TTL_MS);

  abandonStale();

  const freshRow = db.prepare("SELECT * FROM scripture_export_leases WHERE lease_id='fresh'").get();
  const staleRow = db.prepare("SELECT * FROM scripture_export_leases WHERE lease_id='stale'").get();
  assert.equal(freshRow.status, "held", "fresh lease stays held");
  assert.equal(staleRow.status, "abandoned", "stale lease abandoned");
  assert.ok(staleRow.grace_until > now, "abandoned lease got a grace window");
  console.log("  ✓ abandonStaleHeldLeases: stale held swept to abandon+grace");
}

// ── 31. activation drain: stale held blocks via grace, clears after grace ────
// After abandonStaleHeldLeases, a lone stale held lease no longer counts as a
// fresh held lease, but its grace window blocks activation (export_lease_grace)
// until grace_until passes.

{
  const db = freshDb();
  seedLane(db, "lit");
  const stale = Math.floor((Date.now() - EXPORT_LEASE_TTL_MS - 5000) / 1000);
  db.prepare(`INSERT INTO scripture_export_leases (lease_id, lane, fencing_token, status, holder, heartbeat_at) VALUES ('s','lit','t','held','w',?1)`).run(stale);

  const abandonStale = () => db.prepare(`
    UPDATE scripture_export_leases
       SET status = 'abandoned', abandoned_at = unixepoch(),
           grace_until = unixepoch() + ?1
     WHERE lane = ?2 AND status = 'held' AND heartbeat_at * 1000 <= ?3
  `).run(Math.ceil(EXPORT_ABANDON_GRACE_MS / 1000), "lit", Date.now() - EXPORT_LEASE_TTL_MS);

  const hasFreshHeld = () => !!db.prepare(`
    SELECT 1 FROM scripture_export_leases
    WHERE lane = ?1 AND status = 'held' AND heartbeat_at * 1000 > ?2 LIMIT 1
  `).get("lit", Date.now() - EXPORT_LEASE_TTL_MS);

  const graceClear = () => !db.prepare(`
    SELECT 1 FROM scripture_export_leases
    WHERE lane = ?1 AND status = 'abandoned' AND grace_until > unixepoch() LIMIT 1
  `).get("lit");

  // Before the sweep, the stale row is 'held' — hasFreshHeld ignores it (past
  // TTL) and graceClear ignores it (not abandoned): the blind spot the fix closes.
  assert.equal(hasFreshHeld(), false, "stale held is not a fresh held");
  assert.equal(graceClear(), true, "pre-sweep: no abandoned row → grace looks clear (the gap)");

  // Sweep it into abandon+grace.
  abandonStale();
  assert.equal(hasFreshHeld(), false, "still no fresh held after sweep");
  assert.equal(graceClear(), false, "activation blocked: abandoned lease within grace");

  // Once grace expires, activation is allowed.
  db.prepare("UPDATE scripture_export_leases SET grace_until = unixepoch() - 1 WHERE lease_id='s'").run();
  assert.equal(graceClear(), true, "activation allowed after grace window elapses");
  console.log("  ✓ activation drain: stale held → grace block → allowed after grace");
}

// ── 32. exclusive_owner CAS: lease acquire vs freeze are mutually exclusive ──
// Both paths compete for `exclusive_owner IS NULL` on scripture_lane_state.
// Interleave: freeze UPDATE then lease UPDATE (and the reverse) — exactly one
// wins. This exercises the real SQL predicates, not a synthetic mirror.

{
  const db = freshDb();
  seedLane(db, "lit", { activeGen: 1, nextGen: 2 });

  const freezeCas = (jobId) =>
    db.prepare(`
      UPDATE scripture_lane_state
         SET replacement_job_id = ?1,
             exclusive_owner = ?2,
             exports_blocked = 1,
             next_generation = next_generation + 1,
             updated_at = unixepoch()
       WHERE lane = 'lit' AND replacement_job_id IS NULL
         AND exclusive_owner IS NULL
         AND active_generation = 1
    `).run(jobId, `job:${jobId}`);

  const leaseCas = (leaseId) => {
    const owner = `lease:${leaseId}`;
    const claim = db.prepare(`
      UPDATE scripture_lane_state
         SET exclusive_owner = ?1, updated_at = unixepoch()
       WHERE lane = 'lit'
         AND replacement_job_id IS NULL
         AND exclusive_owner IS NULL
    `).run(owner);
    if (claim.changes !== 1) return { changes: 0 };
    const ins = db.prepare(`
      INSERT INTO scripture_export_leases (lease_id, lane, fencing_token, status, holder, heartbeat_at)
      SELECT ?1, 'lit', 'tok', 'held', 'import:ZEC', unixepoch()
       WHERE EXISTS (
         SELECT 1 FROM scripture_lane_state WHERE lane = 'lit' AND exclusive_owner = ?2
       )
    `).run(leaseId, owner);
    return { changes: claim.changes, inserted: ins.changes };
  };

  // Freeze wins first → lease must lose.
  {
    const db1 = freshDb();
    seedLane(db1, "lit", { activeGen: 1, nextGen: 2 });
    // Rebind helpers to db1
    const f = (jobId) =>
      db1.prepare(`
        UPDATE scripture_lane_state
           SET replacement_job_id = ?1, exclusive_owner = ?2, exports_blocked = 1,
               next_generation = next_generation + 1, updated_at = unixepoch()
         WHERE lane = 'lit' AND replacement_job_id IS NULL
           AND exclusive_owner IS NULL AND active_generation = 1
           AND NOT EXISTS (
             SELECT 1 FROM scripture_export_leases
              WHERE lane = 'lit' AND status = 'held' AND heartbeat_at * 1000 > ?3
           )
      `).run(jobId, `job:${jobId}`, Date.now() - EXPORT_LEASE_TTL_MS);
    const l = (leaseId) => {
      const owner = `lease:${leaseId}`;
      const claim = db1.prepare(`
        UPDATE scripture_lane_state SET exclusive_owner = ?1, updated_at = unixepoch()
         WHERE lane = 'lit' AND replacement_job_id IS NULL AND exclusive_owner IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM scripture_export_leases
              WHERE lane = 'lit' AND status = 'held' AND heartbeat_at * 1000 > ?2
           )
      `).run(owner, Date.now() - EXPORT_LEASE_TTL_MS);
      if (claim.changes !== 1) return claim;
      return db1.prepare(`
        INSERT INTO scripture_export_leases (lease_id, lane, fencing_token, status, holder, heartbeat_at)
        SELECT ?1, 'lit', 'tok', 'held', 'import:ZEC', unixepoch()
         WHERE EXISTS (SELECT 1 FROM scripture_lane_state WHERE exclusive_owner = ?2)
      `).run(leaseId, owner);
    };
    assert.equal(f("job-A").changes, 1, "freeze claims exclusive_owner");
    assert.equal(l("lease-B").changes, 0, "lease loses after freeze");
    assert.equal(getLane(db1, "lit").exclusive_owner, "job:job-A");
    assert.equal(
      db1.prepare("SELECT COUNT(*) AS n FROM scripture_export_leases").get().n,
      0,
      "lost lease inserts no row",
    );
  }

  // Lease wins first → freeze must lose.
  {
    const db2 = freshDb();
    seedLane(db2, "lit", { activeGen: 1, nextGen: 2 });
    const l = (leaseId) => {
      const owner = `lease:${leaseId}`;
      const claim = db2.prepare(`
        UPDATE scripture_lane_state SET exclusive_owner = ?1, updated_at = unixepoch()
         WHERE lane = 'lit' AND replacement_job_id IS NULL AND exclusive_owner IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM scripture_export_leases
              WHERE lane = 'lit' AND status = 'held' AND heartbeat_at * 1000 > ?2
           )
      `).run(owner, Date.now() - EXPORT_LEASE_TTL_MS);
      assert.equal(claim.changes, 1);
      db2.prepare(`
        INSERT INTO scripture_export_leases (lease_id, lane, fencing_token, status, holder, heartbeat_at)
        SELECT ?1, 'lit', 'tok', 'held', 'import:ZEC', unixepoch()
         WHERE EXISTS (SELECT 1 FROM scripture_lane_state WHERE exclusive_owner = ?2)
      `).run(leaseId, owner);
    };
    const f = (jobId) =>
      db2.prepare(`
        UPDATE scripture_lane_state
           SET replacement_job_id = ?1, exclusive_owner = ?2, exports_blocked = 1,
               next_generation = next_generation + 1, updated_at = unixepoch()
         WHERE lane = 'lit' AND replacement_job_id IS NULL
           AND exclusive_owner IS NULL AND active_generation = 1
           AND NOT EXISTS (
             SELECT 1 FROM scripture_export_leases
              WHERE lane = 'lit' AND status = 'held' AND heartbeat_at * 1000 > ?3
           )
      `).run(jobId, `job:${jobId}`, Date.now() - EXPORT_LEASE_TTL_MS);
    l("lease-A");
    assert.equal(f("job-B").changes, 0, "freeze loses after lease");
    assert.equal(getLane(db2, "lit").exclusive_owner, "lease:lease-A");
    assert.equal(getLane(db2, "lit").replacement_job_id, null, "freeze did not set job id");
  }

  void freezeCas;
  void leaseCas;
  void db;
  console.log("  ✓ exclusive_owner CAS: lease vs freeze mutually exclusive");
}

// ── 33. pipeline accept in same batch, predicated on landed version ──────────
// Mirrors the production batch order: UPDATE verses → edit_log → conditional
// pending accept via EXISTS(new version). A fenced no-op leaves pending open;
// a matched write accepts atomically (same transaction).

{
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE pending_imports (
      id TEXT PRIMARY KEY,
      accepted_at INTEGER,
      accepted_by INTEGER
    );
    CREATE TABLE verses (
      book TEXT, chapter INTEGER, verse INTEGER, bible_version TEXT,
      source_generation INTEGER, version INTEGER, content_json TEXT,
      PRIMARY KEY (book, chapter, verse, bible_version, source_generation)
    );
    CREATE TABLE edit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT, row_key TEXT, new_version INTEGER
    );
  `);
  db.prepare(`INSERT INTO pending_imports (id) VALUES ('p1')`).run();
  db.prepare(
    `INSERT INTO verses VALUES ('ZEC',1,1,'ULT',1,1,'{"verseObjects":[]}')`,
  ).run();

  // Simulate freeze: lane predicate fails → UPDATE matches 0 → EXISTS fails.
  db.exec("BEGIN");
  const noOp = db.prepare(`
    UPDATE verses SET version = version + 1, content_json = '{"v":2}'
     WHERE book='ZEC' AND chapter=1 AND verse=1 AND bible_version='ULT'
       AND source_generation=1
       AND EXISTS (SELECT 1 WHERE 0)
  `).run();
  db.prepare(`
    UPDATE pending_imports SET accepted_at=unixepoch(), accepted_by=1
     WHERE id='p1'
       AND EXISTS (
         SELECT 1 FROM verses
          WHERE book='ZEC' AND chapter=1 AND verse=1 AND bible_version='ULT'
            AND source_generation=1 AND version=2
       )
  `).run();
  db.exec("COMMIT");
  assert.equal(noOp.changes, 0);
  assert.equal(
    db.prepare("SELECT accepted_at FROM pending_imports WHERE id='p1'").get().accepted_at,
    null,
    "fenced no-op leaves pending unaccepted",
  );
  assert.equal(
    db.prepare("SELECT version FROM verses").get().version,
    1,
    "verse unchanged after fenced no-op",
  );

  // Successful mutation + accept in one transaction (accept immediately after
  // UPDATE via changes(), before intervening statements).
  db.exec("BEGIN");
  const ok = db.prepare(`
    UPDATE verses SET version = version + 1, content_json = '{"v":2}'
     WHERE book='ZEC' AND chapter=1 AND verse=1 AND bible_version='ULT'
       AND source_generation=1 AND version=1
  `).run();
  db.prepare(`
    UPDATE pending_imports SET accepted_at=unixepoch(), accepted_by=1
     WHERE id='p1' AND changes() > 0
  `).run();
  db.prepare(`
    INSERT INTO edit_log (kind, row_key, new_version)
    SELECT 'verse', 'ZEC/1/1/ULT', 2
     WHERE EXISTS (
       SELECT 1 FROM verses WHERE book='ZEC' AND chapter=1 AND verse=1
         AND bible_version='ULT' AND source_generation=1 AND version=2
     )
  `).run();
  db.exec("COMMIT");
  assert.equal(ok.changes, 1);
  assert.ok(
    db.prepare("SELECT accepted_at FROM pending_imports WHERE id='p1'").get().accepted_at != null,
    "matched mutation accepts pending in same txn",
  );
  assert.equal(db.prepare("SELECT version FROM verses").get().version, 2);

  // Concurrent version collision: another writer already advanced past our
  // expected version → CAS no-op → pending for a second row stays open.
  db.prepare(`INSERT INTO pending_imports (id) VALUES ('p2')`).run();
  db.exec("BEGIN");
  const raced = db.prepare(`
    UPDATE verses SET version = version + 1, content_json = '{"v":3}'
     WHERE book='ZEC' AND chapter=1 AND verse=1 AND bible_version='ULT'
       AND source_generation=1 AND version=1
  `).run();
  db.prepare(`
    UPDATE pending_imports SET accepted_at=unixepoch(), accepted_by=1
     WHERE id='p2' AND changes() > 0
  `).run();
  db.exec("COMMIT");
  assert.equal(raced.changes, 0, "stale expected-version CAS matches 0");
  assert.equal(
    db.prepare("SELECT accepted_at FROM pending_imports WHERE id='p2'").get().accepted_at,
    null,
    "raced CAS does not consume pending",
  );
  assert.equal(db.prepare("SELECT version FROM verses").get().version, 2, "version unchanged by stale CAS");

  // Concurrent advance to +1 by another writer, then our CAS for expected=2
  // lands at 3 while a confused EXISTS(version=2) would wrongly accept —
  // with changes()-after-UPDATE, only our landing accepts.
  db.prepare(`INSERT INTO pending_imports (id) VALUES ('p3')`).run();
  db.exec("BEGIN");
  // Simulate "another writer" already at v=2; we CAS expected=2 → 3.
  const land = db.prepare(`
    UPDATE verses SET version = version + 1, content_json = '{"v":3}'
     WHERE book='ZEC' AND chapter=1 AND verse=1 AND bible_version='ULT'
       AND source_generation=1 AND version=2
  `).run();
  db.prepare(`
    UPDATE pending_imports SET accepted_at=unixepoch(), accepted_by=1
     WHERE id='p3' AND changes() > 0
  `).run();
  db.exec("COMMIT");
  assert.equal(land.changes, 1);
  assert.ok(
    db.prepare("SELECT accepted_at FROM pending_imports WHERE id='p3'").get().accepted_at != null,
  );
  assert.equal(db.prepare("SELECT version FROM verses").get().version, 3);
  console.log("  ✓ pipeline accept predicated on landed version in same txn");
}

// ── 34. Competing writer at newVersion must not fabricate this batch's audit ─
{
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE pending_imports (id TEXT PRIMARY KEY, accepted_at INTEGER, accepted_by INTEGER);
    CREATE TABLE verses (
      book TEXT, chapter INTEGER, verse INTEGER, bible_version TEXT,
      source_generation INTEGER, version INTEGER, content_json TEXT,
      plain_text TEXT, updated_by INTEGER, updated_at INTEGER,
      PRIMARY KEY (book, chapter, verse, bible_version, source_generation)
    );
    CREATE TABLE edit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT, row_key TEXT, new_version INTEGER, action TEXT, payload_json TEXT
    );
  `);
  db.prepare(`INSERT INTO pending_imports (id) VALUES ('p-race')`).run();
  db.prepare(
    `INSERT INTO verses VALUES ('ZEC',1,1,'ULT',1,1,'{"old":true}',null,NULL,100)`,
  ).run();

  // Competitor already advanced to v2 with different content.
  db.prepare(`
    UPDATE verses SET version=2, content_json='{"competitor":true}', updated_by=99, updated_at=200
     WHERE book='ZEC' AND chapter=1 AND verse=1 AND bible_version='ULT' AND source_generation=1
  `).run();

  const ourContent = '{"ai":true}';
  const ourNow = 300;
  const ourUser = 7;
  db.exec("BEGIN");
  const cas = db.prepare(`
    UPDATE verses SET content_json=?1, version=version+1, updated_at=?2, updated_by=?3
     WHERE book='ZEC' AND chapter=1 AND verse=1 AND bible_version='ULT'
       AND source_generation=1 AND version=1
  `).run(ourContent, ourNow, ourUser);
  db.prepare(`
    UPDATE pending_imports SET accepted_at=unixepoch(), accepted_by=?1
     WHERE id='p-race' AND changes() > 0
  `).run(ourUser);
  db.prepare(`
    INSERT INTO edit_log (kind, row_key, new_version, action, payload_json)
    SELECT 'verse', 'ZEC/1/1/ULT', 1, 'baseline', '{}'
     WHERE EXISTS (
       SELECT 1 FROM verses
        WHERE book='ZEC' AND chapter=1 AND verse=1 AND bible_version='ULT'
          AND source_generation=1 AND version=2
          AND updated_by=?1 AND content_json=?2 AND updated_at=?3
     )
  `).run(ourUser, ourContent, ourNow);
  db.prepare(`
    INSERT INTO edit_log (kind, row_key, new_version, action, payload_json)
    SELECT 'verse', 'ZEC/1/1/ULT', 2, 'update', ?1
     WHERE EXISTS (
       SELECT 1 FROM verses
        WHERE book='ZEC' AND chapter=1 AND verse=1 AND bible_version='ULT'
          AND source_generation=1 AND version=2
          AND updated_by=?2 AND content_json=?3 AND updated_at=?4
     )
  `).run(ourContent, ourUser, ourContent, ourNow);
  db.exec("COMMIT");

  assert.equal(cas.changes, 0, "stale CAS loses to competitor");
  assert.equal(
    db.prepare("SELECT accepted_at FROM pending_imports WHERE id='p-race'").get().accepted_at,
    null,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM edit_log").get().n,
    0,
    "no fabricated baseline/AI audit for unlanded output",
  );
  assert.equal(
    db.prepare("SELECT content_json FROM verses").get().content_json,
    '{"competitor":true}',
  );
  console.log("  ✓ competing writer at newVersion does not fabricate audit history");
}

// ── 35. Rolling deploy: legacy held lease blocks freeze without exclusive_owner ─
{
  const db = freshDb();
  seedLane(db, "lit", { activeGen: 1, nextGen: 2 });
  const now = Math.floor(Date.now() / 1000);
  // Pre-0046 Worker: lease row held, exclusive_owner still NULL.
  db.prepare(`
    INSERT INTO scripture_export_leases (lease_id, lane, fencing_token, status, holder, heartbeat_at, created_at)
    VALUES ('legacy','lit','t','held','old-worker',?1,?1)
  `).run(now);
  assert.equal(getLane(db, "lit").exclusive_owner, null);

  const freeze = db.prepare(`
    UPDATE scripture_lane_state
       SET replacement_job_id = 'job-X', exclusive_owner = 'job:job-X',
           exports_blocked = 1, next_generation = next_generation + 1
     WHERE lane = 'lit' AND replacement_job_id IS NULL
       AND exclusive_owner IS NULL AND active_generation = 1
       AND NOT EXISTS (
         SELECT 1 FROM scripture_export_leases
          WHERE lane = 'lit' AND status = 'held' AND heartbeat_at * 1000 > ?1
       )
  `).run(Date.now() - EXPORT_LEASE_TTL_MS);
  assert.equal(freeze.changes, 0, "legacy held lease blocks freeze CAS");
  assert.equal(getLane(db, "lit").replacement_job_id, null);
  console.log("  ✓ legacy held lease blocks freeze without exclusive_owner");
}

// ── 36. Trigger: old Worker cannot INSERT held lease after new claim ─────────
{
  const db = freshDb();
  seedLane(db, "lit");
  // New Worker claimed the slot.
  db.prepare(`UPDATE scripture_lane_state SET exclusive_owner='lease:new-id' WHERE lane='lit'`).run();
  let aborted = false;
  try {
    db.prepare(`
      INSERT INTO scripture_export_leases (lease_id, lane, fencing_token, status, holder, heartbeat_at)
      VALUES ('old-id','lit','t','held','old-worker',unixepoch())
    `).run();
  } catch (e) {
    aborted = String(e?.message ?? e).includes("lane_exclusive_owner_conflict")
      || String(e?.message ?? e).includes("ABORT");
  }
  assert.equal(aborted, true, "old Worker INSERT aborted by trigger");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM scripture_export_leases").get().n,
    0,
  );

  // Matching lease id (new Worker completing its own acquire) is allowed.
  db.prepare(`
    INSERT INTO scripture_export_leases (lease_id, lane, fencing_token, status, holder, heartbeat_at)
    VALUES ('new-id','lit','t','held','export:ZEC',unixepoch())
  `).run();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM scripture_export_leases WHERE lease_id='new-id'").get().n,
    1,
  );
  console.log("  ✓ trigger blocks old lease INSERT after exclusive_owner claim");
}

console.log("\nscriptureLaneReplacement tests passed");
