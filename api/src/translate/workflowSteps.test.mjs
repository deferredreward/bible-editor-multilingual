// workflowSteps.ts: the TranslateWorkflow step bodies driven end to end with a
// real-SQLite D1 (every migration applied, incl. 0073), a Map-backed R2, a
// URL-keyed DCS fetch fake and a transport that replays the recorded OBA dry
// run. No Workflows runtime is invented — translateWorkflow.ts only maps these
// functions onto step.do (see translateWorkflowWorkspace.test.mjs for the env
// re-point it performs first).
//
// What this proves:
//   * guard-and-source → context → batch-01..11 → merge-report reproduces the
//     recorded tn_OBA.tsv byte-for-byte from the recorded model replies, writing
//     the design-§C R2 layout and a bot-shaped wf_status_json along the way,
//     while never touching pipeline_jobs.state / output_json;
//   * a batch whose validated output is already in R2 is reused without a
//     provider call (step-retry idempotency, design risk 4);
//   * cooperative cancel: a cancelled row fails step 1 and every batch step
//     non-retryably; ai_provider_changed / provider_not_supported_internal /
//     ai_provider_unavailable are non-retryable; provider transients stay
//     retryable;
//   * the decrypted key never appears in params, thrown messages, or the
//     wf_status_json written by record-failure — even when the provider echoes
//     it back (design risk 3).
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/workflowSteps.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as steps from "./workflowSteps.ts";
import * as storage from "./storage.ts";
import { parseWfStatus } from "./status.ts";
import { BEGIN_OUTPUT, END_OUTPUT, TranslateProviderError } from "./llm.ts";
import { encryptApiKey } from "../aiKeyCrypto.ts";
import { fixture, fixturePackFiles, memoryBlobStore } from "./fixtures.mjs";

const KEY = "sk-ant-api03-TESTKEYTESTKEYTESTKEYTESTKEY0001";
const WRAP = Buffer.alloc(32, 7).toString("base64");
const DRY = "dry-run-ar-OBA/";
const WS = "bsoj";
const JOB = "job-1";

const PARAMS = Object.freeze({
  jobId: JOB, workspace: WS, userId: 1,
  resourceType: "tn", book: "OBA", startChapter: 1, endChapter: 1,
  targetLang: "ar", direction: "rtl",
  sourceRef: "unfoldingWord/en_tn@master",
  sourceLiteralRef: "unfoldingWord/en_ult@master", sourceSimplifiedRef: "unfoldingWord/en_ust@master",
  targetOrg: "ar_gl", repoName: "ar_tn",
  provider: "claude", model: "claude-sonnet-5", thinking: "medium",
});

// --- fakes -----------------------------------------------------------------

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    async all() { return { results: sqlite.prepare(sql).all(...args), success: true }; },
    async first() { const r = sqlite.prepare(sql).all(...args); return r.length ? r[0] : null; },
    async run() { const r = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (sql) => mk(sql, []) };
}

async function freshSqlite({ provider = "claude", model = "claude-sonnet-5", state = "running" } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(join(dir, f), "utf8"));
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator')`).run();
  sqlite.prepare(
    `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, runner, upstream_job_id)
     VALUES (?, 1, 'translate', 'OBA', 1, 1, 'sess', ?, 'internal', 'translate-bsoj-job-1')`,
  ).run(JOB, state);
  const { ciphertextB64, ivB64 } = await encryptApiKey(WRAP, KEY);
  sqlite.prepare(
    `INSERT INTO ai_provider_config (id, provider, model, key_ciphertext, key_iv, key_hint, version) VALUES (1, ?, ?, ?, ?, ?, 1)`,
  ).run(provider, model, ciphertextB64, ivB64, KEY.slice(-4));
  return sqlite;
}

/** DCS raw fake keyed by org/repo/path — so the target repo can 404 while the source serves. */
function dcsFetch(files) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const m = /^https:\/\/git\.door43\.org\/([^/]+)\/([^/]+)\/raw\/(?:branch|commit)\/[^/]+\/(.+)$/.exec(url);
    if (m) {
      const key = `${m[1]}/${m[2]}/${decodeURIComponent(m[3])}`;
      if (files[key] != null) return { status: 200, ok: true, headers: null, text: async () => files[key], json: async () => JSON.parse(files[key]) };
    }
    return { status: 404, ok: false, headers: null, text: async () => "" };
  };
  return { calls, impl };
}

function dcsFiles({ withTarget = null, source = null } = {}) {
  const files = { "unfoldingWord/en_tn/tn_OBA.tsv": source ?? fixture("tn_OBA.tsv") };
  for (const [p, body] of Object.entries(fixturePackFiles())) files[`ar_gl/translation-context/${p}`] = body;
  if (withTarget != null) files["ar_gl/ar_tn/tn_OBA.tsv"] = withTarget;
  return files;
}

