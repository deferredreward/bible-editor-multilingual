// Unit tests for the export USFM formatting normalizer (usfmFormat.ts).
// Run: node --experimental-strip-types --no-warnings src/usfmFormat.test.mjs
//
// These cases are the regression net for the DCS Check-8 ("USFM Formatting")
// rules. Each was distilled from a real usfm-js output shape observed in the
// `-be-` export branches (see docs/export-validation-cleanup.md). The end-to-end
// proof (the real DCS validator taking every tested book to 0 errors) lives in
// the verification scripts; this file pins the individual transforms.

import assert from "node:assert/strict";
import { normalizeUsfmFormatting } from "./usfmFormat.ts";

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}
const norm = (s) => normalizeUsfmFormatting(s);
const lines = (s) => norm(s).split("\n");

// Minimal header block (normalizer treats everything up to the first blank line
// as the header and passes it through untouched).
const HDR = "\\id 1CH\n\\usfm 3.0\n\\h x\n\n";

t("blank line added before \\b", () => {
  const out = norm(`${HDR}\\q1 \\v 1 \\w a\\w*\n\\b\n\\q1 \\v 2 \\w b\\w*\n`);
  assert.match(out, /\\w a\\w\*\n\n\\b\n/);
});

t("blank line added before \\p (not after)", () => {
  const out = norm(`${HDR}\\v 1 \\w a\\w*\n\\p\n\\v 2 \\w b\\w*\n`);
  assert.match(out, /\\w a\\w\*\n\n\\p\n\\v 2/);
});

t("blank line removed after \\c", () => {
  const out = norm(`${HDR}\\c 1\n\n\\p\n\\v 1 \\w a\\w*\n`);
  assert.match(out, /\\c 1\n\\p\n/);
});

t("malformed \\ts* repaired to \\ts\\*", () => {
  const out = norm(`${HDR}\\v 19 \\w x\\w*.\n\\ts* \\v 20 \\w y\\w*\n`);
  assert.ok(out.includes("\\ts\\*"), "should contain proper \\ts\\*");
  assert.ok(!/\\ts\*(?!\\)/.test(out.replace(/\\ts\\\*/g, "")), "no bare \\ts* remains");
});

t("\\ts\\* glued before \\v moves to its own line", () => {
  const ls = lines(`${HDR}\\v 19 \\w x\\w*.\n\\ts\\* \\v 20 \\w y\\w*\n`);
  assert.ok(ls.includes("\\ts\\*"), "\\ts\\* on its own line");
  assert.ok(ls.some((l) => /^\\v 20 /.test(l)), "\\v 20 starts its own line");
});

t("trailing \\p extracted onto its own line", () => {
  // usfm-js shape: "...word\w*. \p" then "\v 6 ..."
  const ls = lines(`${HDR}\\v 5 \\w drink\\w*.” \\p\n\\v 6 \\w then\\w*\n`);
  assert.ok(ls.includes("\\p"), "\\p isolated");
  // \p must not be followed by a blank line, and must precede \v 6
  const pIdx = ls.indexOf("\\p");
  assert.match(ls[pIdx + 1], /^\\v 6 /);
});

t("embedded \\p (…?”\\p\\w he) split into three", () => {
  const ls = lines(`${HDR}\\v 30 \\w you\\w*?”\\p\\w he\\w*\n`);
  const pIdx = ls.indexOf("\\p");
  assert.ok(pIdx > 0, "\\p isolated");
  // content before \p (a blank line is correctly inserted between them)
  assert.ok(ls.slice(0, pIdx).some((l) => /you\\w\*\?”$/.test(l)), "verse text precedes \\p");
  assert.match(ls[pIdx + 1], /^\\w he/);
});

t("mid-line \\v split so each verse starts its own line", () => {
  const ls = lines(`${HDR}\\v 28 \\w Ishmael\\w*. \\v 29 \\w These\\w*\n`);
  assert.ok(ls.some((l) => /^\\v 28 /.test(l)));
  assert.ok(ls.some((l) => /^\\v 29 /.test(l)));
  assert.ok(ls.some((l) => /Ishmael\\w\*\.$/.test(l)), "v28 tail kept");
});

