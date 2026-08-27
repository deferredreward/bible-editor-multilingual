// Smoke test for layoutStore.ts — localStorage read/write with corrupt-value
// fallback. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/layoutStore.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors src/lib/replace.test.mjs.
// Stubs globalThis.localStorage with an in-memory Map so no DOM is needed.

import {
  loadLayoutStore,
  saveLayoutStore,
  setActiveLayoutId,
  upsertUserLayout,
  deleteUserLayout,
  mergeOverride,
  setLayoutHidden,
  setLayoutTree,
  setClassicSplitRatio,
} from "./layoutStore.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// In-memory localStorage stub.
function installStorage(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  return map;
}

const KEY = "be:layouts.v2";
const userSpec = {
  v: 2,
  id: "user:abc",
  name: "My Layout",
  builtin: false,
  rail: { visible: true },
  root: {
    kind: "split",
    orientation: "horizontal",
    children: [
      {
        kind: "region",
        id: "s",
        size: 0.6,
        panels: [{ id: "sc-1", type: "scripture", config: { mode: "book", versions: "inherit" } }],
      },
      { kind: "region", id: "r", size: 0.4, panels: [{ id: "n-1", type: "notes" }] },
    ],
  },
};

// ─── Defaults ──────────────────────────────────────────────────────────
{
  console.log("\n[default] no storage → fresh default");
  delete globalThis.localStorage;
  const s = loadLayoutStore();
  assert(s.v === 2, "v is 2");
  assert(s.activeLayoutId === "builtin:classic", "default active is classic");
  assert(Array.isArray(s.userLayouts) && s.userLayouts.length === 0, "empty userLayouts");
  assert(s.overrides && Object.keys(s.overrides).length === 0, "empty overrides");
}
{
  console.log("\n[default] empty storage → fresh default");
  installStorage();
  assert(loadLayoutStore().activeLayoutId === "builtin:classic", "default active is classic");
}

// ─── Corruption fallback ───────────────────────────────────────────────
{
  console.log("\n[corrupt] non-JSON → fresh default");
  installStorage({ [KEY]: "{not json" });
  assert(loadLayoutStore().activeLayoutId === "builtin:classic", "bad JSON falls back");
}
{
  console.log("\n[corrupt] wrong version → fresh default");
  installStorage({ [KEY]: JSON.stringify({ v: 1, activeLayoutId: "x" }) });
  assert(loadLayoutStore().activeLayoutId === "builtin:classic", "wrong v falls back");
}
{
  console.log("\n[corrupt] invalid userLayouts are dropped, valid kept");
  installStorage({
    [KEY]: JSON.stringify({
      v: 2,
      activeLayoutId: "user:abc",
      userLayouts: [userSpec, { v: 2, id: "", name: "bad" }, "garbage"],
      overrides: {},
    }),
  });
  const s = loadLayoutStore();
  assert(s.userLayouts.length === 1, "only the valid userLayout survives");
  assert(s.userLayouts[0].id === "user:abc", "valid one kept");
  assert(s.activeLayoutId === "user:abc", "activeLayoutId preserved");
}
{
  console.log("\n[corrupt] invalid overrides dropped, valid kept");
  installStorage({
    [KEY]: JSON.stringify({
      v: 2,
      activeLayoutId: "builtin:classic",
      userLayouts: [],
      overrides: {
        good: { sizes: { scripture: 0.6 }, hidden: { resources: true } },
        badSize: { sizes: { scripture: "big" } },
        badHidden: { hidden: { resources: "no" } },
      },
    }),
  });
  const s = loadLayoutStore();
  assert(s.overrides.good !== undefined, "valid override kept");
  assert(s.overrides.badSize === undefined, "bad size override dropped");
  assert(s.overrides.badHidden === undefined, "bad hidden override dropped");
}