const wrapped = (body) => `Here you go.\n\n${BEGIN_OUTPUT}\n${body}\n${END_OUTPUT}\n`;

/** Every recorded Arabic row of the OBA dry run, by ID, plus the TSV header. */
const RECORDED = (() => {
  const rows = new Map();
  let header = "";
  for (let i = 0; i < 11; i++) {
    const lines = fixture(`${DRY}work/batch-${storage.batchNn(i)}-out.tsv`).split("\n");
    header = lines[0];
    for (const line of lines.slice(1)) if (line) rows.set(line.split("\t")[1], line);
  }
  return { header, rows };
})();

/**
 * Replays the recorded model reply for exactly the rows the prompt's source
 * content carries (so whole batches AND by-id/verse subsets get the right rows,
 * in source order). Asserts the prompt shape and that the decrypted key arrived.
 */
function replayTransport() {
  const calls = [];
  const transport = async (req) => {
    calls.push(req);
    assert.match(req.user, /"batchFile": "batch-\d\d\.tsv"/, "prompt must inline the task JSON with batchFile");
    assert.equal(req.apiKey, KEY, "the decrypted org key reaches the transport");
    assert.equal(req.model, "claude-sonnet-5");
    const src = /-----BEGIN SOURCE CONTENT-----\n([\s\S]*?)\n-----END SOURCE CONTENT-----/.exec(req.user);
    assert.ok(src, "prompt must inline the source TSV");
    const ids = src[1].split("\n").slice(1).filter(Boolean).map((l) => l.split("\t")[1]);
    const body = ids.map((id) => { const r = RECORDED.rows.get(id); assert.ok(r, `recorded row for ${id}`); return r; }).join("\n");
    return { text: wrapped(`${RECORDED.header}\n${body}`), usage: { inputTokens: 5000, outputTokens: 3000 }, stopReason: "end_turn" };
  };
  return { calls, transport };
}

async function scenario(opts = {}) {
  const sqlite = await freshSqlite(opts);
  const blobs = memoryBlobStore();
  const fetchFake = dcsFetch(dcsFiles(opts));
  const replay = replayTransport();
  const deps = {
    db: makeDb(sqlite), blobs, workspaceSlug: WS, wrappingKey: WRAP,
    startedAt: "2026-09-15T10:00:00.000Z", fetchImpl: fetchFake.impl,
    transport: opts.transport === null ? undefined : (opts.transport ?? replay.transport),
    now: () => new Date("2026-09-15T10:05:00.000Z"),
  };
  const row = () => sqlite.prepare(`SELECT * FROM pipeline_jobs WHERE job_id = ?`).get(JOB);
  const wf = () => parseWfStatus(row().wf_status_json);
  return { sqlite, blobs, deps, fetchFake, replay, row, wf };
}

const kindOf = (fn) => fn().then(() => { throw new Error("expected rejection"); }, (err) => steps.classifyStepError(err));

// --- tests -------------------------------------------------------------------

test("params → TranslateParams: defaults, names, mergeMode and skill resolve as the bot would", () => {
  const p = steps.paramsToTranslateParams(PARAMS);
  assert.equal(p.skill, "translate-tn");
  assert.equal(p.mergeMode, "range");
  assert.equal(p.contextRef, "ar_gl/translation-context@master");
  assert.equal(p.contextRefExplicit, false);
  assert.equal(p.targetLangName, "Arabic");
  assert.equal(p.direction, "rtl");
  assert.equal(p.targetLiteralRef, "ar_gl/ar_glt@master");
  assert.equal(p.thinking, "medium");
  const byId = steps.paramsToTranslateParams({ ...PARAMS, rowIds: ["ab12"] });
  assert.equal(byId.mergeMode, "by-id");
  // Persisted params carry provider + model only — there is no key field to leak.
  const json = JSON.stringify(PARAMS);
  assert.ok(!/apiKey|api_key|ciphertext/i.test(json));
  assert.ok(!json.includes(KEY));
});

