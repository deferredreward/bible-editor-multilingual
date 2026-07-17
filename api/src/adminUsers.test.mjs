// Unit tests for adminUserRoutes.ts — the admin-only user_roles CRUD API.
// Mirrors auth.test.mjs's harness for the HTTP/auth/CSRF layer (a real Hono
// app wired the same way the real app wires it, a jose-signed JWT cookie to
// simulate callers of each role, a stubbed globalThis.fetch for the DCS
// existence check restored in a finally so it never leaks between tests).
//
// Unlike the original version of this file, the D1 layer is REAL SQLite
// (node:sqlite DatabaseSync, same adapter shape as projectConfigApply.test.mjs)
// rather than a hand-rolled string-matching stub. This matters here because
// the last-admin guard is implemented as a single atomic UPSERT/DELETE
// statement whose WHERE clause embeds a COUNT(*) subquery (see
// adminUserRoutes.ts) — the whole point of that design is the atomicity
// SQLite provides, which a fake statement dispatcher can't actually exercise.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/adminUsers.test.mjs

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { attachAuth, requireCsrf } from "./auth.ts";
import { adminUsers } from "./adminUserRoutes.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const SIGNING = "test-signing-key-that-is-at-least-32-bytes-long";
const KEY = new TextEncoder().encode(SIGNING);
const ISSUER = "bible-editor";

// ── D1 adapter over node:sqlite (same shape as projectConfigApply.test.mjs) ─

