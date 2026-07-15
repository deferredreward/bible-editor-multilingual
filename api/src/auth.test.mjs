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
  authMe,
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
  return { JWT_SIGNING_KEY: SIGNING, JWT_ISSUER: ISSUER, DCS_BASE_URL: "https://git.door43.org", DB: db };
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

console.log("auth: all assertions passed");