// ─── Round-trip + mutators ─────────────────────────────────────────────
{
  console.log("\n[roundtrip] save then load");
  installStorage();
  saveLayoutStore({ v: 2, activeLayoutId: "user:abc", userLayouts: [userSpec], overrides: {} });
  const s = loadLayoutStore();
  assert(s.activeLayoutId === "user:abc", "active round-trips");
  assert(s.userLayouts.length === 1 && s.userLayouts[0].id === "user:abc", "userLayout round-trips");
}
{
  console.log("\n[mutators] setActiveLayoutId");
  installStorage();
  const s = setActiveLayoutId("builtin:flexible");
  assert(s.activeLayoutId === "builtin:flexible", "returned store updated");
  assert(loadLayoutStore().activeLayoutId === "builtin:flexible", "persisted");
}
{
  console.log("\n[mutators] upsert then delete userLayout");
  installStorage();
  upsertUserLayout(userSpec);
  assert(loadLayoutStore().userLayouts.length === 1, "upsert added");
  upsertUserLayout({ ...userSpec, name: "Renamed" });
  const after = loadLayoutStore();
  assert(after.userLayouts.length === 1, "upsert same id does not duplicate");
  assert(after.userLayouts[0].name === "Renamed", "upsert updated in place");
  setActiveLayoutId("user:abc");
  const del = deleteUserLayout("user:abc");
  assert(del.userLayouts.length === 0, "delete removed layout");
  assert(del.activeLayoutId === "builtin:classic", "active reset to classic after deleting active");
}

// ─── mergeOverride ─────────────────────────────────────────────────────
{
  console.log("\n[mergeOverride] merges sub-records without clobbering");
  installStorage();
  mergeOverride("builtin:classic", { sizes: { scripture: 0.6 } });
  mergeOverride("builtin:classic", { hidden: { resources: true } });
  const ov = loadLayoutStore().overrides["builtin:classic"];
  assert(ov.sizes.scripture === 0.6, "sizes preserved after setting hidden");
  assert(ov.hidden.resources === true, "hidden set alongside sizes");

  // A second sizes merge adds a key without dropping the earlier one or hidden.
  mergeOverride("builtin:classic", { sizes: { resources: 0.4 } });
  const ov2 = loadLayoutStore().overrides["builtin:classic"];
  assert(ov2.sizes.scripture === 0.6 && ov2.sizes.resources === 0.4, "sizes sub-record merged");
  assert(ov2.hidden.resources === true, "hidden untouched by later sizes merge");

  mergeOverride("builtin:classic", { minimized: { "notes-1": true } });
  const ov3 = loadLayoutStore().overrides["builtin:classic"];
  assert(ov3.minimized["notes-1"] === true, "minimized sub-record set");
  assert(ov3.sizes.scripture === 0.6 && ov3.hidden.resources === true, "prior sub-records intact");

  // Scripture-mode override (Phase 3): persists per-layout without clobbering.
  mergeOverride("builtin:classic", { mode: "columns" });
  const ov4 = loadLayoutStore().overrides["builtin:classic"];
  assert(ov4.mode === "columns", "mode sub-record set");
  assert(ov4.sizes.scripture === 0.6 && ov4.minimized["notes-1"] === true, "mode merge keeps prior records");
}
{
  console.log("\n[mode override] bad mode value is dropped on load");
  installStorage({
    [KEY]: JSON.stringify({
      v: 2,
      activeLayoutId: "builtin:classic",
      userLayouts: [],
      overrides: { good: { mode: "book" }, bad: { mode: "grid" } },
    }),
  });
  const s = loadLayoutStore();
  assert(s.overrides.good?.mode === "book", "valid mode kept");
  assert(s.overrides.bad === undefined, "invalid mode override dropped");
}

// ─── tree override (user-rearranged topology) ──────────────────────────
const treeOverride = () => ({
  kind: "split",
  orientation: "vertical",
  children: [
    {
      kind: "region",
      id: "scripture",
      size: 0.3,
      panels: [{ id: "sc-1", type: "scripture", config: { mode: "columns" } }],
    },
    {
      kind: "region",
      id: "region-1",
      size: 0.7,
      display: "stacked",
      panels: [
        { id: "n-1", type: "notes" },
        { id: "w-1", type: "words" },
      ],
    },
  ],
});

