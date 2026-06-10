// Pure placement math for assigning a sort_order to a new row, given the
// sort_orders of its nearest already-placed same-verse neighbours. Lives in
// its own leaf module so it's unit testable under the strip-only test runner
// (bookReimport.ts can't be imported there). Used by midpointSortOrder during
// reimport. Both null → seed a fresh verse group at the import spacing (100).
export function placeSortOrder(before: number | null, after: number | null): number {
  if (before != null && after != null) return (before + after) / 2; // between
  if (before != null) return before + 100; // append after the last placed row
  if (after != null) return after - 1; // new head, just before the first row
  return 100; // whole verse group is new — nothing placed yet, seed at import spacing
}
