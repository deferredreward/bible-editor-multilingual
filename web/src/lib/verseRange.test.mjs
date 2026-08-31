// Smoke test for verseRange.ts helpers. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/verseRange.test.mjs

import {
  verseSpan,
  isRangeRow,
  formatVerseLabel,
  buildVerseIndex,
  isFirstOfRange,
  rangeSize,
  concatSourceRange,
  noteCoveredVerses,
  noteOverlapsRange,
  coveredLaneSlices,
  clampCoveredForRender,
  LANE_RENDER_CAP,
  noteRefLabel,
  verseBoundaryText,
  verseObjectsOf,
} from "./verseRange.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function mkVerse(verse, verseEnd, voCount = 1) {
  return {
    book: "ISA",
    chapter: 7,
    verse,
    verse_end: verseEnd,
    bible_version: "UST",
    plain_text: `verse ${verse}`,
    version: 1,
    updated_by: null,
    updated_at: 0,
    content: {
      verseObjects: Array.from({ length: voCount }, (_, i) => ({
        type: "text",
        text: `v${verse}.${i} `,
      })),
    },
  };
}

// --- verseSpan / isRangeRow / rangeSize / isFirstOfRange ---
{
  const single = mkVerse(7, null);
  const range = mkVerse(6, 9);
  assert(verseSpan(single)[0] === 7 && verseSpan(single)[1] === 7, "singleton span is [n,n]");
  assert(verseSpan(range)[0] === 6 && verseSpan(range)[1] === 9, "range span is [6,9]");
  assert(!isRangeRow(single), "singleton is not a range row");
  assert(isRangeRow(range), "6-9 is a range row");
  assert(rangeSize(single) === 1, "singleton size is 1");
  assert(rangeSize(range) === 4, "6-9 size is 4");
  assert(isFirstOfRange(range, 6), "v=6 is first of 6-9");
  assert(!isFirstOfRange(range, 7), "v=7 is not first of 6-9");
}

// --- formatVerseLabel ---
{
  assert(formatVerseLabel(mkVerse(7, null)) === "7", "singleton label is '7'");
  assert(formatVerseLabel(mkVerse(6, 9)) === "6-9", "range label is '6-9'");
  // verse_end equal to verse (defensive) → treat as singleton
  assert(formatVerseLabel(mkVerse(7, 7)) === "7", "verse_end === verse → singleton label");
}

// --- buildVerseIndex ---
{
  const byStart = {
    1: mkVerse(1, null),
    6: mkVerse(6, 9),
    10: mkVerse(10, null),
  };
  const idx = buildVerseIndex(byStart);
  assert(idx[1]?.verse === 1, "singleton 1 indexed at key 1");
  assert(idx[6]?.verse === 6, "range start indexed at 6");
  assert(idx[7] === idx[6], "verse 7 inside 6-9 resolves to same DTO reference");
  assert(idx[8] === idx[6], "verse 8 inside 6-9 resolves to same DTO reference");
  assert(idx[9] === idx[6], "verse 9 inside 6-9 resolves to same DTO reference");
  assert(idx[10]?.verse === 10, "singleton 10 indexed at key 10");
  assert(idx[11] === undefined, "verse 11 not present");
}

// --- concatSourceRange ---
{
  // Singleton range → returns input unchanged
  const single = mkVerse(7, null);
  const out = concatSourceRange({ 7: single }, 7, 7);
  assert(out === single, "single-verse range returns the input row");
}
{
  // Multi-verse range → concatenates verseObjects with separators
  const byStart = {
    6: mkVerse(6, null, 2),
    7: mkVerse(7, null, 1),
    8: mkVerse(8, null, 1),
    9: mkVerse(9, null, 1),
  };
  const combined = concatSourceRange(byStart, 6, 9);
  assert(combined !== null, "combined range produces a DTO");
  assert(combined.verse === 6 && combined.verse_end === 9, "synthetic DTO carries span 6-9");
  const vos = combined.content.verseObjects;
  // 2 from v6 + 1 sep + 1 from v7 + 1 sep + 1 from v8 + 1 sep + 1 from v9 = 8
  assert(vos.length === 8, `combined has 8 verseObjects (got ${vos.length})`);
  assert(vos[0].text === "v6.0 ", "first vo is from v6");
  assert(vos[vos.length - 1].text === "v9.0 ", "last vo is from v9");
}
{
  // Missing rows in the range → skip silently
  const byStart = {
    6: mkVerse(6, null, 1),
    9: mkVerse(9, null, 1),
  };
  const combined = concatSourceRange(byStart, 6, 9);
  assert(combined !== null, "partial range still produces a DTO");
  const vos = combined.content.verseObjects;
  // 1 from v6 + 1 sep + 1 from v9 = 3
  assert(vos.length === 3, `partial combined has 3 verseObjects (got ${vos.length})`);
}

