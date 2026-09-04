// Smoke test for exportChapterMerge.ts. Run from api/:
//   node --experimental-strip-types --no-warnings src/exportChapterMerge.test.mjs
//
// Not a test framework; failures exit non-zero.

import {
  chapterOfReference,
  formatChapterRange,
  parseChapterRangeLabel,
  mergeTsvChapterRange,
  chapterShrinkRefused,
} from "./exportChapterMerge.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

function assertThrows(fn, expectedMessage, msg) {
  try {
    fn();
    assert(false, `${msg} (did not throw)`);
  } catch (e) {
    assert(e instanceof Error && e.message === expectedMessage, `${msg} (message: ${e && e.message})`);
  }
}

const HEADER = "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote";

function row(ref, id, note = "n") {
  return `${ref}\t${id}\t\t\t\t1\t${note}`;
}

function tsv(header, rows) {
  return [header, ...rows].join("\n") + "\n";
}

// --- chapterOfReference ---
console.log("chapterOfReference");
assert(chapterOfReference("13:4") === 13, '"13:4" -> 13');
assert(chapterOfReference("13:intro") === 13, '"13:intro" -> 13');
assert(chapterOfReference("front:intro") === null, '"front:intro" -> null');
assert(chapterOfReference("garbage") === null, '"garbage" -> null');
assert(chapterOfReference("") === null, '"" -> null');
assert(chapterOfReference("1:1-3") === 1, '"1:1-3" -> 1');

// --- formatChapterRange / parseChapterRangeLabel ---
console.log("formatChapterRange / parseChapterRangeLabel");
assert(formatChapterRange({ start: 13, end: 13 }) === "13", "single chapter formats as \"13\"");
assert(formatChapterRange({ start: 13, end: 14 }) === "13-14", "range formats as \"13-14\"");
assert(
  JSON.stringify(parseChapterRangeLabel("13")) === JSON.stringify({ start: 13, end: 13 }),
  'parseChapterRangeLabel("13") is the inverse of formatChapterRange',
);
assert(
  JSON.stringify(parseChapterRangeLabel("13-14")) === JSON.stringify({ start: 13, end: 14 }),
  'parseChapterRangeLabel("13-14") is the inverse of formatChapterRange',
);
assert(parseChapterRangeLabel("14-13") === null, "descending range is invalid");
assert(parseChapterRangeLabel("abc") === null, "non-numeric label is invalid");
assert(parseChapterRangeLabel("0") === null, "chapter 0 is invalid (chapters are >= 1)");

// --- single chapter replace in the middle of a book ---
console.log("single chapter replace in the middle of a book");
{
  const master = tsv(HEADER, [
    row("1:1", "aaa1"),
    row("1:2", "aaa2"),
    row("2:1", "bbb1"),
    row("2:2", "bbb2"),
    row("3:1", "ccc1"),
  ]);
  const rendered = tsv(HEADER, [row("2:1", "new1", "edited"), row("2:2", "new2", "edited")]);
  const result = mergeTsvChapterRange(master, rendered, { start: 2, end: 2 });
  const expected = tsv(HEADER, [
    row("1:1", "aaa1"),
    row("1:2", "aaa2"),
    row("2:1", "new1", "edited"),
    row("2:2", "new2", "edited"),
    row("3:1", "ccc1"),
  ]);
  assert(result.content === expected, "chapter 2 spliced in place of the old chapter 2 rows");
  assert(result.masterRowsInRange === 2, "masterRowsInRange counts the 2 old chapter-2 rows");
  assert(result.masterRowsTotal === 5, "masterRowsTotal counts all 5 master rows");
  assert(result.renderedRows === 2, "renderedRows counts the 2 new rows");
}

// --- multi-chapter range ---
console.log("multi-chapter range");
{
  const master = tsv(HEADER, [
    row("1:1", "a1"),
    row("2:1", "b1"),
    row("3:1", "c1"),
    row("4:1", "d1"),
  ]);
  const rendered = tsv(HEADER, [
    row("2:1", "b1new"),
    row("2:2", "b2new"),
    row("3:1", "c1new"),
  ]);
  const result = mergeTsvChapterRange(master, rendered, { start: 2, end: 3 });
  const expected = tsv(HEADER, [
    row("1:1", "a1"),
    row("2:1", "b1new"),
    row("2:2", "b2new"),
    row("3:1", "c1new"),
    row("4:1", "d1"),
  ]);
  assert(result.content === expected, "chapters 2-3 replaced as one contiguous block");
  assert(result.masterRowsInRange === 2, "masterRowsInRange counts the 2 old rows across ch2-3");
}