test("full run: source → context → 11 batches → merge reproduces the recorded tn_OBA.tsv, in the §C R2 layout", async () => {
  const s = await scenario();
  const { deps } = s;

  const src = await steps.guardAndSourceStep(deps, PARAMS);
  assert.deepEqual(src, { batchCount: 11, rowCount: 153, coversWholeBook: true });
  for (let i = 0; i < 11; i++) {
    const nn = storage.batchNn(i);
    assert.equal(s.blobs.map.get(`pipeline-output/bsoj/job-1/work/batch-${nn}.tsv`), fixture(`${DRY}work/batch-${nn}.tsv`), `work/batch-${nn}.tsv byte-identical to the bot's`);
  }
  assert.equal(s.wf().state, "running");
  assert.match(s.row().current_status, /^source: 153 row\(s\) from unfoldingWord\/en_tn@master — 11 batch\(es\)$/);
  assert.equal(s.row().current_skill, "translate-tn");

  const ctx = await steps.contextStep(deps, PARAMS, src.batchCount);
  assert.equal(ctx.perBatch.length, 11);
  assert.equal(ctx.hasContent, true);
  assert.equal(ctx.contextSha, null, "branches API 404s in the fake → sha unresolved, not fatal");
  assert.ok(ctx.perBatch[0].slugs.includes("figs-metaphor"));
  assert.ok(s.blobs.map.has("pipeline-output/bsoj/job-1/work/batch-01-pack.md"));
  const task = JSON.parse(s.blobs.map.get("pipeline-output/bsoj/job-1/work/batch-11-task.json"));
  assert.equal(task.task, "translate-tsv-batch");
  assert.equal(task.batchFile, "batch-11.tsv");
  assert.equal(task.outputFile, "batch-11-out.tsv");
  assert.ok(!JSON.stringify(ctx).includes("Translation context"), "context step returns no pack bodies");
  assert.match(s.row().current_status, /^context pack: ar_gl\/translation-context@master — 1 templates, 5 terms, 2 examples$/);

  const results = [];
  for (let i = 0; i < src.batchCount; i++) {
    const r = await steps.batchStep(deps, PARAMS, i, src.batchCount);
    results.push(r);
    assert.equal(r.nn, storage.batchNn(i));
    assert.equal(r.attempts, 1);
    assert.equal(r.calls, 1);
    assert.equal(r.reused, false);
    assert.equal(r.inputTokens, 5000);
    assert.ok(r.costUsd > 0);
    assert.equal(s.blobs.map.get(`pipeline-output/bsoj/job-1/work/batch-${r.nn}-out.tsv`), fixture(`${DRY}work/batch-${r.nn}-out.tsv`), `out ${r.nn} persisted as returned`);
    assert.equal(s.row().current_status, `batch ${r.nn}/11 done (${r.rowCount} rows, 1 attempt(s))`);
  }
  assert.equal(s.replay.calls.length, 11);
  assert.equal(results.reduce((n, r) => n + r.rowCount, 0), 153);
  assert.equal(s.wf().state, "running", "batch steps never write done");

  const merged = await steps.mergeReportStep(deps, PARAMS, src, ctx, results);
  assert.equal(merged.rowCount, 153);
  assert.equal(merged.bookFile, "tn_OBA.tsv");
  assert.equal(merged.reportFile, "translate-report-1-1.json");
  assert.equal(merged.calls, 11);
  assert.equal(s.blobs.map.get("pipeline-output/bsoj/job-1/out/tn_OBA.tsv"), fixture(`${DRY}tn_OBA.tsv`), "merged book byte-identical to the bot's dry run");

  const report = JSON.parse(s.blobs.map.get("pipeline-output/bsoj/job-1/out/translate-report-1-1.json"));
  assert.equal(report.generatedBy, "bible-editor/translate");
  assert.equal(report.jobId, JOB);
  assert.equal(report.rowCount, 153);
  assert.equal(report.batches.length, 11);
  assert.deepEqual(report.batches[0].templateFallbacks, ctx.perBatch[0].templateFallbacks);
  assert.equal(report.checks.ok, true);
  assert.equal(report.checks.errorCount, 0);
  assert.equal(report.llm.calls, 11);
  assert.equal(report.llm.provider, "claude");
  assert.equal(report.llm.inputTokens, 55000);
  assert.equal(report.selection.mergeMode, "range");

  const done = s.wf();
  assert.equal(done.state, "done");
  assert.equal(done.current.status, "done");
  assert.equal(done.current.startedAt, "2026-09-15T10:00:00.000Z");
  assert.deepEqual(done.output, [
    { delivery: "editor", type: "tn", repo: "ar_gl/ar_tn", path: "tn_OBA.tsv", file: "tn_OBA.tsv" },
    { delivery: "editor", type: "report", file: "translate-report-1-1.json" },
  ]);
  // Ownership contract: the Workflow never writes state or output_json.
  assert.equal(s.row().state, "running");
  assert.equal(s.row().output_json, null);

  // The manifest's `file` resolves through the same guarded key builder step 5 will use.
  assert.equal(storage.outKey(WS, JOB, done.output[0].file), "pipeline-output/bsoj/job-1/out/tn_OBA.tsv");
  // Everything ever written to the row is key-free.
  for (const v of Object.values(s.row())) assert.ok(!String(v).includes(KEY));
});

