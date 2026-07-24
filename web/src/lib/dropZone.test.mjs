// Tests for dropZone.ts — the pure pointer→DropTarget hit-test that maps a drag
// position inside a region to layoutTree's axis+side vocabulary. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/dropZone.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors src/lib/layoutTree.test.mjs.

import {
  EDGE_RATIO,
  computeDropPreview,
  computeDropTarget,
  computeIntoIndex,
} from "./dropZone.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${msg}\n    expected ${e}\n    actual   ${a}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// A 1000x400 region at the origin, holding three stacked panels of 100px each
// (so their midpoints sit at y = 50, 150, 250).
const REGION = { left: 0, top: 0, width: 1000, height: 400 };
const PANELS = [
  { left: 0, top: 0, width: 1000, height: 100 },
  { left: 0, top: 100, width: 1000, height: 100 },
  { left: 0, top: 200, width: 1000, height: 100 },
];
const IDS = ["a", "b", "c"];

// The edge bands are 22% wide: x < 220 / x > 780, y < 88 / y > 312.
const base = (over = {}) => ({
  rect: REGION,
  pointer: { x: 500, y: 200 },
  direction: "ltr",
  panelRects: PANELS,
  panelIds: IDS,
  draggedPanelId: "z", // by default the dragged panel lives elsewhere
  currentRegionId: "res-a",
  ...over,
});

const split = (orientation, side) => ({
  regionId: "res-a",
  placement: { kind: "split", orientation, side },
});
const into = (index) => ({ regionId: "res-a", placement: { kind: "into", index } });

console.log("EDGE_RATIO sanity");
{
  assert(EDGE_RATIO > 0 && EDGE_RATIO < 0.5, `EDGE_RATIO (${EDGE_RATIO}) is a sane outer band`);
}

console.log("\nfour edge zones, LTR");
{
  // Inline start (visual left under LTR) → before.
  eq(
    computeDropTarget(base({ pointer: { x: 10, y: 200 } })),
    split("horizontal", "before"),
    "LTR far-left → horizontal split, side before",
  );
  eq(
    computeDropTarget(base({ pointer: { x: 990, y: 200 } })),
    split("horizontal", "after"),
    "LTR far-right → horizontal split, side after",
  );
  eq(
    computeDropTarget(base({ pointer: { x: 500, y: 4 } })),
    split("vertical", "before"),
    "top → vertical split, side before",
  );
  eq(
    computeDropTarget(base({ pointer: { x: 500, y: 396 } })),
    split("vertical", "after"),
    "bottom → vertical split, side after",
  );
}

console.log("\nfour edge zones, RTL — inline sides MIRROR, block sides do not");
{
  // The whole point: under dir=rtl the visual LEFT edge is the inline END, so it
  // must resolve to side:"after" — the opposite of the LTR answer at the same
  // pixel. Getting this wrong makes the panel land on the far side from the drop.
  eq(
    computeDropTarget(base({ pointer: { x: 10, y: 200 }, direction: "rtl" })),
    split("horizontal", "after"),
    "RTL far-left → horizontal split, side AFTER (mirrored)",
  );
  eq(
    computeDropTarget(base({ pointer: { x: 990, y: 200 }, direction: "rtl" })),
    split("horizontal", "before"),
    "RTL far-right → horizontal split, side BEFORE (mirrored)",
  );
  eq(
    computeDropTarget(base({ pointer: { x: 500, y: 4 }, direction: "rtl" })),
    split("vertical", "before"),
    "RTL top → vertical split, side before (block axis is NOT mirrored)",
  );
  eq(
    computeDropTarget(base({ pointer: { x: 500, y: 396 }, direction: "rtl" })),
    split("vertical", "after"),
    "RTL bottom → vertical split, side after (block axis is NOT mirrored)",
  );
  // Every LTR/RTL pair on the inline axis is a genuine mirror, not a coincidence
  // of the sample points.
  for (const x of [0, 50, 219, 781, 950, 1000]) {
    const ltr = computeDropTarget(base({ pointer: { x, y: 200 } })).placement;
    const rtl = computeDropTarget(base({ pointer: { x, y: 200 }, direction: "rtl" })).placement;
    assert(
      ltr.kind === "split" && rtl.kind === "split" && ltr.side !== rtl.side,
      `x=${x}: LTR side (${ltr.side}) is the mirror of RTL side (${rtl.side})`,
    );
  }
}

console.log("\ncorner precedence: deeper penetration wins, ties go to the inline axis");
{
  // x=0 is 22% into the inline band; y=80 is only 0.22-0.2=0.02 into the block
  // band. Inline is deeper.
  eq(
    computeDropTarget(base({ pointer: { x: 0, y: 80 } })),
    split("horizontal", "before"),
    "top-left corner, deeper on inline → horizontal",
  );
  // x=219 is 0.001 into the inline band; y=0 is the full 0.22 into the block band.
  eq(
    computeDropTarget(base({ pointer: { x: 219, y: 0 } })),
    split("vertical", "before"),
    "top-left corner, deeper on block → vertical",
  );
  // Exact tie (both 0.22 in): inline wins, deterministically.
  eq(
    computeDropTarget(base({ pointer: { x: 0, y: 0 } })),
    split("horizontal", "before"),
    "exact corner (0,0) tie → inline axis wins",
  );
}

