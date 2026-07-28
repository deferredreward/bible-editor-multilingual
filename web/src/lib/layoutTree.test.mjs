// Tests for layoutTree.ts — pure tree edits (drag a panel into / beside a
// region) plus canonicalization. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/layoutTree.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors src/lib/layoutSpec.test.mjs.

import {
  canHideRegion,
  collectPanels,
  collectRegions,
  collectSizeKeys,
  effectiveRoot,
  findPanelRegion,
  hiddenRegions,
  isNodeVisible,
  isRegionHidden,
  movePanel,
  nextRegionId,
  normalizeTree,
  pruneSizes,
  removePanel,
  resolveHidden,
} from "./layoutTree.ts";
import { MAX_DEPTH } from "./layoutSpec.ts";

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

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const ids = (region) => region.panels.map((p) => p.id);
const clone = (x) => JSON.parse(JSON.stringify(x));

// Every split's children sizes must sum to ~1 after any operation.
function assertSizesSumToOne(node, label) {
  const walk = (n, path) => {
    if (n.kind !== "split") return true;
    const total = n.children.reduce((a, c) => a + (c.size ?? NaN), 0);
    let ok = near(total, 1, 1e-9);
    if (!ok) console.error(`  (split at ${path} sums to ${total})`);
    for (let i = 0; i < n.children.length; i++) {
      ok = walk(n.children[i], `${path}/${i}`) && ok;
    }
    return ok;
  };
  assert(walk(node, "root"), `${label}: every split's sizes sum to 1`);
}

// Shaped like the `flexible` built-in: vertical split → [scripture region,
// horizontal split → [res-a, res-b]]. Fresh each call.
const fixture = () => ({
  kind: "split",
  orientation: "vertical",
  children: [
    {
      kind: "region",
      id: "scripture",
      size: 0.4,
      panels: [{ id: "scripture-1", type: "scripture", config: { mode: "columns" } }],
    },
    {
      kind: "split",
      orientation: "horizontal",
      size: 0.6,
      children: [
        {
          kind: "region",
          id: "res-a",
          size: 0.5,
          display: "stacked",
          panels: [
            { id: "notes-1", type: "notes" },
            { id: "ta-1", type: "taArticle" },
          ],
        },
        {
          kind: "region",
          id: "res-b",
          size: 0.5,
          display: "stacked",
          panels: [
            { id: "words-1", type: "words" },
            { id: "tw-1", type: "twArticle" },
            { id: "questions-1", type: "questions" },
          ],
        },
      ],
    },
  ],
});

const regionById = (root, id) => collectRegions(root).find((r) => r.id === id);

// ─── Queries ───────────────────────────────────────────────────────────
{
  console.log("\n[queries] collectRegions / collectPanels / findPanelRegion");
  const root = fixture();
  assert(
    collectRegions(root).map((r) => r.id).join(",") === "scripture,res-a,res-b",
    "regions in tree order",
  );
  assert(
    collectPanels(root).map((p) => p.id).join(",") ===
      "scripture-1,notes-1,ta-1,words-1,tw-1,questions-1",
    "panels in tree order",
  );
  assert(findPanelRegion(root, "tw-1")?.id === "res-b", "findPanelRegion locates tw-1 in res-b");
  assert(findPanelRegion(root, "scripture-1")?.id === "scripture", "finds scripture-1");
  assert(findPanelRegion(root, "nope") === null, "unknown panel → null");

  // A bare region root is a legal tree.
  const solo = { kind: "region", id: "only", panels: [{ id: "n", type: "notes" }] };
  assert(collectRegions(solo).length === 1, "region-only root yields one region");
  assert(collectPanels(solo).length === 1, "region-only root yields its panel");
}

// ─── into: between sibling regions ─────────────────────────────────────
{
  console.log("\n[into] move a panel to a sibling region (append)");
  const root = fixture();
  const out = movePanel(root, "notes-1", { regionId: "res-b", placement: { kind: "into" } });
  assert(ids(regionById(out, "res-a")).join(",") === "ta-1", "source region lost notes-1");
  assert(
    ids(regionById(out, "res-b")).join(",") === "words-1,tw-1,questions-1,notes-1",
    "target region appended notes-1 last",
  );
  assert(collectPanels(out).length === 6, "no panel lost");
  assertSizesSumToOne(out, "into/append");
}
{
  console.log("\n[into] move a panel to a sibling region at an explicit index");
  const root = fixture();
  const out = movePanel(root, "notes-1", { regionId: "res-b", placement: { kind: "into", index: 1 } });
  assert(
    ids(regionById(out, "res-b")).join(",") === "words-1,notes-1,tw-1,questions-1",
    "inserted at index 1",
  );
  const clamped = movePanel(root, "notes-1", {
    regionId: "res-b",
    placement: { kind: "into", index: 99 },
  });
  assert(
    ids(regionById(clamped, "res-b")).join(",") === "words-1,tw-1,questions-1,notes-1",
    "out-of-range index clamps to append",
  );
  const negative = movePanel(root, "notes-1", {
    regionId: "res-b",
    placement: { kind: "into", index: -5 },
  });
  assert(
    ids(regionById(negative, "res-b")).join(",") === "notes-1,words-1,tw-1,questions-1",
    "negative index clamps to 0",
  );
}

// ─── into: reorder within one region ───────────────────────────────────
{
  console.log("\n[into] reorder inside a single region");
  const root = fixture();
  // Index is an insertion index into the post-removal list: [tw-1, questions-1].
  const out = movePanel(root, "words-1", { regionId: "res-b", placement: { kind: "into", index: 2 } });
  assert(ids(regionById(out, "res-b")).join(",") === "tw-1,questions-1,words-1", "moved to the end");
  const mid = movePanel(root, "words-1", { regionId: "res-b", placement: { kind: "into", index: 1 } });
  assert(ids(regionById(mid, "res-b")).join(",") === "tw-1,words-1,questions-1", "moved to the middle");
  const up = movePanel(root, "questions-1", {
    regionId: "res-b",
    placement: { kind: "into", index: 0 },
  });
  assert(ids(regionById(up, "res-b")).join(",") === "questions-1,words-1,tw-1", "moved to the front");
  assert(collectRegions(out).length === 3, "reorder does not change region count");
}