test("batch step reuses a validated output already in R2 without calling the provider", async () => {
  const s = await scenario();
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  const first = await steps.batchStep(s.deps, PARAMS, 2, src.batchCount);
  assert.equal(first.reused, false);
  assert.equal(s.replay.calls.length, 1);

  const bomb = { ...s.deps, transport: async () => { throw new Error("must not be called"); } };
  const again = await steps.batchStep(bomb, PARAMS, 2, src.batchCount);
  assert.deepEqual(again, { nn: "03", rowCount: first.rowCount, attempts: 0, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null, reused: true });
  assert.match(s.row().current_status, /^batch 03\/11 reused from previous attempt/);

  // A leftover that no longer validates is retranslated, not trusted.
  s.blobs.map.set("pipeline-output/bsoj/job-1/work/batch-03-out.tsv", "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n1:1\tzz99\t\t\tx\t1\tbroken\n");
  const redo = await steps.batchStep(s.deps, PARAMS, 2, src.batchCount);
  assert.equal(redo.reused, false);
  assert.equal(s.replay.calls.length, 2);
});

test("cooperative cancel: a cancelled or externally-failed row fails step 1 and every batch step non-retryably", async () => {
  const s = await scenario();
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);

  s.sqlite.prepare(`UPDATE pipeline_jobs SET state = 'cancelled' WHERE job_id = ?`).run(JOB);
  let f = await kindOf(() => steps.batchStep(s.deps, PARAMS, 0, src.batchCount));
  assert.equal(f.errorKind, "cancelled");
  assert.equal(f.retryable, false);
  assert.equal(s.replay.calls.length, 0, "no provider call after cancel");
  f = await kindOf(() => steps.guardAndSourceStep(s.deps, PARAMS));
  assert.equal(f.errorKind, "cancelled");

  s.sqlite.prepare(`UPDATE pipeline_jobs SET state = 'failed' WHERE job_id = ?`).run(JOB);
  f = await kindOf(() => steps.batchStep(s.deps, PARAMS, 0, src.batchCount));
  assert.equal(f.errorKind, "job_not_running");
  assert.equal(f.retryable, false);

  s.sqlite.prepare(`UPDATE pipeline_jobs SET state = 'dispatching' WHERE job_id = ?`).run(JOB);
  await steps.assertJobLive(s.deps, JOB);

  s.sqlite.prepare(`DELETE FROM pipeline_jobs WHERE job_id = ?`).run(JOB);
  f = await kindOf(() => steps.assertJobLive(s.deps, JOB));
  assert.equal(f.errorKind, "job_missing");
});

test("provider gate inside the batch step: changed / unsupported / unavailable are non-retryable", async () => {
  // Provider switched after dispatch → refuse, don't bill the new vendor.
  let s = await scenario();
  let src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  s.sqlite.prepare(`UPDATE ai_provider_config SET provider = 'openai', model = 'gpt-5.5' WHERE id = 1`).run();
  let f = await kindOf(() => steps.batchStep(s.deps, PARAMS, 0, src.batchCount));
  assert.equal(f.errorKind, "ai_provider_changed");
  assert.equal(f.retryable, false);
  assert.equal(s.replay.calls.length, 0);

  // Dispatched for a provider with no in-Worker adapter (no injected transport).
  s = await scenario({ provider: "openai", model: "gpt-5.5", transport: null });
  src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  f = await kindOf(() => steps.batchStep(s.deps, { ...PARAMS, provider: "openai", model: "gpt-5.5" }, 0, src.batchCount));
  assert.equal(f.errorKind, "provider_not_supported_internal");
  assert.equal(f.retryable, false);

  // Org cleared its key mid-run.
  s = await scenario();
  src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  s.sqlite.prepare(`UPDATE ai_provider_config SET key_ciphertext = NULL, key_iv = NULL WHERE id = 1`).run();
  f = await kindOf(() => steps.batchStep(s.deps, PARAMS, 0, src.batchCount));
  assert.equal(f.errorKind, "ai_provider_unavailable");
  assert.match(f.message, /api_key_missing/);

  // Wrapping key rotated → stored key undecryptable.
  s = await scenario();
  src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  f = await kindOf(() => steps.batchStep({ ...s.deps, wrappingKey: Buffer.alloc(32, 9).toString("base64") }, PARAMS, 0, src.batchCount));
  assert.equal(f.errorKind, "ai_provider_key_decrypt_failed");
  assert.equal(f.retryable, false);
});

