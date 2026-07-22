# In-flight · issue #103 Tier 1 step 1 — per-book tN source override (backend)

**Branch:** `feat/issue-103-per-book-tn-source` (cut from `claude/jovial-taussig-6dd4b7`)
**Status:** implemented, typecheck + tests green, PR #106 open, pre-merge review passed. DEV FORK ONLY.

## Pre-merge review (Claude self-review + 2 Codex passes)
- Claude pass: added a missing-table guard on the per-book read (runs on every import).
- Codex High (fixed): the guard must NOT swallow *transient* D1 errors — during import of
  an overridden book that would fall back to the wrong repo and clobber the tN rows +
  drop the hold-out. Now only a `no such table` error → null/[]; any other error rethrows.
  Regression test added. Codex verify pass: FIXED, no new regressions.

## What shipped in this increment
Extends source config from PROJECT scope (#84 `translationSource.repos[role]`) to
BOOK scope, tN only. Storage = **dedicated table** `book_source_overrides`
(migration `0058`), keyed `(book, resource)` — NOT a nested map in
`project_config`, so the single security-guarded resolver `resolveSourceRef`
stays book-agnostic (no blast radius on lane/reimport/export/aquifer).

- `api/migrations/0058_book_source_overrides.sql` — `(book, resource, org, repo, …)` PK(book,resource).
- `api/src/bookSource.ts` — get/set/clear/list + pure `resolveEffectiveNoteSource`
  (precedence: per-book → project-wide → org default; re-validates idents on read;
  an override == the org's own repo is a no-op so it isn't spuriously held out) +
  async `resolveBookNoteSourceRef` wrapper.
- `api/src/bookImport.ts` — `noteSource.tn` now resolves through the per-book wrapper;
  `GET`/`PUT /api/books/:book/sources` (admin PUT).
- `api/src/bookSource.test.mjs` — 17 assertions: precedence + traversal/non-ident/no-op guards.

## Provenance / hold-out (verified, SCOPE item 3)
A per-book override sets `noteSource.tn` → `sourceProvenance()` → `book_imports.tn_source`
= `source:<owner>/<repo>` → `heldOutNoteResources()` already holds the book out of
BOTH nightly reimport (`bookReimport.ts:285`) and export (`exportWorkflow.ts:317`).
No new hold-out logic. The org-own no-op guard prevents holding out a book whose
override points at its own repo.

## Explicit follow-ups (NOT in this PR)
- Per-book **tQ / tW / scripture** (widen `BookSourceResource` + import wiring; PK already fits).
- **Reimport** should also consult the per-book override for WHERE to pull (today
  it only reads provenance for hold-out; an override set AFTER an org import isn't
  re-pulled until the next explicit `/import`).
- **Tier 2**: per-chapter-range merge within a book + per-range provenance.
- **UI**: import panel (per-book × per-resource grid, verify-on-blur via `/api/orgs/verify-source`).

## Migration-number caution
Used `0058` (latest on main was `0057`). Parallel worktrees may also add `0058` —
check `wrangler d1 migrations list` after merge (memory: migrations collide across worktrees).