{
  console.log("\n[tree override] round-trips through save/load");
  installStorage();
  mergeOverride("builtin:flexible", { sizes: { scripture: 0.3 }, tree: treeOverride() });
  const ov = loadLayoutStore().overrides["builtin:flexible"];
  assert(ov.tree !== undefined, "tree survives the round-trip");
  assert(ov.tree.kind === "split" && ov.tree.orientation === "vertical", "tree shape preserved");
  assert(
    ov.tree.children.map((c) => c.id).join(",") === "scripture,region-1",
    "tree region ids preserved",
  );
  assert(ov.tree.children[1].panels.length === 2, "tree panels preserved");
  assert(ov.sizes.scripture === 0.3, "sizes still present alongside the tree");
}
{
  console.log("\n[tree override] mergeOverride replaces the tree wholesale");
  installStorage();
  mergeOverride("builtin:flexible", { tree: treeOverride() });
  const replacement = {
    kind: "region",
    id: "solo",
    panels: [{ id: "n-1", type: "notes" }],
  };
  mergeOverride("builtin:flexible", { tree: replacement });
  const ov = loadLayoutStore().overrides["builtin:flexible"];
  assert(ov.tree.kind === "region" && ov.tree.id === "solo", "second tree replaced the first");
  assert(ov.tree.children === undefined, "no residue merged in from the previous tree");

  // A non-tree merge leaves the stored tree alone.
  mergeOverride("builtin:flexible", { hidden: { "res-b": true } });
  const ov2 = loadLayoutStore().overrides["builtin:flexible"];
  assert(ov2.tree?.id === "solo", "tree untouched by an unrelated merge");
  assert(ov2.hidden["res-b"] === true, "unrelated merge applied");
}
{
  console.log("\n[tree override] a corrupt tree drops ONLY the tree");
  installStorage({
    [KEY]: JSON.stringify({
      v: 2,
      activeLayoutId: "builtin:flexible",
      userLayouts: [],
      overrides: {
        "builtin:flexible": {
          sizes: { scripture: 0.35 },
          minimized: { "n-1": true },
          mode: "columns",
          // Invalid: a split needs >= 2 children and a region needs `panels`.
          tree: { kind: "split", orientation: "sideways", children: [] },
        },
      },
    }),
  });
  const ov = loadLayoutStore().overrides["builtin:flexible"];
  assert(ov !== undefined, "the override itself is NOT discarded");
  assert(ov.tree === undefined, "corrupt tree dropped");
  assert(ov.sizes.scripture === 0.35, "sizes preserved");
  assert(ov.minimized["n-1"] === true, "minimized preserved");
  assert(ov.mode === "columns", "mode preserved");
}
{
  console.log("\n[tree override] duplicate ids in the tree drop only the tree");
  // Two regions sharing an id would make one movePanel edit apply twice
  // (mapRegions dispatches by region id), so validateLayoutNode must reject it.
  const dupRegion = treeOverride();
  dupRegion.children[1].id = "scripture";
  installStorage({
    [KEY]: JSON.stringify({
      v: 2,
      activeLayoutId: "builtin:flexible",
      userLayouts: [],
      overrides: {
        "builtin:flexible": { sizes: { scripture: 0.45 }, mode: "book", tree: dupRegion },
      },
    }),
  });
  const ov = loadLayoutStore().overrides["builtin:flexible"];
  assert(ov !== undefined, "the override itself is NOT discarded");
  assert(ov.tree === undefined, "duplicate-region-id tree dropped");
  assert(ov.sizes.scripture === 0.45, "sizes preserved");
  assert(ov.mode === "book", "mode preserved");

  // Same for a panel id duplicated across the tree's two regions.
  const dupPanel = treeOverride();
  dupPanel.children[1].panels[0].id = "sc-1";
  installStorage({
    [KEY]: JSON.stringify({
      v: 2,
      activeLayoutId: "builtin:flexible",
      userLayouts: [],
      overrides: { "builtin:flexible": { sizes: { scripture: 0.45 }, tree: dupPanel } },
    }),
  });
  const ov2 = loadLayoutStore().overrides["builtin:flexible"];
  assert(ov2.tree === undefined, "duplicate-panel-id tree dropped");
  assert(ov2.sizes.scripture === 0.45, "sizes preserved");
}
{
  console.log("\n[tree override] a tree with an invalid panel type is also dropped");
  installStorage({
    [KEY]: JSON.stringify({
      v: 2,
      activeLayoutId: "builtin:flexible",
      userLayouts: [],
      overrides: {
        "builtin:flexible": {
          sizes: { scripture: 0.5 },
          tree: { kind: "region", id: "r", panels: [{ id: "x", type: "spaceship" }] },
        },
      },
    }),
  });
  const ov = loadLayoutStore().overrides["builtin:flexible"];
  assert(ov.tree === undefined, "tree with a bogus panel type dropped");
  assert(ov.sizes.scripture === 0.5, "rest of the override kept");
}