// --- noteCoveredVerses (tn/tq references, parsed from ref_raw) ---
{
  const cv = (verse, ref_raw) => JSON.stringify(noteCoveredVerses({ verse, ref_raw }));
  assert(cv(2, "1:2") === "[2]", "singleton ref → [2]");
  assert(cv(2, "1:2-3") === "[2,3]", "bridge 1:2-3 → [2,3]");
  assert(cv(2, "1:2-5") === "[2,3,4,5]", "bridge 1:2-5 expands → [2,3,4,5]");
  // Leading verse is authoritative for the start even if ref_raw drifts.
  assert(cv(2, "2-4") === "[2,3,4]", "colon-less range → [2,3,4]");
  // Comma-separated (discontinuous) references union each segment.
  assert(cv(2, "1:2,4") === "[2,4]", "comma list 1:2,4 → [2,4]");
  assert(cv(2, "1:2-3,5") === "[2,3,5]", "range+comma 1:2-3,5 → [2,3,5]");
  // Cross-chapter segment not supported → skipped, leading verse remains.
  assert(cv(2, "1:2-2:3") === "[2]", "cross-chapter end → leading only");
  // Descending / malformed range → leading verse only.
  assert(cv(3, "1:3-2") === "[3]", "descending range → leading only");
  assert(cv(5, null) === "[5]", "null ref → [5]");
  assert(cv(0, "1:intro") === "[0]", "intro ref → [0]");
  // Malformed huge range from free-text input is bounded (no runaway loop).
  assert(noteCoveredVerses({ verse: 1, ref_raw: "1:1-1000000000" }).length <= 402, "huge range is bounded");
}

// --- clampCoveredForRender (issue #385: a free-text ref typo must not flood a
// card's lanes with the whole chapter; NOTE_SPAN_CAP bounds the hang, this
// bounds the render) ---
{
  // A legitimate short bridge renders every verse — unclamped, referentially
  // identical so the lane useMemos don't churn.
  const short = noteCoveredVerses({ verse: 2, ref_raw: "1:2-3" });
  const shortOut = clampCoveredForRender(short);
  assert(!shortOut.clamped, "legitimate 1:2-3 is not clamped");
  assert(JSON.stringify(shortOut.verses) === "[2,3]", "1:2-3 still renders both verses");
  assert(shortOut.total === 2, "1:2-3 total is 2");
  assert(shortOut.verses === short, "unclamped list is returned by reference");

  // The success-check scenario: "1:1-200" retyped into the reference expands to
  // 200 covered verses but paints at most LANE_RENDER_CAP into the lanes.
  const flood = noteCoveredVerses({ verse: 1, ref_raw: "1:1-200" });
  assert(flood.length === 200, `1:1-200 covers 200 verses (got ${flood.length})`);
  const floodOut = clampCoveredForRender(flood);
  assert(floodOut.clamped, "1:1-200 is clamped for render");
  assert(floodOut.verses.length === LANE_RENDER_CAP, "clamps to LANE_RENDER_CAP verses");
  assert(floodOut.total === 200, "clamp reports the full covered total (200)");
  assert(floodOut.verses[0] === 1, "clamp keeps the leading verse first");

  // Exactly at the cap → not clamped (boundary).
  const exact = Array.from({ length: LANE_RENDER_CAP }, (_, i) => i + 1);
  assert(!clampCoveredForRender(exact).clamped, "a list of exactly the cap is not clamped");
  // One over → clamped.
  assert(clampCoveredForRender([...exact, 99]).clamped, "cap+1 is clamped");
  // Custom cap honored.
  assert(
    JSON.stringify(clampCoveredForRender([1, 2, 3, 4], 2).verses) === "[1,2]",
    "explicit cap slices the head",
  );
}

