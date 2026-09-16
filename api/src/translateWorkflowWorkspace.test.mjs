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

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { workspaceEnv, primeWorkspaces } from "./workspaces.ts";
import { resolveWorkflowWorkspace, resolveWorkflowWorkspaceFresh, classifyStepError } from "./translate/workflowSteps.ts";

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


// ── warm-stale isolate: an org claimed after this isolate primed ────────────
//
// resolveWorkflowWorkspace reads the per-isolate registry cache, which is
// primed ONCE and never expires. An org claimed on a sibling isolate is
// therefore "unknown" here — and unknown is a permanent, non-retryable refusal,
// so every run that org queues would fail until the isolate recycled. Same
// class as the request-path hole issue #418/#419 closed; run() uses the Fresh
// variant, which re-reads the registry once before refusing. Two-isolate model
// and helpers mirror workspaceResolveFresh.test.mjs.

console.log("[TranslateWorkflow env re-point] a slug claimed after this isolate primed resolves, instead of refusing forever");
{
  const MIGRATION = readFileSync(new URL("../migrations/0058_workspaces_registry.sql", import.meta.url), "utf8");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = OFF;");
  sqlite.exec(MIGRATION);
  const claim = (slug, org, binding) => sqlite
    .prepare("INSERT INTO workspaces (slug, label, org, binding, status) VALUES (?,?,?,?, 'claimed')")
    .run(slug, org, org, binding);
  const bound = (sql, params) => ({
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } }),
  });
  const sharedD1 = {
    prepare: (sql) => ({ bind: (...params) => bound(sql, params), ...bound(sql, []) }),
    batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
    _tag: "shared-db",
  };

  claim("home", "HomeOrg", "DB"); // list[0] — the tenant a bad fallback would hand back
  const env = { DB: sharedD1, DB_ORGX: { prepare: () => ({}) } };
  await primeWorkspaces(env);

  // The claim lands on ANOTHER isolate; this one's cache is unaware.
  claim("orgx", "OrgX", "DB_ORGX");

  const stale = thrown(() => resolveWorkflowWorkspace(env, { workspace: "orgx" }));
  assert(stale !== null && classifyStepError(stale).errorKind === "workspace_unknown",
    "the cache-only resolver refuses the freshly-claimed org (the bug: every run of that org fails)");

  const fresh = await resolveWorkflowWorkspaceFresh(env, { workspace: "orgx" });
  assert(fresh.slug === "orgx", "the Fresh resolver re-reads the registry and resolves the org");
  assert(fresh.binding === "DB_ORGX", "…to OrgX's own binding, never the home tenant's DB");

  // The cross-tenant guard itself is unchanged: a genuinely unknown slug still
  // refuses rather than falling back to list[0] the way resolveWorkspaceFresh does.
  let ghost = null;
  try { await resolveWorkflowWorkspaceFresh(env, { workspace: "ghost-slug" }); } catch (e) { ghost = e; }
  assert(ghost !== null, "a genuinely unknown slug still throws");
  assert(classifyStepError(ghost).errorKind === "workspace_unknown", "…as workspace_unknown");
  assert(classifyStepError(ghost).retryable === false, "…non-retryable");
  const missing = await (async () => { try { await resolveWorkflowWorkspaceFresh(env, {}); } catch (e) { return e; } })();
  assert(classifyStepError(missing).errorKind === "workspace_missing", "a missing slug is still workspace_missing (no registry read)");
}

// ── run()'s wiring, asserted on the source ─────────────────────────────────
//
// TranslateWorkflow.run() can't be instantiated here (it needs the Workflows
// runtime), so these two properties are pinned on the file's text. Both are
// one-line regressions with expensive consequences.

console.log("[TranslateWorkflow run() wiring] NonRetryableError is constructed with a message only");
{
  const src = readFileSync(new URL("./translateWorkflow.ts", import.meta.url), "utf8");
  const calls = [...src.matchAll(/new NonRetryableError\(([^;]*?)\);/gs)].map((m) => m[1]);
  assert(calls.length >= 2, `found ${calls.length} NonRetryableError construction(s) to check`);
  for (const args of calls) {
    // The runtime class is `constructor(message, name = "NonRetryableError") { super(message); this.name = name; }`
    // and the engine decides fatality with
    // `err.name === "NonRetryableError" || err.message.startsWith("NonRetryableError")`.
    // A second argument renames the error, so the engine RETRIES a deterministic
    // failure — re-billing the org. The kind travels in the message prefix.
    assert(!/,\s*c\.errorKind/.test(args) && !args.includes("errorKind)"),
      `NonRetryableError must take no name argument (got: ${args.trim().slice(0, 80)})`);
    assert(/\[\$\{c\.errorKind\}\]/.test(args), "…and must still tag the kind in the message");
  }
}

console.log("[TranslateWorkflow run() wiring] the workspace refusal path can still record a failure");
{
  const src = readFileSync(new URL("./translateWorkflow.ts", import.meta.url), "utf8");
  const depsAt = src.indexOf("const deps: StepDeps");
  const resolveAt = src.indexOf("resolveWorkflowWorkspaceFresh(this.env, params)");
  assert(depsAt > 0 && resolveAt > 0, "both the deps literal and the resolve call are present");
  assert(depsAt < resolveAt,
    "deps must be built BEFORE the workspace resolve — otherwise a refusal throws with no deps in scope, "
    + "wf_status_json stays NULL and the job sits in 'running' until the sweep expires it");
  const refusal = src.slice(resolveAt, src.indexOf("workspaceEnv(this.env, ws)"));
  assert(/recordFailure\(deps, params, err\)/.test(refusal), "the refusal path calls recordFailure before rethrowing");
}

console.log("translateWorkflowWorkspace: all assertions passed");
