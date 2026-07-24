// Pure tree edits for the flexible-layout model (layoutSpec v2).
//
// This is the correctness foundation for real tiled docking: a dragged panel can
// be dropped on a region's CENTER (join its panel list) or on a region's EDGE
// (split that region, panel lands in a fresh sibling region). Empty regions and
// single-child splits collapse away, so the topology the user ends up with is
// genuinely their own — that is why the store persists a whole tree rather than
// a patch over a fixed spec (see layoutStore.LayoutOverride.tree).
//
// NO PHYSICAL DIRECTIONS LIVE HERE. Drops are described with
// `orientation: "horizontal" | "vertical"` plus `side: "before" | "after"` only.
// Mapping a pointer position to an axis+side — and mirroring "before"/"after"
// for RTL — is the UI layer's job, not this module's. Introducing
// left/right/top/bottom here would bake in a writing direction.
//
// Every exported function is PURE: it never mutates its input and always
// returns new objects for anything it changes. No React, no DOM.

import {
  MAX_DEPTH,
  normalizeSizes,
  type Axis,
  type LayoutNode,
  type PanelInstance,
  type PanelRegion,
  type SplitNode,
} from "./layoutSpec.ts";

// Where a dragged panel should land.
export type DropPlacement =
  // Join the region's panel list. `index` is an insertion index into the target
  // region's panel list AS IT WILL EXIST AFTER the dragged panel has been
  // removed from wherever it currently lives (so a within-region reorder is
  // expressed in terms of the resulting list). Clamped to [0, length]; the
  // panel is appended when `index` is omitted.
  | { kind: "into"; index?: number }
  // Wrap the target region in a split; the panel goes into a NEW sibling region.
  | { kind: "split"; orientation: Axis; side: "before" | "after" };

export interface DropTarget {
  regionId: string;
  placement: DropPlacement;
}