console.log("\nsetLayoutTree - wholesale tree + sizes replace, and the Classic refusal");
{
  installStorage();
  const tree = { kind: "region", id: "region-1", panels: [{ id: "notes-1", type: "notes" }] };
  mergeOverride("builtin:flexible", { sizes: { "res-a": 0.5, stale: 0.9 }, minimized: { "notes-1": true } });

  setLayoutTree("builtin:flexible", tree, { "region-1": 0.7 });
  const ov = loadLayoutStore().overrides["builtin:flexible"];
  assert(ov.tree && ov.tree.id === "region-1", "tree persisted");
  assert(
    Object.keys(ov.sizes).length === 1 && ov.sizes["region-1"] === 0.7,
    "sizes REPLACED wholesale (stale keys gone), not merged",
  );
  assert(ov.minimized["notes-1"] === true, "unrelated override fields survive");

  setLayoutTree("builtin:flexible", null, { "res-a": 0.5 });
  const cleared = loadLayoutStore().overrides["builtin:flexible"];
  assert(cleared.tree === undefined, "tree: null CLEARS the override (Reset arrangement)");
  assert(cleared.sizes["res-a"] === 0.5, "sizes replaced again on clear");
  assert(cleared.minimized["notes-1"] === true, "minimized still survives the clear");

  // Classic must never carry a tree override: it renders from its spec root.
  setLayoutTree("builtin:classic", tree, { scripture: 0.5 });
  assert(
    loadLayoutStore().overrides["builtin:classic"] === undefined,
    "setLayoutTree REFUSES builtin:classic outright",
  );
}

console.log("\na wholesale sizes replace must be built from a FRESH read, not a stale one");
{
  // The Shell bug this pins down: `sizes` is memoized per render and
  // `onSizesChange` deliberately does NOT bump the render key (bumping on every
  // divider tick would re-render the Shell throughout the drag). So a resize
  // persisted after the last render is invisible to the render closure — and
  // setLayoutTree REPLACES the sizes record wholesale. Committing a drop from the
  // stale closure therefore erased the resize the user had just made.
  installStorage();
  const tree = { kind: "region", id: "region-1", panels: [{ id: "notes-1", type: "notes" }] };
  mergeOverride("builtin:flexible", { sizes: { "region-1": 0.4 } });

  // What a render captured...
  const staleSizes = loadLayoutStore().overrides["builtin:flexible"].sizes;
  // ...then the user drags the divider to 0.7. This is the onSizesChange path:
  // the PATCH ALONE, merged over the live store (seeding the merge with the stale
  // record is itself a stale write — a later resize would carry the old value back).
  mergeOverride("builtin:flexible", { sizes: { "region-1": 0.7 } });
  assert(
    loadLayoutStore().overrides["builtin:flexible"].sizes["region-1"] === 0.7,
    "the resize is in the store at 0.7",
  );
  assert(staleSizes["region-1"] === 0.4, "the captured render closure still reads 0.4 (this is the hazard)");

  // The BUG: commit the drop with the closure's sizes → the 0.7 is erased.
  setLayoutTree("builtin:flexible", tree, staleSizes);
  assert(
    loadLayoutStore().overrides["builtin:flexible"].sizes["region-1"] === 0.4,
    "a wholesale replace built from the STALE record reverts the resize — the defect, reproduced",
  );

  // The FIX: re-read at commit time (Shell's currentSizes()).
  mergeOverride("builtin:flexible", { sizes: { "region-1": 0.7 } });
  const fresh = loadLayoutStore().overrides["builtin:flexible"].sizes;
  setLayoutTree("builtin:flexible", tree, fresh);
  assert(
    loadLayoutStore().overrides["builtin:flexible"].sizes["region-1"] === 0.7,
    "a wholesale replace built from a FRESH read preserves a size written after the last render",
  );
}

