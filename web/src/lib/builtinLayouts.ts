// The built-in layout specs (recursive-container model) + a config-aware
// selector. Phase 1: library code only. Final version-pinning for
// translate-notes is refined when this is wired to Shell (Phase 3).

import type { LayoutSpec } from "./layoutSpec";
import type { ProjectConfig } from "../sync/api";
import { isTranslationProject } from "../hooks/useProjectConfig";

export const CLASSIC_LAYOUT_ID = "builtin:classic";

// Derive the scripture versions the Translate-Notes layout should pin.
// TODO Phase 3: the fuller derivation (source GL + target ordering, RTL) is
// settled when wired to Shell's version model. For now pin the project's
// configured GL bibles; fall back to a sensible default so the spec is always
// valid. `GlBiblePane.version` is the pane's version code (verified in api.ts).
function translateNotesVersions(cfg: ProjectConfig | null): string[] {
  const fromConfig = cfg?.glBibles?.map((b) => b.version).filter(Boolean) ?? [];
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
function translateNotes(cfg: ProjectConfig | null): LayoutSpec {
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
              config: { mode: "stacked", versions: translateNotesVersions(cfg) },
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
// a translation project.
export function getBuiltinLayouts(cfg: ProjectConfig | null): LayoutSpec[] {
  const out: LayoutSpec[] = [classic, bpReview];
  if (isTranslationProject(cfg)) {
    out.push(translateNotes(cfg), translateWords);
  }
  return out;
}