console.log("\nzone boundaries resolve deterministically (threshold belongs to the center)");
{
  // 0.22 * 1000 = 220 and 0.78 * 1000 = 780 exactly; 0.22 * 400 = 88, 312.
  eq(
    computeDropTarget(base({ pointer: { x: 220, y: 200 } })),
    into(2),
    "x exactly on the start threshold (220) → center, not a split",
  );
  eq(
    computeDropTarget(base({ pointer: { x: 780, y: 200 } })),
    into(2),
    "x exactly on the end threshold (780) → center, not a split",
  );
  eq(
    computeDropTarget(base({ pointer: { x: 500, y: 88 } })),
    into(1),
    "y exactly on the top threshold (88) → center, not a split",
  );
  eq(
    computeDropTarget(base({ pointer: { x: 500, y: 312 } })),
    into(3),
    "y exactly on the bottom threshold (312) → center, not a split",
  );
  // One pixel further out is a split, so the boundary really is where we say.
  eq(
    computeDropTarget(base({ pointer: { x: 219, y: 200 } })),
    split("horizontal", "before"),
    "x = 219 (just inside the band) → split",
  );
}

console.log("\ncenter → into, index from panel midpoints");
{
  eq(
    computeDropTarget(base({ pointer: { x: 500, y: 5 } , edgeRatio: 0 })).placement,
    { kind: "into", index: 0 },
    "above the first midpoint → index 0",
  );
  eq(computeIntoIndex(base({ pointer: { x: 500, y: 49 } })), 0, "y=49 (above midpoint 50) → 0");
  eq(computeIntoIndex(base({ pointer: { x: 500, y: 51 } })), 1, "y=51 (below midpoint 50) → 1");
  eq(computeIntoIndex(base({ pointer: { x: 500, y: 151 } })), 2, "y=151 → 2");
  eq(
    computeIntoIndex(base({ pointer: { x: 500, y: 399 } })),
    3,
    "below every midpoint → 3 (append to a 3-panel list)",
  );
  // Exactly ON a midpoint counts that panel as above (mockup's strict offset<0).
  eq(
    computeIntoIndex(base({ pointer: { x: 500, y: 50 } })),
    1,
    "y exactly on a midpoint counts that panel as above → lands after it",
  );
}

console.log("\npost-removal index convention when dragging WITHIN the same region");
{
  // Dragging "a" (the first panel) within its own region. After removal the list
  // is [b, c], so indices must be expressed against THAT list — the engine's
  // documented convention.
  const inRegion = (y) => computeIntoIndex(base({ pointer: { x: 500, y }, draggedPanelId: "a" }));
  eq(inRegion(5), 0, "dragging 'a': above b's midpoint → 0 (in the [b,c] list)");
  eq(inRegion(151), 1, "dragging 'a': between b and c midpoints → 1");
  eq(inRegion(399), 2, "dragging 'a': below every midpoint → 2 = append to [b,c]");
  // The dragged panel's own box is skipped, so the max index is length-1, never 3.
  assert(inRegion(399) === 2, "same-region drag can never produce index 3 (the pre-removal length)");
  // Dragging a panel that lives in ANOTHER region leaves the list at full length.
  eq(
    computeIntoIndex(base({ pointer: { x: 500, y: 399 }, draggedPanelId: "elsewhere" })),
    3,
    "cross-region drag: the target list is unaffected → append index 3",
  );
}

console.log("\ndegenerate geometry");
{
  eq(
    computeDropTarget(base({ rect: { left: 0, top: 0, width: 0, height: 0 } })),
    { regionId: "res-a", placement: { kind: "into" } },
    "zero-sized region → plain append, never a bogus split",
  );
  eq(
    computeDropTarget(base({ panelRects: [], panelIds: [], pointer: { x: 500, y: 200 } })),
    into(0),
    "empty region centre → into index 0",
  );
}

console.log("\npreview geometry mirrors the split side back to a physical half");
{
  eq(
    computeDropPreview(base(), split("horizontal", "before")),
    { kind: "area", left: 0, top: 0, width: 0.5, height: 1 },
    "LTR side:before previews the LEFT half",
  );
  eq(
    computeDropPreview(base({ direction: "rtl" }), split("horizontal", "before")),
    { kind: "area", left: 0.5, top: 0, width: 0.5, height: 1 },
    "RTL side:before previews the RIGHT half",
  );
  eq(
    computeDropPreview(base(), split("vertical", "after")),
    { kind: "area", left: 0, top: 0.5, width: 1, height: 0.5 },
    "side:after on the block axis previews the BOTTOM half",
  );
  eq(
    computeDropPreview(base(), into(0)),
    { kind: "line", top: 0 },
    "into index 0 previews a line at the top of the first panel",
  );
  eq(
    computeDropPreview(base(), into(1)),
    { kind: "line", top: 0.25 },
    "into index 1 previews a line at the first panel's bottom edge (100/400)",
  );
  eq(
    computeDropPreview(base({ panelRects: [], panelIds: [] }), into(0)),
    { kind: "area", left: 0, top: 0, width: 1, height: 1 },
    "into an empty region highlights the whole region",
  );
}

console.log("\npurity");
{
  const input = base();
  const snapshot = JSON.stringify(input);
  computeDropTarget(input);
  computeIntoIndex(input);
  computeDropPreview(input, into(1));
  assert(JSON.stringify(input) === snapshot, "the input object is never mutated");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll dropZone tests passed.");
