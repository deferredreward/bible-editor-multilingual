// Unit tests for orgRoutes.ts GET /api/orgs/search — the clean-match org
// verify behind the Setup wizard's org-entry step. Mirrors adminUsers.test.mjs:
// a real Hono app, real requireAuth/requireAdmin gating (stamped via a tiny
// pre-middleware instead of attachAuth so no DB/JWT is needed), and a stubbed
// globalThis.fetch restored in a finally so it never leaks between tests.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/orgRoutes.test.mjs

import { Hono } from "hono";
import { orgRoutes } from "./orgRoutes.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const ENV = { DCS_BASE_URL: "https://git.door43.org", DCS_SERVICE_TOKEN: "svc" };

// Build an app that stamps a fixed auth context (mimicking attachAuth) then
// mounts the real orgRoutes (which apply requireAuth + requireAdmin).
function buildApp({ userId, role } = {}) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (userId !== undefined) c.set("userId", userId);
    if (role !== undefined) c.set("role", role);
    await next();
  });
  app.route("/api/orgs", orgRoutes);
  return app;
}

// A DCS org-lookup stub: GET /api/v1/orgs/{org} returns 200 with the canonical
// record for any org whose lowercase name is in `known`, else 404.
function stubOrgs(known) {
  globalThis.fetch = async (url) => {
    const m = /\/api\/v1\/orgs\/([^/?]+)/.exec(String(url));
    const name = m ? decodeURIComponent(m[1]).toLowerCase() : "";
    const rec = known[name];
    if (!rec) {
      return new Response(JSON.stringify({ message: "GetOrgByName" }), { status: 404 });
    }
    return new Response(JSON.stringify(rec), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const realFetch = globalThis.fetch;

// ── Auth gating ─────────────────────────────────────────────────────────────
console.log("[auth] GET /api/orgs/search requires an authenticated admin");
{
  stubOrgs({});
  try {
    assert(
      (await buildApp().request("/api/orgs/search?q=unfoldingWord", {}, ENV)).status === 401,
      "no auth → 401",
    );
    assert(
      (await buildApp({ userId: 2, role: "editor" }).request("/api/orgs/search?q=x", {}, ENV))
        .status === 403,
      "editor → 403",
    );
    assert(
      (await buildApp({ userId: 1, role: "admin" }).request("/api/orgs/search?q=x", {}, ENV))
        .status === 200,
      "admin → 200",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── Clean match ─────────────────────────────────────────────────────────────
console.log("[clean match] exact canonical verify returns a single match + canonical");
{
  stubOrgs({ unfoldingword: { username: "unfoldingWord", full_name: "unfoldingWord®" } });
  try {
    const app = buildApp({ userId: 1, role: "admin" });
    // typed lowercase resolves to canonical casing
    const res = await app.request("/api/orgs/search?q=unfoldingword", {}, ENV);
    assert(res.status === 200, "200");
    const body = await res.json();
    assert(body.canonical === "unfoldingWord", "canonical is DCS casing");
    assert(Array.isArray(body.matches) && body.matches.length === 1, "one match");
    assert(body.matches[0].org === "unfoldingWord", "match org canonical");
    assert(body.matches[0].fullName === "unfoldingWord®", "match fullName from DCS");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── Not found ───────────────────────────────────────────────────────────────
console.log("[not found] a query that resolves to nothing returns empty matches, no canonical");
{
  stubOrgs({ unfoldingword: { username: "unfoldingWord" } });
  try {
    const app = buildApp({ userId: 1, role: "admin" });
    const res = await app.request("/api/orgs/search?q=NoSuchOrg", {}, ENV);
    assert(res.status === 200, "200");
    const body = await res.json();
    assert(Array.isArray(body.matches) && body.matches.length === 0, "no matches");
    assert(body.canonical === undefined, "no canonical");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── Empty / invalid query (ambiguous-or-empty path) ─────────────────────────
console.log("[empty/invalid] blank or non-ident query returns empty matches without hitting DCS");
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    const app = buildApp({ userId: 1, role: "admin" });
    const empty = await app.request("/api/orgs/search?q=", {}, ENV);
    assert(empty.status === 200 && (await empty.json()).matches.length === 0, "blank q → empty");
    const bad = await app.request("/api/orgs/search?q=bad%20org!", {}, ENV);
    assert(bad.status === 200 && (await bad.json()).matches.length === 0, "non-ident q → empty");
    assert(calls === 0, "no DCS lookup for blank/invalid queries");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("orgRoutes search tests passed");
