// Regression tests for resolveWorkspaceFresh() — the request-path resolver that
// closes the warm-stale cross-tenant hole (issue #418).
//
// The bug: the registry is primed ONCE per isolate (registryState WeakMap) and
// never expires, so a workspace claimed on a sibling isolate is invisible to an
// already-warm isolate. resolveWorkspace() then answers that unknown slug with
// list[0] — a DIFFERENT tenant's D1 — and index.ts's fetch handler serves it
// with the caller's admin JWT. resolveWorkspaceFresh() re-reads the registry
// ONCE per rate-limit window on an unknown slug before falling back.
//
// Two-isolate model: registryState / the recheck rate-limit are keyed on the
// shared-DB OBJECT, so two makeD1 wrappers over one node:sqlite DB behave as two
// isolates sharing one physical database (same trick as workspacesRegistry.test.mjs).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/workspaceResolveFresh.test.mjs

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { primeWorkspaces, listWorkspaces, resolveWorkspace, resolveWorkspaceFresh } from "./workspaces.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const MIGRATION = readFileSync(new URL("../migrations/0058_workspaces_registry.sql", import.meta.url), "utf8");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(MIGRATION);
  return db;
}

// Minimal D1Database surface workspaces.ts uses. `counts.reads` increments on
// every SELECT .all() (i.e. each registry read), so a test can assert a recheck
// did — or did NOT — hit the DB again.
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

// A deployed-but-unclaimed pool binding: live D1-shaped (prepare is a function)
// so parseEntry accepts a claimed row bound to it, but never actually queried.
const liveBinding = () => ({ prepare: () => ({}) });

function claim(db, slug, org, binding) {
  db.prepare(
    "INSERT INTO workspaces (slug, label, org, binding, status) VALUES (?,?,?,?, 'claimed')",
  ).run(slug, org, org, binding);
}

// ── 1. warm isolate resolves a slug claimed AFTER it primed (the fix) ────────

console.log("[resolveFresh] unknown slug claimed on a sibling isolate resolves to ITS binding, not list[0]");
{
  const sqlite = freshDb();
  claim(sqlite, "home", "HomeOrg", "DB"); // the default/first tenant == list[0]

  const counts = { reads: 0 };
  // Isolate B: a deployed pool binding DB_ORGX exists on env, but org X is not
  // yet in B's cached roster.
  const envB = { DB: makeD1(sqlite, counts), DB_ORGX: liveBinding() };

  await primeWorkspaces(envB);
  assert(listWorkspaces(envB).length === 1, "isolate B primed with only the home workspace");
  assert(counts.reads === 1, "one registry read on prime");

  // A claim lands on ANOTHER isolate (its claimWorkspace wrote this row to the
  // shared DB). B's per-isolate cache is unaware of it.
  claim(sqlite, "orgx", "OrgX", "DB_ORGX");

  // Control: the stale synchronous resolver still serves list[0] — the bug.
  const stale = resolveWorkspace(envB, "orgx");
  assert(stale.slug === "home", "resolveWorkspace (stale) hands back list[0]='home' for the unknown slug (the #418 bug)");

  // Fix: resolveWorkspaceFresh rechecks the registry and finds org X.
  const fresh = await resolveWorkspaceFresh(envB, "orgx");
  assert(fresh.slug === "orgx", "resolveWorkspaceFresh resolves the freshly-claimed slug");
  assert(fresh.binding === "DB_ORGX", "…to OrgX's own binding, NOT the home tenant's DB");
  assert(counts.reads === 2, "exactly one extra registry read for the recheck");
}

// ── 2. recheck is rate-limited — a second unknown slug in-window does not re-read

console.log("[resolveFresh] a second unknown slug within the window triggers no second registry read");
{
  const sqlite = freshDb();
  claim(sqlite, "home", "HomeOrg", "DB");
  const counts = { reads: 0 };
  const envB = { DB: makeD1(sqlite, counts), DB_ORGX: liveBinding() };

  await primeWorkspaces(envB); // reads == 1
  claim(sqlite, "orgx", "OrgX", "DB_ORGX");

  await resolveWorkspaceFresh(envB, "orgx"); // recheck: reads == 2
  assert(counts.reads === 2, "first unknown slug triggered one recheck read");

  // Second unknown slug (a genuinely dead one) within the same window: no read,
  // and it falls back to list[0] exactly as the old behavior.
  const ghost = await resolveWorkspaceFresh(envB, "ghost-slug");
  assert(counts.reads === 2, "second unknown slug in-window did NOT trigger another registry read");
  assert(ghost.slug === "home", "an unresolvable slug still falls back to list[0] (unchanged behavior)");
}

// ── 3. known slug / null slug never re-read the registry ────────────────────

console.log("[resolveFresh] a known or null slug resolves from cache with no extra read");
{
  const sqlite = freshDb();
  claim(sqlite, "home", "HomeOrg", "DB");
  claim(sqlite, "orgx", "OrgX", "DB_ORGX");
  const counts = { reads: 0 };
  const envB = { DB: makeD1(sqlite, counts), DB_ORGX: liveBinding() };

  await primeWorkspaces(envB); // reads == 1
  const known = await resolveWorkspaceFresh(envB, "orgx");
  assert(known.slug === "orgx", "known slug resolves");
  const none = await resolveWorkspaceFresh(envB, null);
  assert(none.slug === "home", "null slug -> list[0]");
  assert(counts.reads === 1, "no recheck read for known / null slugs");
}

console.log("workspaceResolveFresh: all assertions passed");
