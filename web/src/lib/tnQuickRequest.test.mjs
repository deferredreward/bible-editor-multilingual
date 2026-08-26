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

// Minimal fixtures for the full buildTnQuickRequest flow — no alignment
// milestones, so extractTargetSelectionText degrades to "" and the ULT/UST
// selections fall back to the full verse text. That's fine here: the point
// is proving the Greek quote is routed through the source-language branch
// (hebrewGuess carries the source quote) rather than aborting with
// hebrew_not_found the way it did before this fix.
function verse(plainText) {
  return {
    book: "MRK",
    chapter: 13,
    verse: 2,
    verse_end: null,
    bible_version: "test",
    plain_text: plainText,
    version: 1,
    updated_by: null,
    updated_at: 0,
    content: { verseObjects: [] },
  };
}

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

test("buildTnQuickRequest routes a Greek quote through the source-language path", () => {
  const row = makeRow({ quote: "βλέπεις" });
  const result = buildTnQuickRequest(row, makeChapterPayload());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.request.hebrewGuess, "βλέπεις");
    assert.equal(result.request.ref.book, "MRK");
    assert.equal(result.request.ult.verse, "Do you see these great buildings?");
    assert.equal(result.request.ust.verse, "Look at these enormous buildings!");
  }
});

test("buildTnQuickRequest still resolves a Hebrew quote through the source-language path", () => {
  const row = makeRow({ quote: "בְּרֵאשִׁ֖ית" });
  const result = buildTnQuickRequest(row, makeChapterPayload());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.request.hebrewGuess, "בְּרֵאשִׁ֖ית");
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
