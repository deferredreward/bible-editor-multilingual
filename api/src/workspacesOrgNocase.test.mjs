// Schema tests for migration 0068_workspaces_org_collate_nocase.sql (issue #306).
//
// 0058 created workspaces.org as `TEXT UNIQUE` (BINARY collation), so `bsoj` and
// `BSOJ` were distinct under the tenancy UNIQUE guard. 0068 rebuilds the table
// with `org TEXT UNIQUE COLLATE NOCASE`. These assertions ride the REAL migration
// SQL through node:sqlite, so a drift in either file (a dropped column, a lost
// index, a wrong collation) fails here.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/workspacesOrgNocase.test.mjs

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const M0058 = readFileSync(new URL("../migrations/0058_workspaces_registry.sql", import.meta.url), "utf8");
const M0068 = readFileSync(new URL("../migrations/0068_workspaces_org_collate_nocase.sql", import.meta.url), "utf8");

// ── 1. data + schema survive the table rebuild ──────────────────────────────

console.log("[0068] the _v2 rebuild preserves existing rows and the status index");
{
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(M0058);
  // Seed a claimed row and an available spare BEFORE the rebuild, so the
  // INSERT ... SELECT is exercised on real data.
  db.prepare(
    "INSERT INTO workspaces (slug, label, org, binding, export_owner, status) VALUES ('kept', 'Kept', 'KeptOrg', 'DB', 'KeptExport', 'claimed')",
  ).run();
  db.prepare("INSERT INTO workspaces (slug, binding, status) VALUES ('spare', 'DB', 'available')").run();
  const keptId = db.prepare("SELECT id FROM workspaces WHERE slug='kept'").get().id;

  db.exec(M0068);

  const kept = db.prepare("SELECT id, slug, org, export_owner, status FROM workspaces WHERE slug='kept'").get();
  assert(kept && kept.org === "KeptOrg" && kept.export_owner === "KeptExport", "claimed row survives rebuild with its values");
  assert(kept.id === keptId, "primary key id is preserved across the rebuild");
  assert(db.prepare("SELECT COUNT(*) AS n FROM workspaces").get().n === 2, "both rows carried over (claimed + available)");

  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_workspaces_status'").get();
  assert(idx && idx.name === "idx_workspaces_status", "idx_workspaces_status recreated after rename");
}

// ── 2. org UNIQUE is now case-INSENSITIVE ───────────────────────────────────

console.log("[0068] duplicate-cased org is rejected by the NOCASE UNIQUE index");
{
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(M0058);
  db.exec(M0068);

  db.prepare("INSERT INTO workspaces (slug, org, binding, status) VALUES ('a', 'bsoj', 'DB', 'claimed')").run();

  let dupCased = false;
  try {
    db.prepare("INSERT INTO workspaces (slug, org, binding, status) VALUES ('b', 'BSOJ', 'DB', 'claimed')").run();
  } catch {
    dupCased = true;
  }
  assert(dupCased, "'BSOJ' rejected when 'bsoj' already exists (would have inserted pre-0068)");

  // Exact-case duplicate still rejected (baseline UNIQUE behavior intact).
  let dupExact = false;
  try {
    db.prepare("INSERT INTO workspaces (slug, org, binding, status) VALUES ('c', 'bsoj', 'DB', 'claimed')").run();
  } catch {
    dupExact = true;
  }
  assert(dupExact, "exact-case duplicate 'bsoj' still rejected");

  // A genuinely different org is still allowed.
  db.prepare("INSERT INTO workspaces (slug, org, binding, status) VALUES ('d', 'OtherOrg', 'DB', 'claimed')").run();
  assert(db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE org IS NOT NULL").get().n === 2, "distinct org still inserts");
}

// ── 3. multi-NULL org (spare-pool slots) still coexist under NOCASE ──────────

console.log("[0068] many NULL-org spare slots still coexist under the NOCASE UNIQUE");
{
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(M0058);
  db.exec(M0068);
  db.prepare("INSERT INTO workspaces (slug, binding, status) VALUES ('pool-a', 'DB', 'available')").run();
  db.prepare("INSERT INTO workspaces (slug, binding, status) VALUES ('pool-b', 'DB', 'available')").run();
  const n = db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE org IS NULL").get().n;
  assert(n === 2, "multiple NULL-org available rows coexist (UNIQUE ignores NULLs regardless of collation)");
}

// -- 4. the preflight aborts (loudly) when the registry ALREADY holds a
//       case-variant pair, instead of dying on an anonymous UNIQUE failure -----

console.log("[0068] preflight aborts on pre-existing duplicate-cased org rows");
{
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(M0058);
  // 0058's BINARY-collated UNIQUE lets BOTH of these in. That is the state the
  // rebuild cannot represent, and the state the preflight has to name.
  db.prepare("INSERT INTO workspaces (slug, org, binding, status) VALUES ('a', 'bsoj', 'DB', 'claimed')").run();
  db.prepare("INSERT INTO workspaces (slug, org, binding, status) VALUES ('b', 'BSOJ', 'DB_MLTEST', 'claimed')").run();

  let err = null;
  try {
    db.exec(M0068);
  } catch (e) {
    err = e;
  }
  assert(err !== null, "migration refuses to run against a duplicate-cased registry");
  assert(
    String(err?.message ?? "").includes("abort_0068_duplicate_cased_org_in_workspaces_resolve_manually"),
    "the failure message names the problem, so the operator sees WHAT to fix",
  );
  // Nothing destructive ran: both original rows are still there, untouched.
  assert(
    db.prepare("SELECT COUNT(*) AS n FROM workspaces").get().n === 2,
    "both tenancy rows survive the aborted migration (no silent dedupe)",
  );
}

// -- 5. a retry after an aborted run still reaches the real failure -----------

console.log("[0068] a re-run after an aborted attempt is not blocked by leftovers");
{
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(M0058);
  db.prepare("INSERT INTO workspaces (slug, org, binding, status) VALUES ('a', 'bsoj', 'DB', 'claimed')").run();
  db.prepare("INSERT INTO workspaces (slug, org, binding, status) VALUES ('b', 'BSOJ', 'DB_MLTEST', 'claimed')").run();
  try { db.exec(M0068); } catch { /* expected: preflight abort */ }

  // Operator resolves the duplicate the way the comment says to, then re-runs.
  db.prepare("UPDATE workspaces SET org = NULL, status = 'retired' WHERE slug = 'b'").run();
  db.exec(M0068);

  const cols = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workspaces'").get().sql;
  assert(/org\s+TEXT UNIQUE COLLATE NOCASE/.test(cols), "re-run completes and lands the NOCASE collation");
  assert(db.prepare("SELECT COUNT(*) AS n FROM workspaces").get().n === 2, "both rows still present after the successful re-run");
  assert(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces_v2'").get() === undefined,
    "no workspaces_v2 leftover after a successful run",
  );
}

console.log("workspacesOrgNocase: all assertions passed");
