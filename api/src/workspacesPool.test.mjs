// Unit tests for the spare-pool claim mechanism (issue #81, PR-2) in
// workspaces.ts: registerPoolSlot / claimWorkspace / getPoolStatus.
//
// Real D1 via node:sqlite with the actual 0058 migration applied, so the
// UNIQUE/CHECK constraints and the status lifecycle are exercised for real.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/workspacesPool.test.mjs

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { registerPoolSlot, claimWorkspace, getPoolStatus, listWorkspaces } from "./workspaces.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

async function assertThrows(fn, msg) {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(threw, msg);
}

const MIGRATION = readFileSync(new URL("../migrations/0058_workspaces_registry.sql", import.meta.url), "utf8");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(MIGRATION);
  return db;
}

function makeD1(db) {
  function bound(sql, params) {
    return {
      first: async () => db.prepare(sql).get(...params) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...params) }),
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
  };
}

// A live-but-inert D1 stub for a pool binding (only needs `.prepare` to pass the
// native-binding validity gate).
const liveBinding = () => ({ prepare: () => ({}) });

// env: real registry DB on DB/SHARED_DB, plus two live pool bindings.
function makeEnv(db, extra = {}) {
  const d1 = makeD1(db);
  return { DB: d1, SHARED_DB: d1, DB_POOL1: liveBinding(), DB_POOL2: liveBinding(), DB_POOL3: liveBinding(), ...extra };
}

function rowBySlug(db, slug) {
  return db.prepare("SELECT slug, org, label, binding, export_owner, status FROM workspaces WHERE slug = ?").get(slug);
}

// ── registerPoolSlot ─────────────────────────────────────────────────────────

console.log("[registerPoolSlot] registers a live binding as an 'available' slot");
{
  const db = freshDb();
  const env = makeEnv(db);

  const r1 = await registerPoolSlot(env, { binding: "DB_POOL1" });
  assert(r1.ok && r1.slot?.slug === "pool1", "DB_POOL1 -> slug derived 'pool1'");
  assert(r1.slot?.status === "available", "registered slot is 'available'");
  assert(r1.slot?.org === null && r1.slot?.label === null, "available slot has no org/label yet");
  assert(r1.slot?.bindingLive === true, "registered slot reports bindingLive=true");

  const r2 = await registerPoolSlot(env, { binding: "DB_POOL2", slug: "custom-slug", databaseUuid: "uuid-xyz" });
  assert(r2.ok && r2.slot?.slug === "custom-slug", "explicit slug honored");
  assert(rowBySlug(db, "custom-slug").binding === "DB_POOL2", "binding stored");

  const dead = await registerPoolSlot(env, { binding: "DB_NOT_DECLARED" });
  assert(!dead.ok && dead.error === "binding_not_live", "binding not live on env -> binding_not_live");

  // Same binding under a DIFFERENT slug must be rejected — one binding = one
  // physical DB = one workspace, else two orgs could be claimed onto it. (This
  // check runs before the slug check, so re-registering DB_POOL1 is binding_taken.)
  const dupBinding = await registerPoolSlot(env, { binding: "DB_POOL2", slug: "another-slug" });
  assert(!dupBinding.ok && dupBinding.error === "binding_taken", "binding already registered -> binding_taken");

  // A NEW binding whose slug collides with an existing one -> slug_taken.
  const dupSlug = await registerPoolSlot(env, { binding: "DB_POOL3", slug: "pool1" });
  assert(!dupSlug.ok && dupSlug.error === "slug_taken", "new binding, colliding slug -> slug_taken");

  const empty = await registerPoolSlot(env, { binding: "" });
  assert(!empty.ok && empty.error === "invalid_binding", "empty binding -> invalid_binding");

  const badSlug = await registerPoolSlot(env, { binding: "DB_POOL1", slug: "Bad Slug!" });
  assert(!badSlug.ok && badSlug.error === "invalid_slug", "invalid explicit slug -> invalid_slug");
}

// ── claimWorkspace: happy path, ordering, idempotency, exhaustion ───────────

console.log("[claimWorkspace] claims the oldest available slot, is idempotent, exhausts cleanly");
{
  const db = freshDb();
  const env = makeEnv(db);
  await registerPoolSlot(env, { binding: "DB_POOL1" }); // pool1 (id 1)
  await registerPoolSlot(env, { binding: "DB_POOL2" }); // pool2 (id 2)

  const c1 = await claimWorkspace(env, { org: "AlphaOrg", label: "Alpha", exportOwner: "AlphaExport" });
  assert(c1 && !c1.alreadyClaimed, "first claim succeeds, not alreadyClaimed");
  assert(c1.workspace.slug === "pool1", "oldest available slot claimed first");
  assert(c1.workspace.org === "AlphaOrg" && c1.workspace.exportOwner === "AlphaExport", "org + exportOwner stamped on workspace");
  const row1 = rowBySlug(db, "pool1");
  assert(row1.status === "claimed" && row1.org === "AlphaOrg" && row1.label === "Alpha", "row flipped to claimed with org/label");

  // The claim is visible to listWorkspaces in this isolate (cache reprimed).
  assert(listWorkspaces(env).some((w) => w.slug === "pool1" && w.org === "AlphaOrg"), "claimed workspace appears in listWorkspaces");

  const again = await claimWorkspace(env, { org: "AlphaOrg", label: "Alpha Again" });
  assert(again && again.alreadyClaimed && again.workspace.slug === "pool1", "re-claim for same org is idempotent (alreadyClaimed)");
  assert(rowBySlug(db, "pool2").status === "available", "idempotent re-claim did NOT consume a second slot");

  const c2 = await claimWorkspace(env, { org: "BetaOrg", label: "Beta" });
  assert(c2 && !c2.alreadyClaimed && c2.workspace.slug === "pool2", "different org claims the next slot");

  const exhausted = await claimWorkspace(env, { org: "GammaOrg", label: "Gamma" });
  assert(exhausted === null, "no available slots left -> null (pool exhausted)");
}

