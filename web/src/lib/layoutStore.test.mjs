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

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll layoutStore tests passed.");