// ─── split: all four orientation × side combinations ───────────────────
{
  console.log("\n[split] horizontal, before/after — target is a vertical split's child");
  // `scripture` sits under the VERTICAL root split, so a horizontal split there
  // survives normalization intact (no same-orientation flattening).
  for (const side of ["before", "after"]) {
    const root = fixture();
    const out = movePanel(root, "notes-1", {
      regionId: "scripture",
      placement: { kind: "split", orientation: "horizontal", side },
    });
    const node = out.children[0];
    assert(node.kind === "split" && node.orientation === "horizontal", `${side}: new split in place`);
    assert(near(node.size, 0.4), `${side}: new split inherited the target's size 0.4`);
    assert(node.children.length === 2, `${side}: split has two children`);
    assert(
      near(node.children[0].size, 0.5) && near(node.children[1].size, 0.5),
      `${side}: children are 0.5 / 0.5`,
    );
    const [first, second] = node.children;
    const kept = side === "before" ? second : first;
    const fresh = side === "before" ? first : second;
    assert(kept.id === "scripture", `${side}: target region kept its id`);
    assert(ids(kept).join(",") === "scripture-1", `${side}: target region kept its panels`);
    assert(fresh.kind === "region" && fresh.id === "region-1", `${side}: fresh region id region-1`);
    assert(ids(fresh).join(",") === "notes-1", `${side}: fresh region holds only the dragged panel`);
    assert(fresh.display === "stacked", `${side}: fresh region is stacked`);
    assert(ids(regionById(out, "res-a")).join(",") === "ta-1", `${side}: source region lost notes-1`);
    assertSizesSumToOne(out, `split/horizontal/${side}`);
  }
}
{
  console.log("\n[split] vertical, before/after — flattens into the same-orientation parent");
  for (const side of ["before", "after"]) {
    const root = fixture();
    const out = movePanel(root, "notes-1", {
      regionId: "scripture",
      placement: { kind: "split", orientation: "vertical", side },
    });
    assert(out.kind === "split" && out.orientation === "vertical", `${side}: root still vertical`);
    assert(out.children.length === 3, `${side}: grandchildren spliced into the root split`);
    const order = out.children.map((c) => (c.kind === "region" ? c.id : "split"));
    const expected =
      side === "before" ? "region-1,scripture,split" : "scripture,region-1,split";
    assert(order.join(",") === expected, `${side}: order is ${expected}`);
    const sizeOf = (id) => out.children.find((c) => c.kind === "region" && c.id === id).size;
    assert(near(sizeOf("region-1"), 0.2) && near(sizeOf("scripture"), 0.2), `${side}: 0.4 halved to 0.2 each`);
    assert(near(out.children.find((c) => c.kind === "split").size, 0.6), `${side}: sibling keeps 0.6`);
    assertSizesSumToOne(out, `split/vertical/${side}`);
  }
}

// ─── collapsing ────────────────────────────────────────────────────────
{
  console.log("\n[collapse] dragging the last panel out drops the region and its parent split");
  const root = fixture();
  const out = movePanel(root, "scripture-1", { regionId: "res-a", placement: { kind: "into" } });
  // scripture region emptied → dropped → root vertical split has one child left
  // → collapsed into that child (the horizontal resource split).
  assert(out.kind === "split" && out.orientation === "horizontal", "root is now the horizontal split");
  assert(out.children.length === 2, "which has its two regions");
  assert(
    out.children.map((c) => c.id).join(",") === "res-a,res-b",
    "regions are res-a and res-b",
  );
  assert(regionById(out, "scripture") === undefined, "emptied scripture region is gone");
  assert(
    ids(regionById(out, "res-a")).join(",") === "notes-1,ta-1,scripture-1",
    "dragged panel landed in res-a",
  );
  assert(near(out.size, 0.6), "collapsed child kept its own 0.6 (parent had no size)");
  assertSizesSumToOne(out, "collapse");
}
{
  console.log("\n[collapse] removePanel empties a region and collapses the split");
  const root = fixture();
  const out = removePanel(root, "scripture-1");
  assert(out.kind === "split" && out.orientation === "horizontal", "root collapsed to the resource split");
  assert(collectPanels(out).length === 5, "one panel removed");
  assert(removePanel(root, "nope") === root, "removing an unknown panel returns the input");
  assertSizesSumToOne(out, "removePanel");
}
{
  console.log("\n[collapse] emptying the whole tree leaves one empty region");
  const solo = {
    kind: "region",
    id: "scripture",
    size: 0.4,
    panels: [{ id: "scripture-1", type: "scripture" }],
  };
  const out = removePanel(solo, "scripture-1");
  assert(out.kind === "region" && out.panels.length === 0, "single empty region survives");
  assert(out.id === "scripture", "the sole region's id is preserved");
}

// ─── normalizeTree: same-orientation flattening keeps proportions ──────
{
  console.log("\n[normalize] same-orientation nesting flattens with proportions preserved");
  const root = {
    kind: "split",
    orientation: "vertical",
    children: [
      { kind: "region", id: "a", size: 0.4, panels: [{ id: "p-a", type: "notes" }] },
      {
        kind: "split",
        orientation: "vertical",
        size: 0.6,
        children: [
          { kind: "region", id: "g1", size: 0.5, panels: [{ id: "p-g1", type: "words" }] },
          { kind: "region", id: "g2", size: 0.5, panels: [{ id: "p-g2", type: "questions" }] },
        ],
      },
    ],
  };
  const out = normalizeTree(root);
  assert(out.children.length === 3, "grandchildren spliced in place");
  assert(out.children.map((c) => c.id).join(",") === "a,g1,g2", "order preserved");
  assert(near(out.children[0].size, 0.4), "a keeps 0.4");
  assert(near(out.children[1].size, 0.3) && near(out.children[2].size, 0.3), "0.6 × 0.5 → 0.3 each");
  assertSizesSumToOne(out, "flatten");

  console.log("\n[normalize] a split with a single child collapses and inherits its size");
  const single = {
    kind: "split",
    orientation: "horizontal",
    size: 0.7,
    children: [
      { kind: "region", id: "empty", panels: [] },
      { kind: "region", id: "kept", size: 0.25, panels: [{ id: "p", type: "notes" }] },
    ],
  };
  const collapsed = normalizeTree(single);
  assert(collapsed.kind === "region" && collapsed.id === "kept", "collapsed to the surviving region");
  assert(near(collapsed.size, 0.7), "survivor inherited the split's size");

  console.log("\n[normalize] cross-orientation nesting is left alone");
  const mixed = fixture();
  const same = normalizeTree(mixed);
  assert(same.children.length === 2, "flexible fixture keeps its two root children");
  assert(same.children[1].kind === "split", "inner horizontal split survives under a vertical parent");
  assertSizesSumToOne(same, "cross-orientation");
}

