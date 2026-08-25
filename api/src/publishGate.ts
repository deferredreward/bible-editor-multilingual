// Provenance-aware row-level publish gate for the nightly TSV export
// (docs/ux-simplification.md §1.4 — the durable #236 fix).
//
// The plain review-state gate (gateTsvRowForExport, preDraftSnapshot.ts) is not
// provenance-aware: rows imported from a FOREIGN source (a DCS chapter-range
// override, an Aquifer draft, the English translation-source fallback) would
// leak through it — a pristine DCS-range row is translation_state NULL → "export
// current" → the other org's text ships; an Aquifer row is an ai_draft with no
// meaningful snapshot → "legacy" → the Aquifer text ships. That leak is why the
// blunt whole-(book,resource) export skip existed. This module makes the gate
// per-row so the pair skip can be dropped for tn/tq:
//
//   publishable(row) :=
//     own-provenance chapter                                   → gateTsvRowForExport (unchanged)
//     foreign chapter AND validated                            → export live content
//     foreign chapter AND draft (ai_draft/edited) w/ snapshot  → export the snapshot
//     foreign chapter, anything else (pristine/NULL state, or
//       draft with no usable snapshot)                         → OMIT the row
//
// "Foreign" is per CHAPTER, resolved from the same data the old pair skip used:
// the whole-book book_imports marker + the book_source_overrides ranges
// (heldOutChapters / heldOutChaptersFromRanges in bookSource.ts → a HeldOut).
// Whole-book is the inclusive range (0, 999), so chapter-0 front-matter rows
// follow the same membership test as any other chapter.
//
// Pure module (no Env / D1) so it unit-tests under the node strip-types runner,
// same as preDraftSnapshot.ts.

import {
  exportGateDecision,
  type TranslationState,
} from "./preDraftSnapshot.ts";
import { isChapterHeldOut, type HeldOut } from "./bookSource.ts";

export type PublishDecision =
  | { kind: "current" }
  | { kind: "snapshot"; snapshot: Record<string, unknown> }
  // Own-provenance draft with no snapshot (pre-migration-0049): export current
  // content and log — the accepted one-time exception, unchanged.
  | { kind: "legacy" }
  // Foreign-provenance row that is neither validated nor snapshot-backed:
  // never been published by this org and not approved — omit it entirely.
  | { kind: "omit" };

// The per-row publishable decision. `foreign` = the row's chapter is sourced
// off the org's own repo (whole-book marker or a range override).
export function publishGateDecision(
  foreign: boolean,
  state: TranslationState | string | null,
  preDraftJson: string | null,
): PublishDecision {
  if (!foreign) return exportGateDecision(state, preDraftJson);
  if (state === "validated") return { kind: "current" };
  if (state === "ai_draft" || state === "edited") {
    const d = exportGateDecision(state, preDraftJson);
    // A usable snapshot is last-published content — safe to keep shipping.
    if (d.kind === "snapshot") return d;
    // "legacy" (no / unparseable snapshot) must NOT fall through to exporting
    // current content here: on a foreign chapter, current content is the other
    // source's (or the AI's unapproved) text. Omit instead.
    return { kind: "omit" };
  }
  // Pristine / NULL state on a foreign chapter: current content is verbatim
  // foreign text (e.g. English notes from a DCS range import). Omit.
  return { kind: "omit" };
}

// TSV row wrapper: apply publishGateDecision to one tn/tq row.
//   row: null → the row is OMITTED from the render (caller counts it).
//   legacy    → caller logs the own-provenance no-snapshot exception.
// `foreignChapters` is the resolved hold-out set for this (book, resource);
// pass null for a book with no foreign provenance at all.
export function gateTsvRowForPublish<
  T extends {
    chapter: number;
    translation_state?: string | null;
    pre_draft_json?: string | null;
  },
>(
  row: T,
  fields: readonly string[],
  foreignChapters: HeldOut | null,
): { row: T | null; legacy: boolean } {
  const foreign =
    foreignChapters != null && isChapterHeldOut(foreignChapters, row.chapter);
  const decision = publishGateDecision(
    foreign,
    row.translation_state ?? null,
    row.pre_draft_json ?? null,
  );
  if (decision.kind === "current") return { row, legacy: false };
  if (decision.kind === "legacy") return { row, legacy: true };
  if (decision.kind === "omit") return { row: null, legacy: false };
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) out[f] = decision.snapshot[f] ?? null;
  return { row: out as T, legacy: false };
}
