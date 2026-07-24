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

// Kept in sync with builtinLayouts.CLASSIC_LAYOUT_ID. Inlined (not imported) for
// the same reason layoutStore inlines it: importing builtinLayouts would pull
// React (via useProjectConfig) into this leaf module and its strip-types tests.
const CLASSIC_LAYOUT_ID = "builtin:classic";

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

// The split that holds `regionId` as a DIRECT child, or null (the region is the
// root, or does not exist).
function findParentSplit(node: LayoutNode, regionId: string): SplitNode | null {
  if (isRegion(node)) return null;
  for (const child of node.children) {
    if (isRegion(child) && child.id === regionId) return node;
  }
  for (const child of node.children) {
    const found = findParentSplit(child, regionId);
    if (found) return found;
  }
  return null;
}

// A direct child region's fraction within its parent split. A missing `size`
// means "equal share" — the same reading normalizeSizes uses.
function childFraction(parent: SplitNode, regionId: string): number {
  const equalShare = 1 / Math.max(1, parent.children.length);
  const child = parent.children.find((c) => isRegion(c) && c.id === regionId);
  return child !== undefined && child.size !== undefined ? child.size : equalShare;
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

  // SIZE ACCOUNTING — an untouched sibling must never change width.
  //
  // The new split inherits the target region's fraction, and its two halves share
  // it, so a plain split leaves every sibling alone. But when the drop takes the
  // LAST panel out of a sibling region, that region is deleted by normalizeTree
  // and its fraction is freed. normalizeSizes then spreads the freed space
  // PROPORTIONALLY over every survivor — including regions the user never
  // touched. Measured regression: a 3-column row at 0.25 / 0.25 / 0.5, dragging
  // the lone panel of column 1 onto column 2's edge, produced
  // 0.167 / 0.167 / 0.667 — the user dropped on the left and the RIGHT column
  // got wider.
  //
  // Fix: hand the vacated fraction to the new split up front, so the children
  // already sum to 1 and normalizeSizes has nothing to redistribute. The new
  // region effectively takes over the space of the column it emptied, which is
  // also what the gesture looks like. Only applies when the emptied region is an
  // immediate SIBLING of the target — across branches the vacated space belongs
  // to a different split's accounting and plain renormalization is correct there.
  const emptiesSource = !sameRegion && from.panels.length === 1;
  const parent = emptiesSource ? findParentSplit(root, from.id) : null;
  const siblings =
    parent !== null && parent.children.some((c) => isRegion(c) && c.id === targetRegion.id);
  const splitSize = siblings
    ? childFraction(parent, targetRegion.id) + childFraction(parent, from.id)
    : targetRegion.size;

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
    // The new split takes the target region's place, so it inherits its share
    // (plus any fraction vacated by a sibling this drop emptied — see above).
    if (splitSize !== undefined) split.size = splitSize;
    return split;
  });

  const out = normalizeTree(next);
  // Splitting is the only edit that can deepen the tree; refuse rather than
  // produce a tree layoutSpec's validator would reject on reload.
  if (depthOf(out) > MAX_DEPTH) return root;
  return out;
}

// ─── Effective topology ────────────────────────────────────────────────

// THE single source of truth for "what tree is actually on screen".
//
// A layout's rendered topology is the user's persisted rearrangement
// (`LayoutOverride.tree`) when there is one, otherwise the spec's own `root`.
// Everything that reads the tree — the renderer, the drop commit, "Save current
// as…" — must go through here so they can never disagree.
//
// Two hard guards:
//  1. `builtin:classic` ALWAYS resolves to its spec root. Classic renders
//     through WorkspaceLayout's hand-rolled flexbox branch and must stay
//     byte-identical; a tree override must never be able to reach it, even if
//     one somehow lands in localStorage.
//  2. An override whose PANEL SET differs from the spec's is discarded. Built-in
//     specs evolve (panels get added, renamed, removed); a stale override could
//     otherwise drop the scripture panel entirely or render panels the spec no
//     longer defines. Falling back to the spec is always safe.
export function effectiveRoot(
  spec: { id: string; root: LayoutNode },
  override?: { tree?: LayoutNode } | null,
): LayoutNode {
  if (spec.id === CLASSIC_LAYOUT_ID) return spec.root;
  const tree = override?.tree;
  if (!tree) return spec.root;
  const specIds = collectPanels(spec.root).map((p) => p.id).sort();
  const treeIds = collectPanels(tree).map((p) => p.id).sort();
  if (specIds.length !== treeIds.length) return spec.root;
  for (let i = 0; i < specIds.length; i++) {
    if (specIds[i] !== treeIds[i]) return spec.root;
  }
  return tree;
}

// Every persistence key a rendered tree can produce for `LayoutOverride.sizes`.
// MUST mirror WorkspaceLayout's `childId` path scheme exactly: only a split's
// CHILDREN carry a size, keyed by region id, or `split:<path>` for a nested
// split (splits have no id in the schema). `rootPath` seeds from the layout id,
// as WorkspaceLayout seeds `renderNode(spec.root, spec.id)`.
//
// Used to prune dead keys after a drop: a drop creates and destroys regions, so
// stale keys would otherwise accumulate forever — and `nextRegionId` recycles
// `region-<n>` ids, so a leftover key could later mis-size a brand-new region.
export function collectSizeKeys(root: LayoutNode, rootPath: string): Set<string> {
  const keys = new Set<string>();
  const walk = (node: LayoutNode, path: string): void => {
    if (isRegion(node)) return;
    node.children.forEach((child, i) => {
      const cpath = `${path}.${i}`;
      keys.add(isRegion(child) ? child.id : `split:${cpath}`);
      walk(child, cpath);
    });
  };
  walk(root, rootPath);
  return keys;
}

// Drop every `sizes` entry that the given tree can no longer produce a key for.
export function pruneSizes(
  sizes: Record<string, number>,
  root: LayoutNode,
  rootPath: string,
): Record<string, number> {
  const keys = collectSizeKeys(root, rootPath);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(sizes)) {
    if (keys.has(k)) out[k] = v;
  }
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
