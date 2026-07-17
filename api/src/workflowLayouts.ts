// Server-shipped built-in layout defaults for the flexible-layouts feature.
// The GET /api/project-config response carries `layouts: builtinLayoutsFor(cfg)`
// so a project's default layouts ship from the server; the client keeps a
// byte-identical bundled fallback (web/src/lib/builtinLayouts.ts) for offline
// resilience and validates whatever the server sends against its panel registry.
//
// The four specs below MUST stay structurally identical (ids, names, region
// ids, panel ids, sizes, orientations) to the client's getBuiltinLayouts so a
// project rendering server layouts looks the same as one on the fallback. The
// client's validateLayoutSpec / validateLayoutAgainstRegistry catch any drift at
// runtime (a bad spec is dropped, not fatal).

// --- mirror of web/src/lib/layoutSpec.ts — keep in sync ---
// (api cannot import from web/src; these are the type definitions only, copied
//  verbatim. The validator/normalizer live client-side and are not needed here.)

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
  requires?: "translation"; // hidden unless the project is a translation project
  rail: { visible: boolean };
  root: LayoutNode;
}
// --- end mirror ---

import type { ProjectConfig } from "./projectConfig.ts";

export const CLASSIC_LAYOUT_ID = "builtin:classic";

// Server equivalent of the client's isTranslationProject (which gates on
// translationSource != null). A translation project translates FROM a source
// language; the English root project has translationSource === null.
function isTranslationConfig(config: ProjectConfig): boolean {
  return config.translationSource != null;
}

// Derive the scripture versions the Translate-Notes layout should pin. Mirrors
// the client's translateNotesVersions: the project's configured GL bibles, with
// a sensible default when none are configured.
function translateNotesVersions(config: ProjectConfig): string[] {
  const fromConfig = config.glBibles?.map((b) => b.version).filter(Boolean) ?? [];
  return fromConfig.length > 0 ? fromConfig : ["ULT", "GLT"];
}

// Classic = the full current Shell: scripture column + a tabbed resource column
// (notes / words / questions). Must stay behavior-identical to today's Shell.
const classic: LayoutSpec = {
  v: 2,
  id: CLASSIC_LAYOUT_ID,
  name: "Classic",
  builtin: true,
  rail: { visible: true },
  root: {
    kind: "split",
    orientation: "horizontal",
    children: [
      {
        kind: "region",
        id: "scripture",
        size: 0.5,
        display: "stacked",
        panels: [
          { id: "scripture-1", type: "scripture", config: { mode: "stacked", versions: "inherit" } },
        ],
      },
      {
        kind: "region",
        id: "resources",
        size: 0.5,
        display: "tabs",
        panels: [
          { id: "notes-1", type: "notes" },
          { id: "words-1", type: "words" },
          { id: "questions-1", type: "questions" },
        ],
      },
    ],
  },
};

// Translate Notes: scripture on top, notes below (vertical split), rail hidden,
// pinned source+target scripture versions. Notes render source/target
// side-by-side (pairAxis horizontal).
function translateNotes(config: ProjectConfig): LayoutSpec {
  return {
    v: 2,
    id: "builtin:translate-notes",
    name: "Translate Notes",
    builtin: true,
    requires: "translation",
    rail: { visible: false },
    root: {
      kind: "split",
      orientation: "vertical",
      children: [
        {
          kind: "region",
          id: "scripture",
          size: 0.42,
          display: "stacked",
          panels: [
            {
              id: "scripture-1",
              type: "scripture",
              config: { mode: "stacked", versions: translateNotesVersions(config) },
            },
          ],
        },
        {
          kind: "region",
          id: "notes",
          size: 0.58,
          display: "stacked",
          panels: [{ id: "notes-1", type: "notes", config: { pairAxis: "horizontal" } }],
        },
      ],
    },
  };
}

// Book Package Review (round 6): the nested flexible view. Scripture across the
// top (columns mode); resources split into two movable columns below —
// notes + associated tA on the left, words + associated tW + questions on the
// right. Rail visible.
const bpReview: LayoutSpec = {
  v: 2,
  id: "builtin:bp-review",
  name: "Book Package Review",
  builtin: true,
  rail: { visible: true },
  root: {
    kind: "split",
    orientation: "vertical",
    children: [
      {
        kind: "region",
        id: "scripture",
        size: 0.4,
        panels: [
          { id: "scripture-1", type: "scripture", config: { mode: "columns", versions: "inherit" } },
        ],
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
  },
};

// Translate Words: narrow tW article-list nav on the left, editable article
// (source|target, pairAxis horizontal) on the right. Rail hidden.
const translateWords: LayoutSpec = {
  v: 2,
  id: "builtin:translate-words",
  name: "Translate Words",
  builtin: true,
  requires: "translation",
  rail: { visible: false },
  root: {
    kind: "split",
    orientation: "horizontal",
    children: [
      {
        kind: "region",
        id: "list",
        size: 0.2,
        display: "stacked",
        panels: [{ id: "list-1", type: "articleList", config: { resourceType: "tw" } }],
      },
      {
        kind: "region",
        id: "article",
        size: 0.8,
        display: "stacked",
        panels: [
          {
            id: "tw-1",
            type: "twArticle",
            config: { pairAxis: "horizontal", showOccurrences: false },
          },
        ],
      },
    ],
  },
};

// All built-ins whose `requires` is satisfied by the given config. Classic and
// BP Review are always available; the two translate-* layouts are shown only on
// a translation project. Order matches the client's getBuiltinLayouts so the
// server list and the bundled fallback are identical.
export function builtinLayoutsFor(config: ProjectConfig): LayoutSpec[] {
  const out: LayoutSpec[] = [classic, bpReview];
  if (isTranslationConfig(config)) {
    out.push(translateNotes(config), translateWords);
  }
  return out;
}
