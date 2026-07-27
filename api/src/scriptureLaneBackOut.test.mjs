// scriptureLaneBackOut.test.mjs — backOutReplacement staged-row cleanup (issue #102).
//
// Runs the REAL backOutReplacement from scriptureLaneReplacement.ts against a
// thin D1 adapter over node:sqlite (same shape as scriptureLaneCarryForward).
// The bug: Cancel & Revert unfroze the lane but left the abandoned generation's
// staged verses/book_usfm_meta/book_resource_syncs rows behind forever.

import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import test from "node:test";

import { backOutReplacement } from "./scriptureLaneReplacement.ts";

// ── D1 adapter over node:sqlite ───────────────────────────────────────────────

function makeEnv(db) {
  function bound(sql, params) {
    return {
      first() {
        return db.prepare(sql).get(...params) ?? null;
      },
      all() {
        return { results: db.prepare(sql).all(...params) };
      },
      run() {
        const r = db.prepare(sql).run(...params);
        return { meta: { changes: Number(r.changes) } };
      },
    };
  }
  const DB = {
    prepare(sql) {
      return {
        bind(...params) {
          return bound(sql, params);
        },
        first() {
          return db.prepare(sql).get() ?? null;
        },
        all() {
          return { results: db.prepare(sql).all() };
        },
        run() {
          const r = db.prepare(sql).run();
          return { meta: { changes: Number(r.changes) } };
        },
      };
    },
    async batch(stmts) {
      const results = [];
      db.exec("BEGIN");
      try {
        for (const s of stmts) results.push(s.run());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return results;
    },
  };
  return { DB };
}

// ── Schema (current migration shape) ──────────────────────────────────────────

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

CREATE TABLE book_usfm_meta (
  book TEXT NOT NULL,
  bible_version TEXT NOT NULL,
  source_generation INTEGER NOT NULL DEFAULT 1,
  headers_json TEXT NOT NULL,
  created_by_job_id TEXT,
  PRIMARY KEY (book, bible_version, source_generation)
);

CREATE TABLE book_resource_syncs (
  book TEXT NOT NULL,
  resource TEXT NOT NULL,
  source_generation INTEGER NOT NULL DEFAULT 1,
  source_owner TEXT NOT NULL DEFAULT 'unfoldingWord',
  source_repo TEXT NOT NULL DEFAULT '',
  source_ref TEXT NOT NULL DEFAULT 'master',
  source_sha TEXT,
  synced_at INTEGER NOT NULL DEFAULT (unixepoch()),
  origin TEXT NOT NULL,
  PRIMARY KEY (book, resource, source_generation, source_owner, source_repo, source_ref)
);
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

const JOB = "job-backout-102";
// 'lit' lane → bible_version 'ULT', book_resource_syncs.resource 'ult'.
const BV = "ULT";
const CFG = JSON.stringify({
  source: { owner: "unfoldingWord", repo: "en_ult", ref: "master" },
});

/** Lane frozen mid-staging: gen 1 active, gen 2 staged by JOB. */
function freshDb({ jobStatus = "staging", activeGen = 1, jobGen = 2 } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.prepare(
    `INSERT INTO scripture_lane_state (
       lane, active_generation, next_generation, active_config_json,
       replacement_job_id, exclusive_owner, exports_blocked,
       replacement_required, pending_target_json
     ) VALUES ('lit', ?1, 3, ?2, ?3, ?4, 1, 1, ?2)`,
  ).run(activeGen, CFG, JOB, `job:${JOB}`);
  db.prepare(
    `INSERT INTO scripture_lane_replacement (
       job_id, lane, generation, predecessor_generation,
       predecessor_config_hash, pending_config_json, required_books_json, status
     ) VALUES (?1, 'lit', ?2, 1, 'hash-prior', ?3, '["RUT"]', ?4)`,
  ).run(JOB, jobGen, CFG, jobStatus);
  return db;
}

/** RUT: 3 verses in `gen`, attributed to `jobId` when staged. */
function seedBook(db, gen, jobId) {
  for (let v = 1; v <= 3; v++) {
    db.prepare(
      `INSERT INTO verses (book, chapter, verse, bible_version, source_generation,
                           content_json, created_by_job_id)
       VALUES ('RUT', 1, ?1, ?2, ?3, '{"verseObjects":[]}', ?4)`,
    ).run(v, BV, gen, jobId);
  }
  db.prepare(
    `INSERT INTO book_usfm_meta (book, bible_version, source_generation, headers_json, created_by_job_id)
     VALUES ('RUT', ?1, ?2, '{"h":"Ruth"}', ?3)`,
  ).run(BV, gen, jobId);
  db.prepare(
    `INSERT INTO book_resource_syncs (book, resource, source_generation, source_repo, origin)
     VALUES ('RUT', 'ult', ?1, 'en_ult', 'dcs')`,
  ).run(gen);
}

function counts(db, gen) {
  const n = (sql) => db.prepare(sql).get(gen).n;
  return {
    verses: n(`SELECT COUNT(*) AS n FROM verses WHERE source_generation = ?`),
    meta: n(`SELECT COUNT(*) AS n FROM book_usfm_meta WHERE source_generation = ?`),
    syncs: n(`SELECT COUNT(*) AS n FROM book_resource_syncs WHERE source_generation = ?`),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("back-out deletes the abandoned generation's staged rows, keeps gen-1", async () => {
  const db = freshDb();
  seedBook(db, 1, null); // pre-existing active content
  seedBook(db, 2, JOB); // staged, about to be abandoned
  assert.deepEqual(counts(db, 2), { verses: 3, meta: 1, syncs: 1 }, "staged rows seeded");

  await backOutReplacement(makeEnv(db), JOB);

  assert.deepEqual(counts(db, 2), { verses: 0, meta: 0, syncs: 0 }, "gen-2 orphans purged");
  assert.deepEqual(counts(db, 1), { verses: 3, meta: 1, syncs: 1 }, "gen-1 content preserved");

  const lane = db.prepare(`SELECT * FROM scripture_lane_state WHERE lane = 'lit'`).get();
  assert.equal(lane.active_generation, 1, "active_generation untouched");
  assert.equal(lane.replacement_job_id, null, "job detached");
  assert.equal(lane.exclusive_owner, null, "exclusive_owner cleared");
  assert.equal(lane.exports_blocked, 0, "exports unblocked");
  assert.equal(lane.replacement_required, 0, "replacement_required cleared");
  assert.equal(lane.pending_target_json, null, "pending target cleared");
  assert.equal(
    db.prepare(`SELECT status FROM scripture_lane_replacement WHERE job_id = ?`).get(JOB).status,
    "cancelled",
  );
});

test("back-out is idempotent — a second call leaves gen-1 alone", async () => {
  const db = freshDb();
  seedBook(db, 1, null);
  seedBook(db, 2, JOB);

  const env = makeEnv(db);
  await backOutReplacement(env, JOB);
  await backOutReplacement(env, JOB); // already 'cancelled' → early return

  assert.deepEqual(counts(db, 1), { verses: 3, meta: 1, syncs: 1 }, "gen-1 survives replay");
  assert.deepEqual(counts(db, 2), { verses: 0, meta: 0, syncs: 0 });
});

test("back-out never deletes rows in the ACTIVE generation", async () => {
  // Pathological: the job's generation IS the active one. Cleanup must bail
  // rather than delete live content.
  const db = freshDb({ activeGen: 2, jobGen: 2 });
  seedBook(db, 2, JOB);

  await backOutReplacement(makeEnv(db), JOB);

  assert.deepEqual(counts(db, 2), { verses: 3, meta: 1, syncs: 1 }, "active gen untouched");
});

test("back-out deletes nothing once the lane has been detached from the job", async () => {
  // Races activateReplacement: it flips active_generation to this job's
  // generation and clears replacement_job_id. A back-out holding a stale read
  // of the job must not purge the generation the lane now serves — the guard
  // lives inside the DELETE predicates, so a flip that lands mid-flight wins.
  const db = freshDb({ jobStatus: "ready" });
  seedBook(db, 2, JOB);
  db.prepare(
    `UPDATE scripture_lane_state
        SET active_generation = 2, replacement_job_id = NULL, exclusive_owner = NULL
      WHERE lane = 'lit'`,
  ).run();

  await backOutReplacement(makeEnv(db), JOB);

  assert.deepEqual(
    counts(db, 2),
    { verses: 3, meta: 1, syncs: 1 },
    "activated generation survives a racing back-out",
  );
  assert.equal(
    db.prepare(`SELECT active_generation FROM scripture_lane_state WHERE lane='lit'`).get()
      .active_generation,
    2,
  );
});

test("a completed job cannot be backed out (staged rows stay)", async () => {
  const db = freshDb({ jobStatus: "completed" });
  seedBook(db, 2, JOB);

  await assert.rejects(() => backOutReplacement(makeEnv(db), JOB), /job_terminal/);
  assert.deepEqual(counts(db, 2), { verses: 3, meta: 1, syncs: 1 }, "no deletion on refusal");
});
