// Pure decision logic for the IMPORT surface (see web/src/components/ImportWorkspace.tsx).
//
// Two orthogonal facts drive every import action:
//   • whether the book is ALREADY imported into BE (has content in D1), and
//   • the user's INTENT — "translate a new book" (pull the upstream English
//     source so they can translate + AI-Translate) vs "load my existing work"
//     (pull the org's own repo to view/edit/proofread).
//
// The load-bearing SAFETY claim, unit-tested in importIntent.test.mjs:
//   an ALREADY-IMPORTED book must NEVER hit the destructive POST /import.
//   importActionFor only ever returns { kind: "import" } when !imported (the
//   book is empty, so a full bootstrap is safe). An imported book routes to
//   the editor ({ kind: "open" }); a pristine-preserving re-pull is a separate,
//   explicit affordance (POST /reimport via ImportFromDoor43Dialog), never the
//   primary action, and a destructive re-bootstrap stays admin-only + confirmed.

export type ImportIntent = "translate" | "load";

/**
 * The intent the workspace should default to for a book. A not-yet-imported
 * book defaults to "translate a new book"; an imported one defaults to
 * "load my existing work".
 */
export function defaultIntent(imported: boolean): ImportIntent {
  return imported ? "load" : "translate";
}

export type ImportAction =
  // Destructive full bootstrap (POST /api/books/:book/import). Only ever
  // returned for a NOT-imported (empty) book. `translateFromSource` picks the
  // upstream English source (translate intent) over the org's own repo.
  | { kind: "import"; translateFromSource: boolean }
  // The book already has content — route the user into the editor. Re-pulling
  // is a separate, explicit, non-destructive action (never returned here).
  | { kind: "open" };

/**
 * Map (imported, intent) → the action the primary button performs.
 *
 * SAFETY-CRITICAL: never returns { kind: "import" } for an imported book.
 */
export function importActionFor(imported: boolean, intent: ImportIntent): ImportAction {
  if (imported) {
    // Has content: the destructive bootstrap is off the table regardless of
    // intent. Send the user to view/edit; re-pull is offered separately.
    return { kind: "open" };
  }
  // Empty book: a full bootstrap is safe. Intent only picks the source.
  return { kind: "import", translateFromSource: intent === "translate" };
}

/**
 * The default range string to seed the Re-pull (ImportFromDoor43Dialog) input
 * with, from a book's chapter list. The whole book, so accepting the default
 * refreshes everything (not just chapter 1) — the user can still narrow it:
 *   • []          → "1"          (unknown; a safe single-chapter fallback)
 *   • [7]         → "7"          (single chapter — no range needed)
 *   • [1,2,…,50]  → "1-50"       (span the whole book)
 * Chapters may arrive unsorted; we span min…max so gaps don't truncate it.
 */
export function repullDefaultRange(chapters: number[]): string {
  if (chapters.length === 0) return "1";
  const sorted = [...chapters].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return first === last ? String(first) : `${first}-${last}`;
}

/**
 * Classify a whole-book AI-translate run so the UI never reports a clean
 * success when per-chapter starts actually failed. `startBookAiTranslate` is
 * best-effort and tallies started/skipped/failed:
 *   • nothing started or already-running → "failed" (surface an error)
 *   • some started but ≥1 failed          → "partial" (surface a warning)
 *   • everything started/already-running  → "success"
 */
export function classifyAiTranslateResult(r: {
  started: number;
  skipped: number;
  failed: number;
}): "success" | "partial" | "failed" {
  if (r.started === 0 && r.skipped === 0) return "failed";
  if (r.failed > 0) return "partial";
  return "success";
}

/**
 * What the Import workspace's main pane should show. The book's imported status
 * is only known once the GET /api/books list resolves — until then we must not
 * render the intent toggle / action (a deep-link to an imported book would
 * briefly look un-imported and offer a destructive-looking "Import" button).
 */
export function mainPaneState(
  hasBook: boolean,
  booksLoaded: boolean,
): "empty" | "loading" | "ready" {
  if (!hasBook) return "empty";
  if (!booksLoaded) return "loading";
  return "ready";
}
