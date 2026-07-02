// Smoke test for classifyReimportRow — the reorder-preservation invariant in
// the DCS→D1 reimport. Run from api/:
//   node --experimental-strip-types --no-warnings src/reimportClassify.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors sortOrder.test.mjs.
//
// Regression: a TN/TWL reorder writes only sort_order (no version/updated_by
// bump), so the row stays pristine. The reimport used to treat "content matches
// but sort_order differs" as a pristine change and overwrite sort_order back to
// master file order — reverting the user's reorder (HOS 11 TN / HOS 12 TWL,
// reported by Beth Oakes). A content-identical tn/twl row that owns its order
// must be a no-op so its local order survives and the next export pushes it to
// master. But the preservation is SCOPED: tq (no in-app reorder) and NULL-sort
// rows must still adopt master file order.

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

// args: (contentMatches, sortMatches, pristine, preserveLocalOrder)
console.log("\n[classifyReimportRow]");

// Steady state: content AND order match → no-op (both pristine and edited).
eq(classifyReimportRow(true, true, true, true), "noop", "content+sort match → noop");
eq(classifyReimportRow(true, true, false, false), "noop", "content+sort match (edited) → noop");

// THE FIX: content matches, sort differs, row owns its order (tn/twl, non-null)
// → no-op, preserving the local reorder instead of reverting to file order.
eq(
  classifyReimportRow(true, false, true, true),
  "noop",
  "tn/twl reorder (content match, sort differs, preserve) → noop (preserve)",
);

// SCOPING (Codex P2): content matches, sort differs, but master owns the order
// (tq, or a NULL sort_order) → adopt master file order when pristine…
eq(
  classifyReimportRow(true, false, true, false),
  "update",
  "tq / null-sort (content match, sort differs, no preserve) → update (adopt master order)",
);
// …and never clobber a human-edited row even to adopt order.
eq(
  classifyReimportRow(true, false, false, false),
  "edited",
  "edited row, sort differs, no preserve → skip (never clobber)",
);

// Content drifted from master.
eq(classifyReimportRow(false, false, true, false), "update", "content differs + pristine → update");
eq(classifyReimportRow(false, false, false, false), "edited", "content differs + edited → skip");
// A content change on a would-be-preserve row still updates (preserve only
// covers order, not content).
eq(classifyReimportRow(false, false, true, true), "update", "content differs + pristine + preserve → update");

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll reimportClassify assertions passed.");
