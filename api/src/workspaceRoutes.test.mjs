// Unit tests for workspaceRoutes.ts — the GET/POST /api/workspaces switcher
// API. Real D1 via node:sqlite (same shape as adminUsers.test.mjs), a real
// Hono app wired the way index.ts wires it (attachAuth -> requireCsrf), and a
// stubbed globalThis.fetch for the DCS /user/orgs membership check.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/workspaceRoutes.test.mjs

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { attachAuth, requireCsrf } from "./auth.ts";
import { workspaceRoutes } from "./workspaceRoutes.ts";

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

// ── D1 adapter over node:sqlite (same shape as adminUsers.test.mjs) ─────────

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dcs_user_id INTEGER UNIQUE,
      dcs_username TEXT,
      dcs_access_token TEXT
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

function seedUser(db, { id, username, token = null }) {
  db.prepare(
    `INSERT INTO users (id, dcs_user_id, dcs_username, dcs_access_token) VALUES (?, ?, ?, ?)`,
  ).run(id, id, username, token);
  return db;
}

// Two workspaces: "uw" (org unfoldingWord, the "current" one for these
// tests) and "org2" (org OrgTwo). Both point at the same underlying sqlite
// db (these routes never touch DB/SHARED_DB content directly, only users).
function baseEnv(db, overrides = {}) {
  const d1 = makeD1(db);
  return {
    JWT_SIGNING_KEY: SIGNING,
    JWT_ISSUER: ISSUER,
    DCS_BASE_URL: "https://git.door43.org",
    DB: d1,
    DB2: d1,
    WORKSPACES: JSON.stringify([
      { slug: "uw", label: "unfoldingWord", org: "unfoldingWord", binding: "DB" },
      { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB2" },
    ]),
    WORKSPACE_SLUG: "uw",
    SUPER_ADMINS: "",
    ...overrides,
  };
}

async function makeToken({ sub = "1", role = "editor", username = "alice" } = {}) {
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
  app.route("/api/workspaces", workspaceRoutes);
  return app;
}

function req(app, env, method, path, { token, body, skipCsrf } = {}) {
  const cookies = [];
  const headers = {};
  if (token) cookies.push(`be_access=${token}`);
  if (method !== "GET" && !skipCsrf) {
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

// ── unauthenticated ──────────────────────────────────────────────────────────

console.log("[auth gating] GET/POST require an authenticated user");
{
  const app = buildApp();
  const env = baseEnv(freshDb());
  assert((await req(app, env, "GET", "/api/workspaces")).status === 401, "GET no cookie -> 401");
  assert((await req(app, env, "POST", "/api/workspaces/org2")).status === 401, "POST no cookie -> 401");
}

// ── super-admin sees every workspace allowed, no DCS call needed ───────────

console.log("[GET] super-admin: every workspace allowed, DCS never called");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("DCS should not be called for a super-admin");
  };
  try {
    const db = freshDb();
    seedUser(db, { id: 1, username: "ada" });
    const app = buildApp();
    const env = baseEnv(db, { SUPER_ADMINS: "Ada, someone-else" });
    const tok = await makeToken({ sub: "1", username: "ada" });
    const res = await req(app, env, "GET", "/api/workspaces", { token: tok });
    assert(res.status === 200, "super-admin GET -> 200");
    const body = await res.json();
    assert(body.current === "uw", "current workspace echoed from WORKSPACE_SLUG");
    assert(body.workspaces.length === 2, "both workspaces listed");
    assert(body.workspaces.every((w) => w.allowed === true), "super-admin: every workspace allowed=true");
    assert(body.membershipUnknown === undefined, "super-admin response has no membershipUnknown flag");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── membership filtering from a stubbed /api/v1/user/orgs ──────────────────

console.log("[GET] non-super-admin: allowed flags come from DCS org membership");
{
  const realFetch = globalThis.fetch;
  try {
    const db = freshDb();
    seedUser(db, { id: 2, username: "bob", token: "bob-dcs-token" });
    globalThis.fetch = async (url, init) => {
      assert(String(url).includes("/api/v1/user/orgs"), "membership check hits /api/v1/user/orgs");
      assert(init.headers.Authorization === "token bob-dcs-token", "membership check uses the user's stored access token");
      return new Response(JSON.stringify([{ username: "unfoldingWord" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const app = buildApp();
    const env = baseEnv(db);
    const tok = await makeToken({ sub: "2", username: "bob" });
    const res = await req(app, env, "GET", "/api/workspaces", { token: tok });
    assert(res.status === 200, "member GET -> 200");
    const body = await res.json();
    const uw = body.workspaces.find((w) => w.slug === "uw");
    const org2 = body.workspaces.find((w) => w.slug === "org2");
    assert(uw.allowed === true, "member of unfoldingWord -> uw allowed");
    assert(org2.allowed === false, "not a member of OrgTwo -> org2 not allowed");
    assert(body.membershipUnknown === undefined, "successful lookup has no membershipUnknown flag");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── failed membership lookup: fail closed to current-only, never stranded ──

console.log("[GET] failed/absent membership lookup -> only current workspace allowed + membershipUnknown");
{
  const realFetch = globalThis.fetch;
  try {
    // Case 1: no stored access token at all.
    const dbNoToken = freshDb();
    seedUser(dbNoToken, { id: 3, username: "carol", token: null });
    globalThis.fetch = async () => {
      throw new Error("should not be called when there is no access token");
    };
    const app = buildApp();
    const envNoToken = baseEnv(dbNoToken);
    const tokNoToken = await makeToken({ sub: "3", username: "carol" });
    const resNoToken = await req(app, envNoToken, "GET", "/api/workspaces", { token: tokNoToken });
    assert(resNoToken.status === 200, "no access token -> still 200 (never strand the user)");
    const bodyNoToken = await resNoToken.json();
    assert(bodyNoToken.membershipUnknown === true, "no access token -> membershipUnknown:true");
    assert(
      bodyNoToken.workspaces.find((w) => w.slug === "uw").allowed === true,
      "no access token -> current workspace (uw) still allowed",
    );
    assert(
      bodyNoToken.workspaces.find((w) => w.slug === "org2").allowed === false,
      "no access token -> non-current workspace not allowed",
    );

    // Case 2: access token present but the DCS call fails.
    const dbFailedFetch = freshDb();
    seedUser(dbFailedFetch, { id: 4, username: "dave", token: "dave-token" });
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    const envFailedFetch = baseEnv(dbFailedFetch);
    const tokFailedFetch = await makeToken({ sub: "4", username: "dave" });
    const resFailedFetch = await req(app, envFailedFetch, "GET", "/api/workspaces", { token: tokFailedFetch });
    assert(resFailedFetch.status === 200, "DCS fetch throws -> still 200");
    const bodyFailedFetch = await resFailedFetch.json();
    assert(bodyFailedFetch.membershipUnknown === true, "DCS fetch throws -> membershipUnknown:true");
    assert(
      bodyFailedFetch.workspaces.find((w) => w.slug === "uw").allowed === true,
      "DCS fetch throws -> current workspace still allowed",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── POST /api/workspaces/:slug ──────────────────────────────────────────────

console.log("[POST] unknown slug -> 404 unknown_workspace");
{
  const app = buildApp();
  const db = freshDb();
  seedUser(db, { id: 5, username: "erin" });
  const env = baseEnv(db, { SUPER_ADMINS: "erin" });
  const tok = await makeToken({ sub: "5", username: "erin" });
  const res = await req(app, env, "POST", "/api/workspaces/nonexistent", { token: tok });
  assert(res.status === 404, "unknown slug -> 404");
  assert((await res.json()).error === "unknown_workspace", "404 body is unknown_workspace");
}

console.log("[POST] disallowed workspace -> 403 workspace_forbidden");
{
  const realFetch = globalThis.fetch;
  try {
    const db = freshDb();
    seedUser(db, { id: 6, username: "frank", token: "frank-token" });
    globalThis.fetch = async () =>
      new Response(JSON.stringify([{ username: "unfoldingWord" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const app = buildApp();
    const env = baseEnv(db);
    const tok = await makeToken({ sub: "6", username: "frank" });
    const res = await req(app, env, "POST", "/api/workspaces/org2", { token: tok });
    assert(res.status === 403, "not a member of org2's org -> 403");
    assert((await res.json()).error === "workspace_forbidden", "403 body is workspace_forbidden");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[POST] allowed workspace -> 200 + Set-Cookie carrying the slug");
{
  const realFetch = globalThis.fetch;
  try {
    const db = freshDb();
    seedUser(db, { id: 7, username: "gina", token: "gina-token" });
    globalThis.fetch = async () =>
      new Response(JSON.stringify([{ username: "OrgTwo" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const app = buildApp();
    const env = baseEnv(db);
    const tok = await makeToken({ sub: "7", username: "gina" });
    const res = await req(app, env, "POST", "/api/workspaces/org2", { token: tok });
    assert(res.status === 200, "member of org2's org -> 200");
    const body = await res.json();
    assert(body.ok === true && body.slug === "org2", "200 body echoes ok + slug");
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert(/be_ws=org2/.test(setCookie), "Set-Cookie carries the new slug");
    assert(/HttpOnly/i.test(setCookie), "workspace cookie is HttpOnly");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[POST] missing CSRF token -> 403 (same global gate as every other write)");
{
  const app = buildApp();
  const db = freshDb();
  seedUser(db, { id: 8, username: "henry" });
  const env = baseEnv(db, { SUPER_ADMINS: "henry" });
  const tok = await makeToken({ sub: "8", username: "henry" });
  const res = await req(app, env, "POST", "/api/workspaces/org2", { token: tok, skipCsrf: true });
  assert(res.status === 403, "POST without CSRF header/cookie -> 403");
  assert((await res.json()).error === "csrf_mismatch", "403 body is csrf_mismatch");
}

console.log("workspaceRoutes: all assertions passed");
