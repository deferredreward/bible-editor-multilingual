// Tests for correctSourceOccurrences (the data-side fix for AI-doubled source
// occurrence numbers). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/sourceOccurrences.test.mjs
// Not a framework; failures exit non-zero. Mirrors alignment.test.mjs.

import { correctSourceOccurrences } from "./sourceOccurrences.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const zaln = (content, occurrence, occurrences, childWord) => ({
  tag: "zaln",
  type: "milestone",
  strong: "H0000",
  occurrence: String(occurrence),
  occurrences: String(occurrences),
  content,
  children: [{ text: childWord, tag: "w", type: "word", occurrence: "1", occurrences: "1" }],
  endTag: "zaln-e\\*",
});
const srcWord = (text) => ({ text, tag: "w", type: "word", strong: "H0000", occurrence: "1", occurrences: "1" });

// ─── Case 1: over-counted token (JER 28:1 חֲנַנְיָה pattern) ─────────────────
{
  console.log("\n[Case 1] over-counted source token (appears once, stamped occurrences=2)");
  // Source verse: חֲנַנְיָה appears ONCE.
  const source = [srcWord("חֲנַנְיָה")];
  // Target: two milestones referencing it as occ 1/2 and 2/2 (two English runs).
  const target = [
    zaln("חֲנַנְיָה", 1, 2, "Hananiah"),
    { text: " ", type: "text" },
    zaln("חֲנַנְיָה", 2, 2, "Hananiah"),
  ];
  const { changed, verseObjects, corrections } = correctSourceOccurrences(target, source);
  assert(changed === true, "reports changed");
  assert(corrections.length === 2, `two corrections (got ${corrections.length})`);
  const ms = verseObjects.filter((n) => n.tag === "zaln");
  assert(ms.every((m) => m.occurrences === "1"), "both milestones now occurrences=1");
  assert(ms.every((m) => m.occurrence === "1"), "both milestones now occurrence=1 (clamped)");
  // Input is not mutated (deep clone).
  assert(target[0].occurrences === "2", "input tree left unmutated");
}

// ─── Case 2: clean token (occurrences matches source) ───────────────────────
{
  console.log("\n[Case 2] clean token — no change");
  const source = [srcWord("דָּבָר")];
  const target = [zaln("דָּבָר", 1, 1, "word")];
  const { changed, corrections } = correctSourceOccurrences(target, source);
  assert(changed === false, "no change for a correctly-numbered milestone");
  assert(corrections.length === 0, "no corrections emitted");
}

// ─── Case 3: genuine repeat (source has it twice) is left alone ─────────────
{
  console.log("\n[Case 3] genuine repeat — source token appears twice, NOT touched");
  const source = [srcWord("אֱלֹהִים"), srcWord("אֱלֹהִים")];
  const target = [zaln("אֱלֹהִים", 1, 2, "God"), zaln("אֱלֹהִים", 2, 2, "God")];
  const { changed } = correctSourceOccurrences(target, source);
  assert(changed === false, "occurrences=2 matching a twice-occurring source is untouched");
}

// ─── Case 4: under-count is NOT over-corrected (surgical scope) ─────────────
{
  console.log("\n[Case 4] under-count left alone (only appears-once is fixed)");
  const source = [srcWord("מֶלֶךְ"), srcWord("מֶלֶךְ")];
  // Milestone claims occurrences=1 though the source has 2 — not the doubled-card
  // defect, so we deliberately don't touch it.
  const target = [zaln("מֶלֶךְ", 1, 1, "king")];
  const { changed } = correctSourceOccurrences(target, source);
  assert(changed === false, "under-counted occurrences is left untouched");
}

// ─── Case 4b: ambiguous over-count (source appears 2×) is LEFT ALONE ─────────
{
  console.log("\n[Case 4b] ambiguous over-count (source twice, claimed 4×) left alone");
  // וְאֶת appears TWICE in the source; the target over-references it as 1/4..4/4
  // (1CH genealogy pattern). Renumbering correctly needs real re-alignment, not a
  // clamp, so we do NOT touch it — the display merge handles same-position cases.
  const source = [srcWord("וְאֶת"), srcWord("וְאֶת")];
  const target = [
    zaln("וְאֶת", 1, 4, "and"),
    zaln("וְאֶת", 2, 4, "and"),
    zaln("וְאֶת", 3, 4, "and"),
    zaln("וְאֶת", 4, 4, "and"),
  ];
  const { changed } = correctSourceOccurrences(target, source);
  assert(changed === false, "trueTotal>1 over-count is left untouched (ambiguous)");
}

