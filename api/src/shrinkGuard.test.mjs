// Unit tests for shrinkGuard.ts — the truncated-fetch completeness policy.
// The regression the HAB tn incident demands: a single-row (or near-empty)
// incoming TSV must never be allowed to prune an existing multi-row book.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/shrinkGuard.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import {
  isCatastrophicTsvShrink,
  SHRINK_GUARD_MIN_LIVE,
  SHRINK_GUARD_RATIO,
} from "./shrinkGuard.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// --- The HAB incident itself: 252 live, a 1-row truncated body ---
assert(
  isCatastrophicTsvShrink(252, 1),
  "HAB tn: 1-row body vs 252 live → catastrophic (would have blocked the prune)",
);
assert(
  isCatastrophicTsvShrink(252, 0),
  "0-row body vs 252 live → also flagged (defense in depth; softDelete also bails on 0)",
);

// --- A genuine large book that barely changed must NOT trip the guard ---
assert(
  !isCatastrophicTsvShrink(252, 252),
  "no change (252 vs 252) → not a shrink",
);
assert(
  !isCatastrophicTsvShrink(252, 250),
  "tiny edit (250 vs 252) → not a shrink",
);
assert(
  !isCatastrophicTsvShrink(252, 200),
  "moderate trim (200 vs 252, ~79%) → not catastrophic, applies normally",
);

// --- The 50% boundary ---
assert(
  !isCatastrophicTsvShrink(100, 50),
  "exactly 50% (50 vs 100) → not flagged (strictly-less-than ratio)",
);
assert(
  isCatastrophicTsvShrink(100, 49),
  "just under 50% (49 vs 100) → flagged",
);
assert(
  isCatastrophicTsvShrink(100, 40),
  "40 vs 100 → flagged",
);

// --- Small books are exempt: the guard only protects sizeable books, so a
//     legitimate big proportional swing on a tiny book never false-positives ---
assert(
  !isCatastrophicTsvShrink(SHRINK_GUARD_MIN_LIVE - 1, 1),
  `below MIN_LIVE (${SHRINK_GUARD_MIN_LIVE - 1} live) → exempt even with a 1-row body`,
);
assert(
  !isCatastrophicTsvShrink(5, 2),
  "tiny book (2 vs 5) → exempt (no guard for books with <MIN_LIVE rows)",
);
assert(
  isCatastrophicTsvShrink(SHRINK_GUARD_MIN_LIVE, 1),
  `at MIN_LIVE (${SHRINK_GUARD_MIN_LIVE} live) → guard engages; 1-row body flagged`,
);

// --- A growing book is never a shrink ---
assert(
  !isCatastrophicTsvShrink(100, 300),
  "book grew (300 vs 100) → not a shrink",
);

// Sanity: the policy constants are the documented values.
assert(SHRINK_GUARD_MIN_LIVE === 20, "MIN_LIVE is 20");
assert(SHRINK_GUARD_RATIO === 0.5, "RATIO is 0.5");

console.log("shrinkGuard: all assertions passed");
