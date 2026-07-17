// Unit tests for auth.ts — the JWT verifier, the middleware chain
// (attachAuth → requireCsrf → role gates), session refresh/revocation, and
// the last-location validator. These are the guards in front of every write
// route, previously exercised only by the (not-CI-gated) Playwright suite.
//
// auth.ts imports ./index for types only, so it loads standalone under the
// strip-types runner. Hono's app.request() runs middleware against standard
// Request/Response objects — no Workers runtime needed. D1 is faked with a
// dispatch-by-SQL-substring stub (fakeDb below).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/auth.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { Hono } from "hono";
import { SignJWT } from "jose";
import {
  attachAuth,
  requireCsrf,
  requireAuth,
  requireEditor,
  requireAdmin,
  verifyToken,
  refreshToken,
  updateLastLocation,
  updateWorkModePrefs,
  authMe,
  startDcsAuth,
  callbackDcsAuth,
  mintDevToken,
  fetchCurrentUserOrgs,
  fetchUserOrgsByLogin,
} from "./auth.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const SIGNING = "test-signing-key-that-is-at-least-32-bytes-long";
const KEY = new TextEncoder().encode(SIGNING);
const OTHER_KEY = new TextEncoder().encode("a-different-key-also-32-bytes-long!!!");
const ISSUER = "bible-editor";

// Minimal Env. DB is per-test via fakeDb; routes under test touch nothing else.
function baseEnv(db) {
  return {
    JWT_SIGNING_KEY: SIGNING,
    JWT_ISSUER: ISSUER,
    DCS_BASE_URL: "https://git.door43.org",
    DCS_OAUTH_AUTHORIZE_URL: "https://git.door43.org/login/oauth/authorize",
    DCS_OAUTH_TOKEN_URL: "https://git.door43.org/login/oauth/access_token",
    DCS_CLIENT_ID: "test-client-id",
    DCS_CLIENT_SECRET: "test-client-secret",
    DB: db,
  };
}

// D1 stub: the test hands in (sql, args, op) → result. run() defaults to
// one-changed so UPDATE call sites succeed unless the test says otherwise.
function fakeDb(handler = () => null) {
  const stmt = (sql, args) => ({
    first: async () => handler({ sql, args, op: "first" }),
    run: async () => handler({ sql, args, op: "run" }) ?? { meta: { changes: 1 } },
    all: async () => handler({ sql, args, op: "all" }) ?? { results: [] },
  });
  return {
    prepare(sql) {
      return { bind: (...args) => stmt(sql, args), ...stmt(sql, []) };
    },
  };
}

async function makeToken({
  sub = "1",
  role = "editor",
  username = "alice",
  issuer = ISSUER,
  key = KEY,
  expiresIn = 3600,
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username, role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(issuer)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .sign(key);
}

// ── verifyToken ─────────────────────────────────────────────────────────────

console.log("[verifyToken] accepts a well-formed token, rejects every tamper axis");
{
  const env = baseEnv(fakeDb());
  const good = await verifyToken(await makeToken({}), env);
  assert(good && good.userId === 1 && good.username === "alice" && good.role === "editor", "valid token → claims");

  assert((await verifyToken(await makeToken({ issuer: "someone-else" }), env)) === null, "wrong issuer rejected");
  assert((await verifyToken(await makeToken({ key: OTHER_KEY }), env)) === null, "wrong signing key rejected");
  assert((await verifyToken(await makeToken({ expiresIn: -60 }), env)) === null, "expired token rejected");
  assert((await verifyToken("not.a.jwt", env)) === null, "garbage rejected");
  assert((await verifyToken(await makeToken({ sub: "abc" }), env)) === null, "non-numeric sub rejected");

  const weirdRole = await verifyToken(await makeToken({ role: "superadmin" }), env);
  assert(weirdRole && weirdRole.role === undefined, "unknown role claim → role undefined, not trusted");

  const noKeyEnv = { ...env, JWT_SIGNING_KEY: undefined };
  assert((await verifyToken(await makeToken({}), noKeyEnv)) === null, "missing signing key → fail closed");
}

// ── middleware chain ────────────────────────────────────────────────────────

function buildApp() {
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("*", requireCsrf);
  app.get("/open", (c) => c.json({ ok: true }));
  app.post("/write", (c) => c.json({ ok: true }));
  app.get("/authed", requireAuth, (c) => c.json({ ok: true }));
  app.get("/editor-only", requireEditor, (c) => c.json({ ok: true }));
  app.get("/admin-only", requireAdmin, (c) => c.json({ ok: true }));
  app.post("/api/auth/refresh", refreshToken);
  app.get("/api/auth/me", authMe);
  app.put("/loc", requireAuth, updateLastLocation);
  app.put("/prefs", requireAuth, updateWorkModePrefs);
  app.get("/api/auth/dcs/start", startDcsAuth);
  app.get("/api/auth/dcs/callback", callbackDcsAuth);
  app.post("/api/auth/dev", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return mintDevToken(c, body.username ?? "dev");
  });
  return app;
}

