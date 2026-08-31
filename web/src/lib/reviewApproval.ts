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

// ── The one tN/tQ denominator ────────────────────────────────────────────────
//
// #238: OBA reported 153 / 152 / 148 / 147 notes on four surfaces at once,
// because each computed its own total. The three that mattered were 153 (a raw
// `tn.length`), 152 (the meter and the book-summary rollup), and the two
// approve-all predicates (fixed in #404/#408/#412 via `isApprovableRow`).
//
// THE RULE, one line, used everywhere a note/question total is shown:
//   a row counts iff it is not deleted (the server already drops those) and not
//   trashed.
// That is exactly what the book-summary SQL counts
// (`api/src/chapters.ts`: `deleted_at IS NULL AND trashed_at IS NULL`), so the
// hub, home, meter and panel badges now all read the same denominator.
//
// The chapter payload (`GET /api/chapters/:book/:chapter`) deliberately still
// RETURNS trashed rows — the trash is visible and restorable (a trashed note
// grays out at the bottom of its verse, and the review rail has a "Trashed"
// status filter), so filtering them server-side would delete the trash UI. The
// divergence is intentional and lives here: the payload carries them, the
// counts exclude them, and `trashed` below is what lets a surface say so.
//
// tQ has no `trashed_at` column at all, so the same helper is a no-op on the
// trashed axis for questions — which is the point: one rule, not two.

export type ReviewStats = {
  /** Live rows: not trashed. THE denominator — matches the book-summary SQL. */
  total: number;
  /** Live rows already stamped `validated` — the meter numerator. */
  validated: number;
  /** Live rows an Approve-all click can actually validate (see isApprovableRow). */
  draftIds: string[];
  /** Trashed rows, excluded from `total` — for a "· N trashed" label. */
  trashed: number;
};

/**
 * Count a chapter's (or a verse's) tN/tQ rows under the one rule above.
 * Pass `[]` to get the zeroed shape when the surface is switched off.
 */
export function reviewStats<T extends ApprovableRow & { id: string }>(
  rows: readonly T[],
): ReviewStats {
  let total = 0;
  let validated = 0;
  let trashed = 0;
  const draftIds: string[] = [];
  for (const r of rows) {
    if (r.trashed_at != null) {
      trashed++;
      continue;
    }
    total++;
    if (r.translation_state === "validated") validated++;
    else if (isApprovableRow(r)) draftIds.push(r.id);
  }
  return { total, validated, draftIds, trashed };
}

/** The rows that count, under the one rule above. */
export function liveRows<T extends ApprovableRow>(
  rows: readonly T[] | null | undefined,
): T[] {
  return (rows ?? []).filter((r) => r.trashed_at == null);
}

/**
 * The same rule for a surface that only needs the badge number: how many of
 * these rows count, and how many are sitting in the trash beside them.
 */
export function liveRowCount(rows: readonly ApprovableRow[]): {
  live: number;
  trashed: number;
} {
  let live = 0;
  let trashed = 0;
  for (const r of rows) {
    if (r.trashed_at != null) trashed++;
    else live++;
  }
  return { live, trashed };
}
