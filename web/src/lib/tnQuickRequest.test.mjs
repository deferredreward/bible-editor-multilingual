import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isOriginalLanguageQuote, buildTnQuickRequest } from "./tnQuickRequest.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readWeb = (rel) => readFileSync(path.join(webRoot, rel), "utf8");

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
    // #346: the source-language path reports its OWN reason, so call sites can
    // render script-appropriate copy instead of "copy the English phrase".
    assert.equal(result.error.reason, "source_quote_not_found");
  }
});

test("mixed English+Greek quote fails loudly even against an ALIGNED verse (#346)", () => {
  // The #332 fixture has no milestones, so it can't distinguish "the quote
  // didn't resolve" from "the verse has no alignment at all". Here the ULT verse
  // IS aligned (and the UGNT source verse is present), so the quote goes through
  // both the OL-anchored join and the GL set-match degradation — and still
  // resolves to nothing, because none of "the"/"word"/"λόγος" is a milestone's
  // source content.
  const row = makeRow({ quote: "the word λόγος" });
  const result = buildTnQuickRequest(row, makeAlignedGreekPayload());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.reason, "source_quote_not_found");
  }
});

test("an original-language quote and an English phrase fail with DIFFERENT reasons (#346)", () => {
  // The whole point of the split: one shared reason is what let Shell and
  // ReviewQueue show English-only advice for a Hebrew/Greek quote.
  const olResult = buildTnQuickRequest(makeRow({ quote: "λόγος" }), makeChapterPayload());
  const enResult = buildTnQuickRequest(
    makeRow({ quote: "some unrelated english phrase" }),
    makeChapterPayload(),
  );
  assert.equal(olResult.ok, false);
  assert.equal(enResult.ok, false);
  if (!olResult.ok && !enResult.ok) {
    assert.equal(olResult.error.reason, "source_quote_not_found");
    assert.equal(enResult.error.reason, "hebrew_not_found");
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

// A note whose ref_raw bridges verses (e.g. "13:26-27") must feed the AI the
// scripture of EVERY covered verse, not just its leading verse — otherwise a
// redraft sees less context than the translator does (issue #388). The leading
// verse (26) carries the alignment the quote resolves against; the trailing
// verse (27) contributes only its scripture text to `ult.verse`/`ust.verse`.
function makeBridgedGreekPayload() {
  const at = (chapter, verse) => ({ book: "MRK", chapter, verse });
  return {
    book: "MRK",
    chapter: 13,
    verses: {
      ULT: {
        26: verseVO([gms("ἐρχόμενον", ["coming", "in", "clouds"])], "coming in clouds", at(13, 26)),
        27: verse("and he will gather his chosen ones", at(13, 27)),
      },
      UST: {
        26: verse("They will see me arriving", at(13, 26)),
        27: verse("I will send angels to gather my people", at(13, 27)),
      },
      UGNT: {
        26: verseVO([gw("ἐρχόμενον"), gt(" ")], "ἐρχόμενον", at(13, 26)),
        27: verse("καὶ ἐπισυνάξει", at(13, 27)),
      },
    },
    tn: [],
    tq: [],
    twl: [],
    verseStatuses: [],
    verseLaneChecks: [],
  };
}

test("buildTnQuickRequest spans a bridged note's scripture across every covered verse (#388)", () => {
  const row = makeRow({ verse: 26, ref_raw: "13:26-27", quote: "ἐρχόμενον" });
  const result = buildTnQuickRequest(row, makeBridgedGreekPayload());
  assert.equal(result.ok, true);
  if (result.ok) {
    // ult.verse / ust.verse carry BOTH verses (space-joined, no \v marker), so
    // the AI reasons over the same scripture the translator sees. Before #388
    // these were the leading verse alone ("coming in clouds" / "They will see
    // me arriving") — this assertion is the red-before/green-after pin.
    assert.equal(result.request.ult.verse, "coming in clouds and he will gather his chosen ones");
    assert.equal(
      result.request.ust.verse,
      "They will see me arriving I will send angels to gather my people",
    );
    // The quote still resolves against the LEADING verse's alignment — spanning
    // widens the context text only, it does not change quote/selection anchoring.
    assert.equal(result.request.ult.selection, "coming in clouds");
    assert.equal(result.request.hebrewGuess, "ἐρχόμενον");
  }
});

test("buildTnQuickRequest leaves a single-verse note's scripture unchanged (#388 regression floor)", () => {
  // The covered-verse path must reduce to the leading verse exactly for the
  // common singleton — noteCoveredVerses returns [verse], so ult.verse is the
  // one verse's text, byte-identical to the old leading-verse lookup.
  const row = makeRow({ quote: "βλέπεις" });
  const result = buildTnQuickRequest(row, makeAlignedGreekPayload());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.request.ult.verse, "Do you see buildings");
  }
});

// A single USFM bridge row: `\v 26-27` is stored under verse_start 26 with
// verse_end 27, so buildVerseIndex maps BOTH keys 26 and 27 to the one DTO. This
// is distinct from makeBridgedGreekPayload, where 26 and 27 are two separate
// scripture rows — here the ULT/UST lane rows are themselves the bridge.
function makeUsfmBridgeLanePayload() {
  const at = (chapter, verse) => ({ book: "MRK", chapter, verse });
  const bridge = (verseObjects, plainText) => ({
    ...at(13, 26),
    verse_end: 27,
    bible_version: "test",
    plain_text: plainText,
    version: 1,
    updated_by: null,
    updated_at: 0,
    content: { verseObjects },
  });
  return {
    book: "MRK",
    chapter: 13,
    verses: {
      ULT: { 26: bridge([gms("ἐρχόμενον", ["coming", "in", "clouds"])], "coming in clouds and gathering") },
      // UST bridge carries no alignment, exercising the whole-verse selection fallback.
      UST: { 26: bridge([], "they will see and be gathered") },
      UGNT: { 26: verseVO([gw("ἐρχόμενον"), gt(" ")], "ἐρχόμενον", at(13, 26)) },
    },
    tn: [],
    tq: [],
    twl: [],
    verseStatuses: [],
    verseLaneChecks: [],
  };
}

test("buildTnQuickRequest does not double a USFM-bridge lane row's text (#388)", () => {
  const row = makeRow({ verse: 26, ref_raw: "13:26-27", quote: "ἐρχόμενον" });
  const result = buildTnQuickRequest(row, makeUsfmBridgeLanePayload());
  assert.equal(result.ok, true);
  if (result.ok) {
    // buildVerseIndex maps verses 26 AND 27 to the same bridge DTO, so a naive
    // per-verse join appended the whole verse text twice. Dedupe by DTO identity:
    // the text appears exactly once (before the fix this was "…gathering …
    // gathering").
    assert.equal(result.request.ult.verse, "coming in clouds and gathering");
    assert.equal(result.request.ust.verse, "they will see and be gathered");
  }
});

test("buildTnQuickRequest keeps the UST fallback selection on the leading verse of a bridged note (#388)", () => {
  const row = makeRow({ verse: 26, ref_raw: "13:26-27", quote: "ἐρχόμενον" });
  const result = buildTnQuickRequest(row, makeBridgedGreekPayload());
  assert.equal(result.ok, true);
  if (result.ok) {
    // ust.verse (the CONTEXT the AI reasons over) spans both verses…
    assert.equal(
      result.request.ust.verse,
      "They will see me arriving I will send angels to gather my people",
    );
    // …but the UST alignment misses, so the SELECTION falls back — and that
    // fallback must be the leading verse alone, not the whole joined range. The
    // quote's occurrence is counted per verse against the leading verse (26), so
    // widening the selection to verse 27's text is a scope error. Before the fix
    // this was the full "…arriving I will send angels to gather my people".
    assert.equal(result.request.ust.selection, "They will see me arriving");
  }
});

// ---------------------------------------------------------------------------
// Copy contract (#346). A unit test can't render the components, but the defect
// this fixes was purely "a call site forgot that the OL path needs its own
// message". These guards catch exactly that: every component that consumes
// buildTnQuickRequest must branch on the OL reason, and the strings it reaches
// for must not carry the English-only advice.
// ---------------------------------------------------------------------------

// The call sites are DISCOVERED, not listed: a hardcoded list can't catch the
// regression this test exists for — someone adding a fourth consumer and
// forgetting the OL branch. KNOWN_CALL_SITES is only a floor, so a broken walk
// (wrong root, changed layout) fails loudly instead of vacuously finding none.
const KNOWN_CALL_SITES = [
  "src/components/Shell.tsx",
  "src/components/ReviewQueue.tsx",
  "src/components/flows/TranslateNotesScreen.tsx",
];

// Strip LINE comments before the reason check: otherwise a rewrite that deletes
// the ternary arm but leaves its explanatory comment behind would still
// "contain" the reason and pass. Same trick adminSurfaceMap.test.mjs uses.
//
// Deliberately NOT stripping /* */ blocks. Tried it, and the naive regex
// `/\/\*[\s\S]*?\*\//` treats a `/*` inside a string or regex literal as a
// comment opener and swallowed 55KB of TranslateNotesScreen.tsx — including the
// call it was supposed to find. A line-comment pass is safe here (a `//` inside
// a URL only eats the rest of that line), and discovery below reads the RAW
// source so no stripping can hide a call site.
const stripLineComments = (src) => src.replace(/\/\/[^\n]*/g, "");

function findCallSites(dir = "src") {
  const out = [];
  for (const entry of readdirSync(path.join(webRoot, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...findCallSites(rel));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      if (readWeb(rel).includes("buildTnQuickRequest(")) out.push(rel);
    }
  }
  return out;
}

test("every buildTnQuickRequest call site handles source_quote_not_found (#346)", () => {
  // The definition and its own tests call it too; only consumers must branch.
  const sites = findCallSites().filter((rel) => !rel.startsWith("src/lib/tnQuickRequest"));
  for (const known of KNOWN_CALL_SITES) {
    assert.ok(
      sites.includes(known),
      `${known} no longer calls buildTnQuickRequest (or the walk missed it). If the file moved ` +
        `legitimately, update KNOWN_CALL_SITES; otherwise the discovery walk is broken.`,
    );
  }
  for (const rel of sites) {
    assert.ok(
      stripLineComments(readWeb(rel)).includes("source_quote_not_found"),
      `${rel} calls buildTnQuickRequest but never branches on "source_quote_not_found", so an ` +
        `original-language quote that fails to align falls through to English-specific advice ` +
        `(or the generic "prerequisites missing"). See #346.`,
    );
  }
});

test("the OL-failure strings name both scripts and give no English-only advice (#346)", () => {
  const en = JSON.parse(readWeb("src/i18n/locales/en.json"));
  const ar = JSON.parse(readWeb("src/i18n/locales/ar.json"));
  const keys = [
    ["appShell", "shell", "aiSourceQuoteNotFound"],
    ["flowReview", "queue", "sourceQuoteNotAligned"],
    // #360: the flows notes screen (the demo surface) split its combined
    // unalignable-quote branch and owes the same OL-path contract.
    ["flowTranslate", "sourceQuoteNotAligned"],
  ];
  const at = (obj, keyPath) => keyPath.reduce((o, k) => (o == null ? o : o[k]), obj);

  for (const keyPath of keys) {
    const value = at(en, keyPath);
    assert.equal(
      typeof value,
      "string",
      `en.json is missing ${keyPath.join(".")} — the OL-quote failure needs its own copy (#346).`,
    );
    // Names both original languages, the way #332 fixed aiDraft.noHebrew.
    assert.match(value, /Hebrew/, `${keyPath.join(".")} should name Hebrew`);
    assert.match(value, /Greek/, `${keyPath.join(".")} should name Greek`);
    // The whole defect: telling a translator to copy an English support phrase
    // when the quote they have is Hebrew or Greek.
    assert.doesNotMatch(
      value,
      /support phrase/i,
      `${keyPath.join(".")} still gives the English-path advice (#346)`,
    );
    // ar is the one GATED locale (web/src/i18n/coverage.json), so it owes a
    // real translation, not a fallback to en.
    const arValue = at(ar, keyPath);
    assert.equal(
      typeof arValue,
      "string",
      `ar.json is missing ${keyPath.join(".")} — ar is gated in coverage.json, so CI will fail.`,
    );
    assert.notEqual(arValue, value, `${keyPath.join(".")} in ar.json is still the English string`);
    // The anti-advice check has to run on ar too, or the defect can be
    // reintroduced in translation while en stays clean. "عبارة الدعم" is the
    // phrase the English-path ar strings use for "the support phrase".
    assert.doesNotMatch(
      arValue,
      /عبارة الدعم/,
      `${keyPath.join(".")} in ar.json gives the English-path advice ("copy the support phrase") ` +
        `for a Hebrew/Greek quote (#346)`,
    );
    // Both languages must keep the same interpolation contract.
    assert.deepEqual(
      arValue.match(/{{\w+}}/g),
      value.match(/{{\w+}}/g),
      `${keyPath.join(".")} placeholders differ between en.json and ar.json`,
    );
  }
});