// ─── No-op guards ──────────────────────────────────────────────────────
{
  console.log("\n[no-op] into the same region at the slot it already occupies");
  const root = fixture();
  assert(
    movePanel(root, "words-1", { regionId: "res-b", placement: { kind: "into", index: 0 } }) === root,
    "words-1 → res-b index 0 (its current slot) is a no-op",
  );
  assert(
    movePanel(root, "tw-1", { regionId: "res-b", placement: { kind: "into", index: 1 } }) === root,
    "tw-1 → res-b index 1 (its current slot) is a no-op",
  );
  assert(
    movePanel(root, "questions-1", { regionId: "res-b", placement: { kind: "into" } }) === root,
    "appending the panel that is already last is a no-op",
  );
  // ...but appending a non-last panel is a real move.
  assert(
    movePanel(root, "words-1", { regionId: "res-b", placement: { kind: "into" } }) !== root,
    "appending a non-last panel is not a no-op",
  );

  console.log("\n[no-op] splitting a region off its own only panel");
  for (const orientation of ["horizontal", "vertical"]) {
    for (const side of ["before", "after"]) {
      assert(
        movePanel(root, "scripture-1", {
          regionId: "scripture",
          placement: { kind: "split", orientation, side },
        }) === root,
        `scripture-1 split ${orientation}/${side} on its own sole region is a no-op`,
      );
    }
  }
  // Splitting the same region is fine when the region has other panels.
  assert(
    movePanel(root, "notes-1", {
      regionId: "res-a",
      placement: { kind: "split", orientation: "vertical", side: "after" },
    }) !== root,
    "splitting off one of two panels in the same region is a real move",
  );
}

// ─── Unknown ids ───────────────────────────────────────────────────────
{
  console.log("\n[unknown] unknown panel / region ids return the input tree");
  const root = fixture();
  assert(
    movePanel(root, "ghost-1", { regionId: "res-b", placement: { kind: "into" } }) === root,
    "unknown panelId returns the input",
  );
  assert(
    movePanel(root, "notes-1", { regionId: "ghost-region", placement: { kind: "into" } }) === root,
    "unknown regionId returns the input",
  );
  assert(
    movePanel(root, "notes-1", {
      regionId: "ghost-region",
      placement: { kind: "split", orientation: "vertical", side: "before" },
    }) === root,
    "unknown regionId returns the input for split too",
  );
}

// ─── MAX_DEPTH refusal ─────────────────────────────────────────────────
{
  console.log("\n[max-depth] a split that would exceed MAX_DEPTH (8) is refused");
  // Alternating orientations so nothing flattens; every region carries two
  // panels so removing one never collapses a region (which would free up depth).
  const deep = (levels) => {
    let node = {
      kind: "region",
      id: "leaf",
      panels: [
        { id: "leaf-a", type: "notes" },
        { id: "leaf-b", type: "words" },
      ],
    };
    for (let i = levels - 1; i >= 1; i--) {
      node = {
        kind: "split",
        orientation: i % 2 === 1 ? "horizontal" : "vertical",
        children: [
          {
            kind: "region",
            id: `r${i}`,
            panels: [
              { id: `q-${i}-a`, type: "questions" },
              { id: `q-${i}-b`, type: "twArticle" },
            ],
          },
          node,
        ],
      };
    }
    return node;
  };
  const root = deep(8); // splits at depths 1..7, leaf regions at depths 2..8
  const refused = movePanel(root, "q-2-a", {
    regionId: "leaf",
    placement: { kind: "split", orientation: "vertical", side: "after" },
  });
  assert(refused === root, "splitting a depth-8 region is refused (tree unchanged)");
  const allowed = movePanel(root, "q-2-a", {
    regionId: "r1",
    placement: { kind: "split", orientation: "vertical", side: "after" },
  });
  assert(allowed !== root, "splitting a shallow region is still allowed");
  assert(collectPanels(allowed).length === collectPanels(root).length, "no panel lost by the allowed split");
  assertSizesSumToOne(allowed, "max-depth/allowed");
}

// ─── nextRegionId ──────────────────────────────────────────────────────
{
  console.log("\n[nextRegionId] deterministic, collision-free");
  assert(nextRegionId(fixture()) === "region-1", "no region-<n> ids yet → region-1");
  const withThree = {
    kind: "split",
    orientation: "horizontal",
    children: [
      { kind: "region", id: "region-3", panels: [{ id: "a", type: "notes" }] },
      { kind: "region", id: "res-b", panels: [{ id: "b", type: "words" }] },
    ],
  };
  assert(nextRegionId(withThree) === "region-4", "region-3 present but not 1/2 → region-4");
  const many = {
    kind: "split",
    orientation: "horizontal",
    children: [
      { kind: "region", id: "region-1", panels: [{ id: "a", type: "notes" }] },
      { kind: "region", id: "region-10", panels: [{ id: "b", type: "words" }] },
      { kind: "region", id: "region-x", panels: [{ id: "c", type: "questions" }] },
    ],
  };
  assert(nextRegionId(many) === "region-11", "max+1 across numeric ids, non-numeric ignored");
  assert(
    nextRegionId({ kind: "region", id: "scripture", panels: [] }) === "region-1",
    "non-matching id like `scripture` does not block region-1",
  );
}

