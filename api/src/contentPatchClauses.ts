// SET-clause fragments applied by every VERSIONED content PATCH in rows.ts,
// beyond the patched fields themselves. Extracted as a pure leaf so the
// SQL-backed regression test (trashedRowPatch.test.mjs) exercises the exact
// fragment production runs, instead of asserting on a copy that could drift.
//
// - Any tn content edit clears a pending review flag (the adapted-note verify
//   queue — migration 0031). In this fork only tn_rows carries the columns.
// - A versioned content edit on a TRASHED tn row also UN-trashes it
//   (`trashed_at = NULL`; tn only — migration 0026 added the column to tn_rows
//   alone). Without this, a queued outbox PATCH from user B lands with 200 on
//   a row user A trashed — trash is a non-versioning bit-toggle (setTnTrashed),
//   so B's If-Match still matches, and the UPDATE's WHERE only filters
//   deleted_at — and the 05:30 nightly finalize (index.ts) then promotes
//   trashed_at → deleted_at unconditionally, permanently tombstoning B's fresh
//   edit (never exported; the reimport skips tombstones). A versioned content
//   edit is the strongest possible signal the row should live, so it revives
//   the row — mirroring how any content edit clears review flags.
//
// The non-versioning fast paths in rows.ts (the reorder-only sort_order
// patch and the preserve/hint/trash bit-toggles) deliberately do NOT apply
// these — a drag or a flag-ack must never resurrect a trashed note.
export function contentPatchClearClauses(kind: "tn" | "tq" | "twl"): string[] {
  if (kind !== "tn") return [];
  return ["review_kind = NULL", "review_reason = NULL", "trashed_at = NULL"];
}
