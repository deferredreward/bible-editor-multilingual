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

// ── PARITY PIN ───────────────────────────────────────────────────────────────
// web/src/lib/door43Url.ts hand-mirrors api/src/repoUrl.ts parseDoor43SourceRef
// (can't share across the api/web build boundary). This fixed table pins the
// behavior; the SAME cases are asserted in api/src/repoUrl.test.mjs. A divergent
// edit to either module breaks its table. Format: [input, expected|null-on-reject].
const PARSE_PARITY = [
  ["https://git.door43.org/BibleAquifer/ar_tn", { org: "BibleAquifer", repo: "ar_tn" }],
  ["https://git.door43.org/BibleAquifer/ar_tn/", { org: "BibleAquifer", repo: "ar_tn" }],
  ["https://git.door43.org/BibleAquifer/ar_tn.git", { org: "BibleAquifer", repo: "ar_tn" }],
  ["https://git.door43.org/BibleAquifer/ar_tn/src/branch/master/tn_TIT.tsv", { org: "BibleAquifer", repo: "ar_tn" }],
  ["BibleAquifer/ar_tn", { org: "BibleAquifer", repo: "ar_tn" }],
  ["https://github.com/BibleAquifer/ar_tn", null], // unsupported host
  ["not a url", null],
  ["BibleAquifer", null], // bare org
  ["", null],
];

test("PARITY: parseDoor43SourceRef matches the api table exactly", () => {
  for (const [input, expected] of PARSE_PARITY) {
    const r = parseDoor43SourceRef(input);
    if (expected === null) {
      assert.equal(r.ok, false, `expected reject: ${JSON.stringify(input)}`);
    } else {
      assert.ok(r.ok, `expected ok: ${JSON.stringify(input)}`);
      assert.deepEqual({ org: r.org, repo: r.repo }, expected, JSON.stringify(input));
    }
  }
});