// ─── Purity ────────────────────────────────────────────────────────────
{
  console.log("\n[purity] no operation mutates its input");
  const ops = [
    ["into/append", (r) => movePanel(r, "notes-1", { regionId: "res-b", placement: { kind: "into" } })],
    [
      "into/index",
      (r) => movePanel(r, "words-1", { regionId: "res-a", placement: { kind: "into", index: 0 } }),
    ],
    [
      "split/h/before",
      (r) =>
        movePanel(r, "notes-1", {
          regionId: "scripture",
          placement: { kind: "split", orientation: "horizontal", side: "before" },
        }),
    ],
    [
      "split/v/after",
      (r) =>
        movePanel(r, "questions-1", {
          regionId: "scripture",
          placement: { kind: "split", orientation: "vertical", side: "after" },
        }),
    ],
    ["removePanel", (r) => removePanel(r, "scripture-1")],
    ["normalizeTree", (r) => normalizeTree(r)],
    ["collectPanels", (r) => collectPanels(r)],
    ["nextRegionId", (r) => nextRegionId(r)],
  ];
  for (const [label, op] of ops) {
    const root = fixture();
    const before = JSON.stringify(root);
    op(root);
    assert(JSON.stringify(root) === before, `${label} left the input tree byte-identical`);
  }
  // The returned tree is independent of the input, too.
  const root = fixture();
  const snapshot = JSON.stringify(root);
  const out = movePanel(root, "notes-1", { regionId: "res-b", placement: { kind: "into" } });
  const outRegion = regionById(out, "res-b");
  outRegion.panels.push({ id: "intruder", type: "search" });
  assert(JSON.stringify(root) === snapshot, "mutating the OUTPUT does not reach the input");
  assert(clone(root) !== root, "sanity: clone helper works");
}

console.log("\neffectiveRoot - the single source of truth for the rendered tree");
{
  const spec = { id: "builtin:flexible", root: fixture() };
  assert(effectiveRoot(spec, undefined) === spec.root, "no override -> the spec's own root");
  assert(effectiveRoot(spec, {}) === spec.root, "override with no tree -> the spec's own root");

  // A valid rearrangement (same panels, different topology) is honoured.
  const rearranged = movePanel(spec.root, "notes-1", {
    regionId: "res-b",
    placement: { kind: "into", index: 0 },
  });
  assert(rearranged !== spec.root, "sanity: the rearrangement really differs");
  assert(
    effectiveRoot(spec, { tree: rearranged }) === rearranged,
    "override tree with the same panel SET -> the override wins",
  );

  // THE CLASSIC INVARIANT: a tree override can never reach builtin:classic.
  const classicSpec = { id: "builtin:classic", root: fixture() };
  assert(
    effectiveRoot(classicSpec, { tree: rearranged }) === classicSpec.root,
    "builtin:classic ALWAYS resolves to its spec root, override or not",
  );

  // A stale override (spec panels changed) is discarded rather than rendered.
  const missingPanel = removePanel(rearranged, "questions-1");
  assert(
    effectiveRoot(spec, { tree: missingPanel }) === spec.root,
    "override missing a spec panel -> fall back to the spec root",
  );
  const extra = clone(rearranged);
  regionById(extra, "res-b").panels.push({ id: "ghost-1", type: "search" });
  assert(
    effectiveRoot(spec, { tree: extra }) === spec.root,
    "override with an extra panel -> fall back to the spec root",
  );
}

console.log("\ncollectSizeKeys / pruneSizes mirror WorkspaceLayout's childId scheme");
{
  const keys = collectSizeKeys(fixture(), "builtin:flexible");
  // Root vertical split's children: region `scripture` plus a nested split at
  // path builtin:flexible.1 -> `split:builtin:flexible.1`; that split's children
  // are the two regions.
  const expected = ["scripture", "split:builtin:flexible.1", "res-a", "res-b"].sort();
  eqArr([...keys].sort(), expected, "every split child yields exactly one size key");

  const pruned = pruneSizes(
    { scripture: 0.3, "res-a": 0.4, "region-9": 0.5, "split:stale.0": 0.6 },
    fixture(),
    "builtin:flexible",
  );
  eqArr(
    Object.keys(pruned).sort(),
    ["res-a", "scripture"],
    "pruneSizes drops keys the tree can no longer produce (dead regions + dead split paths)",
  );
  assert(pruned.scripture === 0.3 && pruned["res-a"] === 0.4, "surviving values are untouched");

  // The real motivation: a drop that EMPTIES a region deletes it, so its key must
  // go with it. Drag both of res-a's panels into res-b and res-a disappears.
  const step1 = movePanel(fixture(), "notes-1", {
    regionId: "res-b",
    placement: { kind: "into" },
  });
  const afterDrop = movePanel(step1, "ta-1", { regionId: "res-b", placement: { kind: "into" } });
  assert(!collectRegions(afterDrop).some((r) => r.id === "res-a"), "sanity: res-a was emptied and collapsed away");
  const survivors = pruneSizes(
    { "res-a": 0.5, "res-b": 0.5, scripture: 0.4 },
    afterDrop,
    "builtin:flexible",
  );
  assert(
    !("res-a" in survivors),
    "a region emptied by the drop loses its sizes key (nextRegionId recycles ids)",
  );
}

