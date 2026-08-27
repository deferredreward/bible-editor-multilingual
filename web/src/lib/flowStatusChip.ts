// Single source of truth for the flow status-chip PRECEDENCE.
//
// The three flow screens (TranslateNotesScreen, TranslateQuestionsScreen,
// TranslateWordsScreen) each rendered this decision as an inline conditional
// chain, and the ordering has needed fixing repeatedly (#338, #340, #342/#343)
// with no test coverage possible on the components. This module owns the
// precedence so the next reorder is a one-line change with a visible diff in a
// table-driven test (mirrors the tnRedo.ts / tnRedo.test.mjs precedent).
//
// It resolves a *status*, not a label: the label copy differs per screen
// (tn/tq say "Pending", tw says "Edited" for the same saved-edited state; tq/tw
// distinguish an AI draft, tn does not), so the label decision stays in the
// screen. The chip *color* (FlowStatusKind) is derived here via flowChipKind so
// every screen paints a given status identically.

import type { FlowStatusKind } from "../components/flows/FlowStatusChip";

/**
 * Precedence-resolved status of a flow row's chip. Finer-grained than
 * FlowStatusKind (the chip color): "editing"/"unsaved"/"pending" all paint
 * `edited`, "aiDraft" paints `draft` — but the screens label them differently.
 */
export type FlowChipStatus =
  | "editing" // the open/current row's live, unsaved editor diff
  | "unsaved" // a persisted IndexedDB draft on a row that is NOT the open one
  | "approved" // saved verdict: approved (tn/tq) or validated (tw/ta)
  | "skipped" // soft-trashed / "Not needed" (tn today)
  | "pending" // saved-but-not-approved: edited this session, or loaded 'edited'
  | "aquifer" // untouched Aquifer import — provenance, not an AI-bot draft (#295)
  | "aiDraft" // AI-pipeline draft, untouched
  | "draft"; // untouched / not started

export interface FlowChipInputs {
  /** This row is the open/current card. */
  isCurrent: boolean;
  /** The open card's live editor differs from its saved baseline (hasDiff). */
  hasLiveDiff: boolean;
  /** A persisted IndexedDB draft exists for this (non-current) row. */
  draftPresent: boolean;
  /** Saved verdict is approved (tn/tq) or validated (tw/ta). */
  approved: boolean;
  /** Soft-trashed / "Not needed". */
  skipped: boolean;
  /** Saved but not approved: edited this session, or loaded already 'edited'. */
  pending: boolean;
  /** Untouched Aquifer import (ai_draft with draft_meta_json.source==='aquifer'). */
  aquifer: boolean;
  /** AI-pipeline draft (translation_state==='ai_draft' or latest_source==='ai_pipeline'). */
  aiDrafted: boolean;
}

/**
 * Resolve a flow row's chip status by precedence.
 *
 * Unsaved text wins over every saved verdict (#342): a live diff on the open
 * row, or a persisted draft on any other row, must never be hidden behind
 * "Approved" — that is exactly the row a translator jumped to *because* it holds
 * unsaved text. The open row is judged only by its live diff (its persisted
 * draft is already hydrated into the editor, so hasLiveDiff subsumes it);
 * every other row is judged by whether a draft is persisted for it.
 */
export function resolveFlowChipStatus(i: FlowChipInputs): FlowChipStatus {
  if (i.isCurrent) {
    if (i.hasLiveDiff) return "editing";
  } else if (i.draftPresent) {
    return "unsaved";
  }
  if (i.approved) return "approved";
  if (i.skipped) return "skipped";
  if (i.pending) return "pending";
  if (i.aquifer) return "aquifer";
  if (i.aiDrafted) return "aiDraft";
  return "draft";
}

const KIND_BY_STATUS: Record<FlowChipStatus, FlowStatusKind> = {
  editing: "edited",
  unsaved: "edited",
  approved: "approved",
  skipped: "skip",
  pending: "edited",
  aquifer: "aquifer",
  aiDraft: "draft",
  draft: "draft",
};

/** The chip *color* kind for a resolved status. */
export function flowChipKind(status: FlowChipStatus): FlowStatusKind {
  return KIND_BY_STATUS[status];
}
