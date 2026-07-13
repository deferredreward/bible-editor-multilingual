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
  // Batch update all rows at once. Each row's sort_order is set to its computed
  // position, and version is incremented for audit.
  const updateSql = updates
    .map((_, i) => `WHEN '${updates[i].id}' THEN ${updates[i].sort_order}`)
    .join(" ");
  const idList = updates.map((u) => `'${u.id}'`).join(", ");
  const sql = `
    UPDATE twl_rows
    SET sort_order = CASE id ${updateSql} END,
        version = version + 1
    WHERE id IN (${idList})
  `;
  try {
    await db.exec(sql);
  } catch (e) {
    console.error("applyTwlSortOrderUpdates failed", { book, updateCount: updates.length, error: e });
    // Non-fatal: a sort order update failure doesn't block the caller (export or
    // reimport). The TSV is already rendered in the correct order; future
    // operations just won't have the updated sort_order in D1.
  }
}
