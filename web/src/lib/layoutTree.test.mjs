// Tests for layoutTree.ts — pure tree edits (drag a panel into / beside a
// region) plus canonicalization. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/layoutTree.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors src/lib/layoutSpec.test.mjs.

import {
  collectPanels,
  collectRegions,
  findPanelRegion,
  movePanel,
  nextRegionId,
  normalizeTree,
  removePanel,
} from "./layoutTree.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
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

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll layoutTree tests passed.");
