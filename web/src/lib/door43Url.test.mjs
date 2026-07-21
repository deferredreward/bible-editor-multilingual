// Tests for the web Door43 source-URL parser (web/src/lib/door43Url.ts), which
// mirrors api/src/repoUrl.ts parseDoor43SourceRef. Run from web/:
//   node --experimental-strip-types --no-warnings --test src/lib/door43Url.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { parseDoor43SourceRef } from "./door43Url.ts";

test("full URL → { org, repo }", () => {
  const r = parseDoor43SourceRef("https://git.door43.org/BibleAquifer/ar_tn");
  assert.ok(r.ok);
  assert.deepEqual({ org: r.org, repo: r.repo }, { org: "BibleAquifer", repo: "ar_tn" });
});

test("trailing slash tolerated", () => {
  const r = parseDoor43SourceRef("https://git.door43.org/BibleAquifer/ar_tn/");
  assert.ok(r.ok && r.repo === "ar_tn");
});

test(".git suffix stripped", () => {
  const r = parseDoor43SourceRef("https://git.door43.org/BibleAquifer/ar_tn.git");
  assert.ok(r.ok);
  assert.deepEqual({ org: r.org, repo: r.repo }, { org: "BibleAquifer", repo: "ar_tn" });
});

test("deep path (src/branch/...) still yields owner/repo", () => {
  const r = parseDoor43SourceRef("https://git.door43.org/BibleAquifer/ar_tn/src/branch/master/tn_TIT.tsv");
  assert.ok(r.ok && r.org === "BibleAquifer" && r.repo === "ar_tn");
});

test("bare owner/repo", () => {
  const r = parseDoor43SourceRef("BibleAquifer/ar_tn");
  assert.ok(r.ok && r.org === "BibleAquifer" && r.repo === "ar_tn");
});

test("non-Door43 host rejected", () => {
  const r = parseDoor43SourceRef("https://github.com/BibleAquifer/ar_tn");
  assert.ok(!r.ok);
  assert.equal(r.error, "unsupported_host");
});

test("garbage / bare org / empty rejected", () => {
  assert.ok(!parseDoor43SourceRef("not a url").ok);
  assert.ok(!parseDoor43SourceRef("BibleAquifer").ok);
  assert.ok(!parseDoor43SourceRef("").ok);
});
