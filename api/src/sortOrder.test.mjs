// Smoke test for placeSortOrder — the pure placement math behind
// midpointSortOrder (reimport sort_order assignment for DCS-new rows).
// Run from api/:
//   node --experimental-strip-types --no-warnings src/sortOrder.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors export.test.mjs.

import { placeSortOrder } from "./sortOrder.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ─── The four placement branches ─────────────────────────────────────────
{
  console.log("\n[placeSortOrder] branches");
  assert(placeSortOrder(100, 200) === 150, "between two placed rows → midpoint");
  assert(placeSortOrder(100, null) === 200, "append after the last placed row → +100");
  assert(placeSortOrder(null, 200) === 199, "new head before the first row → -1");
  assert(placeSortOrder(null, null) === 100, "whole verse group is new → seed at 100");
}

// ─── A RUN of consecutive new rows stays in file order ────────────────────
// This is the regression: midpointSortOrder writes each row's sort_order
// before computing the next, so the next row's `before` is the one we just
// placed. Simulate that chaining and assert the run is strictly increasing
// and bracketed correctly (NOT all NULL / all the same value).
function simulateRun(before, after, count) {
  const out = [];
  let lo = before;
  for (let i = 0; i < count; i++) {
    const so = placeSortOrder(lo, after);
    out.push(so);
    lo = so; // the row we just placed becomes the next row's left anchor
  }
  return out;
}

function strictlyIncreasing(xs) {
  return xs.every((x, i) => i === 0 || xs[i - 1] < x);
}

{
  console.log("\n[run] two new rows BETWEEN existing 100 and 200");
  const r = simulateRun(100, 200, 2);
  assert(JSON.stringify(r) === JSON.stringify([150, 175]), `→ [150, 175] (got ${JSON.stringify(r)})`);
  assert(100 < r[0] && r[r.length - 1] < 200, "stays strictly inside (100, 200)");
  assert(strictlyIncreasing(r), "file order preserved");
}

{
  console.log("\n[run] three new rows APPENDED after existing 100 (none follow)");
  const r = simulateRun(100, null, 3);
  assert(JSON.stringify(r) === JSON.stringify([200, 300, 400]), `→ [200, 300, 400] (got ${JSON.stringify(r)})`);
  assert(r[0] > 100 && strictlyIncreasing(r), "all after 100, in file order (not NULL/by-id)");
}

{
  console.log("\n[run] two new HEAD rows before existing 200 (none precede)");
  const r = simulateRun(null, 200, 2);
  assert(JSON.stringify(r) === JSON.stringify([199, 199.5]), `→ [199, 199.5] (got ${JSON.stringify(r)})`);
  assert(r[r.length - 1] < 200 && strictlyIncreasing(r), "all before 200, in file order");
}

{
  console.log("\n[run] an entirely new verse group (nothing placed)");
  const r = simulateRun(null, null, 3);
  assert(JSON.stringify(r) === JSON.stringify([100, 200, 300]), `→ [100, 200, 300] (got ${JSON.stringify(r)})`);
  assert(strictlyIncreasing(r), "seeded sequentially in file order");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll placeSortOrder tests passed.");
