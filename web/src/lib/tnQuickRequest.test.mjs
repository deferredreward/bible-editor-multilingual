import test from "node:test";
import assert from "node:assert/strict";
import { isOriginalLanguageQuote, buildTnQuickRequest } from "./tnQuickRequest.ts";

test("Greek quote classifies as source-language", () => {
  assert.equal(isOriginalLanguageQuote("βλέπεις"), true);
});

test("Hebrew quote still classifies as source-language", () => {
  assert.equal(isOriginalLanguageQuote("בְּרֵאשִׁ֖ית"), true);
});

test("plain English phrase takes the English path (not source-language)", () => {
  assert.equal(isOriginalLanguageQuote("Do you see these things"), false);
});

test("mixed punctuation/whitespace around a Greek quote is still detected", () => {
  assert.equal(isOriginalLanguageQuote("  …βλέπεις ταῦτα…  "), true);
  assert.equal(isOriginalLanguageQuote("(βλέπεις)"), true);
});

// Fixtures for the full buildTnQuickRequest flow.
//
// A verse with no alignment milestones: extractTargetSelectionText degrades
// to "" against it. Used by the negative tests (a source-language quote that
// resolves to nothing, and a non-aligning English phrase) — since #332 the
// no-selection case fails loudly with hebrew_not_found rather than silently
// falling back to the whole verse.
// ref defaults to MRK 13:2; buildVerseIndex keys off the object's own verse
// field, so a fixture at another ref (e.g. GEN 1:1) must pass it through.
function verse(plainText, ref = { book: "MRK", chapter: 13, verse: 2 }) {
  return {
    ...ref,
    verse_end: null,
    bible_version: "test",
    plain_text: plainText,
    version: 1,
    updated_by: null,
    updated_at: 0,
    content: { verseObjects: [] },
  };
}

// A verse carrying real verseObjects, so an aligned source-language quote
// resolves to a genuine ULT/UST phrase (the realistic regenerate path).
function verseVO(verseObjects, plainText, ref = { book: "MRK", chapter: 13, verse: 2 }) {
  return {
    ...ref,
    verse_end: null,
    bible_version: "test",
    plain_text: plainText,
    version: 1,
    updated_by: null,
    updated_at: 0,
    content: { verseObjects },
  };
}

// usfm-js-shaped node builders (same shapes alignment.test.mjs uses).
const gw = (text, occurrence = 1, occurrences = 1) => ({
  type: "word", tag: "w", text,
  occurrence: String(occurrence), occurrences: String(occurrences),
});
const gt = (text) => ({ type: "text", text });
// A \zaln-s milestone whose x-content is `content`, wrapping target \w words.
const gms = (content, words) => ({
  type: "milestone", tag: "zaln", content,
  occurrence: "1", occurrences: "1",
  children: words.map((text) => ({
    type: "word", tag: "w", text, occurrence: "1", occurrences: "1",
  })),
});

function makeRow(overrides) {
  return {
    id: "row-1",
    book: "MRK",
    chapter: 13,
    verse: 2,
    ref_raw: "13:2",
    tags: null,
    support_reference: "rc://*/ta/man/translate/figs-rquestion",
    quote: "βλέπεις",
    occurrence: 1,
    note: null,
    sort_order: null,
    version: 1,
    restored_from_version: null,
    updated_by: null,
    updated_at: 0,
    deleted_at: null,
    ...overrides,
  };
}

// Unaligned payload: verses carry plain text but no alignment milestones, so
// no source-language quote can resolve to a phrase. Used by the negative
// tests (loud failure since #332).
function makeChapterPayload() {
  return {
    book: "MRK",
    chapter: 13,
    verses: {
      ULT: { 2: verse("Do you see these great buildings?") },
      UST: { 2: verse("Look at these enormous buildings!") },
      UGNT: { 2: verse("βλέπεις ταύτας τὰς μεγάλας οἰκοδομάς;") },
    },
    tn: [],
    tq: [],
    twl: [],
    verseStatuses: [],
    verseLaneChecks: [],
  };
}

// Aligned payload: the ULT verse's \zaln milestones map source words to real
// English target words, so a source-language quote resolves to a phrase — the
// realistic regenerate path. UST is left unaligned to exercise the (retained)
// UST whole-verse fallback while the ULT anchors the draft.
function makeAlignedGreekPayload() {
  return {
    book: "MRK",
    chapter: 13,
    verses: {
      ULT: {
        2: verseVO(
          [gms("βλέπεις", ["Do", "you", "see"]), gms("οἰκοδομάς", ["buildings"])],
          "Do you see buildings",
        ),
      },
      UST: { 2: verse("Look at these enormous buildings!") },
      UGNT: {
        2: verseVO(
          [gw("βλέπεις"), gt(" "), gw("ταύτας"), gt(" "), gw("οἰκοδομάς"), gt(";")],
          "βλέπεις ταύτας οἰκοδομάς;",
        ),
      },
    },
    tn: [],
    tq: [],
    twl: [],
    verseStatuses: [],
    verseLaneChecks: [],
  };
}

function makeAlignedHebrewPayload() {
  return {
    book: "GEN",
    chapter: 1,
    verses: {
      ULT: {
        1: verseVO([gms("רֵאשִׁית", ["In", "the", "beginning"])], "In the beginning", {
          book: "GEN", chapter: 1, verse: 1,
        }),
      },
      UST: { 1: verse("In the beginning", { book: "GEN", chapter: 1, verse: 1 }) },
      UHB: {
        1: verseVO([gw("רֵאשִׁית"), gt(" ")], "רֵאשִׁית", { book: "GEN", chapter: 1, verse: 1 }),
      },
    },
    tn: [],
    tq: [],
    twl: [],
    verseStatuses: [],
    verseLaneChecks: [],
  };
}

test("buildTnQuickRequest routes a Greek quote through the source-language path", () => {
  const row = makeRow({ quote: "βλέπεις" });
  const result = buildTnQuickRequest(row, makeAlignedGreekPayload());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.request.hebrewGuess, "βλέπεις");
    assert.equal(result.request.ref.book, "MRK");
    // The aligned source quote resolves to its real ULT phrase, not the verse.
    assert.equal(result.request.ult.selection, "Do you see");
    assert.equal(result.request.ult.verse, "Do you see buildings");
  }
});

test("buildTnQuickRequest still resolves a Hebrew quote through the source-language path", () => {
  const row = makeRow({ book: "GEN", chapter: 1, verse: 1, quote: "רֵאשִׁית" });
  const result = buildTnQuickRequest(row, makeAlignedHebrewPayload());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.request.hebrewGuess, "רֵאשִׁית");
    assert.equal(result.request.ult.selection, "In the beginning");
  }
});

test("buildTnQuickRequest fails loudly for a mixed English+Greek quote that resolves to nothing (#332)", () => {
  // isOriginalLanguageQuote is true on the single Greek word, so this takes the
  // source-language branch — but the mixed string aligns to no ULT word. Before
  // #332 it silently drafted the whole verse; now it fails like the English path.
  const row = makeRow({ quote: "the word λόγος" });
  const result = buildTnQuickRequest(row, makeChapterPayload());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.reason, "hebrew_not_found");
  }
});

test("buildTnQuickRequest fails with hebrew_not_found for an English phrase that doesn't align", () => {
  const row = makeRow({ quote: "some unrelated english phrase" });
  const result = buildTnQuickRequest(row, makeChapterPayload());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.reason, "hebrew_not_found");
  }
});
