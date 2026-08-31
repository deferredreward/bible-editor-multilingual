// Schema tests for migration 0070_pipeline_jobs_source_owner_collate_nocase.sql
// (issue #306, final deferred item; follow-up to 0068 / 0069).
//
// 0070 rebuilds pipeline_jobs to add COLLATE NOCASE to source_owner. Unlike the
// three tables 0069 handled, pipeline_jobs carries an INBOUND foreign key
// (pending_imports.job_id REFERENCES pipeline_jobs(job_id), migration 0009) and
// had never been rebuilt -- which is exactly why 0069 deferred it.
//
// The FK is the whole difficulty, and the way SQLite's own rebuild recipe handles
// it (PRAGMA foreign_keys = OFF around the rebuild) DOES NOT WORK ON D1:
//
//   * D1 runs with foreign_keys ON and ignores `PRAGMA foreign_keys = OFF`
//     (the statement succeeds, a read-back still returns 1, enforcement still
//     bites) -- verified against workerd's D1 via miniflare;
//   * `wrangler d1 migrations apply` applies the whole file as ONE transaction
//     (locally through D1's batch(), remotely as a single multi-statement
//     /query), and PRAGMA foreign_keys is a no-op inside a transaction anyway.
//
// So 0070 never disables enforcement: it rebuilds the CHILD (pending_imports)
// alongside the parent, pointing it at the new parent before either old table is
// dropped, so no FK is ever violated. These assertions ride the REAL 0070 SQL
// through node:sqlite and check:
//
//   * the rebuild preserves every pipeline_jobs and pending_imports row + value,
//   * source_owner (and only source_owner) becomes COLLATE NOCASE,
//   * all four pipeline_jobs indexes AND both pending_imports indexes (including
//     the PARTIAL pending_imports_scope) are recreated,
//   * NOCASE equality on source_owner is case-insensitive, with no new uniqueness
//     (it is a non-key column, so no preflight is needed and none is present),
//   * the pending_imports -> pipeline_jobs FK is re-pointed at the rebuilt parent
//     by the RENAME, foreign_key_check is clean, and the FK still enforces,
//   * pending_imports keeps INTEGER PRIMARY KEY AUTOINCREMENT and its id values,
//   * and -- the assertion that actually models D1 -- all of the above holds with
//     PRAGMA foreign_keys ON for the whole file inside a single BEGIN...COMMIT.
//     A supplementary case shows it also works under a plain FKs-off autocommit
//     runner, so 0070 is correct under either application model.
//
// The pre-0070 shapes below are: pipeline_jobs = the 0008 CREATE plus every later
// ADD COLUMN in add-order (0011/0012/0014/0020/0026/0030/0035/0043/0044), minus
// the COLLATE clause 0070 adds; pending_imports = migration 0009 verbatim (never
// altered since). Both were verified against those files.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/pipelineJobsSourceOwnerNocase.test.mjs

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const M0070 = readFileSync(
  new URL("../migrations/0070_pipeline_jobs_source_owner_collate_nocase.sql", import.meta.url),
  "utf8",
);