console.log("\nmergeOverride with a patch alone cannot revert an earlier resize");
{
  // Why onSizesChange passes the patch and nothing else: mergeOverride already
  // merges over the live store, so two resizes of DIFFERENT nodes both survive
  // even though no re-render happened between them.
  installStorage();
  mergeOverride("builtin:flexible", { sizes: { a: 0.3, b: 0.7 } });
  mergeOverride("builtin:flexible", { sizes: { a: 0.6 } }); // first divider
  mergeOverride("builtin:flexible", { sizes: { b: 0.4 } }); // second divider, no re-render between
  const s = loadLayoutStore().overrides["builtin:flexible"].sizes;
  assert(s.a === 0.6 && s.b === 0.4, "both resizes survive (a=0.6, b=0.4)");
}

console.log("\nsetLayoutHidden - wholesale closed-region replace, and the Classic refusal");
{
  installStorage();
  mergeOverride("builtin:flexible", { sizes: { "res-a": 0.5 }, minimized: { "notes-1": true } });

  setLayoutHidden("builtin:flexible", { "res-b": true });
  let ov = loadLayoutStore().overrides["builtin:flexible"];
  assert(ov.hidden["res-b"] === true, "closed region persisted");
  assert(ov.sizes["res-a"] === 0.5 && ov.minimized["notes-1"] === true, "unrelated override fields survive");

  // The whole reason this is not mergeOverride: a merge can only ADD keys, so it
  // could never drop the key for a region a drop had destroyed, nor clear the set.
  setLayoutHidden("builtin:flexible", { "res-a": true });
  ov = loadLayoutStore().overrides["builtin:flexible"];
  assert(
    Object.keys(ov.hidden).length === 1 && ov.hidden["res-a"] === true,
    "hidden REPLACED wholesale (the stale res-b key is gone), not merged",
  );
  mergeOverride("builtin:flexible", { hidden: { "res-b": true } });
  assert(
    Object.keys(loadLayoutStore().overrides["builtin:flexible"].hidden).length === 2,
    "…whereas mergeOverride only ever adds (which is why it cannot prune)",
  );

  setLayoutHidden("builtin:flexible", {});
  ov = loadLayoutStore().overrides["builtin:flexible"];
  assert(Object.keys(ov.hidden).length === 0, "an empty map reopens everything (Reset arrangement)");
  assert(ov.sizes["res-a"] === 0.5, "…without touching sizes");

  // Classic has no region chrome and never consults `hidden`, so a value stored
  // for it could only ever be a lie. Mirrors the setLayoutTree refusal.
  installStorage();
  setLayoutHidden("builtin:classic", { scripture: true });
  assert(
    loadLayoutStore().overrides["builtin:classic"] === undefined,
    "setLayoutHidden REFUSES builtin:classic outright",
  );
}

