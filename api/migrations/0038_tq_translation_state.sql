-- Translation-mode state machine for target-language tQ rows (PIPELINE-SPEC §4.1).
-- Mirrors 0037_tn_translation_state.sql exactly, for translationQuestions. These
-- columns are NULL for the English root project (authoring, not translating) and
-- for any row never touched by the translate pipeline, so the English workflow is
-- completely unaffected.
--
--   translation_state: NULL | 'ai_draft' | 'edited' | 'validated'
--     ai_draft  — the translate pipeline just applied an AI translation
--     edited    — a human changed the draft (set on content PATCH of a non-NULL row)
--     validated — a human explicitly approved it (POST /tq/:id/validate)
--   source_row_hash: hash of the EN source row the draft was made from, so a
--     later source-question revision can be detected and the target re-flagged.
--   draft_meta_json: the translate-report.json entry for this row
--     (model confidence, template-fallback flag, terms applied) — drives
--     review triage. NULL when the bot ships no sidecar.
ALTER TABLE tq_rows ADD COLUMN translation_state TEXT;
ALTER TABLE tq_rows ADD COLUMN source_row_hash TEXT;
ALTER TABLE tq_rows ADD COLUMN draft_meta_json TEXT;

-- Partial index: the review UI filters by state, and validated-row export
-- (the nightly context-repo append) selects on it. Only non-NULL rows matter,
-- so the index stays tiny on an English database (all NULL).
CREATE INDEX IF NOT EXISTS tq_rows_translation_state
  ON tq_rows (book, translation_state)
  WHERE translation_state IS NOT NULL;
