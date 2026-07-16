// articlePopulate.test.mjs — executable node:sqlite tests for PR A.
//
// Applies the REAL migrations (0039 + 0049 + 0050, plus the minimal tn/tq/twl
// and project_config tables 0049 and the driver depend on) to an in-memory
// SQLite database and runs the REAL functions from articlePopulate.ts against a
// thin D1 adapter — no substring-of-SQL assertions, the actual upsert / fence /
// planning SQL is exercised.
//
// Run: node --experimental-strip-types --no-warnings --test src/articlePopulate.test.mjs

import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseTaRef,
  parseTwRef,
  extractRcLinks,
  taPaths,
  twPath,
  planWork,
  populateReferencedArticles,
  populateSingleArticle,
  refreshFromSource,
  upsertStmt,
  manualUpsertStmt,
} from "./articlePopulate.ts";
import { clearProjectConfigCache } from "./projectConfig.ts";
import { gitBlobSha } from "./articleExport.ts";

const here = dirname(fileURLToPath(import.meta.url));
const migDir = join(here, "..", "migrations");
const readMig = (name) => readFileSync(join(migDir, name), "utf-8");

// ── D1 adapter over node:sqlite ──────────────────────────────────────────────
// Supports the subset articlePopulate uses: prepare().bind().first()/all()/run()
// and DB.batch([boundStmts]) as an atomic transaction that rolls back + throws
// on any statement error (D1 semantics — including a CHECK violation from the
// config fence).
function makeEnv(db, extra = {}) {
  function bound(sql, params) {
    return {
      sql,
      params,
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
        // Some reads call prepare(sql).first()/all() without bind.
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
    // D1's batch returns a Promise; keep that contract so production
    // `.catch(...)` and `await` behave identically.
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
  return { DB, DCS_BASE_URL: "https://git.door43.org", ...extra };
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  // Prerequisite tables 0049's ALTERs and the driver reference. Kept minimal.
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE tn_rows (
      id TEXT, book TEXT, chapter INTEGER, verse INTEGER,
      support_reference TEXT, note TEXT,
      trashed_at INTEGER, deleted_at INTEGER
    );
    CREATE TABLE tq_rows (id TEXT, book TEXT, deleted_at INTEGER);
    CREATE TABLE twl_rows (
      id TEXT, book TEXT, tw_link TEXT, deleted_at INTEGER
    );
    CREATE TABLE project_config (
      id INTEGER PRIMARY KEY, preset TEXT NOT NULL,
      overrides_json TEXT, updated_at INTEGER
    );
  `);
  // Real migrations, in order.
  db.exec(readMig("0039_article_units.sql"));
  db.exec(readMig("0049_pre_draft_snapshot.sql"));
  db.exec(readMig("0050_article_populate.sql"));
  clearProjectConfigCache();
  return db;
}

// Seed the active project as en-bible-editor-ml-test (translationSource =
// unfoldingWord/en_tw|en_ta), unless overridden.
function seedConfig(db, preset = "en-bible-editor-ml-test", overrides = null) {
  db.prepare(
    `INSERT INTO project_config (id, preset, overrides_json, updated_at)
     VALUES (1, ?1, ?2, unixepoch())
     ON CONFLICT(id) DO UPDATE SET preset = excluded.preset, overrides_json = excluded.overrides_json`,
  ).run(preset, overrides);
  clearProjectConfigCache();
}

// Fake DCS source. sourceFiles: Map<inRepoPath, {status,text?,truncated?}>.
function makeFetch(sourceFiles, onFirst) {
  let calls = 0;
  return async (_env, url) => {
    if (onFirst && calls === 0) onFirst();
    calls++;
    const m = url.match(/\/raw\/branch\/master\/(.+)$/);
    const path = m ? m[1] : url;
    const entry = sourceFiles.get(path);
    if (!entry) return { status: 404, text: null };
    return entry;
  };
}

const countUnits = (db) =>
  db.prepare(`SELECT COUNT(*) AS n FROM article_units`).get().n;
const getUnit = (db, resource, path) =>
  db.prepare(`SELECT * FROM article_units WHERE resource = ?1 AND path = ?2`).get(resource, path);
const getState = (db, resource, path) =>
  db.prepare(`SELECT * FROM article_fetch_state WHERE resource = ?1 AND path = ?2`).get(resource, path);

// ── 1. Pure parsers ──────────────────────────────────────────────────────────
console.log("parsers");
{
  assert.deepEqual(parseTaRef("figs-metaphor"), { manual: "translate", slug: "figs-metaphor" }, "bare 1-seg → translate");
  assert.deepEqual(parseTaRef("checking/foo-bar"), { manual: "checking", slug: "foo-bar" }, "bare 2-seg");
  assert.deepEqual(
    parseTaRef("rc://en/ta/man/translate/figs-aside"),
    { manual: "translate", slug: "figs-aside" },
    "rc form with man segment",
  );
  assert.deepEqual(
    parseTaRef("rc://*/ta/translate/figs-aside"),
    { manual: "translate", slug: "figs-aside" },
    "rc form without man, wildcard lang",
  );
  assert.equal(parseTaRef("bogus-manual/x"), null, "unknown manual → null");
  assert.equal(parseTaRef(""), null, "empty → null");
  assert.equal(parseTaRef("translate/Bad_Slug"), null, "invalid slug chars → null");

  assert.deepEqual(parseTwRef("kt/god"), { cat: "kt", slug: "god" }, "bare tw 2-seg");
  assert.deepEqual(parseTwRef("bible/names/moab"), { cat: "names", slug: "moab" }, "bare with bible prefix");
  assert.deepEqual(
    parseTwRef("rc://en/tw/dict/bible/other/light"),
    { cat: "other", slug: "light" },
    "rc tw form",
  );
  assert.equal(parseTwRef("grace"), null, "bare 1-seg tw → null (no category)");
  assert.equal(parseTwRef("xx/foo"), null, "unknown category → null");

  const links = extractRcLinks("see [x](rc://en/ta/man/translate/figs-aside) and rc://en/tw/dict/bible/kt/god.");
  assert.equal(links.length, 2, "extractRcLinks finds both");
  assert.ok(links.some((l) => l.includes("/ta/")) && links.some((l) => l.includes("/tw/")), "both kinds");
  assert.deepEqual(extractRcLinks(null), [], "null md → []");

  const paths = taPaths("translate", "figs-aside").map((p) => p.path);
  assert.deepEqual(
    paths,
    ["translate/figs-aside/01.md", "translate/figs-aside/title.md", "translate/figs-aside/sub-title.md"],
    "taPaths shape",
  );
  assert.equal(twPath("kt", "god"), "bible/kt/god.md", "twPath shape");
  console.log("  ✓ parsers + extractRcLinks + path builders");
}

// ── 2. planWork ordering + blocking ──────────────────────────────────────────
console.log("planWork");
{
  const src = { org: "unfoldingWord", repos: { tw: "en_tw", ta: "en_ta" } };
  const referenced = [
    { resource: "tw", path: "bible/kt/god.md", article_id: "kt/god", part: "body" },
    { resource: "tw", path: "bible/kt/grace.md", article_id: "kt/grace", part: "body" },
    { resource: "ta", path: "translate/figs-aside/01.md", article_id: "translate/figs-aside", part: "body" },
  ];
  // god present & fresh (skip); grace missing (fetch); figs-aside mismatched (refetch).
  const existing = [
    { resource: "tw", path: "bible/kt/god.md", source_org: "unfoldingWord", source_repo: "en_tw", deleted_at: null },
    { resource: "ta", path: "translate/figs-aside/01.md", source_org: "OldOrg", source_repo: "old_ta", deleted_at: null },
  ];
  const plan = planWork(referenced, existing, [], src);
  assert.deepEqual(
    plan.map((p) => p.path),
    ["bible/kt/grace.md", "translate/figs-aside/01.md"],
    "missing first, then mismatched; fresh skipped",
  );

  // Soft-deleted present row is never planned.
  const plan2 = planWork(
    referenced.slice(1, 2),
    [{ resource: "tw", path: "bible/kt/grace.md", source_org: "unfoldingWord", source_repo: "en_tw", deleted_at: 123 }],
    [],
    src,
  );
  assert.equal(plan2.length, 0, "soft-deleted row counts as present — skipped");

  // Same-source not_found blocks; error under cap does not; error at cap blocks.
  const blockedNf = planWork(referenced.slice(1, 2), [], [
    { resource: "tw", path: "bible/kt/grace.md", source_org: "unfoldingWord", source_repo: "en_tw", status: "not_found", attempts: 1 },
  ], src);
  assert.equal(blockedNf.length, 0, "same-source not_found blocks");

  const errUnderCap = planWork(referenced.slice(1, 2), [], [
    { resource: "tw", path: "bible/kt/grace.md", source_org: "unfoldingWord", source_repo: "en_tw", status: "error", attempts: 2 },
  ], src);
  assert.equal(errUnderCap.length, 1, "error under cap still eligible");

  const errAtCap = planWork(referenced.slice(1, 2), [], [
    { resource: "tw", path: "bible/kt/grace.md", source_org: "unfoldingWord", source_repo: "en_tw", status: "error", attempts: 5 },
  ], src);
  assert.equal(errAtCap.length, 0, "error at cap blocks");

  // Other-source state does NOT block (voided elsewhere; treated absent here).
  const otherSrc = planWork(referenced.slice(1, 2), [], [
    { resource: "tw", path: "bible/kt/grace.md", source_org: "OtherOrg", source_repo: "x_tw", status: "not_found", attempts: 1 },
  ], src);
  assert.equal(otherSrc.length, 1, "other-source state does not block");
  console.log("  ✓ planWork ordering + fetch-state blocking");
}

// ── 3. Upsert matrix (real SQL) ───────────────────────────────────────────────
console.log("upsert matrix");
{
  const db = freshDb();
  const env = makeEnv(db);
  const now = 1000;
  const insert = (sha, org, repo, extra = {}) =>
    db.prepare(
      `INSERT INTO article_units (resource, path, article_id, part, source_md, source_sha, source_org, source_repo, version, translation_state, target_md, deleted_at, updated_at)
       VALUES ('tw','bible/kt/god.md','kt/god','body', 'OLD', ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)`,
    ).run(sha, org, repo, extra.version ?? 1, extra.state ?? null, extra.target ?? null, extra.deleted ?? null);

  // (a) sha change (identity same) → version bump + validated→edited demotion.
  insert("sha1", "unfoldingWord", "en_tw", { version: 3, state: "validated", target: "T" });
  await upsertStmt(env, "tw", "bible/kt/god.md", "kt/god", "body", "NEW", "sha2", "unfoldingWord", "en_tw", now).run();
  let u = getUnit(db, "tw", "bible/kt/god.md");
  assert.equal(u.version, 4, "sha change bumps version");
  assert.equal(u.translation_state, "edited", "sha change demotes validated→edited");
  assert.equal(u.target_md, "T", "target_md preserved");
  assert.equal(u.source_md, "NEW", "source refreshed");

  // (b) identity-only change (same bytes/sha, different org) → identity updated, NO bump, state preserved.
  db.prepare(`DELETE FROM article_units`).run();
  insert("shaX", "OldOrg", "old_tw", { version: 2, state: "validated", target: "T" });
  await upsertStmt(env, "tw", "bible/kt/god.md", "kt/god", "body", "SAME", "shaX", "unfoldingWord", "en_tw", now).run();
  u = getUnit(db, "tw", "bible/kt/god.md");
  assert.equal(u.version, 2, "identity-only change does NOT bump version");
  assert.equal(u.source_org, "unfoldingWord", "identity org updated");
  assert.equal(u.source_repo, "en_tw", "identity repo updated");
  assert.equal(u.translation_state, "validated", "identity-only change preserves state");

  // (c) no change at all (same sha + same identity) → no-op (version unchanged).
  db.prepare(`DELETE FROM article_units`).run();
  insert("shaY", "unfoldingWord", "en_tw", { version: 5 });
  await upsertStmt(env, "tw", "bible/kt/god.md", "kt/god", "body", "X", "shaY", "unfoldingWord", "en_tw", now).run();
  u = getUnit(db, "tw", "bible/kt/god.md");
  assert.equal(u.version, 5, "no-op leaves version");

  // (d) reconciler upsert never revives a soft-deleted row's deleted_at.
  db.prepare(`DELETE FROM article_units`).run();
  insert("shaZ", "OldOrg", "old_tw", { version: 1, deleted: 999, target: "T" });
  await upsertStmt(env, "tw", "bible/kt/god.md", "kt/god", "body", "NEW", "shaZ2", "unfoldingWord", "en_tw", now).run();
  u = getUnit(db, "tw", "bible/kt/god.md");
  assert.equal(u.deleted_at, 999, "reconciler upsert does not touch deleted_at");

  // (e) manual restore: unchanged sha still clears deleted_at + preserves target.
  db.prepare(`DELETE FROM article_units`).run();
  insert("shaR", "unfoldingWord", "en_tw", { version: 2, state: "edited", deleted: 999, target: "KEEP" });
  await manualUpsertStmt(env, "tw", "bible/kt/god.md", "kt/god", "body", "X", "shaR", "unfoldingWord", "en_tw", now).run();
  u = getUnit(db, "tw", "bible/kt/god.md");
  assert.equal(u.deleted_at, null, "manual restore clears deleted_at even with unchanged sha");
  assert.equal(u.target_md, "KEEP", "manual restore preserves target_md");
  assert.equal(u.version, 2, "manual restore with unchanged sha does not bump version");
  console.log("  ✓ upsert matrix (bump/demote/identity/no-op/soft-delete/restore)");
}

// ── 4. Driver: fetch outcomes + fetch-state ────────────────────────────────────
console.log("driver fetch-state");
{
  const db = freshDb();
  seedConfig(db);
  // Reference one tW (found), one tW (404), one tA (title/sub-title absent).
  db.prepare(`INSERT INTO twl_rows (id, book, tw_link) VALUES ('1','TIT','rc://en/tw/dict/bible/kt/god'),('2','TIT','rc://en/tw/dict/bible/kt/missing')`).run();
  db.prepare(`INSERT INTO tn_rows (id, book, support_reference) VALUES ('n1','TIT','figs-aside')`).run();
  const src = new Map([
    ["bible/kt/god.md", { status: 200, text: "# God\n" }],
    ["translate/figs-aside/01.md", { status: 200, text: "# Aside body\n" }],
    // figs-aside title.md / sub-title.md absent (→404, silent); kt/missing absent (→404, warns).
  ]);
  const env = makeEnv(db);
  const r = await populateReferencedArticles(env, { deps: { fetch: makeFetch(src) } });
  assert.equal(r.processed, 2, "two files fetched OK (god + figs-aside body)");
  assert.ok(getUnit(db, "tw", "bible/kt/god.md"), "god unit inserted");
  assert.ok(getUnit(db, "ta", "translate/figs-aside/01.md"), "figs-aside body inserted");
  assert.equal(getUnit(db, "ta", "translate/figs-aside/01.md").translation_state, null, "populated → NULL state");
  // 404s → not_found fetch-state.
  assert.equal(getState(db, "tw", "bible/kt/missing.md").status, "not_found", "missing tw → not_found state");
  assert.equal(getState(db, "ta", "translate/figs-aside/title.md").status, "not_found", "absent tA title → not_found state");
  // Warnings: tW body 404 warns; tA title/sub-title silent.
  assert.ok(r.warnings.some((w) => w.includes("bible/kt/missing.md")), "tW 404 warns");
  assert.ok(!r.warnings.some((w) => w.includes("title.md") || w.includes("sub-title.md")), "tA title/sub-title 404 silent");

  // Re-run → not_found blocks re-fetch; already-present skipped → {processed:0}.
  const r2 = await populateReferencedArticles(env, { deps: { fetch: makeFetch(src) } });
  assert.equal(r2.processed, 0, "re-run is a no-op");
  assert.equal(r2.remaining, 0, "nothing remaining");
  console.log("  ✓ fetch OK/404, not_found terminal, NULL state on populate, warnings");
}

// ── 4b. Truncated 200 → retryable error, never content ────────────────────────
console.log("truncated fetch");
{
  const db = freshDb();
  seedConfig(db);
  db.prepare(`INSERT INTO twl_rows (id, book, tw_link) VALUES ('1','TIT','rc://en/tw/dict/bible/kt/god')`).run();
  const src = new Map([["bible/kt/god.md", { status: 200, text: null, truncated: true }]]);
  const env = makeEnv(db);
  const r = await populateReferencedArticles(env, { deps: { fetch: makeFetch(src) } });
  assert.equal(r.processed, 0, "truncated 200 never counts as content");
  assert.equal(getUnit(db, "tw", "bible/kt/god.md"), undefined, "no unit written for truncated read");
  assert.equal(getState(db, "tw", "bible/kt/god.md").status, "error", "truncated 200 → retryable error state");
  console.log("  ✓ truncated 200 is retryable error, not content");
}

// ── 4c. Error retry / cap / retryFailed reset ─────────────────────────────────
console.log("error retry + retryFailed");
{
  const db = freshDb();
  seedConfig(db);
  db.prepare(`INSERT INTO twl_rows (id, book, tw_link) VALUES ('1','TIT','rc://en/tw/dict/bible/kt/god')`).run();
  const err = new Map([["bible/kt/god.md", { status: 503, text: null }]]);
  const env = makeEnv(db);
  await populateReferencedArticles(env, { deps: { fetch: makeFetch(err) } });
  assert.equal(getState(db, "tw", "bible/kt/god.md").attempts, 1, "first error attempt=1");
  await populateReferencedArticles(env, { deps: { fetch: makeFetch(err) } });
  assert.equal(getState(db, "tw", "bible/kt/god.md").attempts, 2, "retry increments attempts");
  // Push to cap and confirm it stops planning.
  db.prepare(`UPDATE article_fetch_state SET attempts = 5 WHERE resource='tw' AND path='bible/kt/god.md'`).run();
  const capped = await populateReferencedArticles(env, { deps: { fetch: makeFetch(err) } });
  assert.equal(capped.processed, 0, "capped error not retried");
  // retryFailed clears it and it becomes eligible again (now succeeds).
  const ok = new Map([["bible/kt/god.md", { status: 200, text: "# God\n" }]]);
  const r = await populateReferencedArticles(env, { retryFailed: true, deps: { fetch: makeFetch(ok) } });
  assert.equal(r.processed, 1, "retryFailed resets → path fetched");
  assert.equal(getState(db, "tw", "bible/kt/god.md"), undefined, "state cleared on success");
  console.log("  ✓ error retry increments, caps, retryFailed resets");
}

// ── 4d. Void state on source switch ───────────────────────────────────────────
console.log("void on source switch");
{
  const db = freshDb();
  seedConfig(db);
  db.prepare(`INSERT INTO twl_rows (id, book, tw_link) VALUES ('1','TIT','rc://en/tw/dict/bible/kt/god')`).run();
  // A not_found recorded against a DIFFERENT source.
  db.prepare(
    `INSERT INTO article_fetch_state (resource, path, source_org, source_repo, status, attempts, updated_at)
     VALUES ('tw','bible/kt/god.md','OtherOrg','other_tw','not_found',1, 1)`,
  ).run();
  const ok = new Map([["bible/kt/god.md", { status: 200, text: "# God\n" }]]);
  const env = makeEnv(db);
  const r = await populateReferencedArticles(env, { deps: { fetch: makeFetch(ok) } });
  assert.equal(r.processed, 1, "other-source not_found voided → path fetched under current source");
  assert.ok(getUnit(db, "tw", "bible/kt/god.md"), "unit written after void");
  console.log("  ✓ other-source fetch-state voided on read");
}

// ── 5. Write-time config fence ─────────────────────────────────────────────────
console.log("config fence");
{
  const db = freshDb();
  seedConfig(db);
  db.prepare(`INSERT INTO twl_rows (id, book, tw_link) VALUES ('1','TIT','rc://en/tw/dict/bible/kt/god')`).run();
  const before = countUnits(db);
  // fetch mutates project_config AFTER the snapshot is captured, BEFORE the write.
  const src = new Map([["bible/kt/god.md", { status: 200, text: "# God\n" }]]);
  const mutate = () =>
    db.prepare(`UPDATE project_config SET overrides_json = '{"org":"Switched"}' WHERE id = 1`).run();
  const env = makeEnv(db);
  const r = await populateReferencedArticles(env, { deps: { fetch: makeFetch(src, mutate) } });
  assert.equal(r.aborted, "source_changed", "config change mid-run aborts");
  assert.equal(r.processed, 0, "no rows processed on abort");
  assert.equal(countUnits(db), before, "entire batch rolled back — zero writes");
  console.log("  ✓ config change between plan and write rolls back the batch");
}

// ── 6. Skipped when not a translation project ─────────────────────────────────
console.log("non-translation project");
{
  const db = freshDb();
  seedConfig(db, "en-unfoldingword"); // translationSource === null
  db.prepare(`INSERT INTO twl_rows (id, book, tw_link) VALUES ('1','TIT','rc://en/tw/dict/bible/kt/god')`).run();
  const env = makeEnv(db);
  const r = await populateReferencedArticles(env, { deps: { fetch: makeFetch(new Map()) } });
  assert.equal(r.skipped, true, "non-translation project → skipped");
  assert.equal(countUnits(db), 0, "nothing written");
  console.log("  ✓ skips when translationSource is null");
}

// ── 7. Manual add + restore ────────────────────────────────────────────────────
console.log("manual add");
{
  const db = freshDb();
  seedConfig(db);
  const env = makeEnv(db);
  const src = new Map([["bible/kt/grace.md", { status: 200, text: "# Grace\n" }]]);
  const r = await populateSingleArticle(env, "tw", "kt/grace", { fetch: makeFetch(src) });
  assert.ok(r.ok && r.article_id === "kt/grace", "add tw returns article_id");
  assert.ok(getUnit(db, "tw", "bible/kt/grace.md"), "unit added");

  // unparseable id.
  const bad = await populateSingleArticle(env, "tw", "grace", { fetch: makeFetch(src) });
  assert.equal(bad.error, "unparseable_id", "bare 1-seg tw id → unparseable_id");

  // source_not_found when body missing.
  const nf = await populateSingleArticle(env, "tw", "kt/nope", { fetch: makeFetch(new Map()) });
  assert.equal(nf.error, "source_not_found", "missing source → source_not_found");
  console.log("  ✓ manual add / unparseable / source_not_found");
}

// ── 8. refreshFromSource cursor + demotion ────────────────────────────────────
console.log("refresh");
{
  const db = freshDb();
  seedConfig(db);
  const now = 1;
  // Two current-identity tW rows; one validated with an old sha.
  db.prepare(
    `INSERT INTO article_units (resource, path, article_id, part, source_md, source_sha, source_org, source_repo, version, translation_state, target_md, updated_at)
     VALUES ('tw','bible/kt/aaa.md','kt/aaa','body','OLD','shaA','unfoldingWord','en_tw',1,'validated','T', ?1),
            ('tw','bible/kt/bbb.md','kt/bbb','body','OLD','shaB','unfoldingWord','en_tw',1,NULL,NULL, ?1)`,
  ).run(now);
  // aaa changed upstream, bbb unchanged.
  const shaB = await gitBlobSha("OLD-bbb-unchanged");
  db.prepare(`UPDATE article_units SET source_sha = ?1 WHERE path='bible/kt/bbb.md'`).run(shaB);
  const src = new Map([
    ["bible/kt/aaa.md", { status: 200, text: "# AAA new\n" }],
    ["bible/kt/bbb.md", { status: 200, text: "OLD-bbb-unchanged" }],
  ]);
  const env = makeEnv(db);

  // Page size 1 → cursor advances.
  const p1 = await refreshFromSource(env, { maxFetches: 1, deps: { fetch: makeFetch(src) } });
  assert.equal(p1.processed, 1, "page 1 processed one row");
  assert.ok(p1.nextCursor && p1.nextCursor.path === "bible/kt/aaa.md", "cursor points at last row of page 1");
  const aaa = getUnit(db, "tw", "bible/kt/aaa.md");
  assert.equal(aaa.translation_state, "edited", "upstream change demotes validated→edited");
  assert.equal(aaa.target_md, "T", "refresh preserves target_md");

  const p2 = await refreshFromSource(env, { maxFetches: 1, cursor: p1.nextCursor, deps: { fetch: makeFetch(src) } });
  assert.equal(p2.processed, 1, "page 2 processed the second row");
  assert.equal(p2.changed, 0, "unchanged sha → no write");
  assert.ok(p2.nextCursor && p2.nextCursor.path === "bible/kt/bbb.md", "page 2 cursor advanced past aaa");
  assert.notEqual(p1.nextCursor.path, p2.nextCursor.path, "cursor differs between pages");
  // A full page always yields a cursor; the next call drains to empty.
  const p3 = await refreshFromSource(env, { maxFetches: 1, cursor: p2.nextCursor, deps: { fetch: makeFetch(src) } });
  assert.equal(p3.processed, 0, "page 3 reads no rows");
  assert.equal(p3.nextCursor, null, "drained → nextCursor null");
  console.log("  ✓ refresh cursor advances, unchanged rows no-op, demotion + target preserved");
}

console.log("\nALL articlePopulate tests passed");
