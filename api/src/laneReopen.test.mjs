// Smoke test for lanesToReopenOnVerseEdit — the pure decision behind which
// verse_lane_checks lanes a content save reopens. Run from api/:
//   node --experimental-strip-types --no-warnings src/laneReopen.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors sortOrder.test.mjs.
//
// Regression: a tiny ULT edit (a comma after "Gilgal", a moved `{…}` brace)
// used to reopen the 'tw' (Words) lane and clear the Board checkoff even though
// no word changed. It must now reopen only 'text' for such edits (HOS 12:11 /
// HOS 8 report from Beth Oakes).

import { lanesToReopenOnVerseEdit } from "./laneReopen.ts";

let failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${msg}\n    expected ${e}\n    got      ${a}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

console.log("\n[lanesToReopenOnVerseEdit]");

// ULT punctuation-only edit (comma / brace / whitespace): word sequence
// unchanged → Words stays checked, only Text reopens.
eq(
  lanesToReopenOnVerseEdit("ULT", true),
  ["text"],
  "ULT comma/brace edit (wordSequenceUnchanged) reopens only 'text'",
);

// ULT real word edit: a word changed → Words reopens too ("trickles down").
eq(
  lanesToReopenOnVerseEdit("ULT", false),
  ["text", "tw"],
  "ULT word edit (wordSequence changed) reopens 'text' and 'tw'",
);

// UST edits never touch the Words lane, regardless of word changes.
eq(
  lanesToReopenOnVerseEdit("UST", false),
  ["text"],
  "UST word edit reopens only 'text'",
);
eq(
  lanesToReopenOnVerseEdit("UST", true),
  ["text"],
  "UST punctuation edit reopens only 'text'",
);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll laneReopen assertions passed.");
