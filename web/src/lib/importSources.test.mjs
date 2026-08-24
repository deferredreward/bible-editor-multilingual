// Tests for the pure "Bring in this book" source-sheet planner
// (web/src/lib/importSources.ts) — sheet rows → ordered setBookSource payloads
// plus the validation the sheet surfaces inline (partial bounds, intra-sheet
// overlaps). Mirrors the orgDraft.test.mjs pattern.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings --test src/lib/importSources.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import {
  OVERRIDABLE_RESOURCES,
  defaultSheetRows,
  planSourceWrites,
  setBookSourceBody,
} from "./importSources.ts";

function row(overrides = {}) {
  return { resource: "tn", kind: "default", url: "", fromCh: "", toCh: "", ...overrides };
}

// ── defaults ─────────────────────────────────────────────────────────────────

test("defaultSheetRows: one no-op default row per overridable resource", () => {
  const rows = defaultSheetRows();
  assert.deepEqual(
    rows.map((r) => r.resource),
    OVERRIDABLE_RESOURCES,
  );
  for (const r of rows) {
    assert.equal(r.kind, "default");
    assert.equal(r.fromCh, "");
    assert.equal(r.toCh, "");
  }
});

test("all-default rows produce NO payloads (the 2-click import path)", () => {
  const plan = planSourceWrites(defaultSheetRows());
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.writes, []);
});

test("a default row with bounds filled in is still a no-op (no validation noise)", () => {
  // "Project default" for a range means "no override there" — the row writes
  // nothing and must not trip bounds/overlap validation.
  const plan = planSourceWrites([row({ kind: "default", fromCh: "1", toCh: "5" })]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.writes, []);
});

// ── payload shapes ───────────────────────────────────────────────────────────

test("upstream row resolves the unfoldingWord preset org/repo per resource", () => {
  const plan = planSourceWrites([
    row({ resource: "tn", kind: "upstream" }),
    row({ resource: "tq", kind: "upstream" }),
  ]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.writes, [
    { index: 0, resource: "tn", kind: "upstream", org: "unfoldingWord", repo: "en_tn" },
    { index: 1, resource: "tq", kind: "upstream", org: "unfoldingWord", repo: "en_tq" },
  ]);
});

test("whole-book upstream row omits bounds entirely (server whole-book default)", () => {
  const plan = planSourceWrites([row({ kind: "upstream" })]);
  assert.equal(plan.ok, true);
  assert.equal("chapterStart" in plan.writes[0], false);
  assert.equal("chapterEnd" in plan.writes[0], false);
  const body = setBookSourceBody(plan.writes[0]);
  assert.deepEqual(body, { resource: "tn", org: "unfoldingWord", repo: "en_tn" });
});

test("ranged upstream row carries its numeric bounds", () => {
  const plan = planSourceWrites([row({ kind: "upstream", fromCh: "13", toCh: "16" })]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.writes[0], {
    index: 0,
    resource: "tn",
    kind: "upstream",
    org: "unfoldingWord",
    repo: "en_tn",
    chapterStart: 13,
    chapterEnd: 16,
  });
});

test("aquifer row emits kind:'aquifer' with bounds and NO org/repo", () => {
  const plan = planSourceWrites([row({ kind: "aquifer", fromCh: "1", toCh: "12" })]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.writes[0], {
    index: 0,
    resource: "tn",
    kind: "aquifer",
    chapterStart: 1,
    chapterEnd: 12,
  });
  const body = setBookSourceBody(plan.writes[0]);
  assert.deepEqual(body, { resource: "tn", kind: "aquifer", chapterStart: 1, chapterEnd: 12 });
  assert.equal("org" in body, false);
  assert.equal("repo" in body, false);
});

test("url row carries the trimmed URL for the caller to verify", () => {
  const plan = planSourceWrites([
    row({ kind: "url", url: "  https://git.door43.org/BibleAquifer/ar_tn  " }),
  ]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.writes[0], {
    index: 0,
    resource: "tn",
    kind: "url",
    url: "https://git.door43.org/BibleAquifer/ar_tn",
  });
  // The PUT body uses the verified { org, repo }, never the raw URL.
  const body = setBookSourceBody(plan.writes[0], { org: "BibleAquifer", repo: "ar_tn" });
  assert.deepEqual(body, { resource: "tn", org: "BibleAquifer", repo: "ar_tn" });
});

