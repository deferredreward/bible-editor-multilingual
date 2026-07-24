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

import type { DropTarget } from "./layoutTree.ts";

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
export function computeDropTarget(input: DropZoneInput): DropTarget {
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

// ─── Preview geometry ──────────────────────────────────────────────────

// Where to draw the drop preview, as fractions (0..1) of the region's own box —
// so the caller can render it as CSS percentages with no further math.
export type DropPreview =
  // The half (or whole) of the region the panel will occupy.
  | { kind: "area"; left: number; top: number; width: number; height: number }
  // A thin insertion line between panels, at `top` down the region.
  | { kind: "line"; top: number };

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function computeDropPreview(input: DropZoneInput, target: DropTarget): DropPreview {
  const { rect, direction } = input;
  const placement = target.placement;

  if (placement.kind === "split") {
    if (placement.orientation === "horizontal") {
      // Mirror the logical side back to a physical half for painting.
      const physicalStart = direction === "rtl" ? placement.side === "after" : placement.side === "before";
      return { kind: "area", left: physicalStart ? 0 : 0.5, top: 0, width: 0.5, height: 1 };
    }
    return { kind: "area", left: 0, top: placement.side === "before" ? 0 : 0.5, width: 1, height: 0.5 };
  }

  const rects = survivors(input);
  if (rects.length === 0 || !(rect.height > 0)) {
    // Nothing to insert between — highlight the whole region instead.
    return { kind: "area", left: 0, top: 0, width: 1, height: 1 };
  }
  const index = placement.index === undefined ? rects.length : Math.min(Math.max(placement.index, 0), rects.length);
  const y = index === 0 ? rects[0].top : rects[index - 1].top + rects[index - 1].height;
  return { kind: "line", top: clamp01((y - rect.top) / rect.height) };
}
