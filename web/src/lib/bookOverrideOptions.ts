// Pure decision logic for the Source-overrides Book picker (issue #282).
//
// Per-book source overrides are stored per book (api/src/bookSource.ts) and the
// backend accepts them for books that have NOT been imported yet:
// `PUT /api/books/:book/sources` (api/src/bookImport.ts) guards only on the book
// being a canonical code, with no `book_imports` existence check. Range overrides
// then take effect on the book's next FULL import.
//
// The overrides panel used to feed its picker from `GET /api/books` (imported
// books only), so an admin could not select the not-yet-imported book they
// needed to configure — a UI dead-end for a shipped backend feature. This helper
// composes the full canonical book list with an "imported" flag, mirroring the
// TopBar book picker idiom (web/src/components/TopBar.tsx), so unimported books
// surface in the dropdown instead of being hidden.
//
// Kept as a pure module (no i18n / React imports) so it is unit-testable via the
// repo's `npm --workspace web run test` strip-types runner.

export interface BookOverrideOption {
  /** Stable USFM/DCS book code (e.g. "MRK"). */
  code: string;
  /** Whether the book has already been imported into this workspace. */
  imported: boolean;
}

/**
 * All canonical books, in canonical order, each flagged with whether it has been
 * imported. `allCodes` is the canonical list (BOOKS.map(b => b.code)); imported
 * codes come from `GET /api/books`.
 */
export function bookOverrideOptions(
  allCodes: readonly string[],
  importedCodes: Iterable<string>,
): BookOverrideOption[] {
  const imported = new Set(importedCodes);
  return allCodes.map((code) => ({ code, imported: imported.has(code) }));
}

/**
 * Pick the initial book for the overrides picker: keep the caller's current
 * selection if it's a real canonical code, else prefer the first imported book
 * (so an admin who has imported books lands on a familiar one), else fall back
 * to the first canonical book (so the picker is never empty pre-import).
 */
export function defaultOverrideBook(
  current: string | null,
  allCodes: readonly string[],
  importedCodes: Iterable<string>,
): string | null {
  if (current && allCodes.includes(current)) return current;
  const imported = new Set(importedCodes);
  const firstImported = allCodes.find((c) => imported.has(c));
  return firstImported ?? allCodes[0] ?? null;
}
