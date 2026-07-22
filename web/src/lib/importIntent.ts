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
