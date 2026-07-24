-- Per-chapter-range source overrides (issue #103, Tier 2).
--
-- book_source_overrides (0060) was keyed (book, resource) — exactly ONE source
-- per book+resource. Tier 2 allows MULTIPLE ranges per (book, resource): the
-- BSOJ driver is tN chapters 1-11 from unfoldingWord and 12-16 from Aquifer in
-- one book. Ranges are [chapter_start, chapter_end] INCLUSIVE.
--
-- Whole-book override (Tier 1 semantics) = (0, 999): chapter_start 0 includes
-- the front matter (refParts maps "front" -> chapter 0), 999 exceeds any real
-- chapter count (Psalms tops out at 150). SQLite cannot alter a PRIMARY KEY, so
-- rebuild the table and migrate every existing Tier 1 row to (0, 999) — i.e.
-- "whole book", byte-for-byte the behavior it had before this migration.
--
-- Non-overlap of ranges within a (book, resource) is enforced by the write path
-- (bookSource.setBookSourceRange), not the schema; the PK only forbids two ranges
-- sharing a chapter_start.
--
-- HOLD-OUT provenance is now RANGE-scoped (heldOutChapters, bookSource.ts):
-- reimport skips, and export merges current-master content for, ONLY the
-- chapters whose range resolves to a cross-org source. The book-level
-- book_imports.tn_source / tq_source marker stays the WHOLE-BOOK signal
-- (aquifer-drafts, the 404 fallback, and a whole-book override) — a partial book
-- leaves it NULL and relies on the range table.
CREATE TABLE book_source_overrides_v2 (
  book          TEXT NOT NULL,
  resource      TEXT NOT NULL,                 -- 'tn' | 'tq'
  chapter_start INTEGER NOT NULL DEFAULT 0,    -- inclusive; 0 = book start (incl. front matter)
  chapter_end   INTEGER NOT NULL DEFAULT 999,  -- inclusive; 999 = book end
  org           TEXT NOT NULL,
  repo          TEXT NOT NULL,
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by    INTEGER REFERENCES users(id),
  PRIMARY KEY (book, resource, chapter_start)
);

INSERT INTO book_source_overrides_v2 (book, resource, chapter_start, chapter_end, org, repo, updated_at, updated_by)
  SELECT book, resource, 0, 999, org, repo, updated_at, updated_by FROM book_source_overrides;

DROP TABLE book_source_overrides;
ALTER TABLE book_source_overrides_v2 RENAME TO book_source_overrides;
