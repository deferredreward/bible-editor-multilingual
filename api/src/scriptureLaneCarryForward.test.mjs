// scriptureLaneCarryForward.test.mjs — copyBookForward (issue #94, PR-1).
//
// Runs the REAL copyBookForward from scriptureLane.ts against a thin D1 adapter
// over node:sqlite (same shape as projectConfigApply.test.mjs / articlePopulate).
// scriptureLane.ts is importable under --experimental-strip-types (its sibling
// scriptureLaneReplacement.ts is not), which is exactly why copyBookForward
// lives here rather than in the FSM module — it can be unit-tested directly.
//
// The schema mirrors the current migrations: scripture_lane_replacement_books
// as of 0043 (+ 'staging') / 0045 (+ staging_claim_token) / 0059 (+ mode,
// + 'carried_forward'); verses/book_usfm_meta with created_by_job_id (0042);
// book_resource_syncs with source_repo in the PK (0044).

import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import test from "node:test";

import { copyBookForward, laneBookStats } from "./scriptureLane.ts";

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
    'pending', 'staging', 'artifact_ok', 'carried_forward',
    'retryable_error', 'failed', 'absent_authorized'
  )),
  mode TEXT NOT NULL DEFAULT 'staged' CHECK (mode IN ('staged', 'carry_forward')),
  source_owner TEXT,
  source_repo TEXT,
  source_ref TEXT,
  source_sha TEXT,
  completeness_json TEXT,
  error_json TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  staging_claim_token TEXT,
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

const JOB = "job-cf-1";
// 'sim' lane → bible_version 'UST', resource 'ust'.
const BV = "UST";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

function seedJob(db, opts = {}) {
  const {
    jobId = JOB,
    lane = "sim",
    generation = 2,
    predGen = 1,
    status = "reserved",
  } = opts;
  db.prepare(
    `INSERT INTO scripture_lane_replacement (
       job_id, lane, generation, predecessor_generation,
       predecessor_config_hash, pending_config_json, required_books_json,
       status, created_at
     ) VALUES (?1, ?2, ?3, ?4, 'hash', '{}', '[]', ?5, unixepoch())`,
  ).run(jobId, lane, generation, predGen, status);
}

function seedBook(db, book, opts = {}) {
  const { jobId = JOB, status = "pending", mode = "staged" } = opts;
  db.prepare(
    `INSERT INTO scripture_lane_replacement_books (job_id, book, status, mode, updated_at)
     VALUES (?1, ?2, ?3, ?4, unixepoch())`,
  ).run(jobId, book, status, mode);
}

// Insert `perChapter` verses across `chapters` chapters for a book/generation.
function seedVerses(db, book, { gen = 1, chapters = 3, perChapter = 4, createdByJobId = null } = {}) {
  let n = 0;
  for (let c = 1; c <= chapters; c++) {
    for (let v = 1; v <= perChapter; v++) {
      db.prepare(
        `INSERT INTO verses (book, chapter, verse, bible_version, source_generation, content_json, plain_text, version, created_by_job_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8)`,
      ).run(
        book, c, v, BV, gen,
        JSON.stringify({ ref: `${book} ${c}:${v}`, gen }),
        `${book} ${c}:${v} text`,
        createdByJobId,
      );
      n++;
    }
  }
  return n;
}

