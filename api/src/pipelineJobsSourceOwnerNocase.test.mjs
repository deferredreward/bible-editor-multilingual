// Schema tests for migration 0070_pipeline_jobs_source_owner_collate_nocase.sql
// (issue #306, final deferred item; follow-up to 0068 / 0069).
//
// 0070 rebuilds pipeline_jobs to add COLLATE NOCASE to source_owner. Unlike the
// three tables 0069 handled, pipeline_jobs carries an INBOUND foreign key
// (pending_imports.job_id REFERENCES pipeline_jobs(job_id), migration 0009) and
// had never been rebuilt -- which is exactly why 0069 deferred it. So these
// assertions ride the REAL 0070 SQL through node:sqlite AND exercise that FK:
//
//   * the rebuild preserves every pipeline_jobs row and value,
//   * source_owner (and only source_owner) becomes COLLATE NOCASE,
//   * all four indexes are recreated,
//   * NOCASE equality on source_owner is case-insensitive, with no new uniqueness
//     (it is a non-key column, so no preflight is needed and none is present),
//   * the pending_imports -> pipeline_jobs FK survives the rebuild and still
//     enforces afterward,
//   * the rebuild completes under BOTH realistic migration-application models:
//     FKs OFF (D1's default -- how 0069's test applies and how every prior rebuild
//     in this repo ran) AND a stricter runner that starts with FKs ON but applies
//     statements in autocommit, where the migration's leading PRAGMA foreign_keys
//     = OFF disables enforcement before the parent DROP. After the rebuild, with
//     FKs re-enabled, PRAGMA foreign_key_check is clean and the FK enforces.
//
// The pre-0070 shape below is the 0008 CREATE plus every later ADD COLUMN in
// add-order (0011/0012/0014/0020/0026/0030/0035/0043/0044), transcribed from
// those files, minus the COLLATE clause 0070 adds. It must match production's
// actual shape; it was verified against the migration files named above.
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
// inbound FK, so the FK interaction is genuinely exercised (0069's test could set
// foreign_keys OFF because its tables had no inbound FK; here the FK is the point).
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
CREATE INDEX pending_imports_job ON pending_imports(job_id);
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
  // A pending_imports row referencing j1 -- this is the inbound FK the rebuild
  // must not orphan.
  db.prepare(
    "INSERT INTO pending_imports (job_id, kind, book, chapter, verse, payload_json) VALUES ('j1', 'tn', 'GEN', 1, 1, '{}')",
  ).run();
}

// ── 1. FKs-OFF autocommit application (mirrors 0069's test + historical D1) ──

console.log("[0070] rebuild under FKs-off autocommit: rows/indexes preserved, NOCASE landed, FK intact");
{
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(PRE);
  seed(db);

  db.exec(M0070);

  // both rows survive with their (case-variant) values
  const j1 = db.prepare("SELECT source_owner, source_repo, state FROM pipeline_jobs WHERE job_id='j1'").get();
  const j2 = db.prepare("SELECT source_owner, source_repo, state FROM pipeline_jobs WHERE job_id='j2'").get();
  assert(j1 && j1.source_owner === "unfoldingWord" && j1.source_repo === "en_ult" && j1.state === "done", "j1 survives with values");
  assert(j2 && j2.source_owner === "UNFOLDINGWORD" && j2.source_repo === "en_tn" && j2.state === "running", "j2 (case-variant source_owner) survives -- no dedupe on a non-key column");
  assert(db.prepare("SELECT COUNT(*) AS n FROM pipeline_jobs").get().n === 2, "both jobs present after rebuild");

  // COLLATE NOCASE landed on source_owner and ONLY source_owner
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pipeline_jobs'").get().sql;
  assert(/source_owner\s+TEXT COLLATE NOCASE/.test(sql), "source_owner is COLLATE NOCASE");
  assert(!/source_repo\s+TEXT COLLATE NOCASE/.test(sql), "source_repo left BINARY (not over-collated)");
  assert(!/source_ref\s+TEXT COLLATE NOCASE/.test(sql), "source_ref left BINARY (not over-collated)");
  assert(/job_id\s+TEXT\s+PRIMARY KEY/i.test(sql), "job_id PK preserved");

  // all four indexes recreated
  for (const idx of ["pipeline_jobs_user_state", "pipeline_jobs_scope", "pipeline_jobs_user_unnotified", "pipeline_jobs_queue"]) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(idx);
    assert(row && row.name === idx, `index ${idx} recreated`);
  }

  // no _v2 leftover
  const leftovers = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE '%\\_v2' ESCAPE '\\'")
    .get().n;
  assert(leftovers === 0, "no pipeline_jobs_v2 left behind");

  // the inbound FK definition survives the rebuild (child still references parent)
  const pendSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pending_imports'").get().sql;
  assert(/REFERENCES pipeline_jobs\(job_id\)/.test(pendSql), "pending_imports FK -> pipeline_jobs(job_id) still declared");
  // the referencing row is still there and still resolves to its parent
  const orphan = db
    .prepare("SELECT p.id FROM pending_imports p LEFT JOIN pipeline_jobs j ON j.job_id = p.job_id WHERE j.job_id IS NULL")
    .all();
  assert(orphan.length === 0, "no orphaned pending_imports row after rebuild");

  // NOCASE equality: a lookup by any casing matches both case-variant owners
  const n = db.prepare("SELECT COUNT(*) AS n FROM pipeline_jobs WHERE source_owner = 'unfoldingword'").get().n;
  assert(n === 2, "source_owner = 'unfoldingword' matches both 'unfoldingWord' and 'UNFOLDINGWORD' (NOCASE)");
}

