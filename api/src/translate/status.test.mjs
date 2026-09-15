// status.ts: the wf_status_json writer/reader (design §B/§C, migration 0073).
// Rides the REAL migrations through node:sqlite so the assertions prove the
// 0073 columns exist and that writeWfStatus touches exactly the four columns
// the design allows — never `state`, never `output_json`.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/status.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as status from "./status.ts";

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    async all() { return { results: sqlite.prepare(sql).all(...args), success: true }; },
    async first() { const r = sqlite.prepare(sql).all(...args); return r.length ? r[0] : null; },
    async run() { const r = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (sql) => mk(sql, []) };
}

function freshSqlite() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(join(dir, f), "utf8"));
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator')`).run();
  sqlite.prepare(
    `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, current_skill, current_status, updated_at, runner)
     VALUES ('job-1', 1, 'translate', 'OBA', 1, 1, 'sess', 'running', 'pre-skill', 'pre-status', 1000, 'internal')`,
  ).run();
  return sqlite;
}

const scope = { chapter: 1, skill: "translate-tn", startedAt: "2026-09-15T10:00:00.000Z" };
const at = new Date("2026-09-15T10:05:00.000Z");

test("migration 0073 adds runner and wf_status_json to pipeline_jobs (plain additive, nullable)", () => {
  const sqlite = freshSqlite();
  const cols = sqlite.prepare(`PRAGMA table_info(pipeline_jobs)`).all();
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
  assert.ok(byName.runner, "runner column exists");
  assert.equal(byName.runner.type, "TEXT");
  assert.equal(byName.runner.notnull, 0);
  assert.ok(byName.wf_status_json, "wf_status_json column exists");
  assert.equal(byName.wf_status_json.type, "TEXT");
  assert.equal(byName.wf_status_json.notnull, 0);
  const row = sqlite.prepare(`SELECT runner, wf_status_json FROM pipeline_jobs WHERE job_id = 'job-1'`).get();
  assert.equal(row.runner, "internal");
  assert.equal(row.wf_status_json, null);
});

test("builders produce the bot-shaped StatusResponse fragment", () => {
  const running = status.runningStatus(scope, "batch 03/11 done (15 rows, 1 attempt(s))", at);
  assert.deepEqual(running, {
    version: 1, runner: "internal", state: "running",
    current: { chapter: 1, skill: "translate-tn", status: "batch 03/11 done (15 rows, 1 attempt(s))", startedAt: scope.startedAt },
    updatedAt: "2026-09-15T10:05:00.000Z",
  });
  assert.equal(status.runningStatus(scope, "x".repeat(500), at).current.status.length, 120, "status clipped like the bot's 120-char progress lines");

  const manifest = status.buildEditorManifest({ resourceType: "tn", targetOrg: "ar_gl", repoName: "ar_tn", bookFile: "tn_OBA.tsv", reportFile: "translate-report-1-1.json" });
  assert.deepEqual(manifest, [
    { delivery: "editor", type: "tn", repo: "ar_gl/ar_tn", path: "tn_OBA.tsv", file: "tn_OBA.tsv" },
    { delivery: "editor", type: "report", file: "translate-report-1-1.json" },
  ], "manifest shape = translate-pipeline.js:831-840");
  const done = status.doneStatus(scope, manifest, at);
  assert.equal(done.state, "done");
  assert.equal(done.current.status, "done");
  assert.deepEqual(done.output, manifest);

  const failed = status.failedStatus(scope, "checks_failed", "batch 02 still failing", at);
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.current, { chapter: 1, skill: "translate-tn", status: "failed", startedAt: scope.startedAt, errorKind: "checks_failed", error: "batch 02 still failing" });
  assert.ok(!("output" in failed), "a failed status carries no manifest");
});

test("writeWfStatus writes exactly current_skill, current_status, updated_at, wf_status_json — never state or output_json", async () => {
  const sqlite = freshSqlite();
  const db = makeDb(sqlite);
  const before = sqlite.prepare(`SELECT * FROM pipeline_jobs WHERE job_id = 'job-1'`).get();

  const s = status.runningStatus(scope, "context: 3 templates", at);
  assert.equal(await status.writeWfStatus(db, "job-1", s), true);
  const after = sqlite.prepare(`SELECT * FROM pipeline_jobs WHERE job_id = 'job-1'`).get();

  assert.equal(after.current_skill, "translate-tn");
  assert.equal(after.current_status, "context: 3 templates");
  assert.ok(after.updated_at > before.updated_at, "updated_at bumped");
  assert.deepEqual(JSON.parse(after.wf_status_json), s);
  // Everything else — in particular the two columns the design forbids — is untouched.
  const allowed = new Set(["current_skill", "current_status", "updated_at", "wf_status_json"]);
  for (const col of Object.keys(before)) {
    if (allowed.has(col)) continue;
    assert.equal(after[col], before[col], `column ${col} must not change`);
  }
  assert.equal(after.state, "running");
  assert.equal(after.output_json, null, "output_json IS NULL stays the not-yet-imported flag");

  // done: output lives inside wf_status_json only.
  const done = status.doneStatus(scope, status.buildEditorManifest({ resourceType: "tn", targetOrg: "ar_gl", repoName: "ar_tn", bookFile: "tn_OBA.tsv", reportFile: "translate-report-1-1.json" }), at);
  await status.writeWfStatus(db, "job-1", done);
  const row = sqlite.prepare(`SELECT state, output_json, current_status, wf_status_json FROM pipeline_jobs WHERE job_id = 'job-1'`).get();
  assert.equal(row.state, "running", "state transitions stay owned by pollPipelineJob");
  assert.equal(row.output_json, null);
  assert.equal(row.current_status, "done");
  assert.equal(JSON.parse(row.wf_status_json).output.length, 2);

  assert.equal(await status.writeWfStatus(db, "no-such-job", s), false, "missing row reports false, does not throw");
});

test("parseWfStatus round-trips and rejects NULL / malformed / foreign JSON", () => {
  const s = status.failedStatus(scope, "cancelled", "job cancelled by user", at);
  assert.deepEqual(status.parseWfStatus(JSON.stringify(s)), s);
  assert.equal(status.parseWfStatus(null), null);
  assert.equal(status.parseWfStatus(""), null);
  assert.equal(status.parseWfStatus("{not json"), null);
  assert.equal(status.parseWfStatus(JSON.stringify({ state: "done" })), null, "no runner stamp → not ours");
  assert.equal(status.parseWfStatus(JSON.stringify({ runner: "internal", state: "weird", current: {} })), null);
  assert.equal(status.parseWfStatus(JSON.stringify({ runner: "internal", state: "running" })), null, "current is required");
});