function verseCount(db, book, gen, { createdByJobId } = {}) {
  const extra = createdByJobId !== undefined ? ` AND created_by_job_id = '${createdByJobId}'` : "";
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM verses WHERE book = ? AND bible_version = ? AND source_generation = ?${extra}`,
    )
    .get(book, BV, gen).n;
}

function bookRow(db, book, jobId = JOB) {
  return db
    .prepare(`SELECT * FROM scripture_lane_replacement_books WHERE job_id = ? AND book = ?`)
    .get(jobId, book);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("copyBookForward copies the full predecessor generation and marks carried_forward", async () => {
  const db = freshDb();
  const env = makeEnv(db);
  seedJob(db);
  seedBook(db, "MAL");
  const predN = seedVerses(db, "MAL", { gen: 1, chapters: 4, perChapter: 5 });
  db.prepare(
    `INSERT INTO book_usfm_meta (book, bible_version, source_generation, headers_json) VALUES (?, ?, 1, ?)`,
  ).run("MAL", BV, JSON.stringify([{ tag: "h", content: "Malachi" }]));
  db.prepare(
    `INSERT INTO book_resource_syncs (book, resource, source_generation, source_owner, source_repo, source_ref, source_sha, origin)
     VALUES (?, 'ust', 1, 'unfoldingWord', 'en_ust', 'master', 'sha-pred', 'import')`,
  ).run("MAL");

  const res = await copyBookForward(env, JOB, "MAL");
  assert.equal(res.status, "carried_forward");

  // Destination generation now holds an identical, complete copy.
  assert.equal(verseCount(db, "MAL", 2), predN, "dest gen has every predecessor verse");
  assert.equal(verseCount(db, "MAL", 2, { createdByJobId: JOB }), predN, "all attributed to the job");
  // Predecessor generation is untouched.
  assert.equal(verseCount(db, "MAL", 1), predN, "predecessor untouched");

  // Content carried faithfully.
  const c = db
    .prepare(`SELECT content_json, plain_text FROM verses WHERE book='MAL' AND chapter=2 AND verse=3 AND bible_version=? AND source_generation=2`)
    .get(BV);
  assert.equal(JSON.parse(c.content_json).ref, "MAL 2:3");
  assert.equal(c.plain_text, "MAL 2:3 text");

  // Book row: carried_forward + mode carry_forward + completeness marker.
  const row = bookRow(db, "MAL");
  assert.equal(row.status, "carried_forward");
  assert.equal(row.mode, "carry_forward");
  assert.equal(row.error_json, null);
  const comp = JSON.parse(row.completeness_json);
  assert.equal(comp.carriedForward, true);
  assert.equal(comp.verses, predN);
  assert.equal(comp.predecessorVerses, predN);

  // Header + scripture watermark carried forward to the new generation.
  const meta = db.prepare(`SELECT headers_json FROM book_usfm_meta WHERE book='MAL' AND bible_version=? AND source_generation=2`).get(BV);
  assert.ok(meta, "book_usfm_meta carried forward");
  assert.equal(JSON.parse(meta.headers_json)[0].content, "Malachi");
  const sync = db.prepare(`SELECT source_sha FROM book_resource_syncs WHERE book='MAL' AND resource='ust' AND source_generation=2`).get();
  assert.ok(sync, "book_resource_syncs carried forward");
  assert.equal(sync.source_sha, "sha-pred");

  // Job flipped reserved → staging.
  const job = db.prepare(`SELECT status FROM scripture_lane_replacement WHERE job_id=?`).get(JOB);
  assert.equal(job.status, "staging");
});

test("carry-forward preserves edit provenance (version / updated_by / updated_at)", async () => {
  // The whole point of carry-forward is "leave the books I've already edited
  // alone." If the copy dropped updated_by, reimport's `updated_by IS NULL`
  // overwrite-guard would treat a carried translator edit as pristine and
  // clobber it after activation. So the copy MUST preserve edit provenance.
  const db = freshDb();
  const env = makeEnv(db);
  seedJob(db);
  seedBook(db, "MAL");
  seedVerses(db, "MAL", { gen: 1, chapters: 2, perChapter: 3 });
  // Mark MAL 1:2 as a translator edit in the predecessor generation.
  db.prepare(
    `UPDATE verses SET updated_by = 42, version = 5, updated_at = 1700000000
      WHERE book='MAL' AND chapter=1 AND verse=2 AND bible_version=? AND source_generation=1`,
  ).run(BV);

  const res = await copyBookForward(env, JOB, "MAL");
  assert.equal(res.status, "carried_forward");

  const edited = db
    .prepare(`SELECT updated_by, version, updated_at FROM verses WHERE book='MAL' AND chapter=1 AND verse=2 AND bible_version=? AND source_generation=2`)
    .get(BV);
  assert.equal(edited.updated_by, 42, "editor id carried forward (not nulled)");
  assert.equal(edited.version, 5, "version carried forward");
  assert.equal(edited.updated_at, 1700000000, "edit timestamp carried forward");

  // A never-edited verse stays pristine (updated_by NULL) on the new generation.
  const pristine = db
    .prepare(`SELECT updated_by FROM verses WHERE book='MAL' AND chapter=2 AND verse=1 AND bible_version=? AND source_generation=2`)
    .get(BV);
  assert.equal(pristine.updated_by, null, "un-edited verse stays pristine");
});

test("carry-forward is idempotent: a second call is a no-op with no duplicate rows", async () => {
  const db = freshDb();
  const env = makeEnv(db);
  seedJob(db);
  seedBook(db, "MAL");
  const predN = seedVerses(db, "MAL", { gen: 1, chapters: 3, perChapter: 6 });

  const first = await copyBookForward(env, JOB, "MAL");
  assert.equal(first.status, "carried_forward");
  assert.equal(verseCount(db, "MAL", 2), predN);

  // Second call: the book row is no longer claimable → no-op, no duplication.
  const second = await copyBookForward(env, JOB, "MAL");
  assert.equal(second.status, "carried_forward");
  assert.equal(verseCount(db, "MAL", 2), predN, "no duplicate rows after re-run");
});

test("reset-and-rerun re-deletes partial rows and re-copies to an identical complete result", async () => {
  const db = freshDb();
  const env = makeEnv(db);
  seedJob(db);
  seedBook(db, "MAL");
  const predN = seedVerses(db, "MAL", { gen: 1, chapters: 4, perChapter: 4 });

  await copyBookForward(env, JOB, "MAL");
  assert.equal(verseCount(db, "MAL", 2), predN);

  // Reset the book to pending (as a retry would) and re-run.
  db.prepare(`UPDATE scripture_lane_replacement_books SET status='pending' WHERE job_id=? AND book='MAL'`).run(JOB);
  const again = await copyBookForward(env, JOB, "MAL");
  assert.equal(again.status, "carried_forward");
  assert.equal(verseCount(db, "MAL", 2), predN, "exactly predecessor count, no dupes after re-copy");
});

test("fails closed when the destination cannot be fully copied", async () => {
  const db = freshDb();
  const env = makeEnv(db);
  seedJob(db);
  seedBook(db, "MAL");
  const predN = seedVerses(db, "MAL", { gen: 1, chapters: 3, perChapter: 4 }); // 12

  // Inject a foreign row at destGen for one (chapter,verse) that also exists in
  // the predecessor. The token-gated pre-delete only removes THIS job's rows, so
  // the foreign row survives; NOT EXISTS then skips copying that verse, leaving
  // the destination one verse short of the predecessor. copyBookForward must
  // refuse to mark it carried_forward.
  db.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, source_generation, content_json, created_by_job_id)
     VALUES ('MAL', 2, 2, ?, 2, '{"foreign":true}', 'other-job')`,
  ).run(BV);

  const res = await copyBookForward(env, JOB, "MAL");
  assert.equal(res.status, "retryable_error");

  const row = bookRow(db, "MAL");
  assert.equal(row.status, "retryable_error");
  assert.notEqual(row.status, "carried_forward");
  const err = JSON.parse(row.error_json);
  assert.equal(err.error, "incomplete_carry_forward");
  assert.equal(err.predecessor, predN);
  assert.ok(err.copied < predN, "records that the copy fell short");
});

