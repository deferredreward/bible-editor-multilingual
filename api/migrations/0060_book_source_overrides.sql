-- Per-book, per-resource source override (issue #103, Tier 1 step 1).
--
-- Extends the source-config model from PROJECT scope (project_config /
-- translationSource.repos[role], shipped in #84 / PR #90) to BOOK scope: an
-- admin can point ONE book's resource at a specific DCS org/repo, overriding
-- the project-wide translationSource ref for that book alone. The BSOJ driver:
-- pull Mark's translationNotes from Aquifer/unfoldingWord while the rest of the
-- project keeps its own org repos.
--
-- Resolution precedence (api/src/bookSource.ts):
--   per-book override  →  project-wide translationSource.repos[role]  →  org's own repo.
--
-- SECURITY: org/repo are DCS idents, validated on write (repoUrl.isIdent) AND
-- re-validated on read through normalizeSourceRef (dcsSources.ts) — the stored
-- value is NEVER trusted raw, matching the project-wide path's defense in depth
-- (a value must never leave resolution as a URL-path traversal).
--
-- HOLD-OUT: importing a book's tN from a per-book override stamps
-- book_imports.tn_source = 'source:<owner>/<repo>' exactly as the project-wide
-- English-source fallback does, so heldOutNoteResources() already holds that
-- book out of BOTH the nightly DCS reimport and export — no new hold-out logic.
--
-- Scope: tN only for this first increment (resource = 'tn'). tQ/tW/scripture and
-- per-chapter-range (Tier 2) are fast-follows; the (book, resource) PK already
-- accommodates the other resources, and a later migration adds range columns.
CREATE TABLE book_source_overrides (
  book        TEXT NOT NULL,             -- canonical 3-char id, e.g. 'MRK'
  resource    TEXT NOT NULL,             -- 'tn' (tq | tw | scripture fast-follow)
  org         TEXT NOT NULL,             -- DCS owner ident
  repo        TEXT NOT NULL,             -- DCS repo ident
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by  INTEGER REFERENCES users(id),
  PRIMARY KEY (book, resource)
);
