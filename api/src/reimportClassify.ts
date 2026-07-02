// How the reimport should treat an existing (non-tombstone) row when it also
// appears in the incoming master TSV. Pure decision, split out so it is unit-
// testable without dragging in bookReimport's runtime deps.
//
// The reorder-preservation invariant (the reason this is its own function):
// a TWL/TN reorder writes only sort_order via the rows.ts fast path — it does
// NOT bump version or updated_by, so the row still reads as pristine. If the
// reimport keyed "no-op" on sort_order matching (it used to: sigMatch &&
// sortMatches), a reordered-but-content-identical row looked like a pristine
// change and got its sort_order overwritten back to master file order — the
// documented HOS 11 TN / HOS 12 TWL reorder-revert bug. Order flows app→master
// (the nightly export renders D1's sort_order into TSV row order), so D1 is the
// source of truth for order: a content-identical row must PRESERVE its local
// sort_order, never adopt file order. Hence "no-op" now keys on content alone.
export type ReimportFate = "noop" | "edited" | "update";

export function classifyReimportRow(contentMatches: boolean, pristine: boolean): ReimportFate {
  // Content identical to master → nothing to import. Preserve whatever
  // sort_order D1 holds (a divergent one is a local reorder to keep), so this
  // is a no-op regardless of sort_order or pristine-ness.
  if (contentMatches) return "noop";
  // Content changed. A human-edited row is never clobbered.
  if (!pristine) return "edited";
  // Pristine row whose content drifted from master → adopt master content and
  // its file-order sort_order.
  return "update";
}
