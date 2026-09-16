// storage.ts: R2 key builders for the internal translate runner (design §C) and
// the path-safety guard every caller-derived path goes through.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/storage.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as storage from "./storage.ts";
import * as core from "./core.ts";
import { memoryBlobStore } from "./fixtures.mjs";

const WS = "bsoj";
const JOB = "job_01HZX";

test("key layout matches design §C: pipeline-output/<ws>/<jobId>/{work,out}/…", () => {
  assert.equal(storage.jobPrefix(WS, JOB), "pipeline-output/bsoj/job_01HZX");
  assert.equal(storage.workKey(WS, JOB, "batch-01.tsv"), "pipeline-output/bsoj/job_01HZX/work/batch-01.tsv");
  assert.equal(storage.outKey(WS, JOB, "tn_OBA.tsv"), "pipeline-output/bsoj/job_01HZX/out/tn_OBA.tsv");
  assert.equal(storage.outKey(WS, JOB, "bible/kt/god.md"), "pipeline-output/bsoj/job_01HZX/out/bible/kt/god.md");
  assert.equal(storage.outKey(WS, JOB, storage.reportFileName(1, 4)), "pipeline-output/bsoj/job_01HZX/out/translate-report-1-4.json");
});

test("batchKeys mirrors the bot's work/ file names and core.buildBatchArtifacts's names", () => {
  const keys = storage.batchKeys(WS, JOB, "03");
  assert.deepEqual(keys, {
    source: "pipeline-output/bsoj/job_01HZX/work/batch-03.tsv",
    pack: "pipeline-output/bsoj/job_01HZX/work/batch-03-pack.md",
    task: "pipeline-output/bsoj/job_01HZX/work/batch-03-task.json",
    output: "pipeline-output/bsoj/job_01HZX/work/batch-03-out.tsv",
  });
  const art = core.buildBatchArtifacts(2, {
    batchRows: [], packMarkdown: "", targetLang: "ar", targetLangName: "Arabic", direction: "rtl", book: "OBA", resource: core.tsvResource("tn"),
  });
  assert.equal(art.nn, "03");
  assert.deepEqual(storage.batchFileNames("03"), art.names, "storage's names must never drift from core's");
  assert.equal(storage.batchNn(0), "01");
  assert.equal(storage.batchNn(10), "11");
});

test("path guard rejects traversal, absolute, empty and control-character paths", () => {
  const bad = [
    "", null, undefined,
    "/etc/passwd", "C:/x", "c:\\x",
    "../other-job/out/tn_OBA.tsv", "work/../../x", "a/./b", "a//b", "a/", "./a",
    "..\\x", "a\\..\\b",
    "a\u0000b", "a\nb",
  ];
  for (const p of bad) {
    assert.throws(() => storage.assertSafeRelPath(p), /unsafe path/, `must reject ${JSON.stringify(p)}`);
    assert.throws(() => storage.outKey(WS, JOB, p), /unsafe/, `outKey must reject ${JSON.stringify(p)}`);
  }
  // Backslashes normalize to forward slashes rather than being rejected outright.
  assert.equal(storage.assertSafeRelPath("bible\\kt\\god.md"), "bible/kt/god.md");
  assert.equal(storage.assertSafeRelPath("tn_OBA.tsv"), "tn_OBA.tsv");
});

test("slug and job id segments may not contain a slash or traverse", () => {
  for (const s of ["a/b", "..", ".", "", "/x", "x\\y"]) {
    assert.throws(() => storage.jobPrefix(s, JOB), /unsafe workspace slug/, `slug ${JSON.stringify(s)}`);
    assert.throws(() => storage.jobPrefix(WS, s), /unsafe job id/, `job id ${JSON.stringify(s)}`);
  }
  // Two tenants can never share a prefix, whatever their job ids.
  assert.notEqual(storage.jobPrefix("org-a", "j1"), storage.jobPrefix("org-b", "j1"));
});

test("getText/putText round-trip through a BlobStore with a charset-tagged content type", async () => {
  const puts = [];
  const store = {
    map: new Map(),
    async get(k) { return this.map.has(k) ? { text: async () => this.map.get(k) } : null; },
    async put(k, v, o) { puts.push([k, o]); this.map.set(k, v); },
  };
  const key = storage.workKey(WS, JOB, "batch-01-out.tsv");
  assert.equal(await storage.getText(store, key), null, "absent key reads as null, not throw");
  await storage.putText(store, key, "Reference\tID\n1:1\tab12\n");
  assert.equal(await storage.getText(store, key), "Reference\tID\n1:1\tab12\n");
  assert.equal(puts[0][1].httpMetadata.contentType, "text/tab-separated-values; charset=utf-8");
  await storage.putText(store, storage.outKey(WS, JOB, "translate-report-1-1.json"), "{}");
  assert.equal(puts[1][1].httpMetadata.contentType, "application/json; charset=utf-8");
  await storage.putText(store, storage.workKey(WS, JOB, "batch-01-pack.md"), "# pack");
  assert.equal(puts[2][1].httpMetadata.contentType, "text/markdown; charset=utf-8");
});

test("memoryBlobStore behaves like the R2 subset the steps use", async () => {
  const store = memoryBlobStore({ "a/b": "x" });
  assert.equal(await storage.getText(store, "a/b"), "x");
  assert.equal(await storage.getText(store, "a/c"), null);
  await storage.putText(store, "a/c", "y");
  assert.equal(store.map.get("a/c"), "y");
});
