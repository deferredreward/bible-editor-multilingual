// How the reimport should treat an existing (non-tombstone) row when it also
// appears in the incoming master TSV. Pure decision, split out so it is unit-
// testable without dragging in bookReimport's runtime deps.
//
// The reorder-preservation invariant (the reason this is its own function):
// a TN/TWL reorder writes only sort_order via the rows.ts fast path — it does
// NOT bump version or updated_by, so the row still reads as pristine. If the
// reimport keyed "no-op" on sort_order matching (it used to: sigMatch &&
// sortMatches), a reordered-but-content-identical row looked like a pristine
// change and got its sort_order overwritten back to master file order — the
// documented HOS 11 TN / HOS 12 TWL reorder-revert bug. Order flows app→master
// (the nightly export renders D1's sort_order into TSV row order), so for those
// rows D1 is the source of truth for order and a content-identical row must
// PRESERVE its local sort_order rather than adopt file order.
//
// This preservation is SCOPED (see caller): only tn/twl (the resources with an
// in-app reorder gesture) whose row already carries a non-null sort_order.
//   - tq has NO in-app reorder (its PATCH schema has no sort_order; the fast
//     path can't fire for it), so master file order stays authoritative — a
//     master-side reorder must still sync in.
//   - a NULL sort_order carries no order to preserve, so a content-identical
//     null row must still be repaired to file order (else it exports at the end
//     via `NULLS LAST`).
// Both of those fall through to the normal adopt-from-master path.
//
// "reimportable" (below) is broader than "pristine": a row the AI pipeline wrote
// but no human has since edited is also safe to overwrite from master (see
// isReimportableRow). Such a row is re-seeded AND returned to master-owned
// (updated_by → NULL); the caller writes it under a relaxed guard (version-CAS
// + re-asserted protections) and counts it as `reimported_ai` rather than the
// misleading `skipped_edited`. `aiOnly` distinguishes that case so the caller
// picks the right write guard + counter.
export type ReimportFate = "noop" | "edited" | "update" | "update_ai";

export function classifyReimportRow(
  contentMatches: boolean,
  sortMatches: boolean,
  reimportable: boolean,
  preserveLocalOrder: boolean,
  aiOnly = false,
): ReimportFate {
  // Content AND order both match master → nothing to import.
  if (contentMatches && sortMatches) return "noop";
  // Content matches but order differs, and this row owns its order locally
  // (tn/twl with a stored sort_order) → preserve the reorder; do NOT adopt
  // master file order. This is the reorder-revert fix. (Applies to AI-only rows
  // too: a content-identical row that only differs in order stays a no-op — the
  // AI never gains a stale re-seed; it self-heals to master-owned on the next
  // content change.)
  if (contentMatches && preserveLocalOrder) return "noop";
  // Otherwise the row must take master's content and/or file-order sort_order:
  // content drifted, OR order diverged on a row whose order master owns (tq /
  // null sort_order). A human-edited row is never clobbered; a pristine one is
  // updated from master; an AI-only one is re-seeded AND reclaimed to
  // master-owned via the update_ai path.
  if (!reimportable) return "edited";
  return aiOnly ? "update_ai" : "update";
}

// Source label the AI pipeline stamps on every edit_log row it writes. Kept in
// sync with pipelineImport.ts AI_SOURCE (the delete-sweep precedent this mirrors).
export const AI_SOURCE = "ai_pipeline";

// Column shape needed to decide whether a reimport may overwrite a row.
export interface ReimportableRow {
  // Non-null once anyone (human OR the AI pipeline) has written the row.
  updated_by: number | null;
  // source of the latest content-bearing (create/update) edit_log entry for the
  // row, or null if none / not fetched. The ONLY signal that separates an
  // AI-written row (source = ai_pipeline) from a human edit (source null/manual)
  // once updated_by is set.
  latestSource: string | null;
  deleted_at: number | null;
  // tn-only human-owned protections. Ignored for tq/twl/verse.
  trashed_at?: number | null;
  preserve?: number | null;
  hint?: number | null;
  kind: "tn" | "tq" | "twl" | "verse";
}

// True iff the reimport may overwrite this (non-tombstone) row from master.
// Two admissible cases, both meaning "no human owns this row":
//   1. pristine        — updated_by IS NULL (never touched at all);
//   2. AI-only         — updated_by set, but the latest content edit_log entry
//                        is source = ai_pipeline (the AI pipeline wrote it and no
//                        human has edited it since — a human PATCH would write a
//                        null/manual-source edit_log row, flipping this false).
// Human-owned protections still block overwrite regardless of the above: a
// tombstone (deleted_at), a note queued for deletion (trashed_at), or an
// explicit preserve/hint flag (tn). This mirrors the pipelineImport deleteUnkeptTns
// safety predicate; the caller re-asserts the same conditions at write time
// (version-CAS + flag re-assertion) so a human edit landing mid-import can't be
// clobbered.
export function isReimportableRow(r: ReimportableRow): boolean {
  if (r.deleted_at != null) return false;
  if (r.kind === "tn") {
    if (r.trashed_at != null) return false;
    if (Number(r.preserve ?? 0) !== 0) return false;
    if (Number(r.hint ?? 0) !== 0) return false;
  }
  if (r.updated_by == null) return true; // pristine
  return r.latestSource === AI_SOURCE; // AI-only, never human-edited
}
