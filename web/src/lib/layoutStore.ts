// localStorage persistence for flexible layouts (key `be:layouts.v2`).
// Mirrors Shell's loadFromStorage/saveToStorage: try/catch, JSON.parse guard,
// silent fallback. Corrupt or partially-invalid values degrade to a fresh
// default rather than throwing. Storage access is read through globalThis so
// this is SSR/test-safe (tests can stub globalThis.localStorage). The v1 key is
// abandoned — dev-only, no migration.

import {
  validateLayoutNode,
  validateLayoutSpec,
  type LayoutNode,
  type LayoutSpec,
  type ScriptureMode,
} from "./layoutSpec.ts";

const STORAGE_KEY = "be:layouts.v2";
// Kept in sync with builtinLayouts.CLASSIC_LAYOUT_ID. Inlined (not imported)
// so this module stays a leaf depending only on layoutSpec — importing
// builtinLayouts would transitively pull React (via useProjectConfig) into
// this store and its strip-types tests.
const CLASSIC_LAYOUT_ID = "builtin:classic";

export interface LayoutOverride {
  sizes?: Record<string, number>; // node/region id -> size fraction
  hidden?: Record<string, boolean>; // region id -> hidden
  minimized?: Record<string, boolean>; // panel id -> minimized
  activePanelByRegion?: Record<string, string>; // region id -> active tab panel id
  // Scripture mode chosen while this (non-classic) layout is active. Classic
  // keeps writing `be:scriptureMode`; every other layout persists its mode here
  // so a mode toggle never mutates Classic's shared key (Phase 3, plan risk
  // "scripture-mode double ownership").
  mode?: ScriptureMode;
  // The user's rearranged TOPOLOGY for this layout. When present it REPLACES the
  // spec's `root` for rendering (the spec still supplies name / rail / builtin).
  //
  // Why a whole tree instead of a patch: the other fields above are keyed by
  // region or panel id, which only works while the set of regions is fixed by
  // the spec. Dragging a panel to a region's edge CREATES a region, and dragging
  // the last panel out DESTROYS one — so a region-keyed patch no longer has
  // stable subjects to describe. The full tree is the only representation that
  // can express an arrangement the spec never contained.
  tree?: LayoutNode;
}

const SCRIPTURE_MODES: readonly ScriptureMode[] = ["stacked", "columns", "book"];

export interface LayoutStore {
  v: 2;
  activeLayoutId: string;
  userLayouts: LayoutSpec[];
  overrides: Record<string, LayoutOverride>;
}

function freshStore(): LayoutStore {
  return { v: 2, activeLayoutId: CLASSIC_LAYOUT_ID, userLayouts: [], overrides: {} };
}

function getStorage(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// A localStorage-sourced Record<string, V> where every value is `valType`.
// Returns null (drop the whole override) on any bad entry.
function sanitizeRecord(
  x: unknown,
  valType: "number" | "boolean" | "string",
): Record<string, unknown> | null {
  if (!isPlainObject(x)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) {
    if (typeof v !== valType) return null;
    if (valType === "number" && !Number.isFinite(v as number)) return null;
    out[k] = v;
  }
  return out;
}

function sanitizeOverride(x: unknown): LayoutOverride | null {
  if (!isPlainObject(x)) return null;
  const out: LayoutOverride = {};
  if (x.sizes !== undefined) {
    const rec = sanitizeRecord(x.sizes, "number");
    if (!rec) return null;
    out.sizes = rec as Record<string, number>;
  }
  if (x.hidden !== undefined) {
    const rec = sanitizeRecord(x.hidden, "boolean");
    if (!rec) return null;
    out.hidden = rec as Record<string, boolean>;
  }
  if (x.minimized !== undefined) {
    const rec = sanitizeRecord(x.minimized, "boolean");
    if (!rec) return null;
    out.minimized = rec as Record<string, boolean>;
  }
  if (x.activePanelByRegion !== undefined) {
    const rec = sanitizeRecord(x.activePanelByRegion, "string");
    if (!rec) return null;
    out.activePanelByRegion = rec as Record<string, string>;
  }
  if (x.mode !== undefined) {
    if (!SCRIPTURE_MODES.includes(x.mode as ScriptureMode)) return null;
    out.mode = x.mode as ScriptureMode;
  }
  // `tree` is a nested node, not a primitive-valued record, so sanitizeRecord
  // cannot validate it — it goes through layoutSpec's node validator instead.
  // A corrupt tree drops ONLY the tree: the user falls back to the built-in
  // arrangement rather than also losing their sizes / hidden / minimized state.
  if (x.tree !== undefined) {
    const tree = validateLayoutNode(x.tree);
    if (tree) out.tree = tree;
  }
  return out;
}

export function loadLayoutStore(): LayoutStore {
  const storage = getStorage();
  if (!storage) return freshStore();
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return freshStore();
  }
  if (!raw) return freshStore();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return freshStore();
  }
  if (!isPlainObject(parsed) || parsed.v !== 2) return freshStore();

  const activeLayoutId =
    typeof parsed.activeLayoutId === "string" && parsed.activeLayoutId
      ? parsed.activeLayoutId
      : CLASSIC_LAYOUT_ID;

  // Validate each user layout; silently drop invalid ones.
  const userLayouts: LayoutSpec[] = [];
  if (Array.isArray(parsed.userLayouts)) {
    for (const u of parsed.userLayouts) {
      const spec = validateLayoutSpec(u);
      if (spec) userLayouts.push(spec);
    }
  }

  const overrides: Record<string, LayoutOverride> = {};
  if (isPlainObject(parsed.overrides)) {
    for (const [key, value] of Object.entries(parsed.overrides)) {
      const ov = sanitizeOverride(value);
      if (ov) overrides[key] = ov;
    }
  }

  return { v: 2, activeLayoutId, userLayouts, overrides };
}