test("source-side guards: missing source and empty selection are non-retryable; DCS 5xx stays retryable", async () => {
  let s = await scenario();
  let f = await kindOf(() => steps.guardAndSourceStep(s.deps, { ...PARAMS, book: "ZEC" }));
  assert.equal(f.errorKind, "source_not_found");
  assert.equal(f.retryable, false);

  f = await kindOf(() => steps.guardAndSourceStep(s.deps, { ...PARAMS, rowIds: ["nope"] }));
  assert.equal(f.errorKind, "no_source_rows");
  assert.match(f.message, /rowIds nope/);

  f = await kindOf(() => steps.guardAndSourceStep(s.deps, { ...PARAMS, resourceType: "tw", articleId: "kt/god" }));
  assert.equal(f.errorKind, "resource_not_supported_internal");

  s = await scenario();
  const flaky = { ...s.deps, fetchImpl: async () => ({ status: 502, ok: false, headers: null, text: async () => "bad gateway" }) };
  f = await kindOf(() => steps.guardAndSourceStep(flaky, PARAMS));
  assert.equal(f.errorKind, "internal_error");
  assert.equal(f.retryable, true, "an infra error keeps the step's retry budget");
  assert.match(f.message, /HTTP 502/);
});

test("by-id subset merges into an existing target book; range merge with an existing book replaces the chapter", async () => {
  // Existing target = the bot's finished Arabic book; re-translate two rows by id.
  const finished = fixture(`${DRY}tn_OBA.tsv`);
  const s = await scenario({ withTarget: finished });
  const rowIds = ["jdr1", "gn3t"]; // 1:1 (recorded batch 01) and 1:8 (recorded batch 05)
  const params = { ...PARAMS, rowIds };
  const src = await steps.guardAndSourceStep(s.deps, params);
  assert.deepEqual(src, { batchCount: 1, rowCount: 2, coversWholeBook: false });
  const sourceIds = s.blobs.map.get("pipeline-output/bsoj/job-1/work/batch-01.tsv");
  assert.deepEqual(sourceIds.split("\n").slice(1).filter(Boolean).map((l) => l.split("\t")[1]), rowIds, "the single batch holds exactly the selected rows, in source order");
  const ctx = await steps.contextStep(s.deps, params, 1);
  const r = await steps.batchStep(s.deps, params, 0, 1);
  assert.equal(r.rowCount, 2);
  const merged = await steps.mergeReportStep(s.deps, params, src, ctx, [r]);
  assert.equal(merged.rowCount, src.rowCount);
  assert.equal(s.blobs.map.get("pipeline-output/bsoj/job-1/out/tn_OBA.tsv"), finished, "by-id update of identical rows leaves the book byte-identical");
  const report = JSON.parse(s.blobs.map.get("pipeline-output/bsoj/job-1/out/translate-report-1-1.json"));
  assert.equal(report.selection.mergeMode, "by-id");
  assert.deepEqual(report.selection.rowIds, rowIds);
});

test("by-id with no existing target book fails merge_failed (non-retryable), as the bot does", async () => {
  const s = await scenario();
  const params = { ...PARAMS, verseStart: 1, verseEnd: 1 };
  const src = await steps.guardAndSourceStep(s.deps, params);
  const ctx = await steps.contextStep(s.deps, params, src.batchCount);
  const results = [];
  for (let i = 0; i < src.batchCount; i++) results.push(await steps.batchStep(s.deps, params, i, src.batchCount));
  const f = await kindOf(() => steps.mergeReportStep(s.deps, params, src, ctx, results));
  assert.equal(f.errorKind, "merge_failed");
  assert.equal(f.retryable, false);
  assert.match(f.message, /requires an existing target book/);
});

test("key hygiene: a provider that echoes the key back never leaks it into errors or wf_status_json", async () => {
  const s = await scenario();
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);

  // Deterministic provider failure carrying the key (and an Authorization header) in its body.
  const echo = { ...s.deps, transport: async () => { const e = new Error(`bad request: key ${KEY} rejected; Authorization: Bearer ${KEY}`); e.status = 400; throw e; } };
  let err;
  try { await steps.batchStep(echo, PARAMS, 0, src.batchCount); } catch (e) { err = e; }
  assert.ok(err instanceof TranslateProviderError);
  assert.equal(err.code, "provider_error");
  assert.ok(!err.message.includes(KEY), `message leaked the key: ${err.message}`);
  assert.ok(!String(err.cause?.message ?? "").includes(KEY), "cause message scrubbed too");
  const f = await steps.recordFailure(s.deps, PARAMS, err);
  assert.equal(f.errorKind, "provider_error");
  assert.equal(f.retryable, false);
  const wf = s.wf();
  assert.equal(wf.state, "failed");
  assert.equal(wf.current.errorKind, "provider_error");
  assert.equal(wf.current.status, "failed");
  assert.ok(!s.row().wf_status_json.includes(KEY));
  assert.ok(!(s.row().error_message ?? "").includes(KEY));
  assert.equal(s.row().state, "running", "record-failure does not flip state either");

  // Transient failure with the key in a nested cause: still retryable, still scrubbed.
  const over = { ...s.deps, transport: async () => { const inner = new Error(`socket closed for ${KEY}`); const e = new Error("Overloaded", { cause: inner }); e.status = 529; throw e; } };
  try { await steps.batchStep(over, PARAMS, 0, src.batchCount); } catch (e) { err = e; }
  const c = steps.classifyStepError(err);
  assert.equal(c.errorKind, "provider_overloaded");
  assert.equal(c.retryable, true);
  assert.ok(!JSON.stringify({ m: err.message, c: err.cause?.message, cc: err.cause?.cause?.message }).includes(KEY));

  // A non-Error throw is wrapped and scrubbed rather than escaping raw.
  const raw = { ...s.deps, transport: async () => { throw `string failure ${KEY}`; } };
  try { await steps.batchStep(raw, PARAMS, 0, src.batchCount); } catch (e) { err = e; }
  assert.ok(!String(err.message ?? err).includes(KEY));
});