// Pre-0070 current shape (source_owner BINARY), transcribed from the migrations.
// Includes the parent `users` table and the child `pending_imports` with its real
// inbound FK and both of its indexes, so the FK interaction is genuinely
// exercised (0069's test could set foreign_keys OFF because its tables had no
// inbound FK; here the FK is the point).
const PRE = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT
);
CREATE TABLE pipeline_jobs (
  job_id          TEXT    PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  pipeline_type   TEXT    NOT NULL,
  book            TEXT    NOT NULL,
  start_chapter   INTEGER NOT NULL,
  end_chapter     INTEGER NOT NULL,
  session_key     TEXT    NOT NULL,
  state           TEXT    NOT NULL,
  current_skill   TEXT,
  current_status  TEXT,
  error_kind      TEXT,
  error_message   TEXT,
  output_json     TEXT,
  raw_status_json TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  last_polled_at  INTEGER,
  follow_up_options TEXT,
  follow_up_job_id  TEXT,
  follow_up_chain   TEXT,
  notified_user_at  INTEGER,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  upstream_job_id   TEXT,
  priority          INTEGER NOT NULL DEFAULT 0,
  options_json      TEXT,
  staged_at         INTEGER,
  import_claimed_at INTEGER,
  source_generation INTEGER,
  source_owner      TEXT,
  source_repo       TEXT,
  source_ref        TEXT,
  source_stamps_json TEXT
);
CREATE INDEX pipeline_jobs_user_state     ON pipeline_jobs(user_id, state, updated_at DESC);
CREATE INDEX pipeline_jobs_scope          ON pipeline_jobs(book, start_chapter, pipeline_type, state);
CREATE INDEX pipeline_jobs_user_unnotified ON pipeline_jobs(user_id, notified_user_at, updated_at DESC);
CREATE INDEX pipeline_jobs_queue          ON pipeline_jobs(state, priority DESC, created_at ASC);
CREATE TABLE pending_imports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT    NOT NULL REFERENCES pipeline_jobs(job_id),
  kind            TEXT    NOT NULL,
  book            TEXT    NOT NULL,
  chapter         INTEGER NOT NULL,
  verse           INTEGER NOT NULL,
  bible_version   TEXT,
  payload_json    TEXT    NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  accepted_at     INTEGER,
  accepted_by     INTEGER REFERENCES users(id),
  rejected_at     INTEGER,
  rejected_by     INTEGER REFERENCES users(id)
);
CREATE INDEX pending_imports_job   ON pending_imports(job_id);
CREATE INDEX pending_imports_scope ON pending_imports(book, chapter, kind)
  WHERE accepted_at IS NULL AND rejected_at IS NULL;
