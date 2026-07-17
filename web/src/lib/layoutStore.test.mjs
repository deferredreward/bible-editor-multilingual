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
  const s = setActiveLayoutId("builtin:bp-review");
  assert(s.activeLayoutId === "builtin:bp-review", "returned store updated");
  assert(loadLayoutStore().activeLayoutId === "builtin:bp-review", "persisted");
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

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll layoutStore tests passed.");
