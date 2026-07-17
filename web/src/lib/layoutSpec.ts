// Flexible-layout schema (v2). Pure types + validator + size normalization.
// Phase 1: library code only — no Shell wiring yet.
//
// The model is a RECURSIVE CONTAINER: a layout root is a tree of horizontal /
// vertical splits whose leaves are panel regions. Each region holds an ordered,
// movable list of panel instances. This supersedes the v1 "one host per region"
// model (see docs/mockups design rounds 4–6).
//
// The validator guards untrusted localStorage today and future server-stored
// layout JSON, so it is deliberately strict: any shape violation returns null
// and callers fall back to Classic. Unknown panel-config keys are IGNORED (not
// rejected) for forward-compatibility.

export type Axis = "horizontal" | "vertical";
export type ScriptureMode = "stacked" | "columns" | "book";
export type PanelType =
  | "scripture"
  | "original"
  | "notes"
  | "words"
  | "questions"
  | "taArticle"
  | "twArticle"
  | "articleList"
  | "alignment"
  | "search";

export interface PanelConfig {
  mode?: ScriptureMode; // scripture
  versions?: string[] | "inherit"; // scripture
  pairAxis?: Axis; // notes / taArticle / twArticle source-target axis
  resource?: "uhb" | "ugnt"; // original
  resourceType?: "tw" | "ta"; // articleList / article panels
  showOccurrences?: boolean; // article panels
}

export interface PanelInstance {
  id: string;
  type: PanelType;
  minimized?: boolean; // runtime default; live state lives in the store override
  size?: number; // optional within-region fraction
  config?: PanelConfig;
}

export interface PanelRegion {
  kind: "region";
  id: string;
  size?: number;
  display?: "stacked" | "tabs"; // default "stacked"
  hidden?: boolean; // region on/off (default false)
  panels: PanelInstance[]; // may be empty (an emptied region)
}

export interface SplitNode {
  kind: "split";
  orientation: Axis;
  size?: number;
  children: LayoutNode[]; // length >= 2
}

export type LayoutNode = SplitNode | PanelRegion;

export interface LayoutSpec {
  v: 2;
  id: string; // "builtin:*" | "user:<uuid>"
  name: string;
  builtin: boolean;
  requires?: "translation"; // hidden unless isTranslationProject(cfg)
  rail: { visible: boolean };
  root: LayoutNode;
}

const AXES: readonly Axis[] = ["horizontal", "vertical"];
const SCRIPTURE_MODES: readonly ScriptureMode[] = ["stacked", "columns", "book"];
const DISPLAYS: readonly ("stacked" | "tabs")[] = ["stacked", "tabs"];
const PANEL_TYPES: readonly PanelType[] = [
  "scripture",
  "original",
  "notes",
  "words",
  "questions",
  "taArticle",
  "twArticle",
  "articleList",
  "alignment",
  "search",
];

// Reject pathological nesting. Root is depth 1; a node deeper than this is
// rejected (guards against hostile/looping JSON blowing the stack).
const MAX_DEPTH = 8;

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

// Present config fields must be valid; unknown keys are ignored (forward-compat).
function validatePanelConfig(x: unknown): PanelConfig | null {
  if (!isPlainObject(x)) return null;
  const out: PanelConfig = {};
  if (x.mode !== undefined) {
    if (!SCRIPTURE_MODES.includes(x.mode as ScriptureMode)) return null;
    out.mode = x.mode as ScriptureMode;
  }
  if (x.versions !== undefined) {
    if (x.versions === "inherit") {
      out.versions = "inherit";
    } else if (Array.isArray(x.versions) && x.versions.every((v) => typeof v === "string")) {
      out.versions = x.versions as string[];
    } else {
      return null;
    }
  }
  if (x.pairAxis !== undefined) {
    if (!AXES.includes(x.pairAxis as Axis)) return null;
    out.pairAxis = x.pairAxis as Axis;
  }
  if (x.resource !== undefined) {
    if (x.resource !== "uhb" && x.resource !== "ugnt") return null;
    out.resource = x.resource;
  }
  if (x.resourceType !== undefined) {
    if (x.resourceType !== "tw" && x.resourceType !== "ta") return null;
    out.resourceType = x.resourceType;
  }
  if (x.showOccurrences !== undefined) {
    if (typeof x.showOccurrences !== "boolean") return null;
    out.showOccurrences = x.showOccurrences;
  }
  return out;
}