function freshDb() {
  const db = new DatabaseSync(":memory:");
  // D1 does not enforce foreign keys by default; node:sqlite does unless told
  // otherwise. Match production so tests aren't stricter than reality.
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dcs_user_id INTEGER UNIQUE,
      dcs_username TEXT
    );
    CREATE TABLE user_roles (
      dcs_username TEXT PRIMARY KEY COLLATE NOCASE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
      added_at INTEGER NOT NULL DEFAULT (unixepoch()),
      added_by INTEGER REFERENCES users(id)
    );
  `);
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
  };
}

// Seeds user_roles rows: [{username, role, addedBy?}]. addedBy (a users.id)
// defaults to null. Returns the db for chaining into makeD1().
function seed(db, rows) {
  db.prepare(
    `INSERT INTO user_roles (dcs_username, role, added_by) VALUES (?, ?, ?)`,
  );
  for (const r of rows) {
    db.prepare(`INSERT INTO user_roles (dcs_username, role, added_by) VALUES (?, ?, ?)`).run(
      r.username,
      r.role,
      r.addedBy ?? null,
    );
  }
  return db;
}

function baseEnv(db, dcsServiceToken) {
  return {
    JWT_SIGNING_KEY: SIGNING,
    JWT_ISSUER: ISSUER,
    DCS_BASE_URL: "https://git.door43.org",
    DCS_SERVICE_TOKEN: dcsServiceToken,
    DB: makeD1(db),
  };
}

async function makeToken({ sub = "1", role = "admin", username = "ada" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username, role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(KEY);
}

function buildApp() {
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("*", requireCsrf);
  app.route("/api/admin/users", adminUsers);
  return app;
}

// Helper to fire requests with the auth + (for writes) CSRF cookies wired.
function req(app, env, method, path, { token, body } = {}) {
  const cookies = [];
  const headers = {};
  if (token) cookies.push(`be_access=${token}`);
  if (method !== "GET") {
    cookies.push("be_csrf=tok123");
    headers["x-csrf-token"] = "tok123";
  }
  if (cookies.length) headers.cookie = cookies.join("; ");
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, env);
}

// A DCS fetch stub that succeeds and echoes back the path-param username as
// the canonical login (same casing) unless the test overrides globalThis.fetch.
function stubDcsOk() {
  globalThis.fetch = async (url) => {
    const m = /\/api\/v1\/users\/([^/?]+)/.exec(String(url));
    const login = m ? decodeURIComponent(m[1]) : "unknown";
    return new Response(JSON.stringify({ login }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

// ── Auth gating: 401 no cookie, 403 editor, 200 admin ──────────────────────

console.log("[auth gating] GET/PUT/DELETE all require an authenticated admin");
{
  const realFetch = globalThis.fetch;
  stubDcsOk();
  try {
    const app = buildApp();
    const editorTok = await makeToken({ role: "editor", sub: "2", username: "eddie" });
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });

    const listEnv = baseEnv(seed(freshDb(), [{ username: "ada", role: "admin" }]));
    assert((await req(app, listEnv, "GET", "/api/admin/users")).status === 401, "GET no cookie → 401");
    assert(
      (await req(app, listEnv, "GET", "/api/admin/users", { token: editorTok })).status === 403,
      "GET editor → 403",
    );
    assert(
      (await req(app, listEnv, "GET", "/api/admin/users", { token: adminTok })).status === 200,
      "GET admin → 200",
    );

    // PUT: adding a brand-new editor, count irrelevant.
    const putEnv = () => baseEnv(seed(freshDb(), [{ username: "ada", role: "admin" }]));
    assert(
      (await req(app, putEnv(), "PUT", "/api/admin/users/newbie", { body: { role: "editor" } })).status === 401,
      "PUT no cookie → 401",
    );
    assert(
      (await req(app, putEnv(), "PUT", "/api/admin/users/newbie", { token: editorTok, body: { role: "editor" } }))
        .status === 403,
      "PUT editor → 403",
    );
    assert(
      (await req(app, putEnv(), "PUT", "/api/admin/users/newbie", { token: adminTok, body: { role: "editor" } }))
        .status === 200,
      "PUT admin → 200",
    );

    // DELETE: existing editor row, count irrelevant (not admin).
    const delEnv = () => baseEnv(seed(freshDb(), [{ username: "newbie", role: "editor" }]));
    assert((await req(app, delEnv(), "DELETE", "/api/admin/users/newbie")).status === 401, "DELETE no cookie → 401");
    assert(
      (await req(app, delEnv(), "DELETE", "/api/admin/users/newbie", { token: editorTok })).status === 403,
      "DELETE editor → 403",
    );
    assert(
      (await req(app, delEnv(), "DELETE", "/api/admin/users/newbie", { token: adminTok })).status === 200,
      "DELETE admin → 200",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── Last-admin guard (atomic — real SQLite executes the guarded UPSERT/DELETE) ─

console.log("[last-admin guard] refuse to demote/remove the sole remaining admin");
{
  const realFetch = globalThis.fetch;
  stubDcsOk();
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });

    // Sole admin ("target") — demote must be blocked.
    const soleAdminEnv = baseEnv(seed(freshDb(), [{ username: "target", role: "admin" }]));
    const blocked = await req(app, soleAdminEnv, "PUT", "/api/admin/users/target", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(blocked.status === 409, "demote sole admin (count=1) → 409");
    assert((await blocked.json()).error === "last_admin", "409 body is last_admin");

    // Two admins — demoting one must succeed.
    const twoAdminsEnv = baseEnv(
      seed(freshDb(), [
        { username: "target", role: "admin" },
        { username: "other", role: "admin" },
      ]),
    );
    const allowed = await req(app, twoAdminsEnv, "PUT", "/api/admin/users/target", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(allowed.status === 200, "demote when another admin exists (count=2) → 200");

    // DELETE mirrors the same guard.
    const delSoleAdminEnv = baseEnv(seed(freshDb(), [{ username: "target", role: "admin" }]));
    const delBlocked = await req(app, delSoleAdminEnv, "DELETE", "/api/admin/users/target", { token: adminTok });
    assert(delBlocked.status === 409, "DELETE sole admin (count=1) → 409");
    assert((await delBlocked.json()).error === "last_admin", "DELETE 409 body is last_admin");

    const delTwoAdminsEnv = baseEnv(
      seed(freshDb(), [
        { username: "target", role: "admin" },
        { username: "other", role: "admin" },
      ]),
    );
    const delAllowed = await req(app, delTwoAdminsEnv, "DELETE", "/api/admin/users/target", { token: adminTok });
    assert(delAllowed.status === 200, "DELETE admin when another admin exists (count=2) → 200");

    // Not a demotion (admin→admin) — guard must not trigger even at count=1.
    const sameRoleEnv = baseEnv(seed(freshDb(), [{ username: "target", role: "admin" }]));
    const sameRole = await req(app, sameRoleEnv, "PUT", "/api/admin/users/target", {
      token: adminTok,
      body: { role: "admin" },
    });
    assert(sameRole.status === 200, "admin→admin at count=1 is not a demotion → 200");

    // Brand-new user (no current row) being added as editor must not trigger
    // the guard even when the DB's only row is a lone admin (count=1) — the
    // INSERT has no conflict to fire the DO UPDATE guard clause at all.
    const newUserEnv = baseEnv(seed(freshDb(), [{ username: "ada", role: "admin" }]));
    const newUser = await req(app, newUserEnv, "PUT", "/api/admin/users/brandnew", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(newUser.status === 200, "new user added as editor never trips the last-admin guard → 200");

    // Concurrency: two "simultaneous" demote requests against the same sole
    // admin. Fired back-to-back against the SAME db (no seed reset between
    // them) — this is the actual race the atomic guard exists to close: if
    // the count-check and the write were still two separate statements, both
    // requests could observe count=1... no wait, count=2 (two admins) and
    // both succeed, leaving zero admins. Assert exactly one succeeds.
    const raceEnv = baseEnv(
      seed(freshDb(), [
        { username: "raceA", role: "admin" },
        { username: "raceB", role: "admin" },
      ]),
    );
    const [raceRes1, raceRes2] = await Promise.all([
      req(app, raceEnv, "PUT", "/api/admin/users/raceA", { token: adminTok, body: { role: "editor" } }),
      req(app, raceEnv, "PUT", "/api/admin/users/raceB", { token: adminTok, body: { role: "editor" } }),
    ]);
    const raceStatuses = [raceRes1.status, raceRes2.status].sort();
    assert(
      JSON.stringify(raceStatuses) === JSON.stringify([200, 409]),
      `concurrent demote of both remaining admins: exactly one succeeds, one gets last_admin (got ${raceStatuses})`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── PUT validation ordering ─────────────────────────────────────────────────

console.log("[PUT validation] body shape → username shape → DCS existence → canonical casing");
{
  const realFetch = globalThis.fetch;
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    const dbThrowsIfTouched = () => ({
      prepare() {
        throw new Error("DB should not be touched for a request rejected before the DB step");
      },
    });

    // Invalid body: must 400 before the username regex, DCS fetch, or DB.
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("should not be called", { status: 500 });
    };
    const untouchedEnv = { ...baseEnv(freshDb()), DB: dbThrowsIfTouched() };
    const badBody = await req(app, untouchedEnv, "PUT", "/api/admin/users/valid-name", {
      token: adminTok,
      body: { role: "viewer" },
    });
    assert(badBody.status === 400, "role:viewer → 400");
    assert((await badBody.json()).error === "invalid_body", "400 body is invalid_body");
    assert(fetchCalled === false, "DCS fetch never called for invalid_body");

    // Invalid username (contains a space) — valid role, so body passes; must
    // 400 before the DCS call.
    fetchCalled = false;
    const badUsername = await req(app, untouchedEnv, "PUT", "/api/admin/users/bad%20name", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(badUsername.status === 400, "username with space → 400");
    assert((await badUsername.json()).error === "invalid_username", "400 body is invalid_username");
    assert(fetchCalled === false, "DCS fetch never called for invalid_username");

    // Invalid username (contains @).
    const badUsername2 = await req(app, untouchedEnv, "PUT", "/api/admin/users/bad@name", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(badUsername2.status === 400, "username with @ → 400");
    assert((await badUsername2.json()).error === "invalid_username", "@ username → invalid_username");

    // DCS 404.
    globalThis.fetch = async () => new Response("not found", { status: 404 });
    const notFound = await req(app, untouchedEnv, "PUT", "/api/admin/users/ghostuser", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(notFound.status === 404, "DCS 404 → 404");
    assert((await notFound.json()).error === "dcs_user_not_found", "404 body is dcs_user_not_found");

    // Happy path: DCS returns a different casing than the URL path; the
    // stored/returned row must use DCS's canonical casing, and added_by must
    // be stamped from the caller's userId on first insert.
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ login: "BCameron93" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const casingDb = freshDb();
    const casingEnv = baseEnv(casingDb);
    const casingRes = await req(app, casingEnv, "PUT", "/api/admin/users/bcameron93", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(casingRes.status === 200, "happy-path PUT with casing mismatch → 200");
    const casingBody = await casingRes.json();
    assert(casingBody.user.username === "BCameron93", "response uses DCS-canonical casing, not URL casing");
    assert(casingBody.dcsVerified === true, "dcsVerified true when DCS responded 200");
    const stored = casingDb.prepare("SELECT dcs_username, added_by FROM user_roles").get();
    assert(stored.dcs_username === "BCameron93", "row stored under the DCS-canonical login, not the URL param");
    assert(stored.added_by === 1, "added_by stamped from the caller's userId (sub=1) on first insert");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── Fail-open on DCS network error ──────────────────────────────────────────

console.log("[PUT DCS fail-open] network error still writes, using the path-param username");
{
  const realFetch = globalThis.fetch;
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    const env = baseEnv(freshDb());
    const res = await req(app, env, "PUT", "/api/admin/users/offlineuser", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(res.status === 200, "DCS fetch throws → still 200 (fail open)");
    const body = await res.json();
    assert(body.dcsVerified === false, "dcsVerified false when DCS fetch failed");
    assert(body.user.username === "offlineuser", "row stored under the path-param username when DCS is unreachable");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── DELETE not_found ─────────────────────────────────────────────────────────

console.log("[DELETE] missing row → 404");
{
  const realFetch = globalThis.fetch;
  stubDcsOk();
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    const env = baseEnv(freshDb());
    const res = await req(app, env, "DELETE", "/api/admin/users/nobody", { token: adminTok });
    assert(res.status === 404, "DELETE unknown username → 404");
    assert((await res.json()).error === "not_found", "404 body is not_found");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("adminUsers: all assertions passed");