`;

function seed(db) {
  db.prepare("INSERT INTO users (id, login) VALUES (1, 'alice')").run();
  // Two jobs whose source_owner differs only by case -- both valid pre-0070 (it's
  // a non-key column), and both must survive the rebuild (no dedupe on a non-key
  // column, unlike 0068/0069's PK preflights).
  db.prepare(
    "INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, source_owner, source_repo, source_ref) " +
      "VALUES ('j1', 1, 'generate', 'GEN', 1, 1, 's', 'done', 'unfoldingWord', 'en_ult', 'master')",
  ).run();
  db.prepare(
    "INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, source_owner, source_repo, source_ref) " +
      "VALUES ('j2', 1, 'notes', 'GEN', 2, 2, 's', 'running', 'UNFOLDINGWORD', 'en_tn', 'master')",
  ).run();
  // pending_imports rows referencing both jobs -- this is the inbound FK the
  // rebuild must neither orphan nor drop.
  db.prepare(
    "INSERT INTO pending_imports (id, job_id, kind, book, chapter, verse, payload_json) VALUES (7, 'j1', 'tn', 'GEN', 1, 1, '{\"a\":1}')",
  ).run();
  db.prepare(
    "INSERT INTO pending_imports (id, job_id, kind, book, chapter, verse, payload_json, accepted_at) VALUES (8, 'j2', 'tq', 'GEN', 2, 2, '{\"b\":2}', 123)",
  ).run();
}

// Every post-rebuild expectation, asserted the same way whichever application
// model applied the migration.
function assertRebuilt(db, label) {
  // both job rows survive with their (case-variant) values
  const j1 = db.prepare("SELECT source_owner, source_repo, state FROM pipeline_jobs WHERE job_id='j1'").get();
  const j2 = db.prepare("SELECT source_owner, source_repo, state FROM pipeline_jobs WHERE job_id='j2'").get();
  assert(j1 && j1.source_owner === "unfoldingWord" && j1.source_repo === "en_ult" && j1.state === "done", `${label}: j1 survives with values`);
  assert(j2 && j2.source_owner === "UNFOLDINGWORD" && j2.source_repo === "en_tn" && j2.state === "running", `${label}: j2 (case-variant source_owner) survives -- no dedupe on a non-key column`);
  assert(db.prepare("SELECT COUNT(*) AS n FROM pipeline_jobs").get().n === 2, `${label}: both jobs present after rebuild`);

  // COLLATE NOCASE landed on source_owner and ONLY source_owner
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pipeline_jobs'").get().sql;
  assert(/source_owner\s+TEXT COLLATE NOCASE/.test(sql), `${label}: source_owner is COLLATE NOCASE`);
  assert(!/source_repo\s+TEXT COLLATE NOCASE/.test(sql), `${label}: source_repo left BINARY (not over-collated)`);
  assert(!/source_ref\s+TEXT COLLATE NOCASE/.test(sql), `${label}: source_ref left BINARY (not over-collated)`);
  assert(/job_id\s+TEXT\s+PRIMARY KEY/i.test(sql), `${label}: job_id PK preserved`);

  // all four pipeline_jobs indexes recreated
  for (const idx of ["pipeline_jobs_user_state", "pipeline_jobs_scope", "pipeline_jobs_user_unnotified", "pipeline_jobs_queue"]) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(idx);
    assert(row && row.name === idx, `${label}: index ${idx} recreated`);
  }

  // ...and BOTH pending_imports indexes, the second one still PARTIAL. The child
  // is rebuilt too, so its indexes are dropped with it and must come back.
  const piJob = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='pending_imports_job'").get();
  assert(piJob && /ON\s+"?pending_imports"?\(job_id\)/i.test(piJob.sql), `${label}: index pending_imports_job recreated`);
  const piScope = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='pending_imports_scope'").get();
  assert(piScope != null, `${label}: index pending_imports_scope recreated`);
  assert(
    /WHERE\s+accepted_at\s+IS\s+NULL\s+AND\s+rejected_at\s+IS\s+NULL/i.test(piScope.sql),
    `${label}: pending_imports_scope is still PARTIAL (WHERE accepted_at IS NULL AND rejected_at IS NULL)`,
  );

  // no _v2 leftovers, for either table
  const leftovers = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE '%\\_v2' ESCAPE '\\'")
    .get().n;
  assert(leftovers === 0, `${label}: no pipeline_jobs_v2 / pending_imports_v2 left behind`);

  // the child table survived the rebuild with its rows, ids and AUTOINCREMENT
  const pendSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pending_imports'").get().sql;
  assert(/id\s+INTEGER PRIMARY KEY AUTOINCREMENT/i.test(pendSql), `${label}: pending_imports keeps INTEGER PRIMARY KEY AUTOINCREMENT`);
  const pend = db.prepare("SELECT id, job_id, kind, payload_json, accepted_at FROM pending_imports ORDER BY id").all();
  assert(pend.length === 2, `${label}: both pending_imports rows preserved`);
  assert(pend[0].id === 7 && pend[0].job_id === "j1" && pend[0].payload_json === '{"a":1}', `${label}: pending_imports id 7 copied verbatim (id preserved)`);
  assert(pend[1].id === 8 && pend[1].accepted_at === 123, `${label}: pending_imports id 8 copied verbatim (nullable columns preserved)`);

  // the RENAME re-pointed the child's FK at the rebuilt parent -- not at the
  // transient pipeline_jobs_v2, which no longer exists.
  assert(/REFERENCES\s+"?pipeline_jobs"?\(job_id\)/.test(pendSql), `${label}: pending_imports FK -> pipeline_jobs(job_id) after the rename`);
  assert(!/pipeline_jobs_v2/.test(pendSql), `${label}: no dangling reference to pipeline_jobs_v2`);

  // no orphans, by join and by SQLite's own checker
  const orphan = db
    .prepare("SELECT p.id FROM pending_imports p LEFT JOIN pipeline_jobs j ON j.job_id = p.job_id WHERE j.job_id IS NULL")
    .all();
  assert(orphan.length === 0, `${label}: no orphaned pending_imports row after rebuild`);
  assert(db.prepare("PRAGMA foreign_key_check").all().length === 0, `${label}: PRAGMA foreign_key_check is clean after the rebuild`);

  // NOCASE equality: a lookup by any casing matches both case-variant owners
  const n = db.prepare("SELECT COUNT(*) AS n FROM pipeline_jobs WHERE source_owner = 'unfoldingword'").get().n;
  assert(n === 2, `${label}: source_owner = 'unfoldingword' matches both 'unfoldingWord' and 'UNFOLDINGWORD' (NOCASE)`);
}

// ── 1. THE D1 MODEL: foreign_keys ON for the whole file, applied as ONE
//       transaction. This is how `wrangler d1 migrations apply` runs a migration
//       (D1 batch() locally, one multi-statement /query remotely) and D1 neither
//       disables nor lets you disable FK enforcement. 0070 must survive this
//       without any pragma at all. ────────────────────────────────────────────

console.log("[0070] D1 model -- FKs ON for the whole file inside a single BEGIN...COMMIT");
{
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(PRE);
  seed(db);
  assert(db.prepare("PRAGMA foreign_keys").get().foreign_keys === 1, "FK enforcement is ON before the migration");

  let err = null;
  try {
    db.exec("BEGIN;\n" + M0070 + "\nCOMMIT;");
  } catch (e) {
    err = e;
    try { db.exec("ROLLBACK;"); } catch { /* already rolled back */ }
  }
  assert(err === null, `0070 applies with FKs ON inside one transaction, no pragma needed: ${err?.message ?? ""}`);

  assertRebuilt(db, "FKs-ON/transaction");

  // enforcement was never turned off, and still bites: an orphan child is rejected.
  assert(db.prepare("PRAGMA foreign_keys").get().foreign_keys === 1, "FK enforcement still ON after the migration");
  let fkRejected = false;
  try {
    db.prepare("INSERT INTO pending_imports (job_id, kind, book, chapter, verse, payload_json) VALUES ('nope', 'tn', 'GEN', 1, 1, '{}')").run();
  } catch {
    fkRejected = true;
  }
  assert(fkRejected, "FK enforces after the rebuild: a pending_imports row for a missing job_id is rejected");

  // AUTOINCREMENT continues past the copied ids rather than restarting at 1.
  db.prepare("INSERT INTO pending_imports (job_id, kind, book, chapter, verse, payload_json) VALUES ('j1', 'tn', 'GEN', 3, 3, '{}')").run();
  const nextId = db.prepare("SELECT MAX(id) AS m FROM pending_imports").get().m;
  assert(nextId > 8, `a new pending_imports row gets id ${nextId} (> the copied max of 8; AUTOINCREMENT sequence carried over)`);
}

// ── 2. Supplementary: a plain autocommit runner with FKs off (how 0069's test
//       applies, and how a bare `sqlite3` shell would). 0070 must work there too
//       -- it depends on no pragma state either way. ───────────────────────────

console.log("[0070] also applies under a plain FKs-off autocommit runner");
{
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(PRE);
  seed(db);

  db.exec(M0070);

  assertRebuilt(db, "FKs-off/autocommit");
}

// ── 3. Documentation: why 0070 rebuilds the CHILD instead of following SQLite's
//       `PRAGMA foreign_keys = OFF` rebuild recipe. Under the D1 model (FKs ON,
//       whole file in one transaction) the naive single-table rebuild fails --
//       and neither pragma rescues it. `foreign_keys` is a documented no-op
//       inside a transaction (and D1 ignores it outright); `defer_foreign_keys`
//       only moves the check to COMMIT, and re-creating the parent under the same
//       name does not decrement the deferred violation the parent DROP counted.
//       ────────────────────────────────────────────────────────────────────────

console.log("[0070] the naive single-table rebuild fails under the D1 model -- with either pragma");
{
  // The rebuild 0070 would have been if it only touched pipeline_jobs.
  const naiveBody = `
    CREATE TABLE pipeline_jobs_v2 (
      job_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      pipeline_type TEXT NOT NULL, book TEXT NOT NULL,
      start_chapter INTEGER NOT NULL, end_chapter INTEGER NOT NULL,
      session_key TEXT NOT NULL, state TEXT NOT NULL,
      source_owner TEXT COLLATE NOCASE
    );
    INSERT INTO pipeline_jobs_v2 (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, source_owner)
      SELECT job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, source_owner FROM pipeline_jobs;
    DROP TABLE pipeline_jobs;
    ALTER TABLE pipeline_jobs_v2 RENAME TO pipeline_jobs;
  `;

  for (const [pragma, why] of [
    ["PRAGMA foreign_keys = OFF;", "foreign_keys = OFF is a no-op inside a transaction (and D1 ignores it entirely)"],
    ["PRAGMA defer_foreign_keys = ON;", "defer_foreign_keys only moves the parent DROP's violation to COMMIT; re-creating the parent does not clear it"],
  ]) {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(PRE);
    seed(db);

    let failed = false;
    try {
      db.exec("BEGIN;\n" + pragma + naiveBody + "\nCOMMIT;");
    } catch {
      failed = true;
      try { db.exec("ROLLBACK;"); } catch { /* already rolled back */ }
    }
    assert(failed, `naive single-table rebuild still trips the inbound FK: ${why}`);
  }
}

console.log("pipelineJobsSourceOwnerNocase: all assertions passed");
