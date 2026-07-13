// Pure builder for the bp-assistant `translate` pipeline options, extracted from
// pipelines.ts so it can be unit-tested without importing the Hono route module
// (whose extensionless imports don't resolve under the node strip-types runner —
// same reason pipelineImportClaim.ts is split out from pipelineImport.ts).
//
// Contract of record: bp-bot/translate-pipeline/{PLAN.md,BIBLE-EDITOR-INTEGRATION.md}.

import type { ProjectConfig } from "./projectConfig.ts";

// Client-supplied overrides (a top-level `translate:{…}` field on the start body).
export type TranslateClientOptions = {
  model?: "sonnet" | "opus";
  delivery?: "path" | "branch";
  branchOnly?: boolean;
  direction?: "ltr" | "rtl";
  rowIds?: string[];
  verseStart?: number;
  verseEnd?: number;
  targetLang?: string;
  targetOrg?: string;
  sourceRef?: string;
  contextRef?: string;
};

// Build the bp-assistant `translate` options from the active project config,
// folding in any client overrides. Contract: PLAN.md §1 — the bot fetches the
// source rows BY REFERENCE (sourceRef), so nothing is gathered from D1 here
// (unlike the notes-hints path). Returns null if the project has no
// translationSource (the English root project can't be a translate TARGET) —
// the caller turns that into a 400.
export function buildTranslateOptions(
  cfg: ProjectConfig,
  overrides: TranslateClientOptions | undefined,
): Record<string, unknown> | null {
  const src = cfg.translationSource;
  if (!src) return null; // not a gateway-language project → can't translate INTO it
  const o = overrides ?? {};
  const targetLang = o.targetLang ?? cfg.languageCode;
  const targetOrg = o.targetOrg ?? cfg.exportOrg;
  // Source is the published EN tN repo pinned to master by default; a caller
  // can pin an exact SHA for reproducibility (the bot echoes the resolved SHA).
  const sourceRef = o.sourceRef ?? `${src.org}/${src.repos.tn}@master`;
  return {
    targetLang,
    targetOrg,
    sourceRef,
    // contextRef is OPT-IN, not auto-derived. Per the live bot's
    // BIBLE-EDITOR-INTEGRATION.md §4: any caller-supplied contextRef is treated
    // as an explicit demand, and the bot FAILS the run with "context pack has no
    // content files" if that repo isn't populated yet. Auto-sending
    // `${cfg.org}/translation-context@master` therefore breaks every live run
    // until the context repo exists. Omitting it lets the bot default internally,
    // detect the repo's absence, and proceed as a raw baseline (warn, don't fail).
    // Once {org}/translation-context is created + populated (CONTEXT-REPO-CONTRACT.md),
    // a caller enables assisted output by passing translate.contextRef explicitly.
    ...(o.contextRef ? { contextRef: o.contextRef } : {}),
    // Review branch, no auto-merge — the editor consumes the DCS branch and
    // applies it as ai_draft rows (PLAN.md §1 delivery: branch, branchOnly).
    delivery: o.delivery ?? "branch",
    branchOnly: o.branchOnly ?? true,
    model: o.model ?? "opus",
    direction: o.direction ?? cfg.direction,
    ...(o.rowIds ? { rowIds: o.rowIds } : {}),
    ...(o.verseStart != null ? { verseStart: o.verseStart } : {}),
    ...(o.verseEnd != null ? { verseEnd: o.verseEnd } : {}),
  };
}
