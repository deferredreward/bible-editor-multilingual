// Schema tests for migration 0069_org_owner_collate_nocase.sql (issue #306,
// follow-up to 0068).
//
// 0069 rebuilds three tables to add COLLATE NOCASE to their org/owner columns:
//   * book_resource_syncs.source_owner   (in the composite PK — needs preflight)
//   * article_units.source_org           (plain non-key column)
//   * scripture_export_baselines.owner   (in the composite PK — needs preflight)
//
// These assertions ride the REAL 0069 SQL through node:sqlite, so a drift in that
// file (a dropped column, a lost index, a wrong collation, a broken preflight)
// fails here.
//
// Unlike workspacesOrgNocase.test.mjs (workspaces has a clean 0058→0068 history,
// so that test rides both real files), these three tables reached their current
// shape across several rebuild migrations with cross-table dependencies
// (book_resource_syncs: 0028→0036→0042→0044; article_units: 0039→0049→0050;
// scripture_export_baselines: 0042) that are impractical to replay in isolation.
// So the PRE-0069 shapes below are transcribed verbatim from those files (the
// current CREATE TABLE they produce, minus the COLLATE clauses 0069 adds) and the
// real 0069 is applied on top. The DDL here must match production's actual shape;
// it was verified against the migration files named above.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/orgOwnerNocase.test.mjs

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const M0069 = readFileSync(new URL("../migrations/0069_org_owner_collate_nocase.sql", import.meta.url), "utf8");

// Pre-0069 current shapes (BINARY collation), transcribed from the migrations.
// book_resource_syncs: 0044 form. article_units: 0039 + 0049 + 0050. Note
// article_units has an outbound FK (updated_by → users) and two partial indexes.
// scripture_export_baselines: 0042 form.
const PRE = `
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
CREATE TABLE article_units (
  resource TEXT NOT NULL,
  path TEXT NOT NULL,
  article_id TEXT NOT NULL,
  part TEXT NOT NULL DEFAULT 'body',
  source_md TEXT NOT NULL,
  source_sha TEXT,
  target_md TEXT,
  translation_state TEXT,
  draft_meta_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  pre_draft_json TEXT,
  source_org TEXT,
  source_repo TEXT,
  PRIMARY KEY (resource, path)
);
CREATE INDEX article_units_article ON article_units(resource, article_id) WHERE deleted_at IS NULL;
CREATE INDEX article_units_state ON article_units(resource, translation_state) WHERE translation_state IS NOT NULL;
CREATE TABLE scripture_export_baselines (
  lane TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  book TEXT NOT NULL,
  base_sha TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (lane, owner, repo, base_ref, book)
);
`;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;"); // fixtures don't seed the users FK parent
  db.exec(PRE);
  return db;
}

// ── 1. rows + indexes survive each rebuild; collation lands ──────────────────

console.log("[0069] the rebuilds preserve rows/indexes and land COLLATE NOCASE on the targets");
{
  const db = freshDb();
  db.prepare(
    "INSERT INTO book_resource_syncs (book, resource, source_generation, source_owner, source_repo, source_ref, source_sha, origin) VALUES ('GEN','tn',1,'unfoldingWord','en_tn','master','abc','dcs')",
  ).run();
  db.prepare(
    "INSERT INTO article_units (resource, path, article_id, source_md, source_org, source_repo) VALUES ('tw','bible/kt/god.md','kt/god','God','unfoldingWord','en_tw')",
  ).run();
  db.prepare(
    "INSERT INTO scripture_export_baselines (lane, owner, repo, base_ref, book, base_sha) VALUES ('lit','unfoldingWord','en_ult','master','GEN','def')",
  ).run();

  db.exec(M0069);

  // rows carried over with their values
  const brs = db.prepare("SELECT source_owner, source_sha FROM book_resource_syncs WHERE book='GEN'").get();
  assert(brs && brs.source_owner === "unfoldingWord" && brs.source_sha === "abc", "book_resource_syncs row survives with values");
  const au = db.prepare("SELECT source_org, source_md FROM article_units WHERE path='bible/kt/god.md'").get();
  assert(au && au.source_org === "unfoldingWord" && au.source_md === "God", "article_units row survives with values");
  const seb = db.prepare("SELECT owner, base_sha FROM scripture_export_baselines WHERE book='GEN'").get();
  assert(seb && seb.owner === "unfoldingWord" && seb.base_sha === "def", "scripture_export_baselines row survives with values");

  // collation landed on exactly the target columns
  const brsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='book_resource_syncs'").get().sql;
  assert(/source_owner\s+TEXT NOT NULL DEFAULT 'unfoldingWord' COLLATE NOCASE/.test(brsSql), "book_resource_syncs.source_owner is COLLATE NOCASE");
  const auSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='article_units'").get().sql;
  assert(/source_org\s+TEXT COLLATE NOCASE/.test(auSql), "article_units.source_org is COLLATE NOCASE");
  const sebSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scripture_export_baselines'").get().sql;
  assert(/owner\s+TEXT NOT NULL COLLATE NOCASE/.test(sebSql), "scripture_export_baselines.owner is COLLATE NOCASE");

  // article_units partial indexes recreated after the rename
  const idxA = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='article_units_article'").get();
  const idxS = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='article_units_state'").get();
  assert(idxA && idxS, "both article_units partial indexes recreated after rebuild");

  // no _v2 leftovers on a clean run
  const leftovers = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE '%\\_v2' ESCAPE '\\'")
    .get().n;
  assert(leftovers === 0, "no _v2 tables left behind after a successful run");
}

