// Tests for layoutBands.ts — pure responsive-layout-band logic. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/layoutBands.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors src/lib/layoutTree.test.mjs.

import { BAND_PX, bandForWidth, maxVisibleRegions, resolveBandHidden } from "./layoutBands.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function eqArr(actual, expected, msg) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (got ${JSON.stringify(actual)})`);
}

console.log("\n[bandForWidth] boundaries");
{
  assert(BAND_PX.tablet === 560 && BAND_PX.desktop === 900, "BAND_PX pins the two thresholds");
  assert(bandForWidth(0) === "phone", "0 -> phone");
  assert(bandForWidth(559) === "phone", "559 -> phone");
  assert(bandForWidth(560) === "tablet", "560 -> tablet");
  assert(bandForWidth(899) === "tablet", "899 -> tablet");
  assert(bandForWidth(900) === "desktop", "900 -> desktop");
  assert(bandForWidth(1400) === "desktop", "1400 -> desktop");
}

console.log("\n[maxVisibleRegions]");
{
  assert(maxVisibleRegions("phone") === 1, "phone caps at 1");
  assert(maxVisibleRegions("tablet") === 2, "tablet caps at 2");
  assert(maxVisibleRegions("desktop") === Infinity, "desktop has no cap");
}

console.log("\n[resolveBandHidden] desktop never hides anything");
{
  eqArr(resolveBandHidden(["a", "b", "c"], "desktop", "b"), [], "desktop -> []");
  eqArr(resolveBandHidden(["a", "b", "c"], "desktop", null), [], "desktop, no focus -> []");
}

console.log("\n[resolveBandHidden] fewer regions than the cap hides nothing");
{
  eqArr(resolveBandHidden(["a"], "tablet", null), [], "tablet, 1 region (cap 2) -> []");
  eqArr(resolveBandHidden(["a", "b"], "tablet", "a"), [], "tablet: exactly at the cap (2 regions) -> []");
  eqArr(resolveBandHidden(["a"], "phone", null), [], "phone: exactly at the cap (1 region) -> []");
  eqArr(resolveBandHidden([], "phone", null), [], "no regions at all -> []");
  eqArr(resolveBandHidden([], "tablet", "anything"), [], "no regions at all, tablet -> []");
}

console.log("\n[resolveBandHidden] phone keeps exactly the focused region");
{
  eqArr(resolveBandHidden(["a", "b", "c"], "phone", "b"), ["a", "c"], "phone keeps only the focused region 'b'");
  eqArr(resolveBandHidden(["a", "b", "c"], "phone", "c"), ["a", "b"], "phone keeps only the focused region 'c'");
}

console.log("\n[resolveBandHidden] phone with null focus keeps the first");
{
  eqArr(resolveBandHidden(["a", "b", "c"], "phone", null), ["b", "c"], "null focus -> keep 'a' (first in tree order)");
}

console.log("\n[resolveBandHidden] tablet keeps focused + following sibling");
{
  eqArr(resolveBandHidden(["a", "b", "c", "d"], "tablet", "b"), ["a", "d"], "tablet keeps 'b' + following 'c'");
  eqArr(resolveBandHidden(["a", "b", "c"], "tablet", "a"), ["c"], "tablet keeps 'a' + following 'b'");
}

console.log("\n[resolveBandHidden] tablet keeps focused + preceding sibling when focused is last");
{
  eqArr(resolveBandHidden(["a", "b", "c"], "tablet", "c"), ["a"], "focused 'c' is last -> keep 'c' + preceding 'b'");
  eqArr(resolveBandHidden(["a", "b", "c", "d"], "tablet", "d"), ["a", "b"], "focused 'd' is last -> keep 'd' + preceding 'c'");
}

console.log("\n[resolveBandHidden] never hides every region");
{
  const out = resolveBandHidden(["a", "b", "c"], "phone", "not-in-list");
  assert(out.length < 3, "an unknown focus id still keeps at least one region visible");
  eqArr(out, ["b", "c"], "unknown focus id falls back to keeping the first, like null focus");
}

console.log("\n[resolveBandHidden] contract: callers must pass OPEN region ids only");
{
  // resolveBandHidden has no way to know which ids are user-closed — that is
  // entirely the caller's job (see Shell.tsx's bandHiddenRegionIds memo,
  // which filters through layoutTree.resolveHidden before calling this). Fed
  // only the open ids, the function must always keep at least one of THOSE
  // ids visible, however few there are.
  const openIds = ["res-a", "res-b"]; // "scripture" already user-closed, never passed in
  const out = resolveBandHidden(openIds, "phone", null);
  assert(out.length < openIds.length, "at least one of the open ids stays visible");
  eqArr(out, ["res-b"], "phone keeps the first open id when none is focused");
}

console.log("\n[resolveBandHidden] deterministic for repeated calls");
{
  const first = resolveBandHidden(["a", "b", "c", "d", "e"], "tablet", "c");
  const second = resolveBandHidden(["a", "b", "c", "d", "e"], "tablet", "c");
  eqArr(first, second, "same input -> same output every time");
  eqArr(first, ["a", "b", "e"], "tablet keeps 'c' + following 'd'");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll layoutBands tests passed.");
