// Smoke test for exportUsfm.ts + chapterCopy.ts. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/exportCopy.test.mjs

import { buildUsfmFromVerses } from "./exportUsfm.ts";
import { buildChapterClipboard } from "./chapterCopy.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function mkVerse(verse, verseObjects, extra = {}) {
  return {
    book: "ZEC",
    chapter: 1,
    verse,
    verse_end: null,
    bible_version: "ULT",
    plain_text: null,
    version: 1,
    updated_by: null,
    updated_at: 0,
    content: { verseObjects },
    ...extra,
  };
}

// A verse: an aligned "Return" then bare " to".
const aligned = [
  {
    type: "milestone",
    tag: "zaln",
    strong: "H7725",
    lemma: "שׁוּב",
    morph: "He,Vqv2mp",
    occurrence: "1",
    occurrences: "1",
    content: "שׁ֣וּבוּ",
    endTag: "zaln-e\\*",
    children: [{ type: "word", tag: "w", text: "Return", occurrence: "1", occurrences: "1" }],
  },
  { type: "text", text: " " },
  { type: "word", tag: "w", text: "to", occurrence: "1", occurrences: "1" },
];

// ── exportUsfm: aligned keeps milestones ──────────────────────────────────────
{
  const usfm = buildUsfmFromVerses("ZEC", "ULT", [mkVerse(1, aligned)], { aligned: true });
  assert(usfm.includes("\\zaln-s"), "aligned export keeps \\zaln-s milestone");
  assert(usfm.includes("\\w Return"), "aligned export keeps \\w word");
  assert(usfm.includes("\\c 1"), "export emits chapter marker");
  assert(usfm.includes("\\v 1"), "export emits verse marker");
}

// ── exportUsfm: unaligned strips alignment but keeps text ──────────────────────
{
  const usfm = buildUsfmFromVerses("ZEC", "ULT", [mkVerse(1, aligned)], { aligned: false });
  assert(!usfm.includes("\\zaln"), "unaligned export drops \\zaln milestones");
  assert(!usfm.includes("\\w "), "unaligned export drops \\w wrappers");
  assert(usfm.includes("Return to"), "unaligned export keeps the plain words");
}

// ── exportUsfm: unaligned preserves poetry markers ────────────────────────────
{
  const vos = [
    { type: "word", tag: "w", text: "First" },
    { type: "text", text: " " },
    { type: "quote", tag: "q1" },
    { type: "word", tag: "w", text: "Second" },
  ];
  const usfm = buildUsfmFromVerses("ZEC", "ULT", [mkVerse(2, vos)], { aligned: false });
  assert(usfm.includes("\\q1"), "unaligned export preserves \\q1 poetry marker");
  assert(!usfm.includes("\\w"), "unaligned poetry verse has no \\w");
}

// ── exportUsfm: multi-chapter grouping ────────────────────────────────────────
{
  const usfm = buildUsfmFromVerses(
    "ZEC",
    "ULT",
    [mkVerse(1, aligned), mkVerse(1, aligned, { chapter: 2, verse: 1 })],
    { aligned: true },
  );
  assert(usfm.includes("\\c 1") && usfm.includes("\\c 2"), "multi-chapter export emits both \\c markers");
}

// ── chapterCopy: superscript verse numbers + poetry lines ─────────────────────
{
  const v1 = mkVerse(1, [
    { type: "word", tag: "w", text: "Alpha" },
    { type: "text", text: " " },
    { type: "quote", tag: "q1" },
    { type: "word", tag: "w", text: "Beta" },
  ]);
  const v2 = mkVerse(2, [{ type: "word", tag: "w", text: "Gamma" }]);
  const { html, text } = buildChapterClipboard("ZEC", 1, [{ version: "ULT", verses: [v1, v2] }]);
  assert(html.includes("<sup>1</sup>"), "clipboard html superscripts verse 1");
  assert(html.includes("<sup>2</sup>"), "clipboard html superscripts verse 2");
  assert(html.includes("Alpha") && html.includes("Beta") && html.includes("Gamma"), "clipboard html keeps words");
  assert(/margin:0 0 0 1\.5em/.test(html), "poetry \\q1 line is indented in html");
  assert(!html.includes("\\w") && !html.includes("zaln"), "clipboard html has no usfm markup");
  // Plain text: numbers present as bare digits, one poetry line break.
  assert(/\b1\b/.test(text) && /\b2\b/.test(text), "clipboard text has verse numbers");
  assert(text.split("\n").length >= 2, "clipboard text breaks the poetry line");
  assert(text.includes("Beta"), "clipboard text keeps poetry word");
}

// ── chapterCopy: range row not duplicated ─────────────────────────────────────
{
  const rangeVerse = mkVerse(6, [{ type: "word", tag: "w", text: "Bridged" }], { verse_end: 7 });
  // Caller keys the same DTO under 6 and 7.
  const { text } = buildChapterClipboard("ZEC", 1, [{ version: "ULT", verses: [rangeVerse, rangeVerse] }]);
  const occurrences = (text.match(/Bridged/g) || []).length;
  assert(occurrences === 1, "range row copied exactly once");
  assert(text.includes("6-7"), "range row shows hyphenated label");
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nexportCopy: all assertions passed");
