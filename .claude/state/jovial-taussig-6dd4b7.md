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

## PR #109 (feat/issue-103-followups → main; SUPERSEDES #106)
Merged current main in (main landed #105/#107/#108); renumbered migrations to 0060/0061.
Pre-merge review: Codex found 3 (2 High, 1 Med), all FIXED + verified:
(1) truncation guard counted all D1 rows not just owned chapters → dropped partial-book reimport;
(2) cross-source id collision threw AFTER the wipe → stuck partial (now pre-wipe scan, fails clean);
(3) PUT clear path rejected by the both-bounds check → UI Remove broken.
167 API tests + typecheck + web build green. Recommend CLOSING #106 once #109 merges.

## Follow-ups branch (feat/issue-103-followups, stacked on #106)
All #103 follow-ups, built on top of PR #106:
- **tQ widening** + **range-capable storage** (migration 0059 rebuilds book_source_overrides
  with [chapter_start, chapter_end]; whole book = (0,999); Tier 1 rows migrate to (0,999)).
  tW/scripture deliberately OUT (twl language-neutral; scripture = lane model).
- **Tier 2 per-chapter-range**: import fetches base + each range file and splices by chapter
  (insertTn/TqRows gain a chapterFilter); reimport holds out per-chapter on BOTH the direct
  and nightly-staging paths (apply loop + pristine prune both skip held-out chapters); export
  skip extended to range-based partial books (which carry no book_imports marker).
- **Provenance**: base non-null → whole-book book_imports marker; base=org's own + ranges →
  marker NULL, the range table (heldOutChapters) drives per-chapter hold-out.
- **UI**: the Import workspace's "Advanced" accordion is now a per-book source panel
  (admin add/remove ranges, verify-on-blur via /api/orgs/verify-source).

### Known limitations / follow-ups (documented in code + PR)
- **Export is whole-RESOURCE skip** for a partial book — its OWNED chapters don't publish while
  an override exists. The merge-export (owned chapters from D1 + held-out chapters from current
  master) is the real fix; tied to un-deferring cross-sourced note export generally.
- **Cross-source tN/tQ ID collision** within a book fails the import loudly (rare). Follow-up:
  re-mint colliding range-file ids preserving alignment.
- **Aquifer as a per-range source** is separate (aquifer-drafts endpoint; per-range = future).

## Migration-number caution
Used `0058` (latest on main was `0057`). Parallel worktrees may also add `0058` —
check `wrangler d1 migrations list` after merge (memory: migrations collide across worktrees).
