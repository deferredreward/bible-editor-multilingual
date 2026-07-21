// Viewer read-only enforcement tests — the global blockViewerWrites backstop
// (viewerGuard.ts) plus the per-route guards it backs up, exercised against
// REAL route modules mounted the same way index.ts mounts them.
//
// Chain mirrors index.ts: attachAuth → requireCsrf → blockViewerWrites →
// routes. (requireWorkspaceMatch is skipped — workspace pinning is orthogonal
// to role enforcement and has its own suite in workspaces.test.mjs.)
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/viewerGuard.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { Hono } from "hono";
import { SignJWT } from "jose";
import { attachAuth, requireCsrf, requireEditor, refreshToken, updateLastLocation } from "./auth.ts";
import { blockViewerWrites, isViewerWritablePath } from "./viewerGuard.ts";
import { alerts } from "./alerts.ts";
import { rows } from "./rows.ts";
import { verses } from "./verses.ts";
import { l10n } from "./l10n.ts";
import { scriptureLaneRoutes } from "./scriptureLaneRoutes.ts";

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

// D1 stub: handler(sql, args, op) → result; run() defaults to one-changed.
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

function baseEnv(db) {
  return { JWT_SIGNING_KEY: SIGNING, JWT_ISSUER: ISSUER, DCS_BASE_URL: "https://git.door43.org", DB: db };
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

// Build an app with the index.ts middleware order and real route modules.
function buildApp() {
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("*", requireCsrf);
  app.use("*", blockViewerWrites);
  app.route("/api/alerts", alerts);
  app.route("/api/rows", rows);
  app.route("/api/verses", verses);
  app.route("/api/l10n", l10n);
  app.route("/api/project-config/lanes", scriptureLaneRoutes);
  app.post("/api/auth/refresh", refreshToken);
  app.put("/api/users/me/location", updateLastLocation);
  // Deliberately UNGUARDED write route — stands in for a future route someone
  // forgets to add requireEditor to. The backstop must still 403 viewers.
  app.post("/api/future-unguarded", (c) => c.json({ ok: true }));
  // Workspace switch stand-in (the real workspaceRoutes handler needs live
  // cookie/session plumbing; the guard only cares about the path prefix).
  app.post("/api/workspaces/other", (c) => c.json({ ok: true }));
  app.get("/api/read-anything", (c) => c.json({ ok: true }));
  return app;
}

// Every write below sends the CSRF pair; auth via be_access cookie.
function writeReq(method, token, body) {
  return {
    method,
    headers: {
      cookie: `be_access=${token}; be_csrf=tok123`,
      "x-csrf-token": "tok123",
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

const app = buildApp();
const viewerTok = await makeToken({ role: "viewer", sub: "2", username: "vera" });
const editorTok = await makeToken({ role: "editor", sub: "1", username: "alice" });
const adminTok = await makeToken({ role: "admin", sub: "3", username: "ada" });

// ── allowlist unit checks ───────────────────────────────────────────────────

console.log("[isViewerWritablePath] classifies self-scoped vs content paths");
{
  assert(isViewerWritablePath("/api/auth/refresh"), "auth endpoints self-scoped");
  assert(isViewerWritablePath("/api/users/me/location"), "own location self-scoped");
  assert(isViewerWritablePath("/api/workspaces/mltest"), "workspace switch self-scoped");
  assert(isViewerWritablePath("/api/alerts/7/dismiss"), "alert dismiss self-scoped");
  assert(!isViewerWritablePath("/api/rows/tn"), "rows are content");
  assert(!isViewerWritablePath("/api/verses/ZEC/1/1/ULT"), "verses are content");
  assert(!isViewerWritablePath("/api/books/ZEC/import"), "imports are content");
  assert(!isViewerWritablePath("/api/project-config/lanes/lit/validate"), "lane config is content");
}

// ── viewer blocked on content writes ────────────────────────────────────────

console.log("[viewer] 403 on representative content-write routes");
{
  const env = baseEnv(fakeDb());
  const cases = [
    ["POST", "/api/rows/tn", { book: "ZEC" }],
    ["PATCH", "/api/rows/tn/abc123", { note: "x" }],
    ["DELETE", "/api/rows/tn/abc123", undefined],
    ["PATCH", "/api/verses/ZEC/1/1/ULT", { contentJson: {} }],
    ["PUT", "/api/l10n/overrides/en", { overrides: {} }],
    ["POST", "/api/project-config/lanes/lit/validate", { url: "x" }],
    ["POST", "/api/future-unguarded", {}],
  ];
  for (const [method, path, body] of cases) {
    const res = await app.request(path, writeReq(method, viewerTok, body), env);
    assert(res.status === 403, `viewer ${method} ${path} → 403 (got ${res.status})`);
  }
  // The backstop (not just per-route guards) is what catches the unguarded
  // route — prove the response is the guard's own shape.
  const res = await app.request("/api/future-unguarded", writeReq("POST", viewerTok, {}), env);
  const bodyJson = await res.json();
  assert(bodyJson.reason === "viewer_read_only", "unguarded route rejected by backstop");
}

console.log("[viewer] reads stay open");
{
  const env = baseEnv(fakeDb());
  const res = await app.request(
    "/api/read-anything",
    { headers: { cookie: `be_access=${viewerTok}` } },
    env,
  );
  assert(res.status === 200, "viewer GET passes untouched");
  const anon = await app.request("/api/read-anything", {}, env);
  assert(anon.status === 200, "anonymous GET passes untouched");
}

// ── viewer allowed on self-scoped writes ────────────────────────────────────

console.log("[viewer] self-scoped writes still work");
{
  const env = baseEnv(fakeDb());
  const dismiss = await app.request("/api/alerts/7/dismiss", writeReq("POST", viewerTok), env);
  assert(dismiss.status === 200, `viewer can dismiss own alert (got ${dismiss.status})`);
  const dismissed = await dismiss.json();
  assert(dismissed.ok === true && dismissed.changed === true, "dismiss reached the handler");

  const loc = await app.request(
    "/api/users/me/location",
    writeReq("PUT", viewerTok, { book: "ZEC", chapter: 1, verse: 1 }),
    env,
  );
  assert(loc.status === 200, `viewer can save own reading position (got ${loc.status})`);

  const ws = await app.request("/api/workspaces/other", writeReq("POST", viewerTok, {}), env);
  assert(ws.status === 200, `viewer can hit workspace-switch path (got ${ws.status})`);

  // CSRF-exempt auth route: the guard must not intercept; the handler's own
  // 401 (no refresh cookie) proves the request reached it.
  const refresh = await app.request("/api/auth/refresh", { method: "POST" }, env);
  assert(refresh.status === 401, "auth refresh reaches handler (401 from handler, not 403 from guard)");
}

// ── editors and admins unaffected by the backstop ───────────────────────────

console.log("[editor/admin] backstop does not block privileged roles");
{
  const env = baseEnv(fakeDb());
  const unguarded = await app.request("/api/future-unguarded", writeReq("POST", editorTok, {}), env);
  assert(unguarded.status === 200, "editor passes the backstop");

  // Editor on the newly admin-gated lane validate → 403 from requireAdmin.
  const laneEditor = await app.request(
    "/api/project-config/lanes/lit/validate",
    writeReq("POST", editorTok, { url: "garbage" }),
    env,
  );
  assert(laneEditor.status === 403, `editor blocked from lane validate (got ${laneEditor.status})`);

  // Admin reaches the handler (400 invalid URL — proves the guard passed
  // before any DB access).
  const laneAdmin = await app.request(
    "/api/project-config/lanes/lit/validate",
    writeReq("POST", adminTok, { url: "garbage" }),
    env,
  );
  assert(laneAdmin.status === 400, `admin reaches lane validate handler (got ${laneAdmin.status})`);
}

// ── unauthenticated writes: guard defers to per-route auth ─────────────────

console.log("[anonymous] backstop passes through; per-route guards still decide");
{
  const env = baseEnv(fakeDb());
  const res = await app.request(
    "/api/rows/tn",
    {
      method: "POST",
      headers: { cookie: "be_csrf=tok123", "x-csrf-token": "tok123", "content-type": "application/json" },
      body: JSON.stringify({}),
    },
    env,
  );
  assert(res.status === 401, `anonymous content write → 401 from requireEditor (got ${res.status})`);
  // requireEditor (not the viewer backstop) must be the rejecting layer.
  const bodyJson = await res.json();
  assert(bodyJson.error === "unauthorized", "rejected by per-route auth, not the viewer backstop");
}

console.log("viewerGuard tests passed");
