// Tests for flowHighlight.ts — per-token <mark> segments for the flows
// scripture lanes (issue #323). Run from web/:
//   node --experimental-strip-types --no-warnings --test src/lib/flowHighlight.test.mjs
//
// The regression these pin: the old lane renderer joined the matched target
// words into one string and did plain_text.indexOf(...), so scattered matches
// highlighted nothing, occurrence>1 highlighted the first instance, and
// occurrence:-1 highlighted only one.

import test from "node:test";
import assert from "node:assert/strict";

import { flowLaneSegments, flowLaneSegmentsAcross } from "./flowHighlight.ts";
import { extractPlainText } from "./usfm.ts";

// ── fixture builders (usfm-js node shapes) ───────────────────────────────────
const w = (text, occ, occs) =>
  occ === undefined
    ? { type: "word", tag: "w", text }
    : { type: "word", tag: "w", text, occurrence: occ, occurrences: occs };
const x = (text) => ({ type: "text", text });
const z = (content, occ, occs, children) => ({
  type: "milestone",
  tag: "zaln",
  content,
  occurrence: occ,
  occurrences: occs,
  children,
});

// Trimmed copies of the REAL D1 rows for MRK 13:2 (dev DB, read 2026-08-26):
// the ULT lane is a genuinely aligned Arabic verse (AR_AVD), UGNT is the Greek
// source it aligns to. Only the fields the highlighter reads are kept.
//
// Note the real UGNT `\w` nodes carry NO occurrence attribute, so the
// OL-anchored join in findTargetHighlights cannot tell this verse's two
// "οὐ μὴ" instances apart. The occurrence tests below therefore run the
// GL-only degradation path (no source verse passed) — a real runtime case,
// since the lane renders whenever the OL verse hasn't loaded.
const MRK_13_2_ULT_VO = [
  z("καὶ", "1", "1", [z("εἶπεν", "1", "1", [w("فَأَجَابَ", "1", "1")])]),
  x(" "),
  z("ὁ", "1", "1", [z("Ἰησοῦς", "1", "1", [w("يَسُوعُ", "1", "1")])]),
  x(" "),
  z("καὶ", "1", "1", [z("εἶπεν", "1", "1", [w("وَقَالَ", "1", "1")])]),
  x(" "),
  z("αὐτῷ", "1", "1", [w("لَهُ", "1", "1")]),
  x(": «"),
  z("βλέπεις", "1", "1", [w("أَتَنْظُرُ", "1", "1")]),
  x(" "),
  z("ταύτας", "1", "1", [w("هَذِهِ", "1", "1")]),
  x(" "),
  z("οἰκοδομάς", "1", "1", [w("ٱلْأَبْنِيَةَ", "1", "1")]),
  x(" "),
  z("τὰς", "1", "1", [z("μεγάλας", "1", "1", [w("ٱلْعَظِيمَةَ", "1", "1")])]),
  x("؟ "),
  z("οὐ", "1", "2", [z("μὴ", "1", "2", [w("لَا", "1", "2")])]),
  x(" "),
  z("ἀφεθῇ", "1", "1", [z("ὧδε", "1", "1", [w("يُتْرَكُ", "1", "1")])]),
  x(" "),
  z("λίθος", "1", "1", [w("حَجَرٌ", "1", "1")]),
  x(" "),
  z("ἐπὶ", "1", "1", [w("عَلَى", "1", "1")]),
  x(" "),
  z("λίθον", "1", "1", [w("حَجَرٍ", "1", "1")]),
  x(" "),
  z("ὃς", "1", "1", [z("οὐ", "2", "2", [z("μὴ", "2", "2", [w("لَا", "2", "2")])])]),
  x(" "),
  z("καταλυθῇ", "1", "1", [w("يُنْقَضُ", "1", "1")]),
  x("». \n"),
];

