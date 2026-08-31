-- Provenance stamp for BULK review-state writes on tn/tq rows (issue #296).
--
-- WHY THIS COLUMN EXISTS. `translation_state = 'validated'` means two very
-- different things depending on how it got there:
--   * a translator opened one row, read it, and clicked Approve
--     (POST /api/rows/tn/:id/validate) — a per-row human judgement; and
--   * an admin (or an importer) made a BULK statement about a body of work
--     ("this whole book was already checked upstream") without any row-by-row
--     review.
-- The AI few-shot pipeline treats `validated` as human-approved GOLD (it is the
-- selector behind examples/validated.jsonl in the nightly context export), so
-- folding the second kind into the first quietly poisons the training set with
-- rows nobody read. `translation_state` alone cannot tell them apart.
--
-- WHAT THE VALUE MEANS. Non-NULL = "a bulk sweep set this row's state". The
-- value itself is the state the row held IMMEDIATELY BEFORE the first sweep
-- (`COALESCE(translation_state, 'none')`) — 'none' for a never-drafted imported
-- row, otherwise 'ai_draft' | 'edited' | 'validated'. Recording the displaced
-- state (rather than a bare flag) keeps the sweep reversible-by-inspection and
-- tells a later reader whether the sweep overwrote a real human decision.
-- The stamp is written once and never re-derived, so a second sweep does not
-- lose the original pre-sweep state.
--
-- WHO READS IT.
--   * api/src/contextExport.ts — the validated-examples selectors filter
--     `admin_bulk_state IS NULL`, so swept rows never become few-shot gold.
--   * api/src/reimportClassify.ts — a stamped row is no longer "pristine", so
--     the nightly DCS reimport will not rewrite content underneath a bulk
--     approval and leave the label describing content nobody approved (#394).
--   * api/src/aquiferImport.ts stamps its own bulk approve the same way (#393):
--     it is the same act, and was previously invisible to both readers above.
--
-- NULL is the overwhelmingly common case (every row not touched by a bulk
-- sweep), so this stays cheap on an English database.
ALTER TABLE tn_rows ADD COLUMN admin_bulk_state TEXT;
ALTER TABLE tq_rows ADD COLUMN admin_bulk_state TEXT;

-- Partial indexes: the few-shot selectors and the reimport read this column
-- alongside translation_state. Only the (rare) non-NULL rows are worth indexing
-- — on a database with no bulk sweeps these indexes are empty.
CREATE INDEX IF NOT EXISTS tn_rows_admin_bulk_state
  ON tn_rows (book, admin_bulk_state)
  WHERE admin_bulk_state IS NOT NULL;
CREATE INDEX IF NOT EXISTS tq_rows_admin_bulk_state
  ON tq_rows (book, admin_bulk_state)
  WHERE admin_bulk_state IS NOT NULL;