console.log("\nhidden survives a save/load round trip and rejects junk");
{
  installStorage();
  setLayoutHidden("builtin:flexible", { "res-b": true });
  assert(
    loadLayoutStore().overrides["builtin:flexible"].hidden["res-b"] === true,
    "a closed region round-trips through localStorage",
  );
  // A non-boolean value drops the WHOLE override (sanitizeRecord's contract) —
  // pinned so a future edit can't silently start trusting junk.
  installStorage({
    [KEY]: JSON.stringify({
      v: 2,
      activeLayoutId: "builtin:flexible",
      userLayouts: [],
      overrides: { "builtin:flexible": { hidden: { "res-a": "yes" } } },
    }),
  });
  assert(
    loadLayoutStore().overrides["builtin:flexible"] === undefined,
    "a non-boolean hidden value drops that override rather than loading garbage",
  );
}

// ─── Classic scripture split (issue #373) ──────────────────────────────
console.log("\nsetClassicSplitRatio - persist, clamp, clear, and coexistence");
{
  installStorage();
  // Absent by default → Shell falls back to autoSplit.
  assert(
    loadLayoutStore().overrides["builtin:classic"]?.scriptureSplit === undefined,
    "no split stored by default",
  );

  setClassicSplitRatio("builtin:classic", 0.62);
  assert(
    loadLayoutStore().overrides["builtin:classic"].scriptureSplit === 0.62,
    "a manual drag ratio persists",
  );

  // Coexists with the other override fields (mode etc.) — no clobber either way.
  mergeOverride("builtin:classic", { mode: "columns" });
  const ov = loadLayoutStore().overrides["builtin:classic"];
  assert(ov.scriptureSplit === 0.62 && ov.mode === "columns", "split and mode coexist");
  setClassicSplitRatio("builtin:classic", 0.4);
  assert(
    loadLayoutStore().overrides["builtin:classic"].mode === "columns",
    "re-setting the split leaves mode intact",
  );

  // Out-of-band values clamp to [0.1, 0.9] on write.
  setClassicSplitRatio("builtin:classic", 0.99);
  assert(loadLayoutStore().overrides["builtin:classic"].scriptureSplit === 0.9, "high value clamps to 0.9");
  setClassicSplitRatio("builtin:classic", 0.01);
  assert(loadLayoutStore().overrides["builtin:classic"].scriptureSplit === 0.1, "low value clamps to 0.1");

  // null CLEARS the field (double-click "reset to auto") without dropping mode.
  setClassicSplitRatio("builtin:classic", null);
  const cleared = loadLayoutStore().overrides["builtin:classic"];
  assert(cleared.scriptureSplit === undefined, "null clears the split (reset to auto)");
  assert(cleared.mode === "columns", "clearing the split leaves the rest of the override");
}
{
  console.log("\n[scriptureSplit] round-trips and drops only itself when corrupt");
  installStorage();
  setClassicSplitRatio("builtin:classic", 0.55);
  assert(
    loadLayoutStore().overrides["builtin:classic"].scriptureSplit === 0.55,
    "split round-trips through localStorage",
  );

  // A non-numeric / non-finite split drops ONLY the field (like `tree`), keeping
  // the user's sizes / mode rather than discarding the whole override.
  installStorage({
    [KEY]: JSON.stringify({
      v: 2,
      activeLayoutId: "builtin:classic",
      userLayouts: [],
      overrides: {
        "builtin:classic": { sizes: { scripture: 0.5 }, mode: "book", scriptureSplit: "wide" },
        nan: { scriptureSplit: null },
      },
    }),
  });
  const ov = loadLayoutStore().overrides["builtin:classic"];
  assert(ov !== undefined, "the override itself is NOT discarded by a bad split");
  assert(ov.scriptureSplit === undefined, "non-numeric split dropped");
  assert(ov.sizes.scripture === 0.5 && ov.mode === "book", "sizes and mode preserved");
  // A stored value beyond the band is clamped on load, not dropped.
  installStorage({
    [KEY]: JSON.stringify({
      v: 2,
      activeLayoutId: "builtin:classic",
      userLayouts: [],
      overrides: { "builtin:classic": { scriptureSplit: 5 } },
    }),
  });
  assert(
    loadLayoutStore().overrides["builtin:classic"].scriptureSplit === 0.9,
    "an out-of-band stored split is clamped on load, not discarded",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll layoutStore tests passed.");
