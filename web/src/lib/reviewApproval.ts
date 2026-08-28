// Which review-queue rows the "Approve" / "Approve all" actions can actually act on.
//
// The server refuses to validate a row the translate pipeline never touched
// (`translation_state IS NULL` — a pristine/pre-state-machine imported row): the
// `setTnState`/`setTqState` UPDATEs carry a `translation_state IS NOT NULL` guard
// (api/src/rows.ts) so such a row can never be stamped `validated` and leak into
// the nightly context-repo few-shot export. A validate call on one therefore 404s.
//
// "Approve all" used to iterate every non-`validated`, non-trashed row, so the
// first pristine row 404'd and halted the whole run, and the "Approve all (N)"
// button counted rows the click could never reach (#238). An approvable row is one
// that actually has a draft to validate — `ai_draft` or `edited` — and, for tN, is
// not trashed (validating a trashed note would promote a thrown-away row into the
// few-shot set).

export type ApprovableRow = {
  translation_state?: "ai_draft" | "edited" | "validated" | null;
  // tN carries a unix-ms timestamp; tQ has no such column. Only ever null-checked.
  trashed_at?: number | string | null;
};

/** True when the Approve/Approve-all action can validate this row without a 404. */
export function isApprovableRow(row: ApprovableRow): boolean {
  if (row.trashed_at != null) return false;
  return row.translation_state === "ai_draft" || row.translation_state === "edited";
}