// --- noteOverlapsRange ---
{
  const bridge = { verse: 2, ref_raw: "1:2-3" };
  assert(noteOverlapsRange(bridge, 2, 2), "bridge 2-3 shows on verse 2");
  assert(noteOverlapsRange(bridge, 3, 3), "bridge 2-3 shows on verse 3");
  assert(!noteOverlapsRange(bridge, 4, 4), "bridge 2-3 hidden on verse 4");
  assert(!noteOverlapsRange(bridge, 1, 1), "bridge 2-3 hidden on verse 1");
  // Discontinuous ref shows on its listed verses but not the gap between them.
  const gap = { verse: 2, ref_raw: "1:2,4" };
  assert(noteOverlapsRange(gap, 4, 4), "gap ref 2,4 shows on verse 4");
  assert(!noteOverlapsRange(gap, 3, 3), "gap ref 2,4 hidden on verse 3");
  const single = { verse: 5, ref_raw: "1:5" };
  assert(noteOverlapsRange(single, 5, 5), "singleton shows on its verse");
  assert(!noteOverlapsRange(single, 6, 6), "singleton hidden elsewhere");
}

// --- coveredLaneSlices (issue #341: flows notes multi-verse text; the slices
// stay separate so per-verse occurrence numbering can't double-mark — #344) ---
{
  const dto = (verse, text, tokens, verse_end = null) => ({
    book: "MRK",
    chapter: 13,
    verse,
    verse_end,
    bible_version: "ULT",
    plain_text: text,
    version: 1,
    updated_by: null,
    updated_at: 0,
    content: { verseObjects: tokens },
  });
  const w = (t) => ({ type: "word", tag: "w", text: t });
  const noSource = buildVerseIndex({});

  // Singleton note: one verse in, one slice out carrying that verse's text/tokens.
  {
    const index = buildVerseIndex({ 26: dto(26, "the Son", [w("the"), w("Son")]) });
    const out = coveredLaneSlices(
      index,
      noSource,
      noteCoveredVerses({ verse: 26, ref_raw: "13:26" }),
    );
    assert(out.slices.length === 1, "singleton note → one lane slice");
    assert(out.plainText === "the Son", "singleton lane plain_text unchanged");
    assert(out.slices[0].verse === 26, "slice carries the verse its text begins at");
    assert(
      Array.isArray(out.slices[0].verseObjects) && out.slices[0].verseObjects.length === 2,
      "singleton lane keeps its 2 tokens",
    );
  }

  // Bridged note 13:26-27: one slice per verse, trees kept separate, plain_text
  // joined for the lane's unhighlighted rendering.
  {
    const index = buildVerseIndex({
      26: dto(26, "in clouds", [w("in"), w("clouds")]),
      27: dto(27, "the Son of Man", [w("the"), w("Son"), w("of"), w("Man")]),
    });
    const out = coveredLaneSlices(
      index,
      noSource,
      noteCoveredVerses({ verse: 26, ref_raw: "13:26-27" }),
    );
    assert(out.slices.length === 2, "bridge note → one slice per covered verse");
    assert(out.slices[0].verseObjects.length === 2, "first slice keeps verse 26's tokens only");
    assert(out.slices[1].verseObjects.length === 4, "second slice keeps verse 27's tokens only");
    assert(
      out.plainText === `in clouds${verseBoundaryText(27)}the Son of Man`,
      "bridge lane joins both verses' plain_text with a verse-boundary marker",
    );
  }

  // #351 item 2: a discontinuous ref must not read as one continuous sentence —
  // the marker names the verse the reader jumps to, so the elided verse 27 is
  // visible rather than silent.
  {
    const index = buildVerseIndex({
      26: dto(26, "in clouds", [w("in"), w("clouds")]),
      27: dto(27, "skipped", [w("skipped")]),
      28: dto(28, "he will send", [w("he"), w("will"), w("send")]),
    });
    const out = coveredLaneSlices(
      index,
      noSource,
      noteCoveredVerses({ verse: 26, ref_raw: "13:26,28" }),
    );
    assert(out.slices.length === 2, "discontinuous ref → slices for 26 and 28 only");
    assert(
      out.plainText === `in clouds ¦28 he will send`,
      `discontinuous lane marks the jump to verse 28 (got ${JSON.stringify(out.plainText)})`,
    );
    assert(!out.plainText.includes("skipped"), "the elided verse's text is not rendered");
  }

  // A scripture row that is itself a USFM bridge (verse_end) is mapped under
  // every integer it spans by buildVerseIndex; it must yield ONE slice.
  {
    const index = buildVerseIndex({ 26: dto(26, "bridged text", [w("bridged"), w("text")], 27) });
    const out = coveredLaneSlices(
      index,
      noSource,
      noteCoveredVerses({ verse: 26, ref_raw: "13:26-27" }),
    );
    assert(out.slices.length === 1, "bridge scripture row yields one slice");
    assert(out.plainText === "bridged text", "bridge scripture row not duplicated");
    assert(out.slices[0].verseObjects.length === 2, "bridge scripture row tokens counted once");
  }

  // The OL verse of every covered verse rides along on its own slice, so each
  // verse is highlighted against its own source.
  {
    const src = (verse, tokens) => ({ ...dto(verse, null, tokens), bible_version: "UGNT" });
    const index = buildVerseIndex({
      26: dto(26, "v26", [w("a")]),
      27: dto(27, "v27", [w("b")]),
    });
    const sourceIndex = buildVerseIndex({
      26: src(26, [w("ἐγώ")]),
      27: src(27, [w("αὐτός")]),
    });
    const out = coveredLaneSlices(
      index,
      sourceIndex,
      noteCoveredVerses({ verse: 26, ref_raw: "13:26-27" }),
    );
    assert(out.slices[0].sourceVerseObjects[0].text === "ἐγώ", "slice 26 carries verse 26's source");
    assert(
      out.slices[1].sourceVerseObjects[0].text === "αὐτός",
      "slice 27 carries verse 27's source",
    );
  }

  // #351 item 3: `plain_text` and the verse tree must cover the SAME verses. A
  // row whose plain_text column is empty but whose tree carries tokens rendered
  // in the highlighted lane yet vanished from the joined string — so tq (which
  // renders only the string) and tn's unhighlighted fallback silently dropped it.
  {
    const sp = { type: "text", text: " " };
    const index = buildVerseIndex({
      26: dto(26, "in clouds", [w("in"), sp, w("clouds")]),
      27: dto(27, null, [w("the"), sp, w("Son")]),
    });
    const out = coveredLaneSlices(
      index,
      noSource,
      noteCoveredVerses({ verse: 26, ref_raw: "13:26-27" }),
    );
    assert(out.slices.length === 2, "plain_text-less verse still yields a slice");
    assert(
      out.slices[1].plainText === "the Son",
      `verse 27's text is derived from its tree (got ${JSON.stringify(out.slices[1].plainText)})`,
    );
    assert(
      out.plainText === `in clouds${verseBoundaryText(27)}the Son`,
      "the joined lane string covers every verse the tree renders",
    );
  }
  // The other side of the same rule: a row with neither text nor tokens
  // contributes to neither, instead of a phantom separator in the string.
  {
    const index = buildVerseIndex({
      26: dto(26, "in clouds", [w("in"), w("clouds")]),
      27: dto(27, null, []),
    });
    const out = coveredLaneSlices(
      index,
      noSource,
      noteCoveredVerses({ verse: 26, ref_raw: "13:26-27" }),
    );
    assert(out.slices[1].plainText === null, "empty verse contributes no text");
    assert(out.slices[1].verseObjects === null, "empty verse contributes no tree");
    assert(out.plainText === "in clouds", "empty verse adds no boundary marker");
  }

  // Missing verse in the range is skipped without blanking the lane.
  {
    const index = buildVerseIndex({ 26: dto(26, "only 26", [w("only")]) });
    const out = coveredLaneSlices(
      index,
      noSource,
      noteCoveredVerses({ verse: 26, ref_raw: "13:26-27" }),
    );
    assert(out.slices.length === 1, "missing verse 27 → only verse 26 sliced");
    assert(out.plainText === "only 26", "missing verse 27 → verse 26 text still shown");
  }

  // No matching verses at all → no slices (Lane renders its empty state).
  {
    const out = coveredLaneSlices(buildVerseIndex({}), noSource, [26, 27]);
    assert(out.slices.length === 0 && out.plainText === null, "empty index → empty lane");
  }
}

