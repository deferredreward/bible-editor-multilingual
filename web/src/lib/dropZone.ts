// Pointer → DropTarget hit-test for tiled docking (the UI half of layoutTree).
//
// layoutTree.ts deliberately knows NO physical directions: a drop is an axis
// (`horizontal` / `vertical`) plus a logical `side` (`before` / `after`).
// Translating a pixel position into that vocabulary — and MIRRORING it for RTL —
// is this module's job.
//
// Everything here is PURE arithmetic: the caller measures the DOM (rects) and
// reads the effective writing direction, this module never touches the DOM or
// React. That is what makes the zone geometry unit-testable
// (see dropZone.test.mjs).

import { OUTER_BAND_SIZE, type OuterDropTarget, type RegionDropTarget } from "./layoutTree.ts";
import type { Axis } from "./layoutSpec.ts";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Direction = "ltr" | "rtl";

// How far in from a region's edge still counts as an edge (split) drop, as a
// fraction of the region's size along that axis. The remaining middle is the
// "center" (join-the-list) zone. Matches the mockup's visual proportions.
export const EDGE_RATIO = 0.22;

export interface DropZoneInput {
  // The target region's bounding box, in the same coordinate space as `pointer`
  // (viewport coordinates when both come from getBoundingClientRect / clientX).
  rect: Rect;
  pointer: Point;
  // The region's EFFECTIVE direction — read it off the element
  // (getComputedStyle(el).direction), not off a prop, so an ancestor `dir`
  // attribute is honoured.
  direction: Direction;
  // The region's panel bounding boxes and ids, parallel arrays in panel-list
  // order (i.e. DOM order, top to bottom).
  panelRects: Rect[];
  panelIds: string[];
  // The panel being dragged. When it lives in THIS region it is excluded from
  // the index arithmetic — see computeDropTarget.
  draggedPanelId: string;
  // The region being hit-tested; becomes the DropTarget's regionId.
  currentRegionId: string;
  edgeRatio?: number;
}

// Which physical edge (if any) the pointer is in, and how deep. Penetration is
// expressed as a fraction of the axis length, so the two axes are comparable.
interface EdgeHit {
  inline: "start" | "end" | null; // physical start/end resolved later
  inlinePenetration: number; // < 0 when not in an inline edge
  block: "start" | "end" | null;
  blockPenetration: number;
}

function hitEdges(fx: number, fy: number, edge: number): EdgeHit {
  // Strict comparisons mean a pointer EXACTLY on a threshold (fx === edge or
  // fx === 1 - edge) is NOT in the edge zone: thresholds belong to the center.
  // Deterministic and documented so the tests can pin it.
  let inline: "start" | "end" | null = null;
  let inlinePenetration = -1;
  if (fx < edge) {
    inline = "start";
    inlinePenetration = edge - fx;
  } else if (fx > 1 - edge) {
    inline = "end";
    inlinePenetration = fx - (1 - edge);
  }
  let block: "start" | "end" | null = null;
  let blockPenetration = -1;
  if (fy < edge) {
    block = "start";
    blockPenetration = edge - fy;
  } else if (fy > 1 - edge) {
    block = "end";
    blockPenetration = fy - (1 - edge);
  }
  return { inline, inlinePenetration, block, blockPenetration };
}

// The region's panels with the dragged one removed, in list order.
//
// This is the POST-REMOVAL convention layoutTree's `{kind:"into", index}`
// expects: the index addresses the target region's list as it will exist AFTER
// the dragged panel has been taken out of wherever it currently is. When the
// dragged panel lives in another region nothing is filtered (that region's list
// is unaffected), which falls out of filtering by id.
function survivors(input: DropZoneInput): Rect[] {
  const out: Rect[] = [];
  for (let i = 0; i < input.panelRects.length; i++) {
    if (input.panelIds[i] === input.draggedPanelId) continue;
    out.push(input.panelRects[i]);
  }
  return out;
}

// Insertion index from the pointer's Y against the surviving panels' midpoints —
// the same algorithm the mockup's `afterElement` uses, expressed as a count:
// the panel is inserted before the first panel whose midpoint is BELOW the
// pointer. A pointer above every midpoint gives 0; below every midpoint gives
// `length` (append). A pointer exactly ON a midpoint counts that panel as
// "above" (so it lands after it), matching the mockup's strict `offset < 0`.
export function computeIntoIndex(input: DropZoneInput): number {
  const rects = survivors(input);
  let index = 0;
  for (const r of rects) {
    if (r.top + r.height / 2 <= input.pointer.y) index++;
  }
  return index;
}

