import test from "node:test";
import assert from "node:assert/strict";
import { buildTnQuickRequest, hasSourceLangQuote } from "./tnQuickRequest.ts";

// Regression for #324: the Redo / tn-quick handoff detected the
// original-language quote by testing the HEBREW Unicode block only, so a
// Greek (NT) quote took the English path, `findSourceForTargetText` returned
// "", and the request aborted `hebrew_not_found` — Redo broken for every NT
// note. Detection now covers Hebrew OR Greek.

const HEBREW_QUOTE = "שֹׁכֵב֙ עִם"; // DEU-style Hebrew quote
const GREEK_QUOTE = "βλέπεις ταύτας"; // MRK 13:2-style Greek quote

test("hasSourceLangQuote classifies Hebrew and Greek as source-language", () => {
  assert.equal(hasSourceLangQuote(HEBREW_QUOTE), true);
  assert.equal(hasSourceLangQuote(GREEK_QUOTE), true);
  // Greek Extended (accented) range too — e.g. ἀ / ῥ.
  assert.equal(hasSourceLangQuote("ἀγάπη"), true);
});

test("hasSourceLangQuote treats English support text and empty as NOT source-language", () => {
  assert.equal(hasSourceLangQuote("great buildings"), false);
  assert.equal(hasSourceLangQuote(""), false);
  assert.equal(hasSourceLangQuote("123 :;.,"), false);
});

// Minimal ChapterPayload: no alignment milestones, so extractTargetSelectionText
// returns "" and the selection falls back to plain text — enough to exercise
// which branch (source-lang vs English) buildTnQuickRequest takes.
function chapterWith(sourceKey, sourceText) {
  const vo = (text) => ({ content: { verseObjects: [{ type: "text", text }] }, verse: 2 });
  return {
    verses: {
      ULT: { 2: { ...vo("Do you see these great buildings?"), plain_text: "Do you see these great buildings?" } },
      UST: { 2: { ...vo("Do you see these huge buildings?"), plain_text: "Do you see these huge buildings?" } },
      [sourceKey]: { 2: { ...vo(sourceText), plain_text: sourceText } },
    },
  };
}

const baseRow = {
  book: "MRK",
  chapter: 13,
  verse: 2,
  support_reference: "rc://*/ta/man/translate/figs-activepassive",
  occurrence: 1,
};

test("Greek NT quote builds a request instead of aborting hebrew_not_found (#324)", () => {
  const data = chapterWith("UGNT", "βλέπεις ταύτας τὰς μεγάλας οἰκοδομάς");
  const res = buildTnQuickRequest({ ...baseRow, quote: GREEK_QUOTE }, data);
  assert.equal(res.ok, true, "Greek quote should take the source-language regenerate path, not fail");
  // hebrewGuess carries the source quote intact (name kept for the bot contract).
  assert.ok(res.request.hebrewGuess.includes("βλέπεις"), "source Greek quote preserved in hebrewGuess");
});

test("Hebrew OT quote still builds a request (unchanged)", () => {
  const data = chapterWith("UHB", "שֹׁכֵב֙ עִם אִשָּׁה");
  const res = buildTnQuickRequest({ ...baseRow, book: "DEU", quote: HEBREW_QUOTE }, data);
  assert.equal(res.ok, true);
  assert.ok(res.request.hebrewGuess.includes("שֹׁכֵב֙"), "source Hebrew quote preserved in hebrewGuess");
});

test("English phrase that doesn't align still fails fast (unchanged English path)", () => {
  const data = chapterWith("UGNT", "βλέπεις ταύτας τὰς μεγάλας οἰκοδομάς");
  // Plain English with no matching aligned target word -> derived source is empty.
  const res = buildTnQuickRequest({ ...baseRow, quote: "totally unrelated words" }, data);
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, "hebrew_not_found");
});