const MRK_13_2_UGNT_VO = [
  w("καὶ"), x(" "), w("ὁ"), x(" "), w("Ἰησοῦς"), x(" "), w("εἶπεν"), x(" "),
  w("αὐτῷ"), x(", "), w("βλέπεις"), x(" "), w("ταύτας"), x(" "), w("τὰς"), x(" "),
  w("μεγάλας"), x(" "), w("οἰκοδομάς"), x("? "), w("οὐ"), x(" "), w("μὴ"), x(" "),
  w("ἀφεθῇ"), x(" "), w("ὧδε"), x(" "), w("λίθος"), x(" "), w("ἐπὶ"), x(" "),
  w("λίθον"), x(", "), w("ὃς"), x(" "), w("οὐ"), x(" "), w("μὴ"), x(" "),
  w("καταλυθῇ"), x(".\n\n"), { type: "paragraph", tag: "p" },
];

// The stored plain_text of that same ULT row, verbatim.
const MRK_13_2_ULT_PLAIN =
  "فَأَجَابَ يَسُوعُ وَقَالَ لَهُ: «أَتَنْظُرُ هَذِهِ ٱلْأَبْنِيَةَ ٱلْعَظِيمَةَ؟ لَا يُتْرَكُ حَجَرٌ عَلَى حَجَرٍ لَا يُنْقَضُ».";

const joined = (segs) => segs.map((s) => s.text).join("");
const marks = (segs) => segs.filter((s) => s.marked).map((s) => s.text);

// ── 1. contiguous multi-word quote → one continuous highlight ────────────────
test("contiguous multi-word quote marks the whole phrase", () => {
  const segs = flowLaneSegments(
    MRK_13_2_ULT_VO,
    MRK_13_2_ULT_PLAIN,
    "βλέπεις ταύτας τὰς μεγάλας οἰκοδομάς",
    1,
    MRK_13_2_UGNT_VO,
  );
  assert.deepEqual(marks(segs), ["أَتَنْظُرُ هَذِهِ ٱلْأَبْنِيَةَ ٱلْعَظِيمَةَ"]);
  // The text around it survives untouched, punctuation included.
  assert.equal(joined(segs), MRK_13_2_ULT_PLAIN);
  assert.ok(segs[0].text.endsWith(": «"), `leading segment kept punctuation: ${segs[0].text}`);
});

// ── 2. scattered matches → each word marked, gap left alone ─────────────────
test("scattered (gap-marked) quote marks each word, not the span between", () => {
  // "βλέπεις & οἰκοδομάς" aligns to أَتَنْظُرُ and ٱلْأَبْنِيَةَ, which are
  // separated in the Arabic by an unmatched هَذِهِ. The old substring renderer
  // highlighted NOTHING here.
  const segs = flowLaneSegments(
    MRK_13_2_ULT_VO,
    MRK_13_2_ULT_PLAIN,
    "βλέπεις & οἰκοδομάς",
    1,
    MRK_13_2_UGNT_VO,
  );
  assert.deepEqual(marks(segs), ["أَتَنْظُرُ", "ٱلْأَبْنِيَةَ"]);
  const gap = segs[segs.findIndex((s) => s.marked) + 1];
  assert.equal(gap.marked, false);
  assert.equal(gap.text, " هَذِهِ ");
  assert.equal(joined(segs), MRK_13_2_ULT_PLAIN);
});

// ── 3. occurrence 2 → the SECOND instance only ──────────────────────────────
test("occurrence 2 marks the second instance, not the first", () => {
  // "οὐ μὴ" appears twice; both align to لَا (occurrence 1/2 and 2/2).
  const segs = flowLaneSegments(MRK_13_2_ULT_VO, MRK_13_2_ULT_PLAIN, "οὐ μὴ", 2);
  assert.deepEqual(marks(segs), ["لَا"]);
  const before = joined(segs.slice(0, segs.findIndex((s) => s.marked)));
  // Everything up to the mark contains the FIRST لَا, so the marked one is the
  // second — the old renderer's indexOf() hit the first.
  assert.ok(before.includes("لَا"), `first instance is left unmarked: ${before}`);
  assert.equal(joined(segs), MRK_13_2_ULT_PLAIN);
});