console.log("[requireCsrf] double-submit on writes; reads and exempt paths pass");
{
  const app = buildApp();
  const env = baseEnv(fakeDb());

  assert((await app.request("/open", {}, env)).status === 200, "GET needs no CSRF");
  assert((await app.request("/write", { method: "POST" }, env)).status === 403, "POST without CSRF → 403");

  const mismatch = await app.request(
    "/write",
    { method: "POST", headers: { cookie: "be_csrf=aaa", "x-csrf-token": "bbb" } },
    env,
  );
  assert(mismatch.status === 403, "cookie/header mismatch → 403");

  const okRes = await app.request(
    "/write",
    { method: "POST", headers: { cookie: "be_csrf=tok123", "x-csrf-token": "tok123" } },
    env,
  );
  assert(okRes.status === 200, "matching cookie+header passes");

  const headerOnly = await app.request(
    "/write",
    { method: "POST", headers: { "x-csrf-token": "tok123" } },
    env,
  );
  assert(headerOnly.status === 403, "header without cookie → 403");

  // Exempt path: refresh must reach the handler (401 for missing session
  // cookie), NOT die at the CSRF gate (403).
  const refresh = await app.request("/api/auth/refresh", { method: "POST" }, env);
  assert(refresh.status === 401, "refresh is CSRF-exempt (401 from handler, not 403)");
}

console.log("[attachAuth + role gates] cookie and bearer paths, role escalation blocked");
{
  const app = buildApp();
  const env = baseEnv(fakeDb());
  const editorTok = await makeToken({ role: "editor" });
  const viewerTok = await makeToken({ role: "viewer", sub: "2", username: "vera" });
  const adminTok = await makeToken({ role: "admin", sub: "3", username: "ada" });

  assert((await app.request("/authed", {}, env)).status === 401, "no token → 401");
  assert(
    (await app.request("/authed", { headers: { cookie: `be_access=${editorTok}` } }, env)).status === 200,
    "access cookie accepted",
  );
  assert(
    (await app.request("/authed", { headers: { authorization: `Bearer ${editorTok}` } }, env)).status === 200,
    "bearer fallback accepted",
  );
  assert(
    (await app.request("/authed", { headers: { cookie: "be_access=tampered.jwt.value" } }, env)).status === 401,
    "tampered cookie token → 401",
  );

  assert(
    (await app.request("/editor-only", { headers: { cookie: `be_access=${viewerTok}` } }, env)).status === 403,
    "viewer blocked from editor route",
  );
  assert(
    (await app.request("/editor-only", { headers: { cookie: `be_access=${editorTok}` } }, env)).status === 200,
    "editor passes editor route",
  );
  assert(
    (await app.request("/admin-only", { headers: { cookie: `be_access=${editorTok}` } }, env)).status === 403,
    "editor blocked from admin route",
  );
  assert(
    (await app.request("/admin-only", { headers: { cookie: `be_access=${adminTok}` } }, env)).status === 200,
    "admin passes admin route",
  );
}

