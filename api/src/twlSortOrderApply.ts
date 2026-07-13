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
  // Batch update all rows at once, scoped to `book`. TWL row identity is
  // (book, id) — the 4-char ids are unique per book, NOT globally (migration
  // 0015) — so the UPDATE MUST filter on book or it would clobber a same-id row
  // in another book. All values are BOUND (never interpolated) to keep ids out
  // of the SQL text.
  const caseClauses = updates.map(() => "WHEN ? THEN ?").join(" ");
  const inPlaceholders = updates.map(() => "?").join(", ");
  const sql =
    `UPDATE twl_rows ` +
    `SET sort_order = CASE id ${caseClauses} END, version = version + 1 ` +
    `WHERE book = ? AND id IN (${inPlaceholders})`;
  const binds: unknown[] = [];
  for (const u of updates) binds.push(u.id, u.sort_order); // CASE id WHEN <id> THEN <sort_order>
  binds.push(book);
  for (const u of updates) binds.push(u.id); // IN (...)
  try {
    await db.prepare(sql).bind(...binds).run();
  } catch (e) {
    console.error("applyTwlSortOrderUpdates failed", { book, updateCount: updates.length, error: e });
    // Non-fatal: a sort order update failure doesn't block the caller (export or
    // reimport). The TSV is already rendered in the correct order; future
    // operations just won't have the updated sort_order in D1.
  }
}
