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

// All built-ins whose `requires` is satisfied by the given config. Classic is
// always available; Translate Notes is shown only on a translation project.
export function getBuiltinLayouts(cfg: ProjectConfig | null): LayoutSpec[] {
  const out: LayoutSpec[] = [classic];
  if (isTranslationProject(cfg)) {
    out.push(translateNotes(cfg));
  }
  return out;
}
