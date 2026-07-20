// Unit test for the workspace resolution ExportWorkflow.run() performs at the
// very top of the method (see exportWorkflow.ts) before touching this.env.
//
// Workflows don't inherit the per-request env clone that index.ts's fetch
// wrapper builds — this.env inside a WorkflowEntrypoint is always the RAW
// Worker env. run() re-points it with:
//   workspaceEnv(this.env, resolveWorkspace(this.env, params.workspace ?? null))
// This test exercises exactly that composition against a raw env, without
// instantiating a real WorkflowEntrypoint (which needs Cloudflare Workflow
// runtime bindings this test harness doesn't have).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/exportWorkflowWorkspace.test.mjs

import { workspaceEnv, resolveWorkspace } from "./workspaces.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

function fakeD1(tag) {
  return { prepare: () => ({ tag }), _tag: tag };
}

console.log("[ExportWorkflow env re-point] resolves the named workspace's DB binding");
{
  const defaultDb = fakeD1("default-DB");
  const orgDb = fakeD1("org2-DB");
  const rawEnv = {
    DB: defaultDb,
    DB_ORG2: orgDb,
    WORKSPACES: JSON.stringify([
      { slug: "uw", label: "UW", org: "unfoldingWord", binding: "DB" },
      { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB_ORG2" },
    ]),
  };

  // params.workspace = "org2" -> this.env.DB must be the org2 binding, not
  // the raw env's default DB.
  const resolved = workspaceEnv(rawEnv, resolveWorkspace(rawEnv, "org2"));
  assert(resolved.DB === orgDb, "named workspace resolves to its own D1 binding");
  assert(resolved.VIEWER_ORG === "OrgTwo", "VIEWER_ORG stamped for the named workspace");
  assert(resolved.WORKSPACE_SLUG === "org2", "WORKSPACE_SLUG stamped for the named workspace");
}

console.log("[ExportWorkflow env re-point] params.workspace undefined -> default binding (pre-workspaces behavior)");
{
  const defaultDb = fakeD1("default-DB");
  const orgDb = fakeD1("org2-DB");
  const rawEnv = {
    DB: defaultDb,
    DB_ORG2: orgDb,
    WORKSPACES: JSON.stringify([
      { slug: "uw", label: "UW", org: "unfoldingWord", binding: "DB" },
      { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB_ORG2" },
    ]),
  };

  // run() calls resolveWorkspace(this.env, params.workspace ?? null) — an
  // absent workspace param (old queued instances, or WORKSPACES unset) must
  // fall back to the first/default workspace, exactly like a request with no
  // be_ws cookie.
  const resolved = workspaceEnv(rawEnv, resolveWorkspace(rawEnv, undefined ?? null));
  assert(resolved.DB === defaultDb, "undefined workspace param falls back to the default binding");
  assert(resolved.WORKSPACE_SLUG === "uw", "WORKSPACE_SLUG falls back to the first/default workspace's slug");
}

console.log("[ExportWorkflow env re-point] WORKSPACES entirely unset -> single implicit default, unaffected");
{
  const db = fakeD1("DB");
  const rawEnv = { DB: db };

  const resolved = workspaceEnv(rawEnv, resolveWorkspace(rawEnv, null));
  assert(resolved.DB === db, "WORKSPACES unset -> DB unchanged (implicit default binding)");
  assert(resolved.WORKSPACE_SLUG === "default", "WORKSPACES unset -> WORKSPACE_SLUG is the implicit 'default' slug");
}

console.log("exportWorkflowWorkspace: all assertions passed");
