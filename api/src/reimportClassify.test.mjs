// Smoke test for classifyReimportRow — the reorder-preservation invariant in
// the DCS→D1 reimport. Run from api/:
//   node --experimental-strip-types --no-warnings src/reimportClassify.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors sortOrder.test.mjs.
//
// Regression: a TWL/TN reorder writes only sort_order (no version/updated_by
// bump), so the row stays pristine. The reimport used to treat "content matches
// but sort_order differs" as a pristine change and overwrite sort_order back to
// master file order — reverting the user's reorder (HOS 11 TN / HOS 12 TWL,
// reported by Beth Oakes). A content-identical row must now be a no-op so its
// local order survives and the next export pushes it to master.

import { classifyReimportRow } from "./reimportClassify.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n    expected ${expected}\n    got      ${actual}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

console.log("\n[classifyReimportRow]");

// THE FIX: content identical → no-op, so the row's local sort_order is
// preserved. This must hold whether or not the row is pristine — a reorder
// leaves it pristine, but a content-identical human-edited row must also keep
// its order (we never clobber order on a content match).
eq(classifyReimportRow(true, true), "noop", "content matches + pristine → noop (preserve reorder)");
eq(classifyReimportRow(true, false), "noop", "content matches + edited → noop (preserve order)");

// Content drifted from master.
eq(classifyReimportRow(false, true), "update", "content differs + pristine → update from master");
eq(classifyReimportRow(false, false), "edited", "content differs + edited → skip (never clobber human edit)");

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll reimportClassify assertions passed.");