test("classifyStepError: kinds survive the [kind] message prefix; provider codes keep their retryable flag", () => {
  let c = steps.classifyStepError(new steps.TranslateStepError("ai_provider_changed", "x"));
  assert.deepEqual(c, { errorKind: "ai_provider_changed", message: "x", retryable: false });
  // What run() sees after the engine rethrows a NonRetryableError: message + name only.
  c = steps.classifyStepError(new Error("[checks_failed] batch 02 still failing"));
  assert.deepEqual(c, { errorKind: "checks_failed", message: "batch 02 still failing", retryable: false });
  c = steps.classifyStepError(new Error("[rate_limited] claude rate_limited: 429"));
  assert.equal(c.retryable, true);
  c = steps.classifyStepError(new TranslateProviderError("timeout", "claude", "claude timeout: hung"));
  assert.deepEqual(c, { errorKind: "timeout", message: "claude timeout: hung", retryable: true });
  c = steps.classifyStepError(new TranslateProviderError("invalid_key", "claude", `claude invalid_key: ${KEY}`));
  assert.equal(c.retryable, false);
  assert.ok(!c.message.includes(KEY), "pattern scrub applies even without the literal key");
  c = steps.classifyStepError(new Error("D1_ERROR: database is locked"));
  assert.deepEqual(c, { errorKind: "internal_error", message: "D1_ERROR: database is locked", retryable: true });
  c = steps.classifyStepError("plain string");
  assert.equal(c.errorKind, "internal_error");
});

test("resolveWorkflowWorkspace: missing and unknown slugs are non-retryable, never silently list[0]", () => {
  const env = {
    DB: { prepare() {} }, DB_ORG2: { prepare() {} },
    WORKSPACES: JSON.stringify([
      { slug: "uw", label: "UW", org: "unfoldingWord", binding: "DB" },
      { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB_ORG2" },
    ]),
  };
  assert.equal(steps.resolveWorkflowWorkspace(env, { workspace: "org2" }).binding, "DB_ORG2");
  for (const params of [{}, { workspace: null }, { workspace: "" }, null, undefined]) {
    const err = (() => { try { steps.resolveWorkflowWorkspace(env, params); } catch (e) { return e; } })();
    assert.equal(steps.classifyStepError(err).errorKind, "workspace_missing", JSON.stringify(params));
    assert.equal(steps.classifyStepError(err).retryable, false);
  }
  const unknown = (() => { try { steps.resolveWorkflowWorkspace(env, { workspace: "retired-org" }); } catch (e) { return e; } })();
  assert.equal(steps.classifyStepError(unknown).errorKind, "workspace_unknown");
});

/** Every string reachable from a value: own enumerable props, nested, cycle-safe. */
function deepStrings(value, seen = new Set(), out = []) {
  if (value == null) return out;
  if (typeof value === "string") { out.push(value); return out; }
  if (typeof value !== "object" && typeof value !== "function") return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (value instanceof Error) {
    // name/message/stack/cause are not enumerable on an Error — walk them explicitly.
    for (const k of ["name", "message", "stack"]) deepStrings(value[k], seen, out);
    deepStrings(value.cause, seen, out);
  }
  for (const v of Object.values(value)) deepStrings(v, seen, out);
  if (Array.isArray(value)) for (const v of value) deepStrings(v, seen, out);
  return out;
}

test("error hygiene: nothing leaving batchStep carries the key — not .stack, not a cause chain, not transportResults/llmCalls", async () => {
  const s = await scenario();
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);

  // A provider failure that echoes the key in every place the old in-place
  // scrub missed: the message (so .stack's header carries it at construction),
  // a nested cause, and the non-message properties the engine persists.
  const leaky = {
    ...s.deps,
    transport: async () => {
      const inner = new Error(`inner: Authorization: Bearer ${KEY}`);
      const e = new Error(`bad request: key ${KEY} rejected`, { cause: inner });
      e.status = 400;
      e.transportResults = [{ text: `echo ${KEY}`, usage: { inputTokens: 1, outputTokens: 1 } }];
      throw e;
    },
  };
  let err;
  try { await steps.batchStep(leaky, PARAMS, 0, src.batchCount); } catch (e) { err = e; }

  assert.ok(err instanceof TranslateProviderError, "still classified as a provider error");
  assert.equal(err.code, "provider_error");
  assert.ok(typeof err.stack === "string" && err.stack.length > 0);
  assert.ok(!err.stack.includes(KEY), "the stack (materialized at construction) must not carry the key");
  assert.equal(err.cause, undefined, "the original cause chain is dropped, not scrubbed in place");
  assert.equal(err.transportResults, undefined, "raw transport records never leave the key's scope");
  assert.equal(err.llmCalls, undefined, "priced-call records never leave the key's scope either");
  for (const str of deepStrings(err)) {
    assert.ok(!str.includes(KEY), `a reachable string leaked the key: ${str.slice(0, 120)}`);
  }
  // Only our own primitive fields carry a value. (The class's declared optional
  // fields still exist as own keys — class fields are defined, not just typed —
  // but they must be undefined, which is what the asserts above pin.)
  const carried = Object.entries(err).filter(([, v]) => v !== undefined).map(([k]) => k).sort();
  assert.deepEqual(carried, ["code", "errorKind", "name", "provider", "retryable", "status"], "no unexpected data rides along");

  // …and the same holds for what record-failure then persists.
  await steps.recordFailure(s.deps, PARAMS, err);
  assert.ok(!s.row().wf_status_json.includes(KEY));
});