// ── 2. PK-column NOCASE now rejects a case-variant duplicate ─────────────────

console.log("[0069] PK-column targets reject case-variant duplicates after the rebuild");
{
  const db = freshDb();
  db.exec(M0069);

  db.prepare(
    "INSERT INTO book_resource_syncs (book, resource, source_owner, source_repo, source_ref, origin) VALUES ('GEN','tn','unfoldingWord','en_tn','master','dcs')",
  ).run();
  let brsDup = false;
  try {
    db.prepare(
      "INSERT INTO book_resource_syncs (book, resource, source_owner, source_repo, source_ref, origin) VALUES ('GEN','tn','UNFOLDINGWORD','en_tn','master','dcs')",
    ).run();
  } catch {
    brsDup = true;
  }
  assert(brsDup, "book_resource_syncs rejects a source_owner that differs only by case (would insert pre-0069)");

  db.prepare(
    "INSERT INTO scripture_export_baselines (lane, owner, repo, base_ref, book) VALUES ('lit','unfoldingWord','en_ult','master','GEN')",
  ).run();
  let sebDup = false;
  try {
    db.prepare(
      "INSERT INTO scripture_export_baselines (lane, owner, repo, base_ref, book) VALUES ('lit','UnfoldingWord','en_ult','master','GEN')",
    ).run();
  } catch {
    sebDup = true;
  }
  assert(sebDup, "scripture_export_baselines rejects an owner that differs only by case");

  // A genuinely different owner is still allowed (collation didn't over-collapse).
  db.prepare(
    "INSERT INTO scripture_export_baselines (lane, owner, repo, base_ref, book) VALUES ('lit','bsoj','ar_avd','master','GEN')",
  ).run();
  assert(db.prepare("SELECT COUNT(*) AS n FROM scripture_export_baselines").get().n === 2, "distinct owner still inserts");
}

// ── 3. article_units.source_org: non-key NOCASE makes equality case-insensitive
//       without imposing uniqueness ────────────────────────────────────────────

console.log("[0069] article_units.source_org NOCASE: case-insensitive match, no new uniqueness");
{
  const db = freshDb();
  db.exec(M0069);

  db.prepare(
    "INSERT INTO article_units (resource, path, article_id, source_md, source_org) VALUES ('tw','a.md','a','x','UnfoldingWord')",
  ).run();
  // Two different paths with case-variant source_org both allowed (non-key column).
  db.prepare(
    "INSERT INTO article_units (resource, path, article_id, source_md, source_org) VALUES ('tw','b.md','b','y','unfoldingword')",
  ).run();
  assert(db.prepare("SELECT COUNT(*) AS n FROM article_units").get().n === 2, "case-variant source_org on distinct paths coexist (non-key)");
  // Column-collated equality is case-insensitive.
  const n = db.prepare("SELECT COUNT(*) AS n FROM article_units WHERE source_org = 'UNFOLDINGWORD'").get().n;
  assert(n === 2, "source_org = 'UNFOLDINGWORD' matches both 'UnfoldingWord' and 'unfoldingword' (NOCASE equality)");
}

