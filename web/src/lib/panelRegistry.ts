// Panel registry: the set of panel types a layout may reference, plus
// per-config availability gating. A LayoutSpec that references a panel type the
// current project can't offer is rejected (caller falls back to Classic).
// i18n keys added in Phase 3.

import type { LayoutSpec, LayoutNode, PanelType } from "./layoutSpec";
import type { ProjectConfig } from "../sync/api";

export interface PanelDescriptor {
  type: PanelType;
  i18nTitleKey: string;
  available: (cfg: ProjectConfig | null) => boolean;
}

// Availability gating is LAYOUT-level (a spec's `requires: "translation"`), not
// per-panel: the same panels (notes, tW/tA articles, original language) are
// meaningful on both root and translation projects, so every descriptor is
// permissive. If a future panel becomes genuinely project-specific, wire its
// `available` here (isTranslationProject lives in hooks/useProjectConfig).
const always = () => true;

export const PANEL_REGISTRY: Record<PanelType, PanelDescriptor> = {
  scripture: { type: "scripture", i18nTitleKey: "layout.panel.scripture", available: always },
  original: { type: "original", i18nTitleKey: "layout.panel.original", available: always },
  notes: { type: "notes", i18nTitleKey: "layout.panel.notes", available: always },
  words: { type: "words", i18nTitleKey: "layout.panel.words", available: always },
  questions: { type: "questions", i18nTitleKey: "layout.panel.questions", available: always },
  taArticle: { type: "taArticle", i18nTitleKey: "layout.panel.taArticle", available: always },
  twArticle: { type: "twArticle", i18nTitleKey: "layout.panel.twArticle", available: always },
  articleList: { type: "articleList", i18nTitleKey: "layout.panel.articleList", available: always },
  alignment: { type: "alignment", i18nTitleKey: "layout.panel.alignment", available: always },
  search: { type: "search", i18nTitleKey: "layout.panel.search", available: always },
};

function nodeOk(node: LayoutNode, cfg: ProjectConfig | null): boolean {
  if (node.kind === "split") return node.children.every((c) => nodeOk(c, cfg));
  return node.panels.every((p) => {
    const descriptor = PANEL_REGISTRY[p.type];
    return !!descriptor && descriptor.available(cfg);
  });
}

// Returns the spec unchanged if every panel it references maps to an available
// registry entry; otherwise null. Structural validity is assumed (run
// validateLayoutSpec first); this only checks registry availability.
export function validateLayoutAgainstRegistry(
  spec: LayoutSpec,
  cfg: ProjectConfig | null,
): LayoutSpec | null {
  return nodeOk(spec.root, cfg) ? spec : null;
}