test("sanitizeBatchError: rebuilds the error, and an unclassified throw after a billed call is non-retryable", () => {
  // Provider errors keep their kind and retryability; everything else is dropped.
  const provider = new TranslateProviderError("rate_limited", "claude", `claude rate_limited: ${KEY}`, { status: 429, retryAfterSeconds: 30 });
  provider.transportResults = [{ text: KEY }];
  provider.llmCalls = [{ costUsd: 1, model: "claude-sonnet-5" }];
  const clean = steps.sanitizeBatchError(provider, KEY);
  assert.notEqual(clean, provider, "a NEW error, never the mutated original");
  assert.equal(steps.classifyStepError(clean).errorKind, "rate_limited");
  assert.equal(steps.classifyStepError(clean).retryable, true);
  assert.equal(clean.status, 429);
  assert.equal(clean.retryAfterSeconds, 30);
  assert.equal(clean.transportResults, undefined);
  assert.equal(clean.llmCalls, undefined);
  assert.ok(!clean.stack.includes(KEY));
  assert.ok(provider.message.includes(KEY), "the original is left untouched (we no longer mutate it)");

  // A step error keeps its own kind and flag.
  const stepErr = steps.sanitizeBatchError(new steps.TranslateStepError("cancelled", "job x was cancelled", { retryable: false }), KEY);
  assert.deepEqual(steps.classifyStepError(stepErr), { errorKind: "cancelled", message: "job x was cancelled", retryable: false });

  // An unclassified error came out of the LLM path — a bug in our adapter,
  // possibly after the model answered and the org was billed. Retrying buys two
  // more billed calls for the same crash.
  for (const raw of [new TypeError(`cannot read x of ${KEY}`), `string failure ${KEY}`]) {
    const c = steps.classifyStepError(steps.sanitizeBatchError(raw, KEY));
    assert.equal(c.errorKind, "internal_error_after_call");
    assert.equal(c.retryable, false, "unknown errors after a billed call must NOT be retried");
    assert.ok(!c.message.includes(KEY));
  }
});

test("retryableStepError: a retryable failure keeps its kind through the engine's rethrow", () => {
  // The engine rethrows a step's final error into run() with message/name only,
  // so a rate_limited failure that exhausted its retries used to record
  // internal_error. classifyStepError must round-trip the tag.
  for (const kind of ["rate_limited", "timeout", "provider_overloaded", "network_error", "internal_error"]) {
    const tagged = steps.retryableStepError({ errorKind: kind, message: "upstream said no", retryable: true });
    assert.ok(!(tagged instanceof TranslateProviderError), "a freshly built plain Error — no provider object reaches the engine");
    const c = steps.classifyStepError(new Error(tagged.message)); // what survives the hop
    assert.equal(c.errorKind, kind);
    assert.equal(c.retryable, true, `${kind} must stay retryable after the round trip`);
  }
});