// --- noteRefLabel (#344 review: the chip must name what the lanes show) ---
{
  assert(
    noteRefLabel({ chapter: 13, verse: 26, ref_raw: "13:26" }) === "13:26",
    "singleton ref_raw rendered verbatim",
  );
  assert(
    noteRefLabel({ chapter: 13, verse: 26, ref_raw: "13:26-27" }) === "13:26-27",
    "same-chapter bridge shows the range",
  );
  assert(
    noteRefLabel({ chapter: 13, verse: 26, ref_raw: "13:26,28" }) === "13:26,28",
    "discontinuous same-chapter ref shows both verses",
  );
  // noteCoveredVerses deliberately drops the cross-chapter segment, so the lanes
  // show verse 26 only — the label must not advertise 14:2.
  assert(
    noteRefLabel({ chapter: 13, verse: 26, ref_raw: "13:26-14:2" }) === "13:26",
    "cross-chapter range falls back to the leading verse",
  );
  assert(
    noteRefLabel({ chapter: 13, verse: 26, ref_raw: null }) === "13:26",
    "absent ref_raw falls back to chapter:verse",
  );
  // tq questions carry the same free-typed ref_raw and get the same label
  // (#351 item 1) — the tq card printed `chapter:verse` and hid the range.
  assert(
    noteRefLabel({ chapter: 1, verse: 2, ref_raw: "1:2-3" }) === "1:2-3",
    "tq bridged question shows its range",
  );
  assert(
    noteRefLabel({ chapter: 1, verse: 2, ref_raw: "1:2,4" }) === "1:2,4",
    "tq discontinuous question shows both verses",
  );
  // #351 review: a free-typed ref naming ANOTHER chapter must not be printed
  // over lanes that render this chapter — noteCoveredVerses ignores the chapter
  // part, so "2:3" on a chapter-1 row still shows chapter 1's verses.
  assert(
    noteRefLabel({ chapter: 1, verse: 5, ref_raw: "2:3" }) === "1:5",
    "cross-chapter ref falls back to this row's chapter:verse",
  );
  assert(
    noteRefLabel({ chapter: 2, verse: 5, ref_raw: "1:5-7" }) === "2:5",
    "cross-chapter range falls back rather than advertising another chapter",
  );
  // A ref with no chapter part at all keeps its previous verbatim treatment.
  assert(noteRefLabel({ chapter: 1, verse: 5, ref_raw: "5" }) === "5", "colon-less ref verbatim");
}

// --- verseObjectsOf (#351 item 4: one exported copy of the content cast) ---
{
  const tokens = [{ type: "word", tag: "w", text: "a" }];
  assert(verseObjectsOf({ content: { verseObjects: tokens } }) === tokens, "returns the tree");
  assert(verseObjectsOf({ content: {} }) === null, "no verseObjects → null");
  assert(verseObjectsOf({ content: null }) === null, "null content → null");
  assert(verseObjectsOf(null) === null, "null dto → null");
  assert(verseObjectsOf(undefined) === null, "undefined dto → null");
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll verseRange smoke checks passed.");
