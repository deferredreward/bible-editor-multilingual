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
export type ReimportFate = "noop" | "edited" | "update";

export function classifyReimportRow(
  contentMatches: boolean,
  sortMatches: boolean,
  pristine: boolean,
  preserveLocalOrder: boolean,
): ReimportFate {
  // Content AND order both match master → nothing to import.
  if (contentMatches && sortMatches) return "noop";
  // Content matches but order differs, and this row owns its order locally
  // (tn/twl with a stored sort_order) → preserve the reorder; do NOT adopt
  // master file order. This is the reorder-revert fix.
  if (contentMatches && preserveLocalOrder) return "noop";
  // Otherwise the row must take master's content and/or file-order sort_order:
  // content drifted, OR order diverged on a row whose order master owns (tq /
  // null sort_order). A human-edited row is never clobbered; a pristine one is
  // updated from master.
  if (!pristine) return "edited";
  return "update";
}