console.log("\n[sizes] a split must never change an UNTOUCHED sibling's fraction");
{
  // Ordered [id, size] pairs of a split's direct children.
  const sharesOf = (node) =>
    node.children.map((c) => [c.kind === "region" ? c.id : "split", c.size]);

  // Two sibling regions at 0.5 / 0.5. Splitting the FIRST along the SAME
  // orientation flattens into three siblings; the two halves share the 0.5 that
  // the split region used to hold, and the sibling keeps its 0.5 exactly.
  const pair = (aSize, bSize) => ({
    kind: "split",
    orientation: "horizontal",
    children: [
      {
        kind: "region",
        id: "a",
        size: aSize,
        panels: [{ id: "p1", type: "notes" }, { id: "p2", type: "words" }],
      },
      { kind: "region", id: "b", size: bSize, panels: [{ id: "p3", type: "questions" }] },
    ],
  });

  const before = movePanel(pair(0.5, 0.5), "p2", {
    regionId: "a",
    placement: { kind: "split", orientation: "horizontal", side: "before" },
  });
  eqArr(
    sharesOf(before),
    [["region-1", 0.25], ["a", 0.25], ["b", 0.5]],
    "side:before -> 0.25 / 0.25 / 0.5 in that order, sibling 'b' untouched",
  );
  assert(before.children[2].size === 0.5, "side:before: 'b' is EXACTLY 0.5, not merely close");

  const after = movePanel(pair(0.5, 0.5), "p2", {
    regionId: "a",
    placement: { kind: "split", orientation: "horizontal", side: "after" },
  });
  eqArr(
    sharesOf(after),
    [["a", 0.25], ["region-1", 0.25], ["b", 0.5]],
    "side:after -> the mirror: 0.25 / 0.25 / 0.5, new region second",
  );
  assert(after.children[2].size === 0.5, "side:after: 'b' is EXACTLY 0.5");

  // Uneven sizes: the untouched sibling must keep its exact fraction, not a
  // renormalized approximation of it.
  const uneven = movePanel(pair(0.3, 0.7), "p2", {
    regionId: "a",
    placement: { kind: "split", orientation: "horizontal", side: "before" },
  });
  eqArr(
    sharesOf(uneven),
    [["region-1", 0.15], ["a", 0.15], ["b", 0.7]],
    "0.3 / 0.7 -> 0.15 / 0.15 / 0.7",
  );
  assert(uneven.children[2].size === 0.7, "uneven: 'b' is EXACTLY 0.7");
  assertSizesSumToOne(uneven, "uneven split");
}

console.log("\n[sizes] REGRESSION: a drop that EMPTIES a sibling region");
{
  // Observed in the browser (PR B): a 3-column row at 0.25 / 0.25 / 0.5. Dragging
  // the LONE panel of column 1 onto column 2's inline-start edge deleted column 1
  // and freed its 0.25 — which normalizeSizes then spread PROPORTIONALLY over
  // every survivor, giving 0.167 / 0.167 / 0.667. The user dropped on the left
  // column and the untouched RIGHT column got wider.
  //
  // Correct behaviour: the new region takes over the vacated 0.25, column 2 keeps
  // its 0.25, and the untouched column 3 keeps EXACTLY 0.5.
  const threeCols = () => ({
    kind: "split",
    orientation: "horizontal",
    children: [
      { kind: "region", id: "c1", size: 0.25, panels: [{ id: "lone-1", type: "questions" }] },
      {
        kind: "region",
        id: "c2",
        size: 0.25,
        panels: [{ id: "notes-1", type: "notes" }, { id: "ta-1", type: "taArticle" }],
      },
      { kind: "region", id: "c3", size: 0.5, panels: [{ id: "words-1", type: "words" }] },
    ],
  });

  const out = movePanel(threeCols(), "lone-1", {
    regionId: "c2",
    placement: { kind: "split", orientation: "horizontal", side: "before" },
  });
  const shares = out.children.map((c) => [c.kind === "region" ? c.id : "split", c.size]);
  eqArr(
    shares,
    [["region-1", 0.25], ["c2", 0.25], ["c3", 0.5]],
    "emptied sibling's fraction goes to the NEW region, not to everyone",
  );
  assert(
    out.children[2].size === 0.5,
    "the untouched third column is EXACTLY 0.5 (was 0.667 before the fix)",
  );
  assert(
    !collectRegions(out).some((r) => r.id === "c1"),
    "the emptied column is gone from the tree",
  );
  assert(collectPanels(out).length === 4, "no panel lost");
  assertSizesSumToOne(out, "emptied-sibling drop");

  // The same drop with side:"after" keeps the invariant.
  const outAfter = movePanel(threeCols(), "lone-1", {
    regionId: "c2",
    placement: { kind: "split", orientation: "horizontal", side: "after" },
  });
  assert(
    outAfter.children[2].size === 0.5,
    "side:after on the emptied-sibling case also leaves column 3 at exactly 0.5",
  );

  // ACROSS branches there is no sibling accounting to preserve: the emptied
  // region's parent collapses on its own, and plain renormalization is correct.
  // Pinned so the compensation cannot leak into that case.
  const crossBranch = movePanel(fixture(), "scripture-1", {
    regionId: "res-a",
    placement: { kind: "split", orientation: "horizontal", side: "before" },
  });
  assert(
    !collectRegions(crossBranch).some((r) => r.id === "scripture"),
    "cross-branch: the emptied scripture region is gone",
  );
  assertSizesSumToOne(crossBranch, "cross-branch drop");
  const resB = regionById(crossBranch, "res-b");
  assert(resB.size === 0.5, `cross-branch: res-b keeps 0.5 (got ${resB.size})`);
}