test("merge-report re-checks cancel before writing out/ and a done manifest", async () => {
  const s = await scenario({ withTarget: fixture(`${DRY}tn_OBA.tsv`) });
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  const ctx = await steps.contextStep(s.deps, PARAMS, src.batchCount);
  const results = [];
  for (let i = 0; i < src.batchCount; i++) results.push(await steps.batchStep(s.deps, PARAMS, i, src.batchCount));

  s.sqlite.prepare(`UPDATE pipeline_jobs SET state = 'cancelled' WHERE job_id = ?`).run(JOB);
  const f = await kindOf(() => steps.mergeReportStep(s.deps, PARAMS, src, ctx, results));
  assert.equal(f.errorKind, "cancelled");
  assert.equal(f.retryable, false);
  assert.ok(!s.blobs.map.has("pipeline-output/bsoj/job-1/out/tn_OBA.tsv"), "no out/ file for a cancelled job");
  assert.notEqual(s.wf().state, "done", "no done manifest either");
});

test("merge base guards: an absent target refuses a partial book, and a shrinking merge is refused", async () => {
  // 1. Base absent + the run covered the whole source book → allowed (the first
  //    translation of a new language; that is the full OBA run above). Base
  //    absent + a partial run → refused: a wrongly defaulted targetOrg/repoName
  //    404s exactly like a genuine bootstrap, and the out/ file would then hold
  //    only the translated range, which step 5 imports as the whole book.
  const s = await scenario();
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  const ctx = await steps.contextStep(s.deps, PARAMS, src.batchCount);
  const results = [];
  for (let i = 0; i < src.batchCount; i++) results.push(await steps.batchStep(s.deps, PARAMS, i, src.batchCount));

  const partial = { ...src, coversWholeBook: false };
  const f = await kindOf(() => steps.mergeReportStep(s.deps, PARAMS, partial, ctx, results));
  assert.equal(f.errorKind, "target_book_absent");
  assert.equal(f.retryable, false);
  assert.match(f.message, /ar_gl\/ar_tn@master/);
  assert.ok(!s.blobs.map.has("pipeline-output/bsoj/job-1/out/tn_OBA.tsv"), "nothing written on refusal");

  // …unless the job explicitly asked to create the file.
  const created = await steps.mergeReportStep(s.deps, { ...PARAMS, createIfAbsent: true }, partial, ctx, results);
  assert.equal(created.rowCount, 153);

  // 2. Shrink guard: the target holds the finished 153-row book, but this run's
  //    source fetch returned only two rows (a truncated or stale source).
  //    Merging the range would replace 153 rows with 2 — the export's
  //    shrink-refusal policy, applied to the merge base.
  const finished = fixture(`${DRY}tn_OBA.tsv`);
  const sourceLines = fixture("tn_OBA.tsv").split("\n");
  const truncatedSource = [sourceLines[0], sourceLines[1], sourceLines[2], ""].join("\n");
  const t = await scenario({ withTarget: finished, source: truncatedSource });
  const tsrc = await steps.guardAndSourceStep(t.deps, PARAMS);
  assert.equal(tsrc.coversWholeBook, true, "a truncated source looks complete to step 1 — only the base reveals it");
  const tctx = await steps.contextStep(t.deps, PARAMS, tsrc.batchCount);
  const tres = [await steps.batchStep(t.deps, PARAMS, 0, tsrc.batchCount)];
  const g = await kindOf(() => steps.mergeReportStep(t.deps, PARAMS, tsrc, tctx, tres));
  assert.equal(g.errorKind, "merge_shrink_refused");
  assert.equal(g.retryable, false);
  assert.match(g.message, /would leave 2 rows where the fetched base has 153/);
  assert.ok(!t.blobs.map.has("pipeline-output/bsoj/job-1/out/tn_OBA.tsv"), "the shrunken book is never written");
});

test("context step: a DCS transport failure on the scripture pack retries instead of persisting a context-free pack", async () => {
  const s = await scenario();
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);

  // The context pack itself resolves; the four USFM fetches 5xx.
  const flaky = {
    ...s.deps,
    fetchImpl: async (url) => (/\.usfm$/.test(url)
      ? { status: 503, ok: false, headers: null, text: async () => "upstream" }
      : s.deps.fetchImpl(url)),
  };
  const f = await kindOf(() => steps.contextStep(flaky, PARAMS, src.batchCount));
  assert.equal(f.errorKind, "scripture_fetch_failed");
  assert.equal(f.retryable, true, "a transient DCS failure keeps the step's retry budget");
  assert.match(f.message, /HTTP 503/);
  assert.ok(!s.blobs.map.has("pipeline-output/bsoj/job-1/work/batch-01-pack.md"), "no context-free pack persisted");

  // A target Bible that simply does not exist yet still degrades to "absent".
  const ctx = await steps.contextStep(s.deps, PARAMS, src.batchCount);
  assert.equal(ctx.hasContent, true);
  assert.ok(s.blobs.map.get("pipeline-output/bsoj/job-1/work/batch-01-pack.md").length > 0);
});
