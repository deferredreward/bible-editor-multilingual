-- Chapter-scoped export observability (see exportWorkflow.ts:exportOne and
-- exportChapterMerge.ts). NULL = a whole-book export (the existing
-- behaviour); "13" or "13-14" = the inclusive chapter range a chapter-scoped
-- run merged into master's whole-book file.
ALTER TABLE export_snapshots ADD COLUMN chapters TEXT;
