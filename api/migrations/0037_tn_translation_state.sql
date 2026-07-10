-- Translation-mode state machine for target-language tN rows (PIPELINE-SPEC §4.1).
-- These columns are NULL for the English root project (authoring, not
-- translating) and for any row never touched by the translate pipeline, so the
-- English workflow is completely unaffected.
--
--   translation_state: NULL | 'ai_draft' | 'edited' | 'validated'
--     ai_draft  — the translate pipeline just applied an AI translation
--     edited    — a human changed the draft (set on content PATCH of a non-NULL row)
--     validated — a human explicitly approved it (POST /tn/:id/validate)
--   source_row_hash: hash of the EN source row the draft was made from, so a
--     later source-note revision can be detected and the target re-flagged.
--   draft_meta_json: the translate-report.json entry for this row
--     (model confidence, template-fallback flag, terms applied) — drives
--     review triage. NULL when the bot ships no sidecar.
ALTER TABLE tn_rows ADD COLUMN translation_state TEXT;
ALTER TABLE tn_rows ADD COLUMN source_row_hash TEXT;
ALTER TABLE tn_rows ADD COLUMN draft_meta_json TEXT;

-- Partial index: the review UI filters by state, and validated-row export
-- (the nightly context-repo append) selects on it. Only non-NULL rows matter,
-- so the index stays tiny on an English database (all NULL).
CREATE INDEX IF NOT EXISTS tn_rows_translation_state
  ON tn_rows (book, translation_state)
  WHERE translation_state IS NOT NULL;