export function saveLayoutStore(store: LayoutStore): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* quota or private mode — soft fail */
  }
}

export function setActiveLayoutId(id: string): LayoutStore {
  const store = loadLayoutStore();
  store.activeLayoutId = id;
  saveLayoutStore(store);
  return store;
}

export function upsertUserLayout(spec: LayoutSpec): LayoutStore {
  const store = loadLayoutStore();
  const idx = store.userLayouts.findIndex((l) => l.id === spec.id);
  if (idx >= 0) store.userLayouts[idx] = spec;
  else store.userLayouts.push(spec);
  saveLayoutStore(store);
  return store;
}

export function deleteUserLayout(id: string): LayoutStore {
  const store = loadLayoutStore();
  store.userLayouts = store.userLayouts.filter((l) => l.id !== id);
  delete store.overrides[id];
  if (store.activeLayoutId === id) store.activeLayoutId = CLASSIC_LAYOUT_ID;
  saveLayoutStore(store);
  return store;
}

// Set (or CLEAR, with `tree: null`) a layout's rearranged topology, replacing
// `sizes` WHOLESALE at the same time.
//
// Why this can't be mergeOverride: (a) mergeOverride only assigns `tree` when
// it's truthy, so there is no way to delete one ("Reset arrangement" needs to);
// (b) it MERGES `sizes`, but a drop creates and destroys regions, so the caller
// has to be able to drop dead keys — a merge would resurrect every one of them.
// Callers prune with layoutTree.pruneSizes and hand the result in here.
//
// Never call this for `builtin:classic`: Classic renders from its spec root and
// must stay byte-identical (see layoutTree.effectiveRoot, which also refuses).
export function setLayoutTree(
  layoutId: string,
  tree: LayoutNode | null,
  sizes: Record<string, number>,
): LayoutStore {
  if (layoutId === CLASSIC_LAYOUT_ID) return loadLayoutStore();
  const store = loadLayoutStore();
  const existing = store.overrides[layoutId] ?? {};
  const next: LayoutOverride = { ...existing, sizes };
  if (tree) next.tree = tree;
  else delete next.tree;
  store.overrides[layoutId] = next;
  saveLayoutStore(store);
  return store;
}

// Set a layout's CLOSED-REGION set, replacing `hidden` WHOLESALE.
//
// Why this can't be mergeOverride (same shape of reason as setLayoutTree):
// mergeOverride only ever ADDS keys, so it can neither drop a key for a region a
// drop has destroyed nor clear the whole set for "Reset arrangement". And since
// `nextRegionId` recycles `region-<n>` ids, a stale key left behind by a merge
// could make a brand-new region spawn invisible. Callers pass the output of
// layoutTree.resolveHidden, which is both the pruner and the
// never-hide-everything backstop (there is deliberately no pruneHidden — see the
// note beside resolveHidden for why every write must resolve, not merely prune).
//
// Never call this for `builtin:classic`: Classic renders through
// WorkspaceLayout's hand-rolled flexbox branch, which has no region chrome and
// never consults `hidden` — so a value stored for it could only ever be a lie.
// Refusing here mirrors setLayoutTree / effectiveRoot.
export function setLayoutHidden(
  layoutId: string,
  hidden: Record<string, boolean>,
): LayoutStore {
  if (layoutId === CLASSIC_LAYOUT_ID) return loadLayoutStore();
  const store = loadLayoutStore();
  const existing = store.overrides[layoutId] ?? {};
  store.overrides[layoutId] = { ...existing, hidden };
  saveLayoutStore(store);
  return store;
}

// Deep-merges each present sub-record into the layout's existing override so a
// caller can set just `sizes` (or just `hidden`, etc.) without clobbering the
// others.
export function mergeOverride(layoutId: string, partial: Partial<LayoutOverride>): LayoutStore {
  const store = loadLayoutStore();
  const existing = store.overrides[layoutId] ?? {};
  const merged: LayoutOverride = { ...existing };
  if (partial.sizes) merged.sizes = { ...existing.sizes, ...partial.sizes };
  if (partial.hidden) merged.hidden = { ...existing.hidden, ...partial.hidden };
  if (partial.minimized) merged.minimized = { ...existing.minimized, ...partial.minimized };
  if (partial.activePanelByRegion) {
    merged.activePanelByRegion = { ...existing.activePanelByRegion, ...partial.activePanelByRegion };
  }
  if (partial.mode) merged.mode = partial.mode;
  // `tree` is a WHOLESALE REPLACE, never a merge: a topology is only meaningful
  // as a whole, and there is no sane way to deep-merge two different shapes.
  if (partial.tree) merged.tree = partial.tree;
  store.overrides[layoutId] = merged;
  saveLayoutStore(store);
  return store;
}
