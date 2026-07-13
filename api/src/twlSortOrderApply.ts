// Shared D1 apply for TWL canonical sort_order updates. Used by BOTH the nightly
// export (exportWorkflow.applyTwlSortOrderUpdates) and the reimport canonical
// post-pass (bookReimport). Sets sort_order to the computed value and bumps
// version (for audit) — it does NOT touch content/updated_by and does NOT write
// edit_log (a reorder is transient last-write-wins, not a versioned content
// edit). Idempotent (same updates → same result) and best-effort: a failure is
// logged and swallowed so a sort-order update can never fail the caller.
export async function applyTwlSortOrderUpdates(
  db: D1Database,
  book: string,
  updates: Array<{ id: string; sort_order: number }>,
): Promise<void> {
  if (updates.length === 0) return;
  // One UPDATE per row, sent as a single atomic D1 batch (one subrequest). Each
  // statement binds just 3 values, so this stays well under D1's ~100
  // bound-parameter-per-statement cap even for a book-level reorder of hundreds
  // of rows (a single CASE...WHEN over all rows would blow that cap). Scoped to
  // (book, id): the 4-char ids are unique per book, NOT globally (migration
  // 0015), so the filter MUST include book or it would clobber a same-id row in
  // another book. version is bumped for audit; content/updated_by untouched.
  const stmt = db.prepare(
    `UPDATE twl_rows SET sort_order = ?1, version = version + 1 WHERE book = ?2 AND id = ?3`,
  );
  try {
    await db.batch(updates.map((u) => stmt.bind(u.sort_order, book, u.id)));
  } catch (e) {
    console.error("applyTwlSortOrderUpdates failed", { book, updateCount: updates.length, error: e });
    // Non-fatal: a sort order update failure doesn't block the caller (export or
    // reimport). The TSV is already rendered in the correct order; future
    // operations just won't have the updated sort_order in D1.
  }
}