t("\\q1 stays attached to its \\v", () => {
  const ls = lines(`${HDR}\\q1 \\v 1 \\w a\\w*\n`);
  assert.ok(ls.some((l) => /^\\q1 \\v 1 /.test(l)));
});

t("\\p before \\ts\\* reordered to \\ts\\* before \\p", () => {
  const ls = lines(`${HDR}\\v 14 \\w x\\w*.\n\\p \\ts\\*\n\\v 15 \\w y\\w*\n`);
  const tsIdx = ls.indexOf("\\ts\\*");
  const pIdx = ls.indexOf("\\p");
  assert.ok(tsIdx >= 0 && pIdx >= 0);
  assert.ok(tsIdx < pIdx, "\\ts\\* comes before \\p");
  assert.match(ls[pIdx + 1], /^\\v 15 /);
});

t("\\ts\\* after \\b reordered to \\b before \\ts\\*", () => {
  const ls = lines(`${HDR}\\v 4 \\w x\\w*.\n\\ts\\*\n\\b\n\\q1 \\v 5 \\w y\\w*\n`);
  const bIdx = ls.indexOf("\\b");
  const tsIdx = ls.indexOf("\\ts\\*");
  assert.ok(bIdx < tsIdx, "\\b before \\ts\\*");
});

t("idempotent", () => {
  const src = `${HDR}\\v 14 \\w x\\w*.\n\\p \\ts\\*\n\\v 15 \\w y\\w*. \\v 16 \\w z\\w*\n\\ts\\*\n\\b\n\\q1 \\v 17 \\w q\\w*\n`;
  const once = norm(src);
  assert.equal(norm(once), once);
});

t("alignment/word content is never modified (counts preserved)", () => {
  const src = `${HDR}\\ts\\* \\v 1 \\zaln-s |x-strong="H1"\\*\\w a\\w*\\zaln-e\\*. \\v 2 \\w b\\w*\\p\n`;
  const out = norm(src);
  const count = (s, re) => (s.match(re) || []).length;
  assert.equal(count(out, /\\zaln-s\b/g), count(src, /\\zaln-s\b/g));
  assert.equal(count(out, /\\zaln-e\\\*/g), count(src, /\\zaln-e\\\*/g));
  assert.equal(count(out, /\\w\s/g), count(src, /\\w\s/g));
  assert.equal(count(out, /\\v\s+\d+/g), count(src, /\\v\s+\d+/g));
});

t("clean input passes through unchanged (no-op)", () => {
  const clean = `${HDR}\\ts\\*\n\\c 1\n\\p\n\\q1 \\v 1 \\w a\\w*\n\n\\b\n\\q1 \\v 2 \\w b\\w*\n`;
  assert.equal(norm(clean), clean);
});

// Issue #384: usfm-js can emit `\c` / `\p` / `\s1 Heading` (real ZEC 6 shape),
// which is legal USFM but places the heading behind the paragraph marker, so a
// naive front-matter scan looking backward from verse 1 hits the heading first
// and never sees the \p behind it. The USFM manual orders a chapter-opening
// section heading BEFORE the paragraph that introduces its first verse, so
// reorderMarkerRuns now hoists \s-family headings above \p, same as it already
// does for \ts\*/\c.
t("issue #384: \\s1 heading is hoisted above a preceding \\p", () => {
  const out = norm(`${HDR}\\c 6\n\\p\n\\s1 The vision of four chariots\n\\v 1 \\w I\\w*\n`);
  const idxS1 = out.indexOf("\\s1 The vision");
  const idxP = out.indexOf("\\p");
  assert.ok(idxS1 >= 0 && idxP >= 0 && idxS1 < idxP, "\\s1 now precedes \\p");
});

t("issue #384: \\s1 already before \\p is left in order", () => {
  const out = norm(`${HDR}\\c 6\n\\s1 A Heading\n\\p\n\\v 1 \\w a\\w*\n`);
  const idxS1 = out.indexOf("\\s1 A Heading");
  const idxP = out.indexOf("\\p");
  assert.ok(idxS1 < idxP, "already-correct order is unchanged");
});