// Map the pointer position inside a region to a DropTarget.
//
// Five zones: four ~22% edge bands (split) plus the center (join the list).
// Corners belong to whichever axis the pointer has penetrated further; an exact
// tie goes to the inline axis, so the result is always deterministic.
export function computeDropTarget(input: DropZoneInput): RegionDropTarget {
  const { rect, pointer, direction, currentRegionId } = input;
  const edge = input.edgeRatio ?? EDGE_RATIO;

  // A zero-sized region has no meaningful geometry (hidden / not yet laid out):
  // fall back to appending into it rather than inventing a split.
  if (!(rect.width > 0) || !(rect.height > 0)) {
    return { regionId: currentRegionId, placement: { kind: "into" } };
  }

  const fx = (pointer.x - rect.left) / rect.width;
  const fy = (pointer.y - rect.top) / rect.height;
  const hit = hitEdges(fx, fy, edge);

  const useInline = hit.inline !== null && hit.inlinePenetration >= hit.blockPenetration;
  const useBlock = hit.block !== null && !useInline;

  if (useInline) {
    // RTL MIRRORING LIVES HERE. `side` is LOGICAL: "before" means earlier in the
    // inline flow, which is the LEFT half under dir="ltr" and the RIGHT half
    // under dir="rtl". So dragging to the visual LEFT edge of an RTL region
    // must produce side:"after", not "before" — otherwise the panel would
    // visibly land on the opposite side from where the user dropped it.
    const physical = hit.inline as "start" | "end";
    const logicalStart = direction === "rtl" ? physical === "end" : physical === "start";
    return {
      regionId: currentRegionId,
      placement: {
        kind: "split",
        orientation: "horizontal",
        side: logicalStart ? "before" : "after",
      },
    };
  }

  if (useBlock) {
    // The block axis runs top→bottom in both LTR and RTL (vertical writing modes
    // are out of scope), so no mirroring here.
    return {
      regionId: currentRegionId,
      placement: {
        kind: "split",
        orientation: "vertical",
        side: hit.block === "start" ? "before" : "after",
      },
    };
  }

  return {
    regionId: currentRegionId,
    placement: { kind: "into", index: computeIntoIndex(input) },
  };
}

// ─── Logical edges: the ONE place a drop is turned into something paintable ────

// An edge named in CSS LOGICAL terms, and that is deliberate: the app renders RTL
// through stylis-plugin-rtl, which rewrites PHYSICAL insets (`left`/`right`) in
// the emitted CSS. Pre-mirroring a logical side into a physical one and then
// letting stylis mirror it again flips the paint to the wrong side — mirrored
// twice. So nothing in this module ever emits a physical inset: callers paint
// `insetInlineStart` / `insetInlineEnd` (see bandInsets) and the browser resolves
// the direction. The block edges are never mirrored by anything.
export type OuterBandEdge = "blockStart" | "blockEnd" | "inlineStart" | "inlineEnd";

// axis + logical side → logical edge. Shared by BOTH preview paths (a region's
// edge-split preview and the workspace perimeter band) so they cannot drift apart:
// one of them being physical while the other was logical is exactly the bug this
// consolidation fixes.
export function logicalBandEdge(orientation: Axis, side: "before" | "after"): OuterBandEdge {
  if (orientation === "vertical") return side === "before" ? "blockStart" : "blockEnd";
  return side === "before" ? "inlineStart" : "inlineEnd";
}

// The CSS insets that paint a band on `edge`, `extent` thick along that band's own
// axis (a px length for a fixed frame, a percentage for a proportional preview).
// `edge: null` fills the whole box.
//
// Pure data — a plain object of CSS properties, no DOM — so it stays unit-testable
// and both components can share it instead of each hand-rolling the mapping.
export function bandInsets(edge: OuterBandEdge | null, extent: string): Record<string, string | number> {
  switch (edge) {
    case "blockStart":
      return { insetInlineStart: 0, insetInlineEnd: 0, top: 0, height: extent };
    case "blockEnd":
      return { insetInlineStart: 0, insetInlineEnd: 0, bottom: 0, height: extent };
    case "inlineStart":
      return { top: 0, bottom: 0, insetInlineStart: 0, width: extent };
    case "inlineEnd":
      return { top: 0, bottom: 0, insetInlineEnd: 0, width: extent };
    default:
      return { inset: 0 };
  }
}

// ─── Preview geometry ──────────────────────────────────────────────────

// Where to draw the drop preview.
//
// An `area` is a band on ONE LOGICAL EDGE of the region, `extent` of the way
// across that edge's own axis (a fraction 0..1, so the caller renders it as a CSS
// percentage with no further math). `edge: null` means the whole region.
//
// LOGICAL, never physical — and this is the load-bearing part. An earlier version
// returned a physical `left` (mirroring the logical side itself for RTL) and the
// caller painted `left` through MUI `sx`. Under an Arabic UI the RTL Emotion cache
// runs stylis-plugin-rtl (see web/src/main.tsx), which rewrites physical insets in
// the emitted CSS — so the value was mirrored a SECOND time and the preview
// painted on the opposite side from where the drop actually committed. The drop
// was right and the feedback lied. Emitting a logical edge and letting the caller
// paint `insetInlineStart` / `insetInlineEnd` leaves stylis nothing to mirror,
// which is exactly how the perimeter bands (computeOuterDropBand) already work.
export type DropPreview =
  | { kind: "area"; edge: OuterBandEdge | null; extent: number }
  // A thin insertion line between panels, at `top` down the region.
  | { kind: "line"; top: number };

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function computeDropPreview(input: DropZoneInput, target: RegionDropTarget): DropPreview {
  const { rect } = input;
  const placement = target.placement;

  // NOTE the absence of `direction` here: mirroring a logical side into a
  // physical one is precisely the bug described on DropPreview. The axis→edge
  // mapping is shared with the perimeter bands via logicalBandEdge so the two
  // preview paths cannot drift apart.
  if (placement.kind === "split") {
    return { kind: "area", edge: logicalBandEdge(placement.orientation, placement.side), extent: 0.5 };
  }

  const rects = survivors(input);
  if (rects.length === 0 || !(rect.height > 0)) {
    // Nothing to insert between — highlight the whole region instead.
    return { kind: "area", edge: null, extent: 1 };
  }
  const index = placement.index === undefined ? rects.length : Math.min(Math.max(placement.index, 0), rects.length);
  const y = index === 0 ? rects[0].top : rects[index - 1].top + rects[index - 1].height;
  return { kind: "line", top: clamp01((y - rect.top) / rect.height) };
}

