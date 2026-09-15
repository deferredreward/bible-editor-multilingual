// Unit test for the workspace resolution TranslateWorkflow.run() performs at the
// very top of the method (see translateWorkflow.ts) before touching this.env.
//
// Workflows don't inherit the per-request env clone that index.ts's fetch
// wrapper builds — this.env inside a WorkflowEntrypoint is always the RAW
// Worker env. run() re-points it with:
//   workspaceEnv(this.env, resolveWorkflowWorkspace(this.env, params))
// This test exercises exactly that composition against a raw env, without
// instantiating a real WorkflowEntrypoint (which needs Cloudflare Workflow
// runtime bindings this test harness doesn't have). Cloned from
// exportWorkflowWorkspace.test.mjs, with one deliberate difference: the
// export tolerates a missing params.workspace (default binding); the translate
// runner refuses it, and refuses an unknown slug, because both would otherwise
// read another tenant's provider key and write another tenant's job row.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translateWorkflowWorkspace.test.mjs

import { workspaceEnv } from "./workspaces.ts";
import { resolveWorkflowWorkspace, classifyStepError } from "./translate/workflowSteps.ts";

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

function rawEnvWithTwoOrgs() {
  return {
    DB: fakeD1("default-DB"),
    DB_ORG2: fakeD1("org2-DB"),
    WORKSPACES: JSON.stringify([
      { slug: "uw", label: "UW", org: "unfoldingWord", binding: "DB" },
      { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB_ORG2" },
    ]),
  };
}

function thrown(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

console.log("[TranslateWorkflow env re-point] resolves the named workspace's DB binding");
{
  const rawEnv = rawEnvWithTwoOrgs();
  // params.workspace = "org2" -> this.env.DB must be the org2 binding, not
  // the raw env's default DB.
  const resolved = workspaceEnv(rawEnv, resolveWorkflowWorkspace(rawEnv, { workspace: "org2" }));
  assert(resolved.DB === rawEnv.DB_ORG2, "named workspace resolves to its own D1 binding");
  assert(resolved.VIEWER_ORG === "OrgTwo", "VIEWER_ORG stamped for the named workspace");
  assert(resolved.WORKSPACE_SLUG === "org2", "WORKSPACE_SLUG stamped for the named workspace (prefixes every R2 key)");
  assert(resolved.BASE_ENV === rawEnv || resolved.BASE_ENV?.DB === rawEnv.DB, "BASE_ENV keeps the raw env for later lookups");
}

console.log("[TranslateWorkflow env re-point] params.workspace missing -> non-retryable workspace_missing, NOT the default binding");
{
  const rawEnv = rawEnvWithTwoOrgs();
  for (const params of [{}, { workspace: undefined }, { workspace: null }, { workspace: "" }, undefined]) {
    const err = thrown(() => resolveWorkflowWorkspace(rawEnv, params));
    assert(err !== null, `throws for params=${JSON.stringify(params)}`);
    const c = classifyStepError(err);
    assert(c.errorKind === "workspace_missing", `errorKind is workspace_missing for params=${JSON.stringify(params)} (got ${c.errorKind})`);
    assert(c.retryable === false, "workspace_missing is non-retryable (the Workflow maps it to NonRetryableError)");
  }
}

console.log("[TranslateWorkflow env re-point] unknown slug -> non-retryable workspace_unknown (resolveWorkspace alone would hand back list[0])");
{
  const rawEnv = rawEnvWithTwoOrgs();
  const err = thrown(() => resolveWorkflowWorkspace(rawEnv, { workspace: "retired-org" }));
  assert(err !== null, "throws for an unknown slug");
  const c = classifyStepError(err);
  assert(c.errorKind === "workspace_unknown", `errorKind is workspace_unknown (got ${c.errorKind})`);
  assert(c.retryable === false, "workspace_unknown is non-retryable");
  assert(/retired-org/.test(err.message), "message names the offending slug");
}

console.log("[TranslateWorkflow env re-point] WORKSPACES entirely unset -> the implicit 'default' slug is the only valid workspace");
{
  const db = fakeD1("DB");
  const rawEnv = { DB: db };
  // Dispatch passes env.WORKSPACE_SLUG, which the fetch wrapper stamps as
  // "default" on a single-workspace deployment — so that is what arrives.
  const resolved = workspaceEnv(rawEnv, resolveWorkflowWorkspace(rawEnv, { workspace: "default" }));
  assert(resolved.DB === db, "WORKSPACES unset -> DB unchanged (implicit default binding)");
  assert(resolved.WORKSPACE_SLUG === "default", "WORKSPACES unset -> WORKSPACE_SLUG is the implicit 'default' slug");
  const err = thrown(() => resolveWorkflowWorkspace(rawEnv, { workspace: "uw" }));
  assert(err !== null && classifyStepError(err).errorKind === "workspace_unknown", "any other slug on a single-workspace deployment is unknown, not silently default");
}

console.log("translateWorkflowWorkspace: all assertions passed");
