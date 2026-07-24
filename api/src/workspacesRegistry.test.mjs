// Unit tests for the shared-DB workspace registry (issue #81, PR-1) added to
// workspaces.ts: primeWorkspaces() + the registry-aware listWorkspaces().
//
// The load-bearing property is the FALLBACK ORDERING: registry → WORKSPACES env
// var → implicit default, and a bad/missing/empty registry read must never
// throw. Real D1 via node:sqlite (same adapter shape as workspaceRoutes.test.mjs),
// with the actual 0058 migration applied so the schema invariants ride along.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/workspacesRegistry.test.mjs

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { primeWorkspaces, listWorkspaces, resolveWorkspace } from "./workspaces.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const MIGRATION = readFileSync(new URL("../migrations/0058_workspaces_registry.sql", import.meta.url), "utf8");

// ── D1 adapter over node:sqlite (prepare/bind/all/run + batch) ──────────────

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(MIGRATION);
  return db;
}

// Wraps a node:sqlite handle in the minimal D1Database surface workspaces.ts
// uses. `counts` lets a test assert the read happened at most once per isolate.
function makeD1(db, counts = { reads: 0 }) {
  function bound(sql, params) {
    return {
      first: async () => db.prepare(sql).get(...params) ?? null,
      all: async () => {
        if (/^\s*select/i.test(sql)) counts.reads++;
        return { results: db.prepare(sql).all(...params) };
      },
      run: async () => {
        const r = db.prepare(sql).run(...params);
        return { meta: { changes: Number(r.changes) } };
      },
    };
  }
  return {
    prepare(sql) {
      return { bind: (...params) => bound(sql, params), ...bound(sql, []) };
    },
    batch: async (stmts) => {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    _tag: "shared-db",
  };
}

// A D1 whose reads always throw — models a missing table / D1 outage. Its
// `prepare` returns a live D1-shaped binding so parseEntry's native-binding
// check still passes for entries bound to it.
function throwingD1() {
  const bound = () => ({
    first: async () => {
      throw new Error("boom");
    },
    all: async () => {
      throw new Error("boom");
    },
    run: async () => {
      throw new Error("boom");
    },
  });
  return {
    prepare: () => ({ bind: () => bound(), ...bound() }),
    batch: async () => {
      throw new Error("boom");
    },
    _tag: "throwing-db",
  };
}

function rows(db) {
  return db.prepare("SELECT slug, org, binding, status FROM workspaces ORDER BY id").all();
}

const WS_TWO = JSON.stringify([
  { slug: "uw", label: "unfoldingWord", org: "unfoldingWord", binding: "DB" },
  { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB_ORG2", exportOwner: "OrgTwoExport" },
]);

// ── 1. registry claimed rows win, and are returned after priming ────────────

console.log("[registry] claimed rows are authoritative after primeWorkspaces");
{
  const sqlite = freshDb();
  sqlite
    .prepare("INSERT INTO workspaces (slug, label, org, binding, status) VALUES (?,?,?,?, 'claimed')")
    .run("alpha", "Alpha", "AlphaOrg", "DB");
  sqlite
    .prepare("INSERT INTO workspaces (slug, label, org, binding, export_owner, status) VALUES (?,?,?,?,?, 'claimed')")
    .run("beta", "Beta", "BetaOrg", "DB_ORG2", "BetaExport");
  const DB = makeD1(sqlite);
  // env.WORKSPACES points somewhere ELSE entirely — the registry must win.
  const env = { DB, DB_ORG2: { prepare: () => ({}) }, WORKSPACES: WS_TWO };

  // Before priming: falls back to the env var (registry not yet consulted).
  const pre = listWorkspaces(env);
  assert(pre.length === 2 && pre[0].slug === "uw", "before prime -> WORKSPACES env-var fallback");

  await primeWorkspaces(env);
  const list = listWorkspaces(env);
  assert(list.length === 2, "after prime -> two claimed registry rows");
  assert(list[0].slug === "alpha" && list[1].slug === "beta", "registry order preserved (ORDER BY id)");
  assert(list[0].org === "AlphaOrg" && list[1].org === "BetaOrg", "registry orgs, not env-var orgs");
  assert(list[1].exportOwner === "BetaExport", "export_owner carried through; NULL -> undefined elsewhere");
  assert(list[0].exportOwner === undefined, "NULL export_owner surfaces as undefined (parseEntry accepts)");
  assert(resolveWorkspace(env, "beta").slug === "beta", "resolveWorkspace matches a registry slug");
  assert(resolveWorkspace(env, "nope").slug === "alpha", "unknown slug -> first registry workspace");
}

// ── 2. non-'claimed' rows are never listed ──────────────────────────────────

console.log("[registry] available/provisioning/etc. rows are NOT listed");
{
  const sqlite = freshDb();
  sqlite.prepare("INSERT INTO workspaces (slug, label, org, binding, status) VALUES (?,?,?,?, 'claimed')").run("live", "Live", "LiveOrg", "DB");
  // A spare-pool slot: no org, no label, status 'available'.
  sqlite.prepare("INSERT INTO workspaces (slug, binding, status) VALUES (?,?, 'available')").run("pool-1", "DB");
  sqlite.prepare("INSERT INTO workspaces (slug, binding, status) VALUES (?,?, 'provisioning')").run("pool-2", "DB");
  const env = { DB: makeD1(sqlite) };
  await primeWorkspaces(env);
  const list = listWorkspaces(env);
  assert(list.length === 1 && list[0].slug === "live", "only the 'claimed' row is a listable workspace");
}

// ── 3. empty registry + WORKSPACES set -> seed table, use env entries ───────

console.log("[registry] empty table seeded from WORKSPACES env var on prime");
{
  const sqlite = freshDb();
  const DB = makeD1(sqlite);
  const env = { DB, DB_ORG2: { prepare: () => ({}) }, WORKSPACES: WS_TWO };
  assert(rows(sqlite).length === 0, "table starts empty");

  await primeWorkspaces(env);
  const seeded = rows(sqlite);
  assert(seeded.length === 2, "prime seeded the two env-var entries");
  assert(seeded.every((r) => r.status === "claimed"), "seeded rows are all status='claimed'");
  assert(seeded[0].slug === "uw" && seeded[1].slug === "org2", "seeded in env-var order");

  const list = listWorkspaces(env);
  assert(list.length === 2 && list[0].slug === "uw", "listWorkspaces returns the seeded/env roster");
}

// ── 4. empty registry + WORKSPACES unset -> implicit default, NO seed ───────

console.log("[registry] WORKSPACES unset -> dynamic implicit default, table left empty");
{
  const sqlite = freshDb();
  const env = { DB: makeD1(sqlite), VIEWER_ORG: "SomeOrg" };
  await primeWorkspaces(env);
  assert(rows(sqlite).length === 0, "implicit default is NOT seeded (stays dynamic)");
  const list = listWorkspaces(env);
  assert(list.length === 1 && list[0].slug === "default", "single implicit default workspace");
  assert(list[0].org === "SomeOrg", "implicit default still honors VIEWER_ORG (would be frozen if seeded)");
}

// ── 5. registry read throws -> fail soft to env var, never throws ───────────

console.log("[registry] a throwing/missing registry falls back to WORKSPACES, never 500s");
{
  const env = { DB: throwingD1(), DB_ORG2: { prepare: () => ({}) }, WORKSPACES: WS_TWO };
  await primeWorkspaces(env); // must not throw
  const list = listWorkspaces(env);
  assert(list.length === 2 && list[0].slug === "uw", "read failure -> WORKSPACES env-var fallback");

  const env2 = { DB: throwingD1() }; // no WORKSPACES either
  await primeWorkspaces(env2);
  const list2 = listWorkspaces(env2);
  assert(list2.length === 1 && list2[0].slug === "default", "read failure + no env var -> implicit default");
}

// ── 6. registry rows with a dead binding are dropped (pool-validity gate) ───

console.log("[registry] a claimed row whose binding isn't a live D1 is dropped");
{
  const sqlite = freshDb();
  sqlite.prepare("INSERT INTO workspaces (slug, label, org, binding, status) VALUES (?,?,?,?, 'claimed')").run("good", "Good", "GoodOrg", "DB");
  sqlite.prepare("INSERT INTO workspaces (slug, label, org, binding, status) VALUES (?,?,?,?, 'claimed')").run("orphan", "Orphan", "OrphanOrg", "NO_SUCH_BINDING");
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const env = { DB: makeD1(sqlite) };
    await primeWorkspaces(env);
    const list = listWorkspaces(env);
    assert(list.length === 1 && list[0].slug === "good", "orphan row (unresolvable binding) dropped, good row kept");
  } finally {
    console.warn = realWarn;
  }
}

// ── 7. primeWorkspaces reads at most once per isolate (per shared-DB) ───────

console.log("[registry] prime is idempotent — registry read once per isolate");
{
  const sqlite = freshDb();
  sqlite.prepare("INSERT INTO workspaces (slug, label, org, binding, status) VALUES (?,?,?,?, 'claimed')").run("solo", "Solo", "SoloOrg", "DB");
  const counts = { reads: 0 };
  const env = { DB: makeD1(sqlite, counts) };
  await primeWorkspaces(env);
  await primeWorkspaces(env);
  await primeWorkspaces(env);
  assert(counts.reads === 1, `registry SELECT ran exactly once across 3 primes (got ${counts.reads})`);
}

// ── 8. migration schema invariants (CHECK + UNIQUE) ─────────────────────────

console.log("[migration 0058] status CHECK, slug/org UNIQUE, multi-NULL org allowed");
{
  const sqlite = freshDb();
  let threw = false;
  try {
    sqlite.prepare("INSERT INTO workspaces (slug, binding, status) VALUES ('bad', 'DB', 'nonsense')").run();
  } catch {
    threw = true;
  }
  assert(threw, "status outside the allowed set is rejected by the CHECK");

  sqlite.prepare("INSERT INTO workspaces (slug, org, binding, status) VALUES ('a', 'DupOrg', 'DB', 'claimed')").run();
  let orgDup = false;
  try {
    sqlite.prepare("INSERT INTO workspaces (slug, org, binding, status) VALUES ('b', 'DupOrg', 'DB', 'claimed')").run();
  } catch {
    orgDup = true;
  }
  assert(orgDup, "duplicate org rejected by UNIQUE(org)");

  let slugDup = false;
  try {
    sqlite.prepare("INSERT INTO workspaces (slug, org, binding, status) VALUES ('a', 'OtherOrg', 'DB', 'claimed')").run();
  } catch {
    slugDup = true;
  }
  assert(slugDup, "duplicate slug rejected by UNIQUE(slug)");

  // Two available pool slots, both with NULL org, must coexist (SQLite allows
  // many NULLs under a UNIQUE column) — the spare-pool model depends on this.
  sqlite.prepare("INSERT INTO workspaces (slug, binding, status) VALUES ('pool-a', 'DB', 'available')").run();
  sqlite.prepare("INSERT INTO workspaces (slug, binding, status) VALUES ('pool-b', 'DB', 'available')").run();
  const nullOrg = sqlite.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE org IS NULL").get();
  assert(nullOrg.n === 2, "multiple NULL-org (available) rows coexist under UNIQUE(org)");

  const dflt = sqlite.prepare("INSERT INTO workspaces (slug, binding) VALUES ('def', 'DB')").run();
  const defRow = sqlite.prepare("SELECT status FROM workspaces WHERE slug='def'").get();
  assert(defRow.status === "available", "status defaults to 'available' when unspecified");
  void dflt;
}

console.log("workspacesRegistry: all assertions passed");