// --- range not present in master: insert before next chapter ---
console.log("range not present in master (insert before next chapter)");
{
  const master = tsv(HEADER, [row("1:1", "a1"), row("3:1", "c1")]);
  const rendered = tsv(HEADER, [row("2:1", "b1"), row("2:2", "b2")]);
  const result = mergeTsvChapterRange(master, rendered, { start: 2, end: 2 });
  const expected = tsv(HEADER, [row("1:1", "a1"), row("2:1", "b1"), row("2:2", "b2"), row("3:1", "c1")]);
  assert(result.content === expected, "new chapter 2 rows inserted before chapter 3");
  assert(result.masterRowsInRange === 0, "master had no chapter-2 rows");
}

// --- range not present in master: append at end ---
console.log("range not present in master (append at end)");
{
  const master = tsv(HEADER, [row("1:1", "a1"), row("2:1", "b1")]);
  const rendered = tsv(HEADER, [row("5:1", "e1")]);
  const result = mergeTsvChapterRange(master, rendered, { start: 5, end: 5 });
  const expected = tsv(HEADER, [row("1:1", "a1"), row("2:1", "b1"), row("5:1", "e1")]);
  assert(result.content === expected, "new chapter 5 rows appended at the end (no later chapter in master)");
}

// --- front:intro and N:intro handling ---
console.log("front:intro and N:intro handling");
{
  const master = tsv(HEADER, [
    row("front:intro", "front1"),
    row("1:intro", "intro1"),
    row("1:1", "a1"),
    row("2:1", "b1"),
  ]);
  const rendered = tsv(HEADER, [row("1:intro", "intro1new"), row("1:1", "a1new")]);
  const result = mergeTsvChapterRange(master, rendered, { start: 1, end: 1 });
  const expected = tsv(HEADER, [
    row("front:intro", "front1"),
    row("1:intro", "intro1new"),
    row("1:1", "a1new"),
    row("2:1", "b1"),
  ]);
  assert(result.content === expected, "front:intro is never in range and 1:intro is treated as chapter 1");
  assert(result.masterRowsInRange === 2, "masterRowsInRange counts 1:intro + 1:1, not front:intro");
}

// --- bootstrap (null master) ---
console.log("bootstrap (null master)");
{
  const rendered = tsv(HEADER, [row("13:1", "x1"), row("13:2", "x2")]);
  const result = mergeTsvChapterRange(null, rendered, { start: 13, end: 13 });
  assert(result.content === rendered, "bootstrap returns the rendered content unchanged (already normalized)");
  assert(result.masterRowsInRange === 0, "bootstrap masterRowsInRange is 0");
  assert(result.masterRowsTotal === 0, "bootstrap masterRowsTotal is 0");
  assert(result.renderedRows === 2, "bootstrap renderedRows counts the rendered rows");
}

// --- bootstrap normalizes CRLF + guarantees one trailing newline ---
console.log("bootstrap normalizes CRLF rendered content");
{
  const renderedCrlf = `${HEADER}\r\n${row("1:1", "x1")}\r\n`;
  const result = mergeTsvChapterRange(null, renderedCrlf, { start: 1, end: 1 });
  assert(result.content === tsv(HEADER, [row("1:1", "x1")]), "CRLF rendered content normalized to LF");
}

// --- CRLF master normalized ---
console.log("CRLF master normalised");
{
  const masterCrlf = `${HEADER}\r\n${row("1:1", "a1")}\r\n${row("2:1", "b1")}\r\n`;
  const rendered = tsv(HEADER, [row("2:1", "b1new")]);
  const result = mergeTsvChapterRange(masterCrlf, rendered, { start: 2, end: 2 });
  const expected = tsv(HEADER, [row("1:1", "a1"), row("2:1", "b1new")]);
  assert(result.content === expected, "CRLF master normalized to LF before merge");
}

