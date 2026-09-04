// Unit tests for the Aquifer chapter-scope helpers (aquiferScope.ts) — issue #310.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/aquiferScope.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChapterScope, chapterInScope } from "./aquiferScope.ts";

test("absent / blank param means whole book (null scope)", () => {
  assert.equal(parseChapterScope(undefined), null);
  assert.equal(parseChapterScope(null), null);
  assert.equal(parseChapterScope(""), null);
  assert.equal(parseChapterScope("   "), null);
  assert.equal(parseChapterScope(",, ,"), null);
});

test("comma-separated list parses to the exact chapter set (non-contiguous)", () => {
  // The motivating case: MRK 9 and 12, not a contiguous range.
  const scope = parseChapterScope("9,12");
  assert.deepEqual([...scope].sort((a, b) => a - b), [9, 12]);
});

test("inclusive a-b ranges expand", () => {
  assert.deepEqual([...parseChapterScope("1-3")].sort((a, b) => a - b), [1, 2, 3]);
  // Mixed list + range, with whitespace and duplicates collapsed.
  assert.deepEqual([...parseChapterScope(" 1-3 , 9 , 12 , 2 ")].sort((a, b) => a - b), [1, 2, 3, 9, 12]);
});

test("invalid / non-positive tokens are skipped, not fatal", () => {
  assert.equal(parseChapterScope("abc"), null);
  assert.equal(parseChapterScope("0"), null);
  assert.equal(parseChapterScope("-5"), null); // leading '-' → dash index 0 → not a range, Number("-5") not > 0
  // A partly-malformed param still scopes to what it could parse.
  assert.deepEqual([...parseChapterScope("9,abc,12")].sort((a, b) => a - b), [9, 12]);
  // A backwards range yields nothing from that token.
  assert.equal(parseChapterScope("5-3"), null);
});

test("chapterInScope: null scope admits every chapter (whole-book default)", () => {
  assert.equal(chapterInScope(1, null), true);
  assert.equal(chapterInScope(999, null), true);
});

test("chapterInScope: a set admits only its members", () => {
  const scope = parseChapterScope("9,12");
  assert.equal(chapterInScope(9, scope), true);
  assert.equal(chapterInScope(12, scope), true);
  assert.equal(chapterInScope(8, scope), false);
  assert.equal(chapterInScope(13, scope), false);
});
