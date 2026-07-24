-- 0063 — widen the terminology identity to include the rendering.
--
-- 0040 keyed the unique identity on (concept_id, source_term, status), which made
-- the table one-term-one-string: a second, equally-valid `preferred` rendering of
-- a concept could not coexist with the first — the CSV importer's UPDATE-by-
-- identity silently overwrote it. That contradicts
-- docs/CONTEXT-REPO-CONTRACT.md §3.3: "one concept MAY have several
-- preferred/admitted rows — sense-dependent renderings are legitimate; do not
-- treat the table as one-term-one-string" (the real Arabic termbase has concepts
-- with three preferred renderings).
--
-- The new identity adds target_term, matching termKey() in
-- api/src/translationMemoryLib.ts exactly.
--
-- COALESCE(target_term, '') is load-bearing: in SQLite, NULLs are always
-- distinct inside a UNIQUE index, so a bare `target_term` column would let
-- unlimited NULL-target duplicates through — precisely the `do_not_translate`
-- rows (empty target by contract) that must still collide with each other. It
-- also keeps the index in lockstep with termKey(), which folds
-- null/undefined/whitespace target_term to the empty string.

DROP INDEX IF EXISTS terminology_identity;

CREATE UNIQUE INDEX terminology_identity ON terminology(
  LOWER(TRIM(concept_id)), LOWER(TRIM(source_term)),
  LOWER(TRIM(COALESCE(target_term, ''))), status
) WHERE deleted_at IS NULL;