// --- header mismatch throws ---
console.log("header mismatch throws");
{
  const master = tsv("Reference\tID\tOther", [row("1:1", "a1")]);
  const rendered = tsv(HEADER, [row("1:1", "a1new")]);
  assertThrows(
    () => mergeTsvChapterRange(master, rendered, { start: 1, end: 1 }),
    "header_mismatch",
    "differing headers throw header_mismatch",
  );
}

// --- duplicate ID throws ---
console.log("duplicate ID throws");
{
  const master = tsv(HEADER, [row("1:1", "dup"), row("2:1", "b1")]);
  const rendered = tsv(HEADER, [row("2:1", "dup")]); // collides with a KEPT master row (chapter 1, outside range)
  assertThrows(
    () => mergeTsvChapterRange(master, rendered, { start: 2, end: 2 }),
    "duplicate_id:dup",
    "an ID colliding with a kept master row throws duplicate_id",
  );
}

// --- pre-existing duplicate IDs outside the range are not this export's problem ---
console.log("pre-existing duplicate IDs outside the range pass");
{
  const master = tsv(HEADER, [row("1:1", "dup"), row("1:2", "dup"), row("2:1", "b1")]);
  const rendered = tsv(HEADER, [row("2:1", "b1new")]);
  const r = mergeTsvChapterRange(master, rendered, { start: 2, end: 2 });
  assert(r.content.includes("b1new"), "merge succeeds despite a master-only duplicate outside the range");
}

// --- two rendered rows sharing an ID throws ---
console.log("two rendered rows sharing an ID throws");
{
  const master = tsv(HEADER, [row("1:1", "a1")]);
  const rendered = tsv(HEADER, [row("2:1", "dup"), row("2:2", "dup")]);
  assertThrows(
    () => mergeTsvChapterRange(master, rendered, { start: 2, end: 2 }),
    "duplicate_id:dup",
    "an ID repeated inside the render throws duplicate_id",
  );
}

// --- rendered row out of range throws ---
console.log("rendered row out of range throws");
{
  const master = tsv(HEADER, [row("1:1", "a1"), row("2:1", "b1")]);
  const rendered = tsv(HEADER, [row("2:1", "b1new"), row("3:1", "c1new")]);
  assertThrows(
    () => mergeTsvChapterRange(master, rendered, { start: 2, end: 2 }),
    "rendered_row_out_of_range:3:1",
    "a rendered row whose chapter is outside the range throws",
  );
}

// --- blank lines in master ignored ---
console.log("blank lines in master ignored");
{
  const master = `${HEADER}\n${row("1:1", "a1")}\n\n${row("2:1", "b1")}\n\n`;
  const rendered = tsv(HEADER, [row("2:1", "b1new")]);
  const result = mergeTsvChapterRange(master, rendered, { start: 2, end: 2 });
  const expected = tsv(HEADER, [row("1:1", "a1"), row("2:1", "b1new")]);
  assert(result.content === expected, "blank lines in master are dropped, not treated as rows");
  assert(result.masterRowsTotal === 2, "masterRowsTotal excludes blank lines");
}

// --- master rows with odd ordering are kept in their order ---
console.log("master rows with odd ordering are kept in their order");
{
  // Chapter 3 row appears BEFORE chapter 1 in master (already out of canonical
  // order) — the merge must not re-sort master's surviving rows.
  const master = tsv(HEADER, [row("3:1", "c1"), row("1:1", "a1"), row("2:1", "b1")]);
  const rendered = tsv(HEADER, [row("2:1", "b1new")]);
  const result = mergeTsvChapterRange(master, rendered, { start: 2, end: 2 });
  const expected = tsv(HEADER, [row("3:1", "c1"), row("1:1", "a1"), row("2:1", "b1new")]);
  assert(result.content === expected, "surviving master rows keep their original (even if odd) order");
}

// --- unparseable master reference is never in range, and kept ---
console.log("unparseable master reference kept (never in range)");
{
  const master = tsv(HEADER, [row("garbage", "g1"), row("2:1", "b1")]);
  const rendered = tsv(HEADER, [row("2:1", "b1new")]);
  const result = mergeTsvChapterRange(master, rendered, { start: 2, end: 2 });
  const expected = tsv(HEADER, [row("garbage", "g1"), row("2:1", "b1new")]);
  assert(result.content === expected, "a row with an unparseable Reference is kept, not dropped or replaced");
  assert(result.masterRowsInRange === 1, "only the real chapter-2 row counts as in-range");
}

