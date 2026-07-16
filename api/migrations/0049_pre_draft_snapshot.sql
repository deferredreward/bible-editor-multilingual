-- Pre-draft snapshot: last published content of a row, captured when the translate
-- pipeline overwrites it with an ai_draft. Export emits this for non-validated rows
-- so unapproved AI content never reaches DCS. Cleared on validate. NULL = never
-- overwritten by a draft (or drafted before this migration — legacy).
ALTER TABLE tn_rows       ADD COLUMN pre_draft_json TEXT;
ALTER TABLE tq_rows       ADD COLUMN pre_draft_json TEXT;
ALTER TABLE article_units ADD COLUMN pre_draft_json TEXT;