// ── claimWorkspace: skips slots whose binding isn't a live D1 ───────────────

console.log("[claimWorkspace] skips available slots whose binding isn't deployed");
{
  const db = freshDb();
  const env = makeEnv(db);
  // A slot declared for a binding that isn't live on this deployment (inserted
  // directly — registerPoolSlot would reject it). Then a genuinely live slot.
  db.prepare("INSERT INTO workspaces (slug, binding, status) VALUES ('ghost', 'DB_GONE', 'available')").run();
  await registerPoolSlot(env, { binding: "DB_POOL1" });

  const claim = await claimWorkspace(env, { org: "RealOrg", label: "Real" });
  assert(claim && claim.workspace.slug === "pool1", "dead-binding slot skipped, live slot claimed");
  assert(rowBySlug(db, "ghost").status === "available", "dead-binding slot left untouched");
}

// ── claimWorkspace: never assigns two orgs to the same physical DB ──────────

console.log("[claimWorkspace] skips an available slot whose binding is already claimed");
{
  const db = freshDb();
  const env = makeEnv(db);
  // OrgA already holds DB_POOL1. A stray available row ALSO points at DB_POOL1
  // (inserted directly — registerPoolSlot would reject it). A live DB_POOL2 too.
  db.prepare("INSERT INTO workspaces (slug, label, org, binding, status) VALUES ('a', 'A', 'OrgA', 'DB_POOL1', 'claimed')").run();
  db.prepare("INSERT INTO workspaces (slug, binding, status) VALUES ('dup1', 'DB_POOL1', 'available')").run();
  db.prepare("INSERT INTO workspaces (slug, binding, status) VALUES ('slot2', 'DB_POOL2', 'available')").run();

  const claim = await claimWorkspace(env, { org: "OrgB", label: "B" });
  assert(claim && claim.workspace.binding === "DB_POOL2", "in-use binding skipped; claim lands on the free DB_POOL2");
  assert(rowBySlug(db, "dup1").status === "available", "the duplicate-binding slot was left unclaimed");
}

// ── claimWorkspace: pre-existing claimed row for org is returned as-is ───────

console.log("[claimWorkspace] pre-existing claimed row for the org short-circuits");
{
  const db = freshDb();
  const env = makeEnv(db);
  db.prepare("INSERT INTO workspaces (slug, label, org, binding, status) VALUES ('existing', 'Existing', 'DupOrg', 'DB_POOL1', 'claimed')").run();
  await registerPoolSlot(env, { binding: "DB_POOL2" }); // an available slot that must NOT be consumed

  const claim = await claimWorkspace(env, { org: "DupOrg", label: "Whatever" });
  assert(claim && claim.alreadyClaimed && claim.workspace.slug === "existing", "org already claimed -> returns existing slot");
  assert(rowBySlug(db, "pool2").status === "available", "available slot not consumed for an org already claimed");
}

// ── claimWorkspace: input validation throws (never persists a bad row) ──────

console.log("[claimWorkspace] rejects invalid org/label without touching the pool");
{
  const db = freshDb();
  const env = makeEnv(db);
  await registerPoolSlot(env, { binding: "DB_POOL1" });

  await assertThrows(() => claimWorkspace(env, { org: "not a valid org!", label: "X" }), "invalid org throws");
  await assertThrows(() => claimWorkspace(env, { org: "OkOrg", label: "" }), "empty label throws");
  await assertThrows(() => claimWorkspace(env, { org: "OkOrg", label: "x".repeat(65) }), "over-long label throws");
  assert(rowBySlug(db, "pool1").status === "available", "no slot consumed by a rejected claim");
}

// ── getPoolStatus ────────────────────────────────────────────────────────────

console.log("[getPoolStatus] reports counts and per-slot bindingLive");
{
  const db = freshDb();
  const env = makeEnv(db);
  await registerPoolSlot(env, { binding: "DB_POOL1" });
  await registerPoolSlot(env, { binding: "DB_POOL2" });
  db.prepare("INSERT INTO workspaces (slug, binding, status) VALUES ('ghost', 'DB_GONE', 'available')").run();
  await claimWorkspace(env, { org: "AlphaOrg", label: "Alpha" });

  const status = await getPoolStatus(env);
  assert(status.counts.claimed === 1, "one claimed slot counted");
  assert(status.counts.available === 2, "two available slots counted (incl. the dead-binding one)");
  assert(status.slots.length === 3, "all rows returned");
  const ghost = status.slots.find((s) => s.slug === "ghost");
  assert(ghost.bindingLive === false, "dead-binding slot reports bindingLive=false");
  const pool2 = status.slots.find((s) => s.slug === "pool2");
  assert(pool2.bindingLive === true, "live slot reports bindingLive=true");
}

console.log("workspacesPool: all assertions passed");