// ─── Case 5: content not present in source (drift) is left alone ────────────
{
  console.log("\n[Case 5] unmatched content (drift / not in source) — left alone");
  const source = [srcWord("שָׁלוֹם")];
  const target = [zaln("מִלָּהּ", 1, 2, "x"), zaln("מִלָּהּ", 2, 2, "y")];
  const { changed } = correctSourceOccurrences(target, source);
  assert(changed === false, "milestone content absent from source is not corrected");
}

// ─── Case 6: compound (nested) milestones are reached ───────────────────────
{
  console.log("\n[Case 6] nested (compound) milestones are corrected");
  const source = [srcWord("אָמַר"), srcWord("אֵלַי")];
  // אָמַר and אֵלַי each appear once; an outer/inner nested pair stamped 2/2.
  const inner = zaln("אֵלַי", 2, 2, "me");
  const outer = { ...zaln("אָמַר", 2, 2, "spoke"), children: [inner] };
  const { changed, corrections, verseObjects } = correctSourceOccurrences([outer], source);
  assert(changed === true, "nested milestones are walked and corrected");
  assert(corrections.length === 2, `both outer and inner corrected (got ${corrections.length})`);
  assert(verseObjects[0].occurrences === "1" && verseObjects[0].children[0].occurrences === "1", "outer and inner now occurrences=1");
}

// ─── Issue #413: `sourceTextTotals` was wrapper-blind (`type === "milestone" ||
//     \d`, no `\qs`), and its totals decide whether a token "appears exactly
//     once" — the verdict that REWRITES stored content_json. A `\qs`-wrapped
//     source word counted 0, so every over-counted milestone naming it was left
//     alone as "content not found in source": conservative, but the correction
//     the data needed silently never happened. The walk now gates on the shared
//     `isSourceWordContainer` (usfm.ts), the same predicate collectSourceWords /
//     collectSourceWordNodes descend by. Hebrew keys fold through nfc() on both
//     sides (sourceTextTotals keys nfc(text); the milestone lookup nfc's
//     x-content).
{
  console.log("\n[#413] a \\qs-wrapped source word counts toward the appears-once verdict");
  // Production Selah shape: the source word sits inside a `\qs` character
  // wrapper rather than at top level.
  const qsWrap = (...children) => ({ tag: "qs", type: "quote", endTag: "qs*", children });
  const wrappedSource = [srcWord("חֲנַנְיָה"), qsWrap(srcWord("סֶלָה"))];
  // The SAME two words with no wrapper — the control proving unwrapped content
  // is byte-identical either side of the fix.
  const plainSource = [srcWord("חֲנַנְיָה"), srcWord("סֶלָה")];

  // Two milestones over the wrapped token, stamped 1/2 and 2/2 — the JER 28:1
  // AI-doubling pattern, but on a word the old walk could not see.
  const target = () => [
    zaln("סֶלָה", 1, 2, "Selah"),
    { text: " ", type: "text" },
    zaln("סֶלָה", 2, 2, "Selah"),
  ];

  const wrapped = correctSourceOccurrences(target(), wrappedSource);
  assert(wrapped.changed === true, "the wrapped token is counted, so its over-counted milestones are corrected");
  assert(wrapped.corrections.length === 2, `both milestones corrected (got ${wrapped.corrections.length})`);
  assert(
    wrapped.verseObjects[0].occurrence === "1" && wrapped.verseObjects[0].occurrences === "1" &&
      wrapped.verseObjects[2].occurrence === "1" && wrapped.verseObjects[2].occurrences === "1",
    "both milestones renumbered to 1/1",
  );

  const plain = correctSourceOccurrences(target(), plainSource);
  assert(
    JSON.stringify(plain) === JSON.stringify(wrapped),
    "unwrapped control produces a byte-identical result — the wrapper only changes whether the word is FOUND",
  );

  // The conservative guards still hold with a wrapper in play: a token that
  // genuinely appears TWICE (once wrapped, once bare) is ambiguous and must be
  // left alone rather than clamped to 1/1.
  const twiceSource = [srcWord("סֶלָה"), qsWrap(srcWord("סֶלָה"))];
  const twice = correctSourceOccurrences(target(), twiceSource);
  assert(twice.changed === false, "a token appearing twice (one wrapped) is left alone — never clamped");
  assert(
    JSON.stringify(twice.verseObjects) === JSON.stringify(target()),
    "the untouched tree round-trips byte-identically",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll sourceOccurrences tests passed.");