test("the demo case — tn: Aquifer 1-12 + unfoldingWord 13-16 — plans in row order", () => {
  const plan = planSourceWrites([
    row({ kind: "aquifer", fromCh: "1", toCh: "12" }),
    row({ kind: "upstream", fromCh: "13", toCh: "16" }),
    row({ resource: "tq", kind: "default" }),
  ]);
  assert.equal(plan.ok, true);
  assert.equal(plan.writes.length, 2);
  assert.equal(plan.writes[0].kind, "aquifer");
  assert.equal(plan.writes[1].kind, "upstream");
  assert.equal(plan.writes[1].chapterStart, 13);
});

// ── validation ───────────────────────────────────────────────────────────────

test("one bound without the other → range_needs_both, pinned on the row", () => {
  const plan = planSourceWrites([row(), row({ kind: "upstream", fromCh: "3" })]);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.errors, [{ index: 1, code: "range_needs_both" }]);
});

test("non-integer / negative bounds → bad_chapter", () => {
  for (const bad of ["x", "1.5", "-2"]) {
    const plan = planSourceWrites([row({ kind: "upstream", fromCh: bad, toCh: "4" })]);
    assert.equal(plan.ok, false, `expected failure for ${bad}`);
    assert.equal(plan.errors[0].code, "bad_chapter");
  }
});

test("chapter 0 (front matter) is a legal bound", () => {
  const plan = planSourceWrites([row({ kind: "upstream", fromCh: "0", toCh: "0" })]);
  assert.equal(plan.ok, true);
  assert.equal(plan.writes[0].chapterStart, 0);
  assert.equal(plan.writes[0].chapterEnd, 0);
});

test("from > to → range_reversed", () => {
  const plan = planSourceWrites([row({ kind: "upstream", fromCh: "9", toCh: "2" })]);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.errors, [{ index: 0, code: "range_reversed" }]);
});

test("aquifer without a range → aquifer_needs_range; on tq → aquifer_tn_only", () => {
  const noRange = planSourceWrites([row({ kind: "aquifer" })]);
  assert.equal(noRange.ok, false);
  assert.deepEqual(noRange.errors, [{ index: 0, code: "aquifer_needs_range" }]);

  const onTq = planSourceWrites([row({ resource: "tq", kind: "aquifer", fromCh: "1", toCh: "2" })]);
  assert.equal(onTq.ok, false);
  assert.deepEqual(onTq.errors, [{ index: 0, code: "aquifer_tn_only" }]);
});

test("url kind with a blank URL → url_required", () => {
  const plan = planSourceWrites([row({ kind: "url", url: "   " })]);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.errors, [{ index: 0, code: "url_required" }]);
});

// ── intra-sheet overlap ──────────────────────────────────────────────────────

test("two ranges of the SAME resource that touch → overlap on the later row", () => {
  const plan = planSourceWrites([
    row({ kind: "aquifer", fromCh: "1", toCh: "12" }),
    row({ kind: "upstream", fromCh: "12", toCh: "16" }), // 12 overlaps 1-12
  ]);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.errors, [{ index: 1, code: "overlap" }]);
});

test("adjacent (non-touching) ranges of the same resource do NOT overlap", () => {
  const plan = planSourceWrites([
    row({ kind: "aquifer", fromCh: "1", toCh: "12" }),
    row({ kind: "upstream", fromCh: "13", toCh: "16" }),
  ]);
  assert.equal(plan.ok, true);
});

test("a whole-book row overlaps ANY ranged row of the same resource", () => {
  const plan = planSourceWrites([
    row({ kind: "upstream" }), // whole book
    row({ kind: "aquifer", fromCh: "3", toCh: "5" }),
  ]);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.errors, [{ index: 1, code: "overlap" }]);
});

test("identical ranges on DIFFERENT resources never overlap", () => {
  const plan = planSourceWrites([
    row({ resource: "tn", kind: "upstream", fromCh: "1", toCh: "5" }),
    row({ resource: "tq", kind: "upstream", fromCh: "1", toCh: "5" }),
  ]);
  assert.equal(plan.ok, true);
  assert.equal(plan.writes.length, 2);
});

test("every offending row is reported in one pass (not just the first)", () => {
  const plan = planSourceWrites([
    row({ kind: "upstream", fromCh: "3" }), // range_needs_both
    row({ resource: "tq", kind: "url", url: "" }), // url_required
  ]);
  assert.equal(plan.ok, false);
  assert.deepEqual(
    plan.errors.map((e) => e.code).sort(),
    ["range_needs_both", "url_required"],
  );
});