// ─── outer (perimeter) drops ───────────────────────────────────────────
console.log("\n[outer] THE REGRESSION: recovering the full-width band after emptying it");
{
  // The bug the perimeter drop exists to fix, end to end. Reported as: "the only
  // thing I can't see how to do is to access the full width top section once I've
  // moved scripture out of it."
  //
  // Step 1 — the bug state. Moving scripture-1 into res-a empties the `scripture`
  // region, so normalizeTree deletes it, the root vertical split is left with one
  // child, and that collapses: the root becomes a plain HORIZONTAL split of
  // res-a | res-b. No full-width region exists any more, and since every
  // region-scoped drop can only split a region that still exists, no gesture
  // could rebuild one (a column's top edge splits that column, not the width).
  const bug = movePanel(fixture(), "scripture-1", { regionId: "res-a", placement: { kind: "into" } });
  assert(
    bug.kind === "split" && bug.orientation === "horizontal",
    "bug state: the root collapsed to a horizontal split",
  );
  eqArr(collectRegions(bug).map((r) => r.id), ["res-a", "res-b"], "bug state: only the two columns remain");
  assert(ids(regionById(bug, "res-a")).join(",") === "notes-1,ta-1,scripture-1", "bug state: scripture-1 is in res-a");

  // Step 2 — the fix. An outer vertical/before drop wraps the WHOLE tree.
  const fixed = movePanel(bug, "scripture-1", { kind: "outer", orientation: "vertical", side: "before" });
  assert(fixed.kind === "split" && fixed.orientation === "vertical", "recovered: root is a vertical split");
  assert(fixed.children.length === 2, "recovered: root has two children");
  const band = fixed.children[0];
  assert(band.kind === "region", "recovered: the FIRST child is a region (the band)");
  assert(ids(band).join(",") === "scripture-1", "recovered: the band holds only scripture-1");
  assert(band.size === 0.4, `recovered: the band is EXACTLY 0.4 (got ${band.size})`);
  const below = fixed.children[1];
  assert(
    below.kind === "split" && below.orientation === "horizontal",
    "recovered: the horizontal res-a|res-b split sits below the band",
  );
  assert(near(below.size, 0.6), `recovered: the content keeps the remainder 0.6 (got ${below.size})`);
  eqArr(
    collectRegions(below).map((r) => r.id),
    ["res-a", "res-b"],
    "recovered: the two columns are untouched below",
  );
  assert(collectPanels(fixed).length === 6, "recovered: no panel lost");
  assert(ids(regionById(fixed, "res-a")).join(",") === "notes-1,ta-1", "recovered: res-a gave scripture-1 back");
  assertSizesSumToOne(fixed, "outer vertical/before recovery");
}

console.log("\n[outer] all four axis × side combinations");
{
  // side:"after" on the block axis → a BOTTOM band, panel last.
  const bottom = movePanel(fixture(), "notes-1", { kind: "outer", orientation: "vertical", side: "after" });
  const last = bottom.children[bottom.children.length - 1];
  assert(last.kind === "region" && ids(last).join(",") === "notes-1", "vertical/after: the band is the LAST child");
  assert(last.size === 0.4, `vertical/after: band is 0.4 (got ${last.size})`);

  // The inline axis is a narrower side COLUMN (0.3), not a 0.4 band.
  for (const side of ["before", "after"]) {
    const out = movePanel(fixture(), "notes-1", { kind: "outer", orientation: "horizontal", side });
    assert(out.kind === "split" && out.orientation === "horizontal", `horizontal/${side}: root is a horizontal split`);
    const fresh = side === "before" ? out.children[0] : out.children[out.children.length - 1];
    assert(fresh.kind === "region" && ids(fresh).join(",") === "notes-1", `horizontal/${side}: panel is on the right side`);
    assert(fresh.size === 0.3, `horizontal/${side}: a side column is 0.3 (got ${fresh.size})`);
    const kept = side === "before" ? out.children[1] : out.children[0];
    assert(near(kept.size, 0.7), `horizontal/${side}: the existing tree keeps 0.7 (got ${kept.size})`);
    assert(kept.kind === "split" && kept.orientation === "vertical", `horizontal/${side}: the whole old tree is the other child`);
    assert(collectPanels(out).length === 6, `horizontal/${side}: no panel lost`);
    assertSizesSumToOne(out, `outer horizontal/${side}`);
  }
}

console.log("\n[outer] a root that is ALREADY the same orientation gets a SIBLING, not a nested split");
{
  // fixture()'s root is a vertical split, so an outer VERTICAL drop must prepend
  // the new band as a third sibling — not wrap a redundant same-orientation level.
  const out = movePanel(fixture(), "notes-1", { kind: "outer", orientation: "vertical", side: "before" });
  assert(out.kind === "split" && out.orientation === "vertical", "root stays one vertical split");
  assert(out.children.length === 3, `flattened into 3 siblings (got ${out.children.length})`);
  assert(out.children[0].kind === "region" && ids(out.children[0]).join(",") === "notes-1", "band is first");
  assert(out.children[0].size === 0.4, `band keeps 0.4 (got ${out.children[0].size})`);
  assert(out.children[1].id === "scripture", "scripture follows the band");
  assert(out.children[2].kind === "split", "the resource split follows scripture");
  // Proportions survive the flattening: the old 0.4 / 0.6 pair is scaled by 0.6.
  assert(near(out.children[1].size, 0.24), `scripture scaled to 0.24 (got ${out.children[1].size})`);
  assert(near(out.children[2].size, 0.36), `resource split scaled to 0.36 (got ${out.children[2].size})`);
  assertSizesSumToOne(out, "outer same-orientation flattening");
  // Nothing nested a same-orientation split anywhere.
  const nestedSame = (n) =>
    n.kind === "split" &&
    (n.children.some((c) => c.kind === "split" && c.orientation === n.orientation) ||
      n.children.some((c) => nestedSame(c)));
  assert(!nestedSame(out), "no same-orientation split is nested anywhere in the result");
}