test("occurrence 1 marks the first instance", () => {
  const segs = flowLaneSegments(MRK_13_2_ULT_VO, MRK_13_2_ULT_PLAIN, "οὐ μὴ", 1);
  assert.deepEqual(marks(segs), ["لَا"]);
  const before = joined(segs.slice(0, segs.findIndex((s) => s.marked)));
  assert.ok(!before.includes("لَا"), `nothing before the first instance: ${before}`);
});

// ── 4. occurrence -1 → every instance ───────────────────────────────────────
test("occurrence -1 marks every instance", () => {
  const segs = flowLaneSegments(MRK_13_2_ULT_VO, MRK_13_2_ULT_PLAIN, "οὐ μὴ", -1);
  assert.deepEqual(marks(segs), ["لَا", "لَا"]);
  assert.equal(joined(segs), MRK_13_2_ULT_PLAIN);
});

// ── 5. no alignment tree → unmarked plain text ──────────────────────────────
test("verse with no zaln milestones falls back to plain text", () => {
  const bare = [w("Jesus", "1", "1"), x(" "), w("answered", "1", "1"), x(".")];
  const segs = flowLaneSegments(bare, "Jesus answered.", "וַיַּעַן", 1);
  assert.deepEqual(segs, [{ text: "Jesus answered.", marked: false }]);
});

test("no verse tree at all falls back to plain text", () => {
  assert.deepEqual(flowLaneSegments(null, "Jesus answered.", "וַיַּעַן", 1), [
    { text: "Jesus answered.", marked: false },
  ]);
  assert.deepEqual(flowLaneSegments([], "Jesus answered.", "וַיַּעַן", 1), [
    { text: "Jesus answered.", marked: false },
  ]);
});

test("no quote leaves the lane exactly as before (plain text, no marks)", () => {
  assert.deepEqual(flowLaneSegments(MRK_13_2_ULT_VO, MRK_13_2_ULT_PLAIN, null, 1), [
    { text: MRK_13_2_ULT_PLAIN, marked: false },
  ]);
  assert.deepEqual(flowLaneSegments(MRK_13_2_ULT_VO, MRK_13_2_ULT_PLAIN, "", 1), [
    { text: MRK_13_2_ULT_PLAIN, marked: false },
  ]);
});

test("a quote that does not resolve in this lane falls back to plain text", () => {
  assert.deepEqual(
    flowLaneSegments(MRK_13_2_ULT_VO, MRK_13_2_ULT_PLAIN, "ουδεποτε", 1, MRK_13_2_UGNT_VO),
    [{ text: MRK_13_2_ULT_PLAIN, marked: false }],
  );
});

test("a lane with no plain text and no tree renders nothing", () => {
  assert.deepEqual(flowLaneSegments(null, null, "οὐ μὴ", 1), []);
});

// ── 6. rendered text === plain_text on the real aligned verse ───────────────
test("segments reproduce the stored plain_text of the real ULT verse", () => {
  const segs = flowLaneSegments(MRK_13_2_ULT_VO, MRK_13_2_ULT_PLAIN, "οὐ μὴ", -1);
  assert.equal(joined(segs), MRK_13_2_ULT_PLAIN);
  // …and equals what the shared extractPlainText derives from the same tree,
  // which is what wrote plain_text in the first place.
  assert.equal(joined(segs), extractPlainText(MRK_13_2_ULT_VO));
  // No segment is empty, and marked/unmarked runs alternate (grouping is tight).
  for (let i = 0; i < segs.length; i++) {
    assert.ok(segs[i].text.length > 0, `segment ${i} is non-empty`);
    if (i > 0) assert.notEqual(segs[i].marked, segs[i - 1].marked, `run ${i} alternates`);
  }
});

test("whitespace normalization matches extractPlainText across a line marker", () => {
  // usfm-js parks the opening quote on the \q1 node and emits no whitespace
  // around it; both walks must produce the same separator + punctuation.
  const vo = [
    z("א", "1", "1", [w("first", "1", "1")]),
    { type: "paragraph", tag: "q1", text: "“" },
    z("ב", "1", "1", [w("second", "1", "1")]),
    x("\n  \n"),
  ];
  const plain = extractPlainText(vo);
  const segs = flowLaneSegments(vo, plain, "ב", 1);
  assert.equal(joined(segs), plain);
  assert.deepEqual(marks(segs), ["second"]);
});