// ── 4. preflight aborts LOUDLY on a pre-existing case-variant PK duplicate ────

console.log("[0069] book_resource_syncs preflight aborts on a pre-existing duplicate-cased source_owner");
{
  const db = freshDb();
  // Pre-0069 BINARY PK lets both of these coexist — the state the rebuild's PK
  // cannot represent and the preflight must name.
  db.prepare(
    "INSERT INTO book_resource_syncs (book, resource, source_owner, source_repo, source_ref, origin) VALUES ('GEN','tn','unfoldingWord','en_tn','master','dcs')",
  ).run();
  db.prepare(
    "INSERT INTO book_resource_syncs (book, resource, source_owner, source_repo, source_ref, origin) VALUES ('GEN','tn','UNFOLDINGWORD','en_tn','master','dcs')",
  ).run();

  let err = null;
  try {
    db.exec(M0069);
  } catch (e) {
    err = e;
  }
  assert(err !== null, "migration refuses to run against a duplicate-cased book_resource_syncs");
  assert(
    String(err?.message ?? "").includes("abort_0069_duplicate_cased_source_owner_in_book_resource_syncs_resolve_manually"),
    "the failure names the offending table/column so the operator knows what to fix",
  );
  assert(db.prepare("SELECT COUNT(*) AS n FROM book_resource_syncs").get().n === 2, "both rows survive the aborted migration (no silent dedupe)");
}

console.log("[0069] scripture_export_baselines preflight aborts on a pre-existing duplicate-cased owner");
{
  const db = freshDb();
  db.prepare(
    "INSERT INTO scripture_export_baselines (lane, owner, repo, base_ref, book) VALUES ('lit','unfoldingWord','en_ult','master','GEN')",
  ).run();
  db.prepare(
    "INSERT INTO scripture_export_baselines (lane, owner, repo, base_ref, book) VALUES ('lit','UNFOLDINGWORD','en_ult','master','GEN')",
  ).run();

  let err = null;
  try {
    db.exec(M0069);
  } catch (e) {
    err = e;
  }
  assert(err !== null, "migration refuses to run against a duplicate-cased scripture_export_baselines");
  assert(
    String(err?.message ?? "").includes("abort_0069_duplicate_cased_owner_in_scripture_export_baselines_resolve_manually"),
    "the failure names the offending table/column",
  );
}

// ── 5. a retry after an aborted run is not blocked by leftovers ──────────────

console.log("[0069] a re-run after an aborted attempt completes once the duplicate is resolved");
{
  const db = freshDb();
  db.prepare(
    "INSERT INTO book_resource_syncs (book, resource, source_owner, source_repo, source_ref, origin) VALUES ('GEN','tn','unfoldingWord','en_tn','master','dcs')",
  ).run();
  db.prepare(
    "INSERT INTO book_resource_syncs (book, resource, source_owner, source_repo, source_ref, origin) VALUES ('GEN','tn','UNFOLDINGWORD','en_tn','master','dcs')",
  ).run();
  try { db.exec(M0069); } catch { /* expected: preflight abort */ }

  // Operator resolves the duplicate by hand, then re-runs.
  db.prepare("DELETE FROM book_resource_syncs WHERE source_owner = 'UNFOLDINGWORD'").run();
  db.exec(M0069);

  const brsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='book_resource_syncs'").get().sql;
  assert(/source_owner\s+TEXT NOT NULL DEFAULT 'unfoldingWord' COLLATE NOCASE/.test(brsSql), "re-run completes and lands the NOCASE collation");
  assert(db.prepare("SELECT COUNT(*) AS n FROM book_resource_syncs").get().n === 1, "the remaining row is present after the successful re-run");
  const leftovers = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND (name LIKE '%\\_v2' ESCAPE '\\' OR name LIKE '\\_0069\\_%' ESCAPE '\\')")
    .get().n;
  assert(leftovers === 0, "no _v2 or preflight leftovers after a successful re-run");
}

console.log("orgOwnerNocase: all assertions passed");