// ── refreshToken: the session row IS the revocation gate ───────────────────

console.log("[refreshToken] session-row gating: missing, revoked, expired, healthy");
{
  // Stub the network: the de-allowlisted case falls through to the DCS
  // org-membership check (isViewerOrgMember), which must not hit the real
  // git.door43.org from a test — and must deny when the lookup fails.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not found", { status: 404 });

  const app = buildApp();
  const now = Math.floor(Date.now() / 1000);
  const session = (over = {}) => ({
    id: "sess1",
    user_id: 7,
    expires_at: now + 1000,
    revoked_at: null,
    dcs_username: "alice",
    ...over,
  });

  const runCase = async (sessionRow, roleRow) => {
    const db = fakeDb(({ sql }) => {
      if (sql.includes("FROM sessions")) return sessionRow;
      if (sql.includes("FROM user_roles")) return roleRow;
      return null;
    });
    return app.request(
      "/api/auth/refresh",
      { method: "POST", headers: { cookie: "be_refresh=sess1" } },
      baseEnv(db),
    );
  };

  assert((await runCase(null, null)).status === 401, "unknown session id → 401");
  assert((await runCase(session({ revoked_at: now - 5 }), { role: "editor" })).status === 401, "revoked session → 401");
  assert((await runCase(session({ expires_at: now - 5 }), { role: "editor" })).status === 401, "expired session → 401");

  // De-allowlisted user: session is healthy but the role row is gone and the
  // org-membership fallback fails (DCS_BASE_URL fetch will error in tests —
  // isViewerOrgMember catches and denies). Must be 403, not a fresh token.
  const dropped = await runCase(session(), null);
  assert(dropped.status === 403, "healthy session but de-allowlisted user → 403");

  const healthy = await runCase(session(), { role: "editor" });
  assert(healthy.status === 200, "healthy session + allowlisted role → 200");
  const setCookie = healthy.headers.get("set-cookie") ?? "";
  assert(/be_access=/.test(setCookie), "healthy refresh rotates the access cookie");
  assert(/HttpOnly/i.test(setCookie), "rotated access cookie stays HttpOnly");
  const body = await healthy.json();
  assert(body.ok === true && body.role === "editor", "refresh reports the re-checked role");

  // Org-member fallback: no user_roles row, but DCS says the user is in the
  // viewer org → refresh succeeds with the viewer role.
  globalThis.fetch = async () =>
    new Response(JSON.stringify([{ username: "unfoldingWord" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const viewer = await runCase(session(), null);
  assert(viewer.status === 200, "org member without role row → 200");
  assert((await viewer.json()).role === "viewer", "org membership grants exactly viewer");

  globalThis.fetch = realFetch;
}

// ── updateLastLocation input validation ─────────────────────────────────────

console.log("[updateLastLocation] strict shape check before the DB write");
{
  const app = buildApp();
  const writes = [];
  const db = fakeDb(({ sql, args, op }) => {
    if (op === "run" && sql.includes("UPDATE users")) writes.push(args);
    return null;
  });
  const env = baseEnv(db);
  const tok = await makeToken({});
  const put = (body) =>
    app.request(
      "/loc",
      {
        method: "PUT",
        headers: {
          cookie: `be_access=${tok}; be_csrf=t`,
          "x-csrf-token": "t",
          "content-type": "application/json",
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      env,
    );

  assert((await put("{not json")).status === 400, "malformed JSON → 400");
  assert((await put({ book: "way-too-long", chapter: 1, verse: 1 })).status === 400, "non-slug book → 400");
  assert((await put({ book: "GEN", chapter: -1, verse: 1 })).status === 400, "negative chapter → 400");
  assert((await put({ book: "GEN", chapter: 1.5, verse: 1 })).status === 400, "fractional chapter → 400");
  assert((await put({ book: "GEN", chapter: 1 })).status === 400, "missing verse → 400");
  assert(writes.length === 0, "no DB write happened for any rejected body");

  const ok = await put({ book: "gen", chapter: 1, verse: 3 });
  assert(ok.status === 200, "valid location accepted");
  assert(writes.length === 1 && writes[0][0] === "GEN", "book uppercased on write");
}

// ── authMe ──────────────────────────────────────────────────────────────────

console.log("[authMe] identity echo, 401 without a token");
{
  const app = buildApp();
  const db = fakeDb(({ sql }) =>
    sql.includes("FROM users") ? { last_book: "ZEC", last_chapter: 4, last_verse: 6 } : null,
  );
  const env = baseEnv(db);

  assert((await app.request("/api/auth/me", {}, env)).status === 401, "anonymous /me → 401");

  const res = await app.request(
    "/api/auth/me",
    { headers: { cookie: `be_access=${await makeToken({})}` } },
    env,
  );
  assert(res.status === 200, "authed /me → 200");
  const body = await res.json();
  assert(
    body.userId === 1 && body.username === "alice" && body.role === "editor" && body.lastBook === "ZEC",
    "/me echoes claims + stored location",
  );
}

// ── fetchCurrentUserOrgs / fetchUserOrgsByLogin: pagination, fail-closed ────

console.log("[org pagination] full pages continue, short page terminates, any page failure discards the whole result");
{
  const env = baseEnv(fakeDb());
  const page = (names) =>
    new Response(JSON.stringify(names.map((n) => ({ username: n }))), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const fiftyNames = Array.from({ length: 50 }, (_, i) => `org${i}`);

  let calls = 0;
  const twoPageFetch = async (url) => {
    calls++;
    const p = Number(new URL(String(url)).searchParams.get("page"));
    if (p === 1) return page(fiftyNames);
    if (p === 2) return page(["orgLast"]);
    throw new Error(`unexpected page ${p}`);
  };
  const result = await fetchCurrentUserOrgs(env, "tok", { fetch: twoPageFetch });
  assert(result.ok === true, "two-page fetch succeeds");
  assert(
    result.orgs.length === 51 && result.orgs[50] === "orgLast",
    "pages concatenated in order across the boundary",
  );
  assert(calls === 2, "stops after the short (final) page — no unnecessary page 3 request");

  // A full page-1 (50 items, i.e. "there might be more") followed by a
  // page-2 failure must discard EVERYTHING fetched so far, not just page 2.
  const failOnPage2 = async (url) => {
    const p = Number(new URL(String(url)).searchParams.get("page"));
    if (p === 1) return page(fiftyNames);
    return new Response("boom", { status: 500 });
  };
  const failed = await fetchCurrentUserOrgs(env, "tok", { fetch: failOnPage2 });
  assert(failed.ok === false, "page-2 failure -> ok:false (partial page-1 result discarded, not returned)");

  const byLoginFailed = await fetchUserOrgsByLogin(env, "alice", { fetch: failOnPage2 });
  assert(byLoginFailed.ok === false, "the service-token by-login path fails closed on page-2 error too");

  const networkError = async () => {
    throw new Error("network down");
  };
  assert(
    (await fetchCurrentUserOrgs(env, "tok", { fetch: networkError })).ok === false,
    "network throw -> ok:false",
  );
  const badJson = async () => new Response("not json", { status: 200 });
  assert(
    (await fetchCurrentUserOrgs(env, "tok", { fetch: badJson })).ok === false,
    "non-JSON 200 body -> ok:false",
  );

  // Every page full up to the page-count cap → we can't prove we saw the whole
  // list, so fail closed rather than return a silently-truncated one (a viewer
  // org past the cap would otherwise read as absent).
  let capCalls = 0;
  const alwaysFull = async () => {
    capCalls++;
    return page(fiftyNames); // always exactly PAGE_LIMIT → "there might be more"
  };
  const capped = await fetchCurrentUserOrgs(env, "tok", { fetch: alwaysFull });
  assert(capped.ok === false, "page-cap exhaustion with full pages -> ok:false (never a truncated ok)");
  assert(capCalls === 20, "stops at the 20-page ceiling, not an unbounded loop");
}

console.log("[refreshToken] viewer org-membership check fails closed on a page-2 pagination failure");
{
  // A user with NO user_roles row, whose true org membership (the viewer org)
  // sits on page 2. If page 2 fails, the partial page-1 list (which doesn't
  // contain the viewer org) must NOT be treated as the complete list — the
  // refresh must deny (403), not silently grant viewer from an incomplete page.
  const realFetch = globalThis.fetch;
  const fiftyOtherOrgs = Array.from({ length: 50 }, (_, i) => ({ username: `other-org-${i}` }));
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    const page = Number(u.searchParams.get("page"));
    if (page === 1) {
      return new Response(JSON.stringify(fiftyOtherOrgs), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // page 2 (which would have contained "unfoldingWord") fails.
    return new Response("boom", { status: 500 });
  };

  const app = buildApp();
  const now = Math.floor(Date.now() / 1000);
  const db = fakeDb(({ sql }) => {
    if (sql.includes("FROM sessions")) {
      return { id: "sess1", user_id: 7, expires_at: now + 1000, revoked_at: null, dcs_username: "alice" };
    }
    if (sql.includes("FROM user_roles")) return null; // not on the allowlist
    return null;
  });
  const res = await app.request(
    "/api/auth/refresh",
    { method: "POST", headers: { cookie: "be_refresh=sess1" } },
    baseEnv(db),
  );
  assert(res.status === 403, "page-2 pagination failure -> viewer auth fails closed, not granted from a partial list");

  globalThis.fetch = realFetch;
}

// ── updateWorkModePrefs ──────────────────────────────────────────────────────

console.log("[updateWorkModePrefs] enum validation, NULL round-trip, requires auth");
{
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("*", requireCsrf);
  app.put("/api/users/me/prefs", requireAuth, updateWorkModePrefs);

  const writes = [];
  const db = fakeDb(({ sql, args, op }) => {
    if (op === "run" && sql.includes("UPDATE users SET work_mode")) {
      writes.push(args);
      return null;
    }
    return null;
  });
  const env = baseEnv(db);
  const tok = await makeToken({});
  const put = (body, headers = {}) =>
    app.request(
      "/api/users/me/prefs",
      {
        method: "PUT",
        headers: {
          cookie: `be_access=${tok}; be_csrf=t`,
          "x-csrf-token": "t",
          "content-type": "application/json",
          ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      env,
    );

  assert((await put({ workMode: "admin" })).status === 400, "unrecognized enum value -> 400");
  assert((await put({ workMode: 123 })).status === 400, "non-string workMode -> 400");
  assert((await put("{not json")).status === 400, "malformed JSON -> 400");
  assert(writes.length === 0, "no DB write happened for any rejected body");

  const okAuthor = await put({ workMode: "author" });
  assert(okAuthor.status === 200, "valid workMode('author') accepted");
  assert(writes[0][0] === "author" && writes[0][1] === 1, "stores the workMode value for the authed user");

  const okNull = await put({ workMode: null });
  assert(okNull.status === 200, "NULL is a valid workMode (clears the stored preference)");
  assert(writes[1][0] === null, "NULL round-trips to the DB, not coerced to a string");

  const noAuth = await app.request(
    "/api/users/me/prefs",
    {
      method: "PUT",
      headers: { cookie: "be_csrf=t", "x-csrf-token": "t", "content-type": "application/json" },
      body: JSON.stringify({ workMode: "translate" }),
    },
    env,
  );
  assert(noAuth.status === 401, "no access token -> 401 (requireAuth gates the route)");
}

// ── authMe: workMode + orgs ───────────────────────────────────────────────────

console.log("[authMe] workMode + orgs passthrough; malformed dcs_orgs_json fails safe to []");
{
  const app = buildApp();

  const malformed = fakeDb(({ sql }) =>
    sql.includes("FROM users")
      ? { last_book: null, last_chapter: null, last_verse: null, work_mode: "author", dcs_orgs_json: "not json{" }
      : null,
  );
  const res1 = await app.request(
    "/api/auth/me",
    { headers: { cookie: `be_access=${await makeToken({})}` } },
    baseEnv(malformed),
  );
  const body1 = await res1.json();
  assert(body1.workMode === "author", "workMode passed through from the users row");
  assert(Array.isArray(body1.orgs) && body1.orgs.length === 0, "malformed dcs_orgs_json -> orgs: []");

  const wellFormed = fakeDb(({ sql }) =>
    sql.includes("FROM users")
      ? { last_book: null, last_chapter: null, last_verse: null, work_mode: null, dcs_orgs_json: '["orga","orgb"]' }
      : null,
  );
  const res2 = await app.request(
    "/api/auth/me",
    { headers: { cookie: `be_access=${await makeToken({})}` } },
    baseEnv(wellFormed),
  );
  const body2 = await res2.json();
  assert(body2.workMode === null, "NULL work_mode -> workMode: null (no stored preference)");
  assert(body2.orgs.length === 2 && body2.orgs[0] === "orga", "well-formed dcs_orgs_json parses through");
}

console.log("[mintDevToken] OAuth vs dev MeResponse parity: workMode passthrough, orgs always []");
{
  const app = new Hono();
  app.post("/api/auth/dev", (c) => mintDevToken(c, "devuser"));
  const db = fakeDb(({ sql }) => {
    if (sql.includes("FROM user_roles")) return { role: "editor" };
    if (sql.includes("SELECT id FROM users WHERE dcs_username")) return { id: 5 };
    if (sql.includes("SELECT last_book")) {
      return { last_book: null, last_chapter: null, last_verse: null, work_mode: "translate" };
    }
    return null;
  });
  const res = await app.request("/api/auth/dev", { method: "POST" }, baseEnv(db));
  const body = await res.json();
  assert(
    body.workMode === "translate" && Array.isArray(body.orgs) && body.orgs.length === 0,
    "dev sign-in returns the stored workMode + orgs: [] — same MeResponse shape as OAuth",
  );
}

// ── callbackDcsAuth: best-effort org cache (failure preserves, success stores) ─

console.log("[callbackDcsAuth] org-cache: fetch failure leaves prior cache untouched; success (incl. empty) always stores fresh");
{
  const app = new Hono();
  app.get("/api/auth/dcs/start", startDcsAuth);
  app.get("/api/auth/dcs/callback", callbackDcsAuth);

  const orgCacheWrites = [];
  const db = fakeDb(({ sql, args, op }) => {
    if (sql.includes("FROM user_roles")) return { role: "editor" };
    if (op === "run" && sql.includes("UPDATE users SET dcs_orgs_json")) {
      orgCacheWrites.push(args);
      return null;
    }
    if (op === "run" && sql.includes("INSERT INTO users")) return null;
    if (sql.includes("SELECT id FROM users WHERE dcs_user_id")) return { id: 42 };
    return null;
  });
  const env = {
    ...baseEnv(db),
    DCS_CLIENT_ID: "cid",
    DCS_CLIENT_SECRET: "secret",
    DCS_OAUTH_AUTHORIZE_URL: "https://git.door43.org/login/oauth/authorize",
    DCS_OAUTH_TOKEN_URL: "https://git.door43.org/login/oauth/access_token",
  };

  const startRes = await app.request("/api/auth/dcs/start", {}, env);
  const setCookieHeader = startRes.headers.get("set-cookie") ?? "";
  const stateCookieVal = /dcs_auth_state=([^;]+)/.exec(setCookieHeader)?.[1];
  const stateParam = new URL(startRes.headers.get("location")).searchParams.get("state");
  assert(stateCookieVal && stateParam, "start endpoint issued a state cookie + redirect state param");

  let orgFetchMode = "fail";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "tok123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.endsWith("/api/v1/user")) {
      return new Response(JSON.stringify({ id: 999, login: "alice" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/api/v1/user/orgs")) {
      if (orgFetchMode === "fail") return new Response("boom", { status: 500 });
      if (orgFetchMode === "empty") {
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response("not found", { status: 404 });
  };

  const runCallback = () =>
    app.request(
      `/api/auth/dcs/callback?state=${stateParam}&code=abc`,
      { headers: { cookie: `dcs_auth_state=${stateCookieVal}` } },
      env,
    );

  orgFetchMode = "fail";
  const res1 = await runCallback();
  assert(res1.status === 302, "sign-in succeeds (redirect) even when the org fetch fails");
  assert(orgCacheWrites.length === 0, "failed org fetch never issues the cache UPDATE — old cache/timestamp left untouched");

  orgFetchMode = "empty";
  const res2 = await runCallback();
  assert(res2.status === 302, "sign-in succeeds on the empty-orgs path too");
  assert(
    orgCacheWrites.length === 1 && orgCacheWrites[0][0] === "[]",
    "a successful EMPTY org list still stores '[]' + a fresh timestamp (failure != empty)",
  );

  globalThis.fetch = realFetch;
}

// ── Regression: edits demote validated -> edited in BOTH work modes ─────────
//
// The Translate/Author toggle is a per-user CLIENT-side view preference
// (users.work_mode); rows.ts's demotion CASE has no awareness of it at all —
// it keys purely on the row's own translation_state. This runs the actual
// literal CASE clause from rows.ts (copied verbatim, not reimplemented) against
// a real SQLite table via node:sqlite, with users.work_mode set to each of
// 'translate', 'author', and NULL, to prove the demotion is identical in every
// case: Author mode hides the review UI client-side, it does not change what
// the server does to the row on edit.
{
  const { DatabaseSync } = await import("node:sqlite");
  console.log("[regression] validated -> edited demotion fires identically regardless of the user's work_mode");

  // Exact fragment from rows.ts's PATCH handler (kind === "tn" / "tq" arm) —
  // kept in sync by inspection; the point is this SQL never mentions work_mode.
  const DEMOTION_CASE =
    "translation_state = CASE WHEN translation_state IN ('ai_draft','validated') THEN 'edited' ELSE translation_state END";

  for (const workMode of ["translate", "author", null]) {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, work_mode TEXT);
      CREATE TABLE tn_rows (id TEXT PRIMARY KEY, translation_state TEXT, version INTEGER NOT NULL DEFAULT 1);
      INSERT INTO users (id, work_mode) VALUES (1, ${workMode === null ? "NULL" : `'${workMode}'`});
      INSERT INTO tn_rows (id, translation_state, version) VALUES ('row1', 'validated', 1);
    `);
    // Simulate a content-field edit: bump version + apply the same literal
    // demotion CASE rows.ts appends for kind==='tn'. No reference to users or
    // work_mode anywhere in this statement — demotion is row-state-only.
    db.exec(`UPDATE tn_rows SET ${DEMOTION_CASE}, version = version + 1 WHERE id = 'row1'`);
    const row = db.prepare("SELECT translation_state, version FROM tn_rows WHERE id = 'row1'").get();
    assert(
      row.translation_state === "edited" && row.version === 2,
      `edit demotes validated -> edited under users.work_mode=${workMode} (server has no mode awareness)`,
    );
    db.close();
  }
}

console.log("auth: all assertions passed");
