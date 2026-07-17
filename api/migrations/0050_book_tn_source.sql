-- Records where a book's translationNotes were sourced from, so the nightly DCS
-- reimport can SKIP tn for books whose tn was pulled from Aquifer (rebuilt on the
-- current en_tn skeleton). A BSOJ/ar_tn reimport must not clobber/prune those
-- en_tn-based Aquifer draft rows. NULL = the default (tn came from the configured
-- DCS repo, normal reimport applies). Value shape: 'aquifer:<aqLang>' e.g. 'aquifer:arb'.
ALTER TABLE book_imports ADD COLUMN tn_source TEXT;