console.log("\n[outer] no-op and depth guards");
{
  const solo = { kind: "region", id: "only", panels: [{ id: "n-1", type: "notes" }] };
  assert(
    movePanel(solo, "n-1", { kind: "outer", orientation: "vertical", side: "before" }) === solo,
    "the only panel of the only region → the tree is returned UNCHANGED (identity)",
  );
  assert(
    movePanel(solo, "nope", { kind: "outer", orientation: "vertical", side: "before" }) === solo,
    "unknown panel → unchanged",
  );

  // Two panels in ONE region is a real outer drop: the region splits into a band
  // plus the remainder.
  const two = {
    kind: "region",
    id: "only",
    panels: [{ id: "n-1", type: "notes" }, { id: "w-1", type: "words" }],
  };
  const split2 = movePanel(two, "n-1", { kind: "outer", orientation: "vertical", side: "after" });
  assert(split2.kind === "split" && split2.orientation === "vertical", "one region, two panels → a vertical split");
  eqArr(split2.children.map((c) => c.id), ["only", "region-1"], "existing region first, new band last (side:after)");
  assert(ids(split2.children[1]).join(",") === "n-1", "the band holds the dragged panel");
  assert(ids(split2.children[0]).join(",") === "w-1", "the source region keeps the other panel");
  assertSizesSumToOne(split2, "one-region outer split");

  // MAX_DEPTH: wrapping adds a level, so a tree already at the limit must refuse
  // rather than emit something validateLayoutNode would reject on reload.
  assert(MAX_DEPTH === 8, `MAX_DEPTH is 8 (got ${MAX_DEPTH}) — the depths below assume it`);
  // Alternating orientations so nothing flattens; the leaf region holds TWO panels
  // so removing one cannot empty it and collapse the depth back.
  const deep = (levels) => {
    let node = {
      kind: "region",
      id: "leaf",
      panels: [{ id: "leaf-1", type: "notes" }, { id: "leaf-2", type: "words" }],
    };
    for (let i = levels; i >= 1; i--) {
      node = {
        kind: "split",
        orientation: i % 2 === 1 ? "horizontal" : "vertical",
        children: [
          { kind: "region", id: `pad-${i}`, panels: [{ id: `pad-${i}-1`, type: "questions" }] },
          node,
        ],
      };
    }
    return node;
  };
  const atLimit = deep(MAX_DEPTH - 1); // splits at depths 1..7, regions at depth 8
  const refused = movePanel(atLimit, "leaf-1", { kind: "outer", orientation: "vertical", side: "before" });
  assert(refused === atLimit, "a tree already at MAX_DEPTH refuses the outer wrap (unchanged)");
  // One level shallower, the same drop is accepted — so the guard is the depth.
  const roomy = deep(MAX_DEPTH - 2);
  const accepted = movePanel(roomy, "leaf-1", { kind: "outer", orientation: "vertical", side: "before" });
  assert(accepted !== roomy, "one level shallower, the same outer drop IS accepted");
  assert(accepted.children[0].kind === "region" && ids(accepted.children[0]).join(",") === "leaf-1", "…with the band first");
}

console.log("\n[outer] purity");
{
  const root = fixture();
  const snapshot = JSON.stringify(root);
  movePanel(root, "scripture-1", { kind: "outer", orientation: "horizontal", side: "after" });
  assert(JSON.stringify(root) === snapshot, "movePanel never mutates the input tree on an outer drop");
}

// ─── Region hide / restore ─────────────────────────────────────────────
//
// THE claim under test: closing a region can never permanently lose a panel.
// Hiding is a render-time filter over a `hidden` map; the TREE is never edited,
// so normalizeTree (which deletes only EMPTY regions) has nothing to delete.

console.log("\n[hide] resolution and defaults");
{
  const root = fixture();
  assert(!isRegionHidden(collectRegions(root)[0], {}), "an absent entry means visible");
  assert(isRegionHidden({ id: "x", kind: "region", panels: [] }, { x: true }), "an override hides");
  // Spec-level default, mirroring how PanelInstance.minimized works.
  assert(
    isRegionHidden({ id: "x", kind: "region", hidden: true, panels: [] }, {}),
    "a spec-level `hidden: true` is respected when there is no override",
  );
  assert(
    !isRegionHidden({ id: "x", kind: "region", hidden: true, panels: [] }, { x: false }),
    "an explicit override BEATS the spec default (a reopened region stays open)",
  );
  eqArr(Object.keys(resolveHidden(root, { "res-a": true })), ["res-a"], "resolveHidden reports the closed region");
  eqArr(
    Object.keys(resolveHidden(root, { "no-such-region": true })),
    [],
    "resolveHidden drops keys for regions not in the tree",
  );
  eqArr(Object.keys(resolveHidden(root, null)), [], "a null hidden map resolves to nothing closed");
}

console.log("\n[hide] the workspace can never go fully blank");
{
  const root = fixture();
  const all = { scripture: true, "res-a": true, "res-b": true };
  eqArr(
    Object.keys(resolveHidden(root, all)),
    [],
    "hiding EVERY region resolves to nothing hidden (the blank-workspace backstop)",
  );
  assert(isNodeVisible(root, resolveHidden(root, all)), "…so the root stays visible");
  // Two of three is fine — one survivor is enough.
  eqArr(
    Object.keys(resolveHidden(root, { "res-a": true, "res-b": true })).sort(),
    ["res-a", "res-b"],
    "hiding all but one region IS allowed",
  );
  // A single-region tree can never hide its only region.
  const solo = { kind: "region", id: "only", panels: [{ id: "p1", type: "notes" }] };
  eqArr(Object.keys(resolveHidden(solo, { only: true })), [], "a lone region cannot be closed");
  assert(!canHideRegion(solo, {}, "only"), "canHideRegion refuses the last visible region");
  assert(canHideRegion(root, {}, "res-a"), "canHideRegion allows one of three");
  assert(
    !canHideRegion(root, { scripture: true, "res-a": true }, "res-b"),
    "canHideRegion refuses the last SURVIVOR when two are already closed",
  );
  assert(!canHideRegion(root, { "res-a": true }, "res-a"), "an already-closed region is not closeable again");
  assert(!canHideRegion(root, {}, "ghost"), "a region that does not exist is not closeable");
}

console.log("\n[hide] a split with every child closed disappears with it");
{
  const root = fixture();
  const hidden = resolveHidden(root, { "res-a": true, "res-b": true });
  const resSplit = root.children[1];
  assert(
    !isNodeVisible(resSplit, hidden),
    "the resources SPLIT is invisible once both its regions are closed (no empty gutter)",
  );
  assert(isNodeVisible(root, hidden), "…while the root is still visible via scripture");
}

console.log("\n[hide] panels are never orphaned");
{
  const root = fixture();
  const hidden = { "res-b": true };
  // The tree is untouched by hiding — nothing calls an edit function at all.
  const before = collectPanels(root).map((p) => p.id).sort();
  const normalized = normalizeTree(root);
  const after = collectPanels(normalized).map((p) => p.id).sort();
  eqArr(after, before, "normalizeTree keeps every panel of a closed region (it is not empty)");
  const closed = hiddenRegions(normalized, hidden);
  assert(closed.length === 1 && closed[0].id === "res-b", "the closed region is still IN the tree");
  eqArr(
    closed[0].panels.map((p) => p.id),
    ["words-1", "tw-1", "questions-1"],
    "…with all three of its panels still inside it, ready to come back",
  );
  // Restoring is only "stop filtering" — no tree work, so no panel can be lost.
  eqArr(
    hiddenRegions(normalized, resolveHidden(normalized, { ...hidden, "res-b": false })).map((r) => r.id),
    [],
    "reopening the region restores it (and its panels) with no tree edit",
  );
}

