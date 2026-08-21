// Smoke test for shouldRecordResourceSync — the reimport-sync watermark gate.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/reimportSyncGate.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors reimportClassify.test.mjs.
//
// Regression under test (issue #427, option 2): the nightly reimport could
// DROP a master row entirely — a reissued tombstone holding its (book, id)
// slot, or an INSERT refused by ON CONFLICT — and still stamp the
// (book, resource) sync watermark, certifying the resource "in sync at
// master's SHA" while it was short of master. The nightly export's freshness
// gate trusts that watermark, so the stale D1 got rendered as current (the
// 1CH 23 tQ incident upstream). shouldRecordResourceSync is the pure decision
// the reimport-sync step (bookReimport.ts) now gates on: withhold the stamp
// iff this run's counts show a dropped master row for that resource. A
// watermark must not certify data it didn't apply.

import { shouldRecordResourceSync } from "./reimportSyncGate.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n    expected ${expected}\n    got      ${actual}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Fork ReimportCounts shape (bookReimport.ts zeroCounts), with overrides.
function counts(overrides = {}) {
  return {
    updated: 0,
    reimported_ai: 0,
    inserted: 0,
    deleted: 0,
    skipped_edited: 0,
    skipped_locked: 0,
    skipped_noop: 0,
    skipped_dup: 0,
    conflict_skipped: 0,
    tombstone_blocked: 0,
    tombstone_reclaimed: 0,
    resurrected: 0,
    source_attr_reconciled: 0,
    source_attr_divergent: 0,
    twl_reordered: 0,
    dcs_404: 0,
    errors: [],
    counts_incomplete: false,
    ...overrides,
  };
}

console.log("\n[healthy runs stamp]");
eq(shouldRecordResourceSync(counts()), true, "all-zero counts → stamp the watermark");
eq(
  shouldRecordResourceSync(counts({ updated: 12, inserted: 3, skipped_edited: 40, skipped_noop: 900 })),
  true,
  "ordinary activity (updates/inserts/skips) → stamp — none of those are drops",
);
eq(
  shouldRecordResourceSync(counts({ skipped_locked: 4 })),
  true,
  "skipped_locked alone does NOT withhold — it is overloaded (also fed by the prune path) and the file re-runs next night anyway (no watermark advance happens for a dropped-row run only)",
);
eq(
  shouldRecordResourceSync(counts({ resurrected: 2, skipped_dup: 5, dcs_404: 1 })),
  true,
  "resurrections / dup-skips / 404 tallies → stamp — they are handled outcomes, not drops",
);

console.log("\n[issue #427, option 2: tombstone-blocked / PK-conflict drops withhold]");
// THE 1CH 23 tQ SHAPE (upstream). Six tQ rows whose ids were held by
// tombstones from 1CH 5 never landed, and the watermark was stamped anyway.
eq(
  shouldRecordResourceSync(counts({ tombstone_blocked: 6 })),
  false,
  "tombstone_blocked > 0 (the 1CH 23 tQ shape) → withhold the watermark",
);
eq(
  shouldRecordResourceSync(counts({ conflict_skipped: 1 })),
  false,
  "conflict_skipped > 0 (an insert refused by ON CONFLICT) → withhold",
);
eq(
  shouldRecordResourceSync(counts({ conflict_skipped: 2, tombstone_blocked: 3 })),
  false,
  "both drop counters firing → withhold",
);

console.log("\n[fail-safe on absent measurements — never zero-and-stamp]");
eq(
  shouldRecordResourceSync({}),
  false,
  "legacy counts object missing conflict_skipped/tombstone_blocked → withhold (fail-safe, not zero-and-stamp)",
);
eq(
  shouldRecordResourceSync({ conflict_skipped: 0 }),
  false,
  "counts object missing tombstone_blocked only → withhold (fail-safe)",
);
eq(
  shouldRecordResourceSync({ tombstone_blocked: 0 }),
  false,
  "counts object missing conflict_skipped only → withhold (fail-safe)",
);
eq(
  shouldRecordResourceSync({ conflict_skipped: 0, tombstone_blocked: 0 }),
  true,
  "both fields present and zero (no taint) → stamp — presence, not truthiness, is the test",
);
eq(
  shouldRecordResourceSync(counts({ counts_incomplete: true })),
  false,
  "counts_incomplete taint (a folded-in chunk was missing these fields, or a write's row count was unreported) → withhold even though the aggregate's own fields read zero",
);

console.log("\n[issue #427, option 1: a LANDED reclaim does not gate]");
// tombstone_reclaimed — a landed reclaim means master's content IS now in D1,
// so it must NOT withhold on its own; only the lost-CAS fallback (which still
// counts tombstone_blocked, exercised above) does. This is a shape test: the
// gate's decision must be identical whether or not tombstone_reclaimed is
// present, and a nonzero tombstone_reclaimed alongside a clean tombstone_blocked
// still stamps.
eq(
  shouldRecordResourceSync(counts({ tombstone_reclaimed: 5, tombstone_blocked: 0 })),
  true,
  "tombstone_reclaimed > 0 with a clean tombstone_blocked → stamp (the reclaim landed master's content)",
);
eq(
  shouldRecordResourceSync(counts({ tombstone_reclaimed: 5, tombstone_blocked: 1 })),
  false,
  "…but a lost-CAS fallback alongside landed reclaims still withholds",
);
{
  const withField = counts({ tombstone_reclaimed: 0 });
  const withoutField = counts();
  delete withoutField.tombstone_reclaimed;
  eq(
    shouldRecordResourceSync(withField),
    shouldRecordResourceSync(withoutField),
    "decision is identical whether or not tombstone_reclaimed is present — the field never enters the gate",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll reimportSyncGate assertions passed.");