test("laneBookStats reports per-book verse and translator-edit counts for the generation", async () => {
  const db = freshDb();
  const env = makeEnv(db);
  seedVerses(db, "MAL", { gen: 1, chapters: 2, perChapter: 3 }); // 6 verses, unedited
  seedVerses(db, "JOL", { gen: 1, chapters: 1, perChapter: 4 }); // 4 verses
  // Two JOL verses carry a translator edit.
  db.prepare(
    `UPDATE verses SET updated_by = 7 WHERE book='JOL' AND chapter=1 AND verse IN (1,2) AND bible_version=? AND source_generation=1`,
  ).run(BV);
  // A different generation must not bleed into the gen-1 stats.
  seedVerses(db, "MAL", { gen: 2, chapters: 5, perChapter: 5 });

  const stats = await laneBookStats(env, BV, 1);
  assert.equal(stats.MAL.verses, 6);
  assert.equal(stats.MAL.edited, 0);
  assert.equal(stats.JOL.verses, 4);
  assert.equal(stats.JOL.edited, 2, "counts only updated_by-set verses");
  assert.equal(Object.keys(stats).length, 2, "gen-2 rows excluded from the gen-1 query");
});

test("JOL/MAL regression: un-selected books are NOT emptied by a subset stage", async () => {
  // The trap: a replacement stages into a fresh generation that starts empty.
  // Stage only JOL from the new source and the un-selected MAL would be EMPTY on
  // activation — silent data loss. Carry-forward copies MAL's predecessor
  // content into the new generation so activation is lossless for it.
  const db = freshDb();
  const env = makeEnv(db);
  seedJob(db); // gen 2, predecessor gen 1
  seedBook(db, "JOL");
  seedBook(db, "MAL");
  const jolN = seedVerses(db, "JOL", { gen: 1, chapters: 3, perChapter: 4 });
  const malN = seedVerses(db, "MAL", { gen: 1, chapters: 4, perChapter: 5 });

  // SUBSET stage: JOL is fetched fresh from the new source (simulated by
  // inserting new-generation JOL verses attributed to the job) and marked
  // artifact_ok. MAL is deliberately NOT staged.
  seedVerses(db, "JOL", { gen: 2, chapters: 3, perChapter: 4, createdByJobId: JOB });
  db.prepare(`UPDATE scripture_lane_replacement_books SET status='artifact_ok', mode='staged' WHERE job_id=? AND book='JOL'`).run(JOB);

  // Before carry-forward, MAL is empty on the new generation — the trap.
  assert.equal(verseCount(db, "MAL", 2), 0, "MAL starts empty on the new generation (the trap)");

  // Carry MAL forward.
  const res = await copyBookForward(env, JOB, "MAL");
  assert.equal(res.status, "carried_forward");

  // MAL is now fully populated on the new generation — no data loss.
  assert.equal(verseCount(db, "MAL", 2), malN, "MAL carried forward, not empty");
  // JOL's freshly-staged content is untouched by the MAL carry-forward.
  assert.equal(verseCount(db, "JOL", 2, { createdByJobId: JOB }), jolN, "JOL staging intact");
  assert.equal(bookRow(db, "JOL").status, "artifact_ok");
  assert.equal(bookRow(db, "MAL").status, "carried_forward");
});
