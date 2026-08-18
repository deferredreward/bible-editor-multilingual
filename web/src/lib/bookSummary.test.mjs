import test from "node:test";
import assert from "node:assert/strict";
import { realChapters, realChapterNumbers } from "./bookSummary.ts";

const row = (chapter, tn = 0) => ({ chapter, verses: 0, tn, tq: 0, twl: 0 });

test("realChapters drops the chapter-0 front-matter entry", () => {
  // OBA: one real chapter plus book-intro notes -> must count as 1, not 2.
  const oba = { book: "OBA", chapters: [row(0, 8), row(1, 146)] };
  assert.equal(realChapters(oba).length, 1);
  assert.deepEqual(realChapterNumbers(oba), [1]);
});

test("realChapters keeps every real chapter", () => {
  const zec = { book: "ZEC", chapters: [row(0), ...Array.from({ length: 14 }, (_, i) => row(i + 1))] };
  assert.equal(realChapters(zec).length, 14);
  assert.deepEqual(realChapterNumbers(zec).slice(0, 3), [1, 2, 3]);
});

test("realChapterNumbers sorts and tolerates a missing summary", () => {
  assert.deepEqual(realChapterNumbers({ book: "X", chapters: [row(3), row(0), row(1)] }), [1, 3]);
  assert.deepEqual(realChapterNumbers(null), []);
  assert.deepEqual(realChapters(undefined), []);
});
