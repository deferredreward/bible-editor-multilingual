-- Sibling of 0050_book_tn_source: records where a book's translationQuestions were
-- sourced from, so the nightly DCS reimport AND the nightly export can SKIP tq for
-- books whose tq did not come from the configured org repo. NULL = the default (tq
-- came from the configured DCS repo, normal reimport/export applies). Value shapes:
-- 'aquifer:<aqLang>' (Aquifer-sourced) or 'source:<owner>/<repo>' (pulled from the
-- project's English translationSource because the org's own file was stale/absent).
ALTER TABLE book_imports ADD COLUMN tq_source TEXT;