// ── 2. Stricter runner: FKs ON at the start, migration applied in autocommit.
//       The migration's leading PRAGMA foreign_keys = OFF is what keeps the DROP
//       of the referenced parent from tripping the inbound FK; re-enabling FKs
//       afterward finds no integrity violation and enforcement is back. ─────────

console.log("[0070] rebuild from an FKs-ON start (autocommit): leading pragma disables enforcement, no orphans, FK re-enforces");
{
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(PRE);
  seed(db);

  // The real 0070 leads with `PRAGMA foreign_keys = OFF`; applied here in
  // autocommit (statement-by-statement, like `wrangler d1 migrations apply`),
  // that first statement flips enforcement off connection-wide before the DROP.
  let err = null;
  try {
    db.exec(M0070);
  } catch (e) {
    err = e;
  }
  assert(err === null, `rebuild succeeds from an FKs-on start via the leading foreign_keys=OFF: ${err?.message ?? ""}`);

  // rows preserved
  assert(db.prepare("SELECT COUNT(*) AS n FROM pipeline_jobs").get().n === 2, "both jobs present after rebuild");
  assert(db.prepare("SELECT COUNT(*) AS n FROM pending_imports").get().n === 1, "pending_imports row preserved");

  // Restore enforcement (as D1 / the SQLite recipe does after the migration) and
  // confirm the rebuild left no dangling child reference.
  db.exec("PRAGMA foreign_keys = ON;");
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  assert(violations.length === 0, "PRAGMA foreign_key_check is clean after the rebuild (no orphaned pending_imports)");

  // the FK genuinely enforces again: a pending_imports row for a missing job is rejected.
  let fkRejected = false;
  try {
    db.prepare("INSERT INTO pending_imports (job_id, kind, book, chapter, verse, payload_json) VALUES ('nope', 'tn', 'GEN', 1, 1, '{}')").run();
  } catch {
    fkRejected = true;
  }
  assert(fkRejected, "FK enforces after re-enable: a pending_imports row for a missing job_id is rejected");

  // and a NOCASE lookup works on the rebuilt column
  const j = db.prepare("SELECT job_id FROM pipeline_jobs WHERE source_owner = 'UnFoLdInGwOrD' ORDER BY job_id").all();
  assert(j.length === 2, "case-insensitive source_owner lookup returns both jobs after rebuild");
}

// ── 3. defer_foreign_keys is NOT a substitute (documents why 0070 uses
//       foreign_keys = OFF instead): with FKs on, deferring does not stop the
//       parent DROP's implicit-DELETE from failing. ─────────────────────────────

console.log("[0070] defer_foreign_keys does NOT rescue the parent DROP (rationale for using foreign_keys=OFF)");
{
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(PRE);
  seed(db);

  // Same rebuild body as 0070 but swap the leading pragma for defer_foreign_keys,
  // wrapped in a transaction. This is expected to FAIL -- proving the choice in
  // 0070 is deliberate, not cargo-culted.
  const deferBody = M0070.replace(/PRAGMA foreign_keys = OFF;/, "PRAGMA defer_foreign_keys = ON;");
  let failed = false;
  try {
    db.exec("BEGIN;\n" + deferBody + "\nCOMMIT;");
  } catch {
    failed = true;
    try { db.exec("ROLLBACK;"); } catch { /* already rolled back */ }
  }
  assert(failed, "defer_foreign_keys cannot keep the parent DROP from tripping the inbound FK -- so 0070 uses foreign_keys=OFF");
}

console.log("pipelineJobsSourceOwnerNocase: all assertions passed");