function isRegion(node: LayoutNode): node is PanelRegion {
  return node.kind === "region";
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

// ─── Queries ───────────────────────────────────────────────────────────

// All regions, in tree order (depth-first, children left to right).
export function collectRegions(root: LayoutNode): PanelRegion[] {
  const out: PanelRegion[] = [];
  const walk = (node: LayoutNode): void => {
    if (isRegion(node)) {
      out.push(node);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

// All panels, in tree order.
export function collectPanels(root: LayoutNode): PanelInstance[] {
  const out: PanelInstance[] = [];
  for (const region of collectRegions(root)) out.push(...region.panels);
  return out;
}

// The region currently holding `panelId`, or null.
export function findPanelRegion(root: LayoutNode, panelId: string): PanelRegion | null {
  for (const region of collectRegions(root)) {
    if (region.panels.some((p) => p.id === panelId)) return region;
  }
  return null;
}

// Deepest node depth, with the root counted as depth 1 (matching layoutSpec's
// validator, whose MAX_DEPTH is expressed on the same scale).
function depthOf(node: LayoutNode, depth = 1): number {
  if (isRegion(node)) return depth;
  let max = depth;
  for (const child of node.children) max = Math.max(max, depthOf(child, depth + 1));
  return max;
}

// A fresh `region-<n>` id that collides with nothing in the tree. Deterministic:
// max existing `region-<n>` + 1, starting at region-1. Non-matching ids
// (`scripture`, `res-a`, …) can never collide with this shape, so they only need
// to be ignored, not avoided.
export function nextRegionId(root: LayoutNode): string {
  let max = 0;
  for (const region of collectRegions(root)) {
    const m = /^region-(\d+)$/.exec(region.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `region-${max + 1}`;
}

// ─── Normalization ─────────────────────────────────────────────────────

// One bottom-up canonicalization pass. Returns null when the subtree has
// nothing left to show (every region under it was empty).
function normalizeNode(node: LayoutNode): LayoutNode | null {
  if (isRegion(node)) return node.panels.length === 0 ? null : node;

  const kids: LayoutNode[] = [];
  const equalShare = 1 / Math.max(1, node.children.length);
  for (const child of node.children) {
    const norm = normalizeNode(child);
    if (!norm) continue; // empty region / emptied subtree drops out
    if (!isRegion(norm) && norm.orientation === node.orientation) {
      // Same-orientation nesting is redundant geometry: splice the grandchildren
      // in place, scaling their fractions by the child's own fraction so the
      // rendered proportions survive the flattening.
      const scale = norm.size !== undefined ? norm.size : equalShare;
      const innerShare = 1 / Math.max(1, norm.children.length);
      for (const grandchild of norm.children) {
        const own = grandchild.size !== undefined ? grandchild.size : innerShare;
        kids.push({ ...grandchild, size: own * scale });
      }
      continue;
    }
    kids.push(norm);
  }

  if (kids.length === 0) return null;
  if (kids.length === 1) {
    // A split needs >= 2 children to be valid; collapse it into its survivor,
    // which inherits the split's own fraction.
    const only = kids[0];
    return { ...only, size: node.size !== undefined ? node.size : only.size };
  }
  return { ...node, children: normalizeSizes(kids) };
}

// Canonicalize a tree. Applied after every edit, repeatedly until stable:
//  - regions with no panels are dropped;
//  - a split with one child is replaced by that child (which inherits its size);
//  - a split nested in a same-orientation split is flattened, proportions kept;
//  - every split's children are re-run through normalizeSizes (sizes sum to 1).
// A tree must always contain at least one region, so a fully emptied tree
// degrades to a single empty region rather than nothing.
export function normalizeTree(root: LayoutNode): LayoutNode {
  let current: LayoutNode = root;
  for (let i = 0; i < MAX_DEPTH + 2; i++) {
    const next = normalizeNode(current);
    if (!next) {
      // Nothing survived. Keep an empty region and reuse the original tree's
      // first region id (which is *the* region id when there was exactly one)
      // so overrides keyed by that id stay meaningful.
      const first = collectRegions(root)[0];
      return { kind: "region", id: first ? first.id : "region-1", display: "stacked", panels: [] };
    }
    if (JSON.stringify(next) === JSON.stringify(current)) return next;
    current = next;
  }
  return current;
}

// ─── Edits ─────────────────────────────────────────────────────────────

// Rebuild the tree, replacing each region with whatever `fn` returns for it.
// Returning the same object leaves that branch untouched.
function mapRegions(node: LayoutNode, fn: (region: PanelRegion) => LayoutNode): LayoutNode {
  if (isRegion(node)) return fn(node);
  const children = node.children.map((child) => mapRegions(child, fn));
  const changed = children.some((c, i) => c !== node.children[i]);
  return changed ? { ...node, children } : node;
}

// Move `panelId` to `target`. Returns the input tree unchanged when the panel or
// the target region does not exist, when the move is a no-op, or when it would
// push the tree past MAX_DEPTH. Never throws.
export function movePanel(root: LayoutNode, panelId: string, target: DropTarget): LayoutNode {
  const from = findPanelRegion(root, panelId);
  if (!from) return root;
  const panel = from.panels.find((p) => p.id === panelId);
  if (!panel) return root;
  const targetRegion = collectRegions(root).find((r) => r.id === target.regionId);
  if (!targetRegion) return root;

  const placement = target.placement;
  const sameRegion = targetRegion.id === from.id;

  if (placement.kind === "into") {
    const remaining = sameRegion
      ? targetRegion.panels.filter((p) => p.id !== panelId)
      : targetRegion.panels;
    const index =
      placement.index === undefined
        ? remaining.length
        : clamp(placement.index, 0, remaining.length);
    if (sameRegion) {
      // No-op guard: re-inserting at the slot the panel already occupies
      // reproduces the existing order exactly.
      const current = from.panels.findIndex((p) => p.id === panelId);
      if (index === current) return root;
    }
    const next = mapRegions(root, (region) => {
      let panels = region.panels;
      if (region.id === from.id) panels = panels.filter((p) => p.id !== panelId);
      if (region.id === target.regionId) {
        const copy = panels.slice();
        copy.splice(index, 0, panel);
        panels = copy;
      }
      return panels === region.panels ? region : { ...region, panels };
    });
    return normalizeTree(next);
  }

  // No-op guard: splitting a region off its own only panel just recreates the
  // same geometry wrapped in a pointless extra split.
  if (sameRegion && from.panels.length === 1) return root;

  const newRegion: PanelRegion = {
    kind: "region",
    id: nextRegionId(root),
    size: 0.5,
    display: "stacked",
    panels: [panel],
  };
  const next = mapRegions(root, (region) => {
    let kept: PanelRegion = region;
    if (region.id === from.id) {
      kept = { ...region, panels: region.panels.filter((p) => p.id !== panelId) };
    }
    if (region.id !== target.regionId) return kept;
    const inner: PanelRegion = { ...kept, size: 0.5 };
    const split: SplitNode = {
      kind: "split",
      orientation: placement.orientation,
      children: placement.side === "before" ? [newRegion, inner] : [inner, newRegion],
    };
    // The new split takes the target region's place, so it inherits its share.
    if (region.size !== undefined) split.size = region.size;
    return split;
  });

  const out = normalizeTree(next);
  // Splitting is the only edit that can deepen the tree; refuse rather than
  // produce a tree layoutSpec's validator would reject on reload.
  if (depthOf(out) > MAX_DEPTH) return root;
  return out;
}

// Remove `panelId` from the tree (and collapse whatever that empties).
export function removePanel(root: LayoutNode, panelId: string): LayoutNode {
  const from = findPanelRegion(root, panelId);
  if (!from) return root;
  const next = mapRegions(root, (region) =>
    region.id === from.id
      ? { ...region, panels: region.panels.filter((p) => p.id !== panelId) }
      : region,
  );
  return normalizeTree(next);
}