function validatePanelInstance(x: unknown): PanelInstance | null {
  if (!isPlainObject(x)) return null;
  if (!isNonEmptyString(x.id)) return null;
  if (!PANEL_TYPES.includes(x.type as PanelType)) return null;
  const out: PanelInstance = { id: x.id, type: x.type as PanelType };
  if (x.minimized !== undefined) {
    if (typeof x.minimized !== "boolean") return null;
    out.minimized = x.minimized;
  }
  if (x.size !== undefined) {
    if (!isFiniteNumber(x.size)) return null;
    out.size = x.size;
  }
  if (x.config !== undefined) {
    const config = validatePanelConfig(x.config);
    if (!config) return null;
    out.config = config;
  }
  return out;
}

function validateRegion(x: Record<string, unknown>): PanelRegion | null {
  if (!isNonEmptyString(x.id)) return null;
  if (!Array.isArray(x.panels)) return null;
  const panels: PanelInstance[] = [];
  for (const p of x.panels) {
    const panel = validatePanelInstance(p);
    if (!panel) return null;
    panels.push(panel);
  }
  const out: PanelRegion = { kind: "region", id: x.id, panels };
  if (x.display !== undefined) {
    if (!DISPLAYS.includes(x.display as "stacked" | "tabs")) return null;
    out.display = x.display as "stacked" | "tabs";
  }
  if (x.hidden !== undefined) {
    if (typeof x.hidden !== "boolean") return null;
    out.hidden = x.hidden;
  }
  if (x.size !== undefined) {
    if (!isFiniteNumber(x.size)) return null;
    out.size = x.size;
  }
  return out;
}

function validateSplit(x: Record<string, unknown>, depth: number): SplitNode | null {
  if (!AXES.includes(x.orientation as Axis)) return null;
  if (!Array.isArray(x.children) || x.children.length < 2) return null;
  const children: LayoutNode[] = [];
  for (const c of x.children) {
    const node = validateNode(c, depth + 1);
    if (!node) return null;
    children.push(node);
  }
  const out: SplitNode = { kind: "split", orientation: x.orientation as Axis, children };
  if (x.size !== undefined) {
    if (!isFiniteNumber(x.size)) return null;
    out.size = x.size;
  }
  return out;
}

function validateNode(x: unknown, depth: number): LayoutNode | null {
  if (depth > MAX_DEPTH) return null;
  if (!isPlainObject(x)) return null;
  if (x.kind === "split") return validateSplit(x, depth);
  if (x.kind === "region") return validateRegion(x);
  return null;
}

export function validateLayoutSpec(x: unknown): LayoutSpec | null {
  if (!isPlainObject(x)) return null;
  if (x.v !== 2) return null;
  if (!isNonEmptyString(x.id)) return null;
  if (!isNonEmptyString(x.name)) return null;
  if (typeof x.builtin !== "boolean") return null;
  if (x.requires !== undefined && x.requires !== "translation") return null;
  if (!isPlainObject(x.rail) || typeof x.rail.visible !== "boolean") return null;
  const root = validateNode(x.root, 1);
  if (!root) return null;

  const spec: LayoutSpec = {
    v: 2,
    id: x.id,
    name: x.name,
    builtin: x.builtin,
    rail: { visible: x.rail.visible },
    root,
  };
  if (x.requires === "translation") spec.requires = "translation";
  return spec;
}

// Clamp each item's size (missing = equal share) to >= min, then rescale so the
// sizes sum to 1.0. Pure — returns new objects, never mutates the input. Used
// for a split's `children` (each carries an optional `size`).
export function normalizeSizes<T extends { size?: number }>(items: T[], min = 0.1): T[] {
  if (items.length === 0) return [];
  const equalShare = 1 / items.length;
  const clamped = items.map((it) =>
    Math.max(min, isFiniteNumber(it.size) ? it.size : equalShare),
  );
  const total = clamped.reduce((a, b) => a + b, 0);
  return items.map((it, i) => ({ ...it, size: clamped[i] / total }));
}