// ── 7. multi-verse span: each verse highlighted on its own ──────────────────
// The regression this pins (#344 review): concatenating two verses'
// verseObjects into ONE tree before highlighting double-marks tokens, because
// occurrence numbers are counted per verse — both verses' أَنَا carry
// occurrence "1", so the single highlight key "أَنَا|1" marks both even though
// the quote resolves in verse 26 only. A bridged note (ref_raw "13:26-27") must
// still mark exactly one token.
const SPAN_V26_VO = [
  z("ἐγώ", "1", "1", [w("أَنَا", "1", "1")]),
  x(" "),
  z("εἶπεν", "1", "1", [w("قَالَ", "1", "1")]),
];
const SPAN_V26_PLAIN = "أَنَا قَالَ";
// Verse 27 repeats the same Arabic surface form, aligned to a DIFFERENT Greek
// word — so the quote below must not touch it.
const SPAN_V27_VO = [
  z("αὐτός", "1", "1", [w("أَنَا", "1", "1")]),
  x(" "),
  z("ἦλθεν", "1", "1", [w("جَاءَ", "1", "1")]),
];
const SPAN_V27_PLAIN = "أَنَا جَاءَ";

test("combined span marks one token per resolving verse, not the shared surface form", () => {
  const segs = flowLaneSegmentsAcross(
    [
      { verseObjects: SPAN_V26_VO, plainText: SPAN_V26_PLAIN, sourceVerseObjects: null },
      { verseObjects: SPAN_V27_VO, plainText: SPAN_V27_PLAIN, sourceVerseObjects: null },
    ],
    "ἐγώ",
    1,
  );
  assert.deepEqual(marks(segs), ["أَنَا"]);
  // The whole span's text is still rendered, verses joined by a single space.
  assert.equal(joined(segs), `${SPAN_V26_PLAIN} ${SPAN_V27_PLAIN}`);
});

test("concatenating the two verses into one tree is what double-marks (defect pin)", () => {
  // Same inputs, the pre-fix shape: one tree with a separator between verses.
  const combined = [...SPAN_V26_VO, { type: "text", text: " " }, ...SPAN_V27_VO];
  const segs = flowLaneSegments(
    combined,
    `${SPAN_V26_PLAIN} ${SPAN_V27_PLAIN}`,
    "ἐγώ",
    1,
  );
  assert.equal(marks(segs).length, 2, "combined tree marks both verses' أَنَا");
});

test("a single slice is the plain single-verse path", () => {
  const across = flowLaneSegmentsAcross(
    [
      {
        verseObjects: MRK_13_2_ULT_VO,
        plainText: MRK_13_2_ULT_PLAIN,
        sourceVerseObjects: MRK_13_2_UGNT_VO,
      },
    ],
    "βλέπεις ταύτας τὰς μεγάλας οἰκοδομάς",
    1,
  );
  const direct = flowLaneSegments(
    MRK_13_2_ULT_VO,
    MRK_13_2_ULT_PLAIN,
    "βλέπεις ταύτας τὰς μεγάλας οἰκοδομάς",
    1,
    MRK_13_2_UGNT_VO,
  );
  assert.deepEqual(across, direct);
});

test("a slice whose quote doesn't resolve contributes its plain text unmarked", () => {
  const segs = flowLaneSegmentsAcross(
    [
      { verseObjects: SPAN_V26_VO, plainText: SPAN_V26_PLAIN, sourceVerseObjects: null },
      { verseObjects: null, plainText: SPAN_V27_PLAIN, sourceVerseObjects: null },
    ],
    "ἐγώ",
    1,
  );
  assert.deepEqual(marks(segs), ["أَنَا"]);
  assert.equal(joined(segs), `${SPAN_V26_PLAIN} ${SPAN_V27_PLAIN}`);
});

test("no slices renders nothing", () => {
  assert.deepEqual(flowLaneSegmentsAcross([], "ἐγώ", 1), []);
});