t("issue #384: bare \\s and \\s2-\\s5 all hoist above \\p", () => {
  for (const tag of ["\\s", "\\s2", "\\s3", "\\s4", "\\s5"]) {
    const out = norm(`${HDR}\\c 6\n\\p\n${tag} Heading text\n\\v 1 \\w a\\w*\n`);
    const idxHeading = out.indexOf(`${tag} Heading text`);
    const idxP = out.indexOf("\\p");
    assert.ok(idxHeading < idxP, `${tag} precedes \\p`);
  }
});

t("issue #384: full front-matter run \\b / \\ts\\* / \\c / \\p / \\s1 sorts into canonical order", () => {
  const out = norm(`${HDR}\\b\n\\ts\\*\n\\c 6\n\\p\n\\s1 Heading\n\\v 1 \\w a\\w*\n`);
  const order = ["\\b", "\\ts\\*", "\\c 6", "\\s1 Heading", "\\p"].map((m) => out.indexOf(m));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i - 1] < order[i], `${["\\b", "\\ts\\*", "\\c 6", "\\s1 Heading", "\\p"][i]} out of order`);
  }
});

t("issue #384: \\sp (speaker) is NOT treated as a section heading", () => {
  const out = norm(`${HDR}\\c 6\n\\p\n\\sp Paul\n\\v 1 \\w a\\w*\n`);
  const idxSp = out.indexOf("\\sp Paul");
  const idxP = out.indexOf("\\p");
  assert.ok(idxP < idxSp, "\\p is unaffected by an unrelated \\sp marker");
});

t("issue #384: fix is idempotent on the ZEC 6 shape", () => {
  const src = `${HDR}\\c 6\n\\p\n\\s1 The vision of four chariots\n\\v 1 \\w I\\w*\n`;
  const once = norm(src);
  assert.equal(norm(once), once, "second normalization pass is a no-op");
});

// ── Issue #431 idempotence pins (test-only; upstream 904eed1 / 8a5f895) ────
// A content-less \q* stranded before \ts\*/\c across a chapter boundary must
// stay idempotent under normalization, and both chapters' \p markers must
// survive. Upstream's "FIX D" (dropping such a \q*) created a fresh \p/\ts\*
// adjacency for the SECOND pass that reorderMarkerRuns had already run past
// on the first — losing a \p and moving \ts\* across the chapter boundary.
// Pinned so a future pass added to this pipeline can't reopen the same
// "creates a run after reorder already ran" hazard unnoticed.
const pCount = (s) => s.split("\n").filter((l) => l.trim() === "\\p").length;

t("issue #431: idempotent on lone \\q1 before \\ts\\* at a chapter boundary", () => {
  const src = `${HDR}\\c 9\n\\p\n\\q1\n\\ts\\*\n\\c 10\n\\p\n\\v 1 \\w text\\w*\n`;
  const once = norm(src);
  assert.equal(norm(once), once, "second normalization pass is a no-op");
  assert.equal(pCount(once), 2, "both \\p markers survive");
});

t("issue #431: idempotent on the exact repro shape (\\ts\\* stays below \\c 9)", () => {
  const src = `\\id HAB\n\\h Habakkuk\n\n\\c 9\n\\p\n\\q1\n\\ts\\*\n\\c 10\n\\p\n\\v 1 text\n`;
  const once = norm(src);
  const twice = norm(once);
  assert.equal(twice, once, "second normalization pass must be a no-op");
  assert.equal(pCount(once), 2, "both chapters' \\p markers must survive");
  const c9Idx = once.split("\n").findIndex((l) => l.trim() === "\\c 9");
  const tsIdx = once.split("\n").findIndex((l) => l.trim() === "\\ts\\*");
  assert.ok(tsIdx > c9Idx, "\\ts\\* must not move above \\c 9");
});

console.log(`\n${passed} usfmFormat tests passed`);