console.log("\n[hide] docking interactions");
{
  // Dropping a panel INTO the visible sibling of a closed region must not touch
  // the closed region — and must not resurrect it.
  const root = fixture();
  const hidden = { "res-b": true };
  const moved = movePanel(root, "notes-1", { kind: "region", regionId: "scripture", placement: { kind: "into" } });
  const stillClosed = hiddenRegions(moved, resolveHidden(moved, hidden));
  assert(stillClosed.length === 1 && stillClosed[0].id === "res-b", "a drop elsewhere leaves the closed region closed");
  eqArr(
    stillClosed[0].panels.map((p) => p.id),
    ["words-1", "tw-1", "questions-1"],
    "…and does not disturb its panels",
  );
  eqArr(
    collectPanels(moved).map((p) => p.id).sort(),
    collectPanels(fixture()).map((p) => p.id).sort(),
    "no panel is lost by a drop made while a region is closed",
  );
  assertSizesSumToOne(moved, "drop beside a closed region");
}

console.log("\n[hide] a closed region survives a drop that collapses its sibling");
{
  // res-a has 2 panels; move BOTH out, which empties res-a and normalizeTree
  // deletes it — collapsing the resources split into res-b alone. res-b is
  // CLOSED, so the naive worry is that it (and its 3 panels) vanishes. It must
  // not: normalizeTree does not know about hiddenness, and res-b is not empty.
  let root = fixture();
  root = movePanel(root, "notes-1", { kind: "region", regionId: "scripture", placement: { kind: "into" } });
  root = movePanel(root, "ta-1", { kind: "region", regionId: "scripture", placement: { kind: "into" } });
  const regions = collectRegions(root).map((r) => r.id);
  assert(!regions.includes("res-a"), "the emptied region really was deleted");
  assert(regions.includes("res-b"), "the CLOSED region survived the collapse");
  const hidden = resolveHidden(root, { "res-b": true });
  eqArr(Object.keys(hidden), ["res-b"], "its hidden entry survives re-resolution against the new tree");
  eqArr(
    collectPanels(root).map((p) => p.id).sort(),
    collectPanels(fixture()).map((p) => p.id).sort(),
    "every panel still exists somewhere in the tree",
  );
  // And it is still restorable, with its own panels.
  const closed = hiddenRegions(root, hidden);
  eqArr(closed.map((r) => r.id), ["res-b"], "still listed as restorable");
  eqArr(closed[0].panels.map((p) => p.id), ["words-1", "tw-1", "questions-1"], "…with its panels intact");
}

console.log("\n[hide] resolveHidden is also the pruner every write goes through");
{
  const root = fixture();
  eqArr(
    Object.keys(resolveHidden(root, { "res-a": true, gone: true })),
    ["res-a"],
    "a key for a region the tree no longer has is dropped (id RECYCLING would otherwise hide a new region)",
  );
  eqArr(
    Object.keys(resolveHidden(root, { "res-a": false })),
    [],
    "explicit `false` entries are dropped — absence already means visible",
  );
  // The recycling hazard, concretely: an outer drop mints region-1; a stale
  // `region-1: true` left over from an earlier arrangement would make the
  // brand-new band invisible.
  const banded = movePanel(root, "notes-1", { kind: "outer", orientation: "vertical", side: "before" });
  assert(collectRegions(banded).some((r) => r.id === "region-1"), "the outer drop minted region-1");
  eqArr(
    Object.keys(resolveHidden(root, { "region-1": true })),
    [],
    "resolving against the PRE-drop tree drops the recycled id, so the new band is born visible",
  );
}

console.log("\n[hide] an UNSATISFIABLE stored set must HEAL, not persist (browser-found bug)");
{
  // The bug, found by clicking in the real app and invisible to every assertion
  // above: `hidden` was only interpreted at RENDER time, so an all-regions-closed
  // value (hand-edited localStorage, or an older build) rendered as "nothing
  // closed" while remaining the value every write built on. Closing a region then
  // produced a set that was STILL unsatisfiable, resolved to {} again, and
  // changed nothing — a Close button that did nothing, forever.
  //
  // The fix is to resolve the BASE too, then persist the resolved value. These
  // assertions pin the arithmetic Shell.setRegionHidden performs.
  const root = fixture();
  const corrupt = { scripture: true, "res-a": true, "res-b": true };
  eqArr(Object.keys(resolveHidden(root, corrupt)), [], "the corrupt set resolves to nothing closed on screen");

  // THE BUG: build the next set on the RAW stored value → still unsatisfiable →
  // still resolves to {} → the click accomplished nothing.
  const naive = resolveHidden(root, { ...corrupt, "res-b": true });
  eqArr(Object.keys(naive), [], "building on the RAW value leaves the click a silent no-op (the bug)");

  // THE FIX: build on the RESOLVED base instead.
  const base = resolveHidden(root, corrupt);
  const healed = resolveHidden(root, { ...base, "res-b": true });
  eqArr(Object.keys(healed), ["res-b"], "building on the RESOLVED base closes exactly the clicked region");
  // …and the next click behaves normally from there, because the stored value is
  // now satisfiable.
  eqArr(
    Object.keys(resolveHidden(root, { ...healed, "res-a": true })).sort(),
    ["res-a", "res-b"],
    "the following click closes a second region, as it should",
  );
}

console.log("\n[hide] purity");
{
  const root = fixture();
  const snapshot = JSON.stringify(root);
  const hidden = { "res-a": true, ghost: true };
  const hiddenSnapshot = JSON.stringify(hidden);
  resolveHidden(root, hidden);
  hiddenRegions(root, hidden);
  canHideRegion(root, hidden, "res-b");
  isNodeVisible(root, hidden);
  assert(JSON.stringify(root) === snapshot, "no hide helper mutates the tree");
  assert(JSON.stringify(hidden) === hiddenSnapshot, "no hide helper mutates the hidden map");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll layoutTree tests passed.");
