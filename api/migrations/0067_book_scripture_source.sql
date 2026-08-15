-- Sibling of 0050_book_tn_source / 0054_book_tq_source: records where a book's
-- ULT/UST/TWL were sourced from, so the nightly DCS reimport AND the nightly
-- export can SKIP that resource for books whose scripture/twl did not come
-- from the configured org/lane repo. NULL = the default (the resource came
-- from the org's own repo / active lane, normal reimport/export applies).
-- Unlike tn/tq there is no Aquifer path for scripture/twl, so the only value
-- shape produced is 'source:<owner>/<repo>' (pulled from the project's
-- configured English translationSource during a translate-mode import — see
-- scriptureImportOverrides() / sourceProvenance() in dcsSources.ts). Issue #142.
ALTER TABLE book_imports ADD COLUMN ult_source TEXT;
ALTER TABLE book_imports ADD COLUMN ust_source TEXT;
ALTER TABLE book_imports ADD COLUMN twl_source TEXT;