// --- chapterShrinkRefused: range-local shrink policy ---
console.log("chapterShrinkRefused");
assert(chapterShrinkRefused(1, 20) === true, "20 existing, 1 rendered (19 lost, 95%) is refused");
assert(chapterShrinkRefused(12, 20) === false, "20 existing, 12 rendered (8 lost, 40%, under the 25-row floor) passes");
assert(chapterShrinkRefused(9, 20) === true, "20 existing, 9 rendered (11 lost, 55% > half) is refused");
assert(chapterShrinkRefused(60, 100) === true, "100 existing, 60 rendered (40 lost, >25 and >5%) is refused");
assert(chapterShrinkRefused(80, 100) === false, "100 existing, 80 rendered (20 lost, under the 25-row floor) passes");
assert(chapterShrinkRefused(5, 0) === false, "0 existing rows has nothing to protect — always passes");
assert(chapterShrinkRefused(25, 20) === false, "growth (rendered > existing) always passes");
assert(chapterShrinkRefused(20, 20) === false, "no change (rendered === existing) passes");

// --- header-only render removes all in-range master rows, keeps the rest ---
console.log("header-only render (zero rows in range) removes master's in-range rows");
{
  const master = tsv(HEADER, [
    row("1:1", "a1"),
    row("2:1", "b1"),
    row("2:2", "b2"),
    row("3:1", "c1"),
  ]);
  const rendered = tsv(HEADER, []); // header + newline, zero data rows
  const result = mergeTsvChapterRange(master, rendered, { start: 2, end: 2 });
  const expected = tsv(HEADER, [row("1:1", "a1"), row("3:1", "c1")]);
  assert(result.content === expected, "chapter 2's rows are removed; chapters 1 and 3 are kept verbatim");
  assert(result.masterRowsInRange === 2, "masterRowsInRange still counts the 2 removed chapter-2 rows");
  assert(result.renderedRows === 0, "renderedRows is 0 for a header-only render");
}

// --- F6: leading UTF-8 BOM on master is stripped before merging ---
console.log("BOM on master text merges cleanly");
{
  const master = `﻿${tsv(HEADER, [row("1:1", "a1"), row("2:1", "b1")])}`;
  const rendered = tsv(HEADER, [row("2:1", "b1new")]);
  const result = mergeTsvChapterRange(master, rendered, { start: 2, end: 2 });
  const expected = tsv(HEADER, [row("1:1", "a1"), row("2:1", "b1new")]);
  assert(result.content === expected, "a BOM-prefixed master merges as if the BOM were absent");
}

// --- F6: leading UTF-8 BOM on rendered text is stripped before merging ---
console.log("BOM on rendered text merges cleanly");
{
  const master = tsv(HEADER, [row("1:1", "a1"), row("2:1", "b1")]);
  const rendered = `﻿${tsv(HEADER, [row("2:1", "b1new")])}`;
  const result = mergeTsvChapterRange(master, rendered, { start: 2, end: 2 });
  const expected = tsv(HEADER, [row("1:1", "a1"), row("2:1", "b1new")]);
  assert(result.content === expected, "a BOM-prefixed rendered blob merges as if the BOM were absent");
}

// --- F6: a Reference cell with leading/trailing whitespace is still "in range" ---
console.log("Reference with leading/trailing spaces is treated as in range");
{
  const master = tsv(HEADER, [row("1:1", "a1"), row(" 2:1 ", "b1"), row("3:1", "c1")]);
  const rendered = tsv(HEADER, [row("2:1", "b1new")]);
  const result = mergeTsvChapterRange(master, rendered, { start: 2, end: 2 });
  const expected = tsv(HEADER, [row("1:1", "a1"), row("2:1", "b1new"), row("3:1", "c1")]);
  assert(result.content === expected, "the padded chapter-2 row is recognized as in-range and replaced");
  assert(result.masterRowsInRange === 1, "the padded row counts toward masterRowsInRange");
}

// --- F6: chapterShrinkRefused boundary — refuse AT exactly 50% loss ---
console.log("chapterShrinkRefused: exact 50% boundary");
assert(chapterShrinkRefused(10, 20) === true, "20 existing, 10 rendered (exactly 50% lost) is refused");
assert(chapterShrinkRefused(11, 20) === false, "20 existing, 11 rendered (45% lost) passes");

console.log("All exportChapterMerge tests passed.");