// ─── Outer (perimeter) drop zones ──────────────────────────────────────

// How far in from the WORKSPACE's outer edge counts as an outer drop. A fixed
// pixel band, not a fraction: it has to stay a thin frame no matter how big the
// window is, or it would swallow the region zones inside it.
export const OUTER_BAND_PX = 22;

export interface OuterDropInput {
  // The bounding box of the WHOLE arrangeable workspace area (all regions), in
  // the same coordinate space as `pointer`.
  rect: Rect;
  pointer: Point;
  // Effective direction of the workspace element (getComputedStyle().direction).
  direction: Direction;
  bandPx?: number;
}

// Map a pointer near the workspace perimeter to an outer DropTarget, or null when
// it is not in any outer band (including a pointer outside the rect entirely).
//
// Corner precedence: the edge whose band is penetrated DEEPER wins. On an exact
// tie the BLOCK (vertical) axis wins — the opposite of the region hit test's
// tie-break, deliberately: a full-width band is the likelier intent at the
// workspace perimeter, and it is the shape that region drops cannot produce.
export function computeOuterDropTarget(input: OuterDropInput): OuterDropTarget | null {
  const { rect, pointer, direction } = input;
  const band = input.bandPx ?? OUTER_BAND_PX;
  if (!(rect.width > 0) || !(rect.height > 0) || !(band > 0)) return null;

  const dx = pointer.x - rect.left;
  const dy = pointer.y - rect.top;
  if (dx < 0 || dy < 0 || dx > rect.width || dy > rect.height) return null;

  // Penetration in PIXELS (both axes use the same band, so they are directly
  // comparable). `< band` is strict, matching hitEdges: a pointer exactly on the
  // band threshold belongs to the inside, not to the perimeter.
  let inline: "start" | "end" | null = null;
  let inlinePenetration = -1;
  if (dx < band) {
    inline = "start";
    inlinePenetration = band - dx;
  } else if (rect.width - dx < band) {
    inline = "end";
    inlinePenetration = band - (rect.width - dx);
  }
  let block: "start" | "end" | null = null;
  let blockPenetration = -1;
  if (dy < band) {
    block = "start";
    blockPenetration = band - dy;
  } else if (rect.height - dy < band) {
    block = "end";
    blockPenetration = band - (rect.height - dy);
  }

  if (block !== null && blockPenetration >= inlinePenetration) {
    // The block axis runs top→bottom in LTR and RTL alike — no mirroring.
    return { kind: "outer", orientation: "vertical", side: block === "start" ? "before" : "after" };
  }
  if (inline !== null) {
    // RTL MIRRORING, same rule as computeDropTarget: `side` is logical, so the
    // visual LEFT band of an RTL workspace is the inline END → side "after".
    const logicalStart = direction === "rtl" ? inline === "end" : inline === "start";
    return { kind: "outer", orientation: "horizontal", side: logicalStart ? "before" : "after" };
  }
  return null;
}

// Is the pointer inside ANY of the four perimeter bands?
//
// Direction-agnostic on purpose: which logical side a band maps to depends on the
// writing direction, but WHETHER the pointer is in a band does not — the four
// bands cover the same pixels either way. The caller (OuterDropZone) uses this to
// decide when to ARM the bands: they must not become live drop targets until the
// pointer has left the perimeter at least once during the drag, because a panel
// whose drag grip sits against a workspace edge starts its drag with the cursor
// already inside a band, which would otherwise lock the drag to that edge.
export function isPointerInAnyOuterBand(input: Omit<OuterDropInput, "direction">): boolean {
  return computeOuterDropTarget({ ...input, direction: "ltr" }) !== null;
}

// Which edge of the workspace the resulting band occupies, and how much of it —
// the fraction comes straight from layoutTree's OUTER_BAND_SIZE so the preview
// can never disagree with the committed tree. The edge is LOGICAL; see
// logicalBandEdge, which computeDropPreview shares.
export function computeOuterDropBand(target: OuterDropTarget): { edge: OuterBandEdge; size: number } {
  return { edge: logicalBandEdge(target.orientation, target.side), size: OUTER_BAND_SIZE[target.orientation] };
}
