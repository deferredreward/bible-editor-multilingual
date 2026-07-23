// End-to-end regression for auto-provisioning at first admin login (issue #81,
// PR-3): a Door43 BE-Admins admin of an org that has NO workspace signs in for
// the first time (no cookie, no history, not a member of any configured org).
// The callback must claim a spare-pool slot for their org, land them in it, and
// grant admin — instead of the denied screen.
//
// The whole callback runs for real (real Hono route, real node:sqlite D1s, the
// real index.ts env swap + registry prime). Only globalThis.fetch (DCS) is
// stubbed. Mirrors callbackWorkspace.test.mjs.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/callbackAutoClaim.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { SignJWT, jwtVerify } from "jose";
import { callbackDcsAuth } from "./auth.ts";
import { resolveWorkspace, workspaceEnv, parseWorkspaceCookie, primeWorkspaces } from "./workspaces.ts";

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

const M0016 = readFileSync(new URL("../migrations/0016_user_roles.sql", import.meta.url), "utf8");
const M0055 = readFileSync(new URL("../migrations/0055_user_roles_source.sql", import.meta.url), "utf8");
const M0057 = readFileSync(new URL("../migrations/0057_user_roles_manual_stash.sql", import.meta.url), "utf8");
const M0058 = readFileSync(new URL("../migrations/0058_workspaces_registry.sql", import.meta.url), "utf8");

// Shared/default DB: users + sessions + user_roles + the workspaces registry,
// pre-seeded with one available spare-pool slot bound to DB_POOL1.
function sharedDbSqlite() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dcs_user_id INTEGER NOT NULL UNIQUE,
      dcs_username TEXT NOT NULL,
      dcs_full_name TEXT,
      dcs_access_token TEXT,
      last_workspace_slug TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, csrf_token TEXT,
      expires_at INTEGER NOT NULL, user_agent TEXT, ip TEXT, last_seen_at INTEGER
    );
  `);
  db.exec(M0016);
  db.exec(M0055);
  db.exec(M0057);
  db.exec(M0058);
  db.exec("DELETE FROM user_roles;");
  // A pre-provisioned, empty, migrated pool slot awaiting a claim.
  db.exec("INSERT INTO workspaces (slug, binding, status) VALUES ('pool1', 'DB_POOL1', 'available');");
  return db;
}

// A spare pool database: mirrored users + user_roles, empty. This is the D1 the
// claim assigns to the new org.
function poolDbSqlite() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dcs_user_id INTEGER NOT NULL UNIQUE,
      dcs_username TEXT NOT NULL,
      dcs_full_name TEXT
    );
  `);
  db.exec(M0016);
  db.exec(M0055);
  db.exec(M0057);
  db.exec("DELETE FROM user_roles;");
  return db;
}

console.log("[callback] first admin login for an unclaimed org -> claims a pool slot and lands there as admin");
{
  const realFetch = globalThis.fetch;
  try {
    const sharedSql = sharedDbSqlite();
    const poolSql = poolDbSqlite();

    const baseEnv = {
      JWT_SIGNING_KEY: SIGNING,
      JWT_ISSUER: ISSUER,
      DCS_BASE_URL: "https://git.door43.org",
      DCS_CLIENT_ID: "client-id",
      DCS_CLIENT_SECRET: "client-secret",
      DCS_OAUTH_TOKEN_URL: "https://git.door43.org/login/oauth/access_token",
      DCS_OAUTH_AUTHORIZE_URL: "https://git.door43.org/login/oauth/authorize",
      SUPER_ADMINS: "",
      DB: makeD1(sharedSql),
      DB_POOL1: makeD1(poolSql),
      // One configured workspace (unfoldingWord) the user is NOT a member of.
      WORKSPACES: JSON.stringify([{ slug: "uw", label: "unfoldingWord", org: "unfoldingWord", binding: "DB" }]),
    };

    // adminuser is a member of NewOrg only, and on NewOrg's BE-Admins team.
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      const page1 = (arr) => (new URL(u).searchParams.get("page") === "1" ? arr : []);
      if (u.includes("/login/oauth/access_token")) {
        assert(init?.method === "POST", "token exchange is a POST");
        return json({ access_token: "admin-token" });
      }
      if (u.includes("/api/v1/user/orgs")) return json(page1([{ username: "NewOrg" }]));
      if (u.includes("/api/v1/user/teams")) return json(page1([{ name: "BE-Admins", organization: { username: "NewOrg" } }]));
      if (u.endsWith("/api/v1/user")) return json({ id: 77, login: "adminuser", full_name: "Admin User" });
      throw new Error(`unexpected DCS call: ${u}`);
    };

    // Mimic index.ts's fetch wrapper: prime the registry (seeds 'uw' as claimed
    // from WORKSPACES), then swap env for the cookie-less request (pins to uw).
    await primeWorkspaces(baseEnv);

    const app = new Hono();
    app.get("/api/auth/dcs/callback", callbackDcsAuth);

    const state = "state123";
    const stateCookie = await new SignJWT({ state }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("10m").sign(KEY);
    const request = new Request(
      `https://editor.example.org/api/auth/dcs/callback?code=abc&state=${state}`,
      { headers: { cookie: `dcs_auth_state=${stateCookie}` } },
    );
    const ws = resolveWorkspace(baseEnv, parseWorkspaceCookie(request));
    const res = await app.fetch(request, workspaceEnv(baseEnv, ws));

    assert(res.status === 302, `callback redirects (302), got ${res.status}`);
    const location = res.headers.get("location") ?? "";
    assert(!location.includes("_auth_denied"), "NOT denied — a pool slot was claimed for the admin's org");
    assert(location === "https://editor.example.org/", "single_match on the freshly claimed workspace -> plain redirect");

    const setCookies =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""];
    assert(setCookies.some((h) => /^be_ws=pool1/.test(h)), "be_ws lands the admin in the claimed pool1 workspace");
    const accessCookie = setCookies.find((h) => /^be_access=/.test(h));
    const token = accessCookie.match(/^be_access=([^;]+)/)[1];
    const { payload } = await jwtVerify(token, KEY, { algorithms: ["HS256"], issuer: ISSUER });
    assert(payload.role === "admin", `JWT carries admin (BE-Admins team of the new org), got ${payload.role}`);
    assert(payload.username === "adminuser", "JWT is for adminuser");

    // The registry row was claimed for NewOrg.
    const slot = sharedSql.prepare("SELECT org, status, binding FROM workspaces WHERE slug = 'pool1'").get();
    assert(slot.status === "claimed" && slot.org === "NewOrg" && slot.binding === "DB_POOL1", "pool1 flipped to claimed for NewOrg");

    // Admin role landed in the CLAIMED workspace's DB (not the shared/uw DB).
    const poolRole = poolSql.prepare("SELECT role, source FROM user_roles WHERE dcs_username = 'adminuser'").get();
    assert(poolRole && poolRole.role === "admin" && poolRole.source === "dcs_team", "admin dcs_team role synced into the claimed workspace's DB");

    const userRow = sharedSql.prepare("SELECT id, last_workspace_slug FROM users WHERE dcs_username = 'adminuser'").get();
    assert(userRow.last_workspace_slug === "pool1", "single_match resolution persists pool1 as last-used");
    const mirrored = poolSql.prepare("SELECT id FROM users WHERE dcs_username = 'adminuser'").get();
    assert(mirrored && mirrored.id === userRow.id, "user mirrored into the claimed workspace's users table");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("callbackAutoClaim: all assertions passed");
