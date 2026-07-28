// Tests for dropZone.ts — the pure pointer→DropTarget hit-test that maps a drag
// position inside a region to layoutTree's axis+side vocabulary. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/dropZone.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors src/lib/layoutTree.test.mjs.

import {
  EDGE_RATIO,
  OUTER_BAND_PX,
  bandInsets,
  computeDropPreview,
  computeDropTarget,
  computeIntoIndex,
  computeOuterDropBand,
  computeOuterDropTarget,
  isPointerInAnyOuterBand,
  logicalBandEdge,
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

console.log("\npreview geometry stays LOGICAL — it must NOT mirror the side itself");
{
  // The preview used to return a PHYSICAL `left`, mirroring the logical side for
  // RTL. The caller then painted that through MUI `sx`, where stylis-plugin-rtl
  // rewrote it a SECOND time — so under an Arabic UI the preview appeared on the
  // opposite side from the drop that actually committed. The contract is now a
  // logical edge, identical in both directions; the browser resolves it.
  eq(
    computeDropPreview(base(), split("horizontal", "before")),
    { kind: "area", edge: "inlineStart", extent: 0.5 },
    "side:before on the inline axis previews the inline-START half",
  );
  eq(
    computeDropPreview(base({ direction: "rtl" }), split("horizontal", "before")),
    { kind: "area", edge: "inlineStart", extent: 0.5 },
    "the SAME logical edge under RTL — direction must not change the preview",
  );
  eq(
    computeDropPreview(base(), split("horizontal", "after")),
    { kind: "area", edge: "inlineEnd", extent: 0.5 },
    "side:after on the inline axis previews the inline-END half",
  );
  eq(
    computeDropPreview(base(), split("vertical", "before")),
    { kind: "area", edge: "blockStart", extent: 0.5 },
    "side:before on the block axis previews the block-START (top) half",
  );
  eq(
    computeDropPreview(base(), split("vertical", "after")),
    { kind: "area", edge: "blockEnd", extent: 0.5 },
    "side:after on the block axis previews the block-END (bottom) half",
  );
  assert(
    !("left" in computeDropPreview(base(), split("horizontal", "before"))),
    "an area preview carries NO physical inset — nothing for stylis to double-mirror",
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
    { kind: "area", edge: null, extent: 1 },
    "into an empty region highlights the whole region (edge null)",
  );
}

console.log("\nthe preview always shows the edge the drop will actually commit to");
{
  // THE regression guard for the double-mirror bug, stated end-to-end: hit-test a
  // real pointer, then check the preview's logical edge is the one the resulting
  // split will occupy. Under RTL the visual LEFT edge yields side:"after" — and so
  // must preview inline-END, which the browser paints back on the visual left,
  // where the user's cursor actually is.
  for (const [x, y, direction, expectedSide, expectedEdge, label] of [
    [10, 200, "ltr", "before", "inlineStart", "LTR visual-left edge"],
    [990, 200, "ltr", "after", "inlineEnd", "LTR visual-right edge"],
    [10, 200, "rtl", "after", "inlineEnd", "RTL visual-left edge (mirrored side AND edge)"],
    [990, 200, "rtl", "before", "inlineStart", "RTL visual-right edge"],
    [500, 10, "ltr", "before", "blockStart", "top edge, LTR"],
    [500, 10, "rtl", "before", "blockStart", "top edge, RTL (block axis never mirrors)"],
  ]) {
    const input = base({ pointer: { x, y }, direction });
    const target = computeDropTarget(input);
    assert(
      target.placement.kind === "split" && target.placement.side === expectedSide,
      `${label}: drop commits side:${expectedSide} (got ${target.placement.side})`,
    );
    const preview = computeDropPreview(input, target);
    assert(
      preview.kind === "area" && preview.edge === expectedEdge,
      `${label}: preview paints ${expectedEdge} (got ${preview.edge})`,
    );
    // And the shared mapping agrees — the perimeter band for the same axis+side
    // lands on the same logical edge, which is what stops the two paths drifting.
    assert(
      logicalBandEdge(target.placement.orientation, target.placement.side) === expectedEdge,
      `${label}: logicalBandEdge agrees with the region preview`,
    );
  }
}

console.log("\nbandInsets emits only logical insets");
{
  // If any physical inset leaks out of here, stylis-plugin-rtl will mirror it under
  // an Arabic UI and the paint will disagree with the drop. Assert the shape.
  const PHYSICAL = ["left", "right", "marginLeft", "marginRight", "paddingLeft", "paddingRight"];
  for (const edge of ["blockStart", "blockEnd", "inlineStart", "inlineEnd", null]) {
    const insets = bandInsets(edge, "50%");
    for (const prop of PHYSICAL) {
      assert(!(prop in insets), `bandInsets(${edge}) emits no physical \`${prop}\``);
    }
  }
  eq(bandInsets("inlineStart", "50%"), { top: 0, bottom: 0, insetInlineStart: 0, width: "50%" }, "inline-start band");
  eq(bandInsets("inlineEnd", "50%"), { top: 0, bottom: 0, insetInlineEnd: 0, width: "50%" }, "inline-end band");
  eq(
    bandInsets("blockStart", "22px"),
    { insetInlineStart: 0, insetInlineEnd: 0, top: 0, height: "22px" },
    "block-start band (the perimeter's px thickness)",
  );
  eq(
    bandInsets("blockEnd", "40%"),
    { insetInlineStart: 0, insetInlineEnd: 0, bottom: 0, height: "40%" },
    "block-end band",
  );
  eq(bandInsets(null, "100%"), { inset: 0 }, "edge null fills the whole box");
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

// ─── Outer (perimeter) drop zones ──────────────────────────────────────
//
// The whole WORKSPACE box, 1000x400 at the origin. The bands are OUTER_BAND_PX
// (22px) thick: x < 22 / x > 978, y < 22 / y > 378.
const WORKSPACE = { left: 0, top: 0, width: 1000, height: 400 };
const outer = (over = {}) => ({
  rect: WORKSPACE,
  pointer: { x: 500, y: 200 },
  direction: "ltr",
  ...over,
});
const band = (orientation, side) => ({ kind: "outer", orientation, side });

console.log("\nOUTER_BAND_PX sanity");
{
  assert(
    OUTER_BAND_PX > 0 && OUTER_BAND_PX * 2 < WORKSPACE.height,
    `OUTER_BAND_PX (${OUTER_BAND_PX}) is a thin frame, not half the workspace`,
  );
}

console.log("\nall four outer edges, LTR");
{
  eq(computeOuterDropTarget(outer({ pointer: { x: 500, y: 2 } })), band("vertical", "before"), "top edge → vertical/before (a full-width band above)");
  eq(computeOuterDropTarget(outer({ pointer: { x: 500, y: 398 } })), band("vertical", "after"), "bottom edge → vertical/after");
  eq(computeOuterDropTarget(outer({ pointer: { x: 2, y: 200 } })), band("horizontal", "before"), "LTR left edge → horizontal/before");
  eq(computeOuterDropTarget(outer({ pointer: { x: 998, y: 200 } })), band("horizontal", "after"), "LTR right edge → horizontal/after");
  eq(computeOuterDropTarget(outer()), null, "the interior is NOT an outer drop");
}

console.log("\nouter inline edges MIRROR under RTL; the block edges do not");
{
  eq(
    computeOuterDropTarget(outer({ pointer: { x: 2, y: 200 }, direction: "rtl" })),
    band("horizontal", "after"),
    "RTL visual LEFT band → side AFTER (mirrored)",
  );
  eq(
    computeOuterDropTarget(outer({ pointer: { x: 998, y: 200 }, direction: "rtl" })),
    band("horizontal", "before"),
    "RTL visual RIGHT band → side BEFORE (mirrored)",
  );
  eq(
    computeOuterDropTarget(outer({ pointer: { x: 500, y: 2 }, direction: "rtl" })),
    band("vertical", "before"),
    "RTL top edge → vertical/before (block axis is NOT mirrored)",
  );
  eq(
    computeOuterDropTarget(outer({ pointer: { x: 500, y: 398 }, direction: "rtl" })),
    band("vertical", "after"),
    "RTL bottom edge → vertical/after (block axis is NOT mirrored)",
  );
  // Genuine mirror across the inline band, not a coincidence of the sample points.
  for (const x of [0, 10, 21, 979, 990, 1000]) {
    const l = computeOuterDropTarget(outer({ pointer: { x, y: 200 } }));
    const r = computeOuterDropTarget(outer({ pointer: { x, y: 200 }, direction: "rtl" }));
    assert(
      l && r && l.orientation === "horizontal" && r.orientation === "horizontal" && l.side !== r.side,
      `x=${x}: LTR side (${l?.side}) is the mirror of RTL side (${r?.side})`,
    );
  }
}

console.log("\nouter corner precedence: deeper band wins, ties go to the BLOCK axis");
{
  // x=2 is 20px into the inline band; y=10 is 12px into the block band.
  eq(
    computeOuterDropTarget(outer({ pointer: { x: 2, y: 10 } })),
    band("horizontal", "before"),
    "top-left, deeper on inline → a full-height column",
  );
  // x=10 is 12px in; y=2 is 20px in.
  eq(
    computeOuterDropTarget(outer({ pointer: { x: 10, y: 2 } })),
    band("vertical", "before"),
    "top-left, deeper on block → a full-width band",
  );
  // EXACT tie: both 17px in. The block axis wins — deliberately the OPPOSITE of
  // computeDropTarget's region tie-break, because a full-width band is the
  // likelier intent at the perimeter and is the shape region drops can't make.
  eq(
    computeOuterDropTarget(outer({ pointer: { x: 5, y: 5 } })),
    band("vertical", "before"),
    "exact tie (5,5) → BLOCK axis wins (full-width band)",
  );
  eq(
    computeOuterDropTarget(outer({ pointer: { x: 0, y: 0 } })),
    band("vertical", "before"),
    "the very corner (0,0) is also a tie → block axis",
  );
  eq(
    computeOuterDropTarget(outer({ pointer: { x: 995, y: 395 } })),
    band("vertical", "after"),
    "bottom-right tie → vertical/after",
  );
}

console.log("\nouter band boundaries and degenerate input");
{
  eq(
    computeOuterDropTarget(outer({ pointer: { x: OUTER_BAND_PX, y: 200 } })),
    null,
    "exactly ON the band threshold (x=22) belongs to the INSIDE, not the perimeter",
  );
  eq(
    computeOuterDropTarget(outer({ pointer: { x: OUTER_BAND_PX - 1, y: 200 } })),
    band("horizontal", "before"),
    "one pixel further out (x=21) IS an outer drop",
  );
  eq(
    computeOuterDropTarget(outer({ pointer: { x: 500, y: OUTER_BAND_PX } })),
    null,
    "exactly on the top threshold (y=22) → not an outer drop",
  );
  eq(computeOuterDropTarget(outer({ pointer: { x: -5, y: 200 } })), null, "pointer left of the workspace → null");
  eq(computeOuterDropTarget(outer({ pointer: { x: 500, y: 500 } })), null, "pointer below the workspace → null");
  eq(
    computeOuterDropTarget(outer({ rect: { left: 0, top: 0, width: 0, height: 0 } })),
    null,
    "zero-sized workspace → null, never a bogus wrap",
  );
  eq(
    computeOuterDropTarget(outer({ pointer: { x: 100, y: 200 }, bandPx: 200 })),
    band("horizontal", "before"),
    "bandPx is overridable (200px band catches x=100)",
  );
  // Offset rects: the bands follow the rect, not the viewport origin.
  eq(
    computeOuterDropTarget(outer({ rect: { left: 300, top: 100, width: 500, height: 300 }, pointer: { x: 305, y: 250 } })),
    band("horizontal", "before"),
    "an offset workspace's left band is measured from its own left edge",
  );
  eq(
    computeOuterDropTarget(outer({ rect: { left: 300, top: 100, width: 500, height: 300 }, pointer: { x: 305, y: 250 - 200 } })),
    null,
    "…and a pointer above that rect is outside it entirely",
  );
}

console.log("\nouter band geometry matches the band the engine will create");
{
  // LOGICAL, not physical: the UI paints insetInlineStart/insetInlineEnd and lets
  // the browser (plus stylis-plugin-rtl, which rewrites physical insets) resolve
  // direction. Pre-mirroring here would flip the band to the WRONG side under an
  // RTL UI — mirrored twice.
  eq(
    computeOuterDropBand(band("vertical", "before")),
    { edge: "blockStart", size: 0.4 },
    "vertical/before → block-start (top) band at 0.4 (= layoutTree's OUTER_BAND_SIZE)",
  );
  eq(
    computeOuterDropBand(band("vertical", "after")),
    { edge: "blockEnd", size: 0.4 },
    "vertical/after → block-end (bottom) band at 0.4",
  );
  eq(
    computeOuterDropBand(band("horizontal", "before")),
    { edge: "inlineStart", size: 0.3 },
    "horizontal/before → inline-start column at 0.3",
  );
  eq(
    computeOuterDropBand(band("horizontal", "after")),
    { edge: "inlineEnd", size: 0.3 },
    "horizontal/after → inline-end column at 0.3",
  );
  // Hit-test → paint round-trips: the band shown is always the one the pointer is
  // in. Under RTL the same visual left edge yields the mirrored logical side and
  // therefore the mirrored logical band — which the browser paints back on the
  // visual left, where the user actually is.
  for (const [x, y, ltrEdge, rtlEdge] of [
    [500, 2, "blockStart", "blockStart"],
    [500, 398, "blockEnd", "blockEnd"],
    [2, 200, "inlineStart", "inlineEnd"],
    [998, 200, "inlineEnd", "inlineStart"],
  ]) {
    for (const [direction, expected] of [["ltr", ltrEdge], ["rtl", rtlEdge]]) {
      const target = computeOuterDropTarget(outer({ pointer: { x, y }, direction }));
      const got = computeOuterDropBand(target).edge;
      assert(got === expected, `(${x},${y}) dir=${direction} → logical band ${expected} (got ${got})`);
    }
  }
}

console.log("\nband arming: is the pointer inside ANY perimeter band?");
{
  // Drives OuterDropZone's `armed` state. Edge-adjacent drag grips start the drag
  // INSIDE a band, so the bands stay pointer-events:none until this returns false
  // at least once.
  const inBand = (over = {}) => isPointerInAnyOuterBand({ rect: WORKSPACE, ...over });
  for (const [x, y, label] of [
    [500, 2, "top band"],
    [500, 398, "bottom band"],
    [2, 200, "left band"],
    [998, 200, "right band"],
    [2, 2, "top-left corner (both bands)"],
    [998, 398, "bottom-right corner"],
  ]) {
    assert(inBand({ pointer: { x, y } }) === true, `(${x},${y}) is inside a band — ${label}`);
  }
  assert(inBand({ pointer: { x: 500, y: 200 } }) === false, "the middle of the workspace is outside every band");
  assert(
    inBand({ pointer: { x: OUTER_BAND_PX, y: OUTER_BAND_PX } }) === false,
    "exactly on both thresholds (22,22) is inside the workspace, outside every band",
  );
  assert(
    inBand({ pointer: { x: -5, y: 200 } }) === false,
    "a pointer dragged clear off the workspace counts as outside every band (it arms)",
  );
  // Direction-agnostic by construction: the four bands cover the same pixels in
  // LTR and RTL, only the LOGICAL side they map to mirrors. Arming must not care.
  for (const [x, y] of [[2, 200], [998, 200], [500, 2], [500, 200]]) {
    const plain = isPointerInAnyOuterBand({ rect: WORKSPACE, pointer: { x, y } });
    for (const direction of ["ltr", "rtl"]) {
      const viaTarget = computeOuterDropTarget(outer({ pointer: { x, y }, direction })) !== null;
      assert(viaTarget === plain, `(${x},${y}) band membership agrees with dir=${direction} hit-test (${plain})`);
    }
  }
  const snapshot = JSON.stringify({ rect: WORKSPACE, pointer: { x: 2, y: 2 } });
  const input = { rect: WORKSPACE, pointer: { x: 2, y: 2 } };
  isPointerInAnyOuterBand(input);
  assert(JSON.stringify(input) === snapshot, "isPointerInAnyOuterBand never mutates its input");
}

console.log("\nouter purity");
{
  const input = outer({ pointer: { x: 2, y: 2 } });
  const snapshot = JSON.stringify(input);
  computeOuterDropTarget(input);
  assert(JSON.stringify(input) === snapshot, "computeOuterDropTarget never mutates its input");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll dropZone tests passed.");
