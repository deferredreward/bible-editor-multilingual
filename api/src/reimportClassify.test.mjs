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

import { classifyReimportRow, isReimportableRow, AI_SOURCE } from "./reimportClassify.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n    expected ${expected}\n    got      ${actual}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// args: (contentMatches, sortMatches, reimportable, preserveLocalOrder, aiOnly)
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

// AI-only rows (reimportable + aiOnly): content drift re-seeds via update_ai
// (distinct from a pristine update so the caller uses the reclaim guard/counter).
eq(
  classifyReimportRow(false, false, true, false, true),
  "update_ai",
  "content differs + AI-only → update_ai (re-seed + reclaim)",
);
// AI-only, sort differs, master owns order → update_ai (adopt master order).
eq(
  classifyReimportRow(true, false, true, false, true),
  "update_ai",
  "AI-only, content match, sort differs, no preserve → update_ai",
);
// AI-only content-identical + sort match → still just a no-op.
eq(classifyReimportRow(true, true, true, false, true), "noop", "AI-only, content+sort match → noop");
// AI-only tn/twl reorder (content match, sort differs, preserve) → no-op; the
// preserve branch wins before the aiOnly re-seed (documented: self-heals later).
eq(
  classifyReimportRow(true, false, true, true, true),
  "noop",
  "AI-only tn/twl reorder (content match, sort differs, preserve) → noop",
);

console.log("\n[isReimportableRow]");

// Pristine (updated_by NULL) is always re-importable regardless of latestSource.
eq(
  isReimportableRow({ updated_by: null, latestSource: null, deleted_at: null, kind: "tn" }),
  true,
  "pristine tn (updated_by null) → reimportable",
);
// AI-only: updated_by set, latest content edit_log source is the AI pipeline.
eq(
  isReimportableRow({ updated_by: 7, latestSource: AI_SOURCE, deleted_at: null, kind: "tn" }),
  true,
  "AI-only tn (updated_by set, latest source ai_pipeline) → reimportable",
);
eq(
  isReimportableRow({ updated_by: 7, latestSource: AI_SOURCE, deleted_at: null, kind: "verse" }),
  true,
  "AI-only verse → reimportable",
);
// Human-edited: updated_by set, latest source null/manual → NOT re-importable.
eq(
  isReimportableRow({ updated_by: 7, latestSource: null, deleted_at: null, kind: "tn" }),
  false,
  "human-edited tn (latest source null) → NOT reimportable (skip)",
);
eq(
  isReimportableRow({ updated_by: 7, latestSource: "dcs_reimport", deleted_at: null, kind: "twl" }),
  false,
  "twl whose latest source is a non-AI source → NOT reimportable",
);
// AI row later human-edited: the human PATCH writes a null-source edit_log entry,
// so latestSource is no longer ai_pipeline → NOT re-importable.
eq(
  isReimportableRow({ updated_by: 7, latestSource: null, deleted_at: null, kind: "verse" }),
  false,
  "AI row later human-edited (latest source null) → NOT reimportable (skip)",
);
// Human-owned protections still block an otherwise-AI-only row.
eq(
  isReimportableRow({ updated_by: 7, latestSource: AI_SOURCE, deleted_at: 123, kind: "tq" }),
  false,
  "tombstone (deleted_at set) → NOT reimportable even if AI-only",
);
eq(
  isReimportableRow({ updated_by: 7, latestSource: AI_SOURCE, deleted_at: null, trashed_at: 123, kind: "tn" }),
  false,
  "trashed tn → NOT reimportable even if AI-only",
);
eq(
  isReimportableRow({ updated_by: 7, latestSource: AI_SOURCE, deleted_at: null, preserve: 1, kind: "tn" }),
  false,
  "preserve=1 tn → NOT reimportable even if AI-only",
);
eq(
  isReimportableRow({ updated_by: 7, latestSource: AI_SOURCE, deleted_at: null, hint: 1, kind: "tn" }),
  false,
  "hint=1 tn → NOT reimportable even if AI-only",
);
// Those tn-only protections are ignored for non-tn kinds (defensive: a caller
// passing them for a tq/twl/verse row must not accidentally block it).
eq(
  isReimportableRow({ updated_by: 7, latestSource: AI_SOURCE, deleted_at: null, preserve: 1, hint: 1, kind: "tq" }),
  true,
  "tq ignores preserve/hint → AI-only tq still reimportable",
);
// A pristine tombstone is not reimportable here (resurrection is a separate path).
eq(
  isReimportableRow({ updated_by: null, latestSource: null, deleted_at: 123, kind: "twl" }),
  false,
  "pristine tombstone → NOT reimportable (resurrection handled elsewhere)",
);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll reimportClassify assertions passed.");
