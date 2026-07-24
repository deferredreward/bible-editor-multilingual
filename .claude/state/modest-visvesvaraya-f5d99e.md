# modest-visvesvaraya-f5d99e (branch claude/modest-visvesvaraya-f5d99e)

Status: shipped in this worktree, 2026-07-24. Delete this file when the PR merges.

Terminology now supports multiple equally-valid renderings per concept, per
`docs/CONTEXT-REPO-CONTRACT.md` §3.3 ("one concept MAY have several preferred/admitted
rows … do not treat the table as one-term-one-string").

- Dedup/upsert identity widened from `(concept_id, source_term, status)` to
  `(concept_id, source_term, target_term, status)` — `termKey()` in
  `api/src/translationMemoryLib.ts`, null-safe on `target_term` so `do_not_translate`
  rows (empty rendering) still collide correctly.
- Migration `api/migrations/0063_terminology_rendering_identity.sql` drops and recreates
  the `terminology_identity` UNIQUE index with `LOWER(TRIM(COALESCE(target_term,'')))`.
- All identity SQL in `api/src/translationMemory.ts` updated to match the new index: POST
  duplicate pre-check + unique-violation backstop, PATCH pre-check + catch, the import
  existing-keys read (now selects `target_term`) and the phase-1 UPDATE predicate.
  `GET /terms` and `/terms/export` now `ORDER BY concept_id, source_term, status, id` so
  the UI can group in one pass.
- CSV importer no longer silently overwrites: `parseTermsCsv` gained an additive
  `warnings: {line,message}[]` channel reporting genuine duplicates with both line numbers
  (last-wins retained so imports still apply). Surfaced as `parseWarnings` on both the
  dry-run and applied `POST /terms/import` responses.
- UI (`web/src/components/PreferencesWorkspace.tsx`): renderings are grouped under their
  concept (`TermConceptGroup`), each group has "Add another rendering" prefilled with the
  concept + source term, the previously write-only `comment` field now has inputs and a
  read-only display, and `ImportPanel` renders line-numbered errors and warnings (capped at
  20 with a "+N more" tail) for both preview and apply.
- Fixed in passing: `TermRow` mapped *every* 409 to "someone else changed this" and called
  `onChanged()`, discarding the user's edit. PATCH also returns 409 `duplicate_term`, which
  becomes reachable with the widened key — that case now keeps edit mode open with a
  duplicate message; only `version_mismatch` refetches.

Verified: 170/170 api tests pass (new cases: null-safe key, 3 `preferred` renderings on one
concept surviving dedup, duplicate-warning + near-miss-no-warning, round-trip); web tests
pass; `npm run typecheck` clean. Browser-verified against a seeded Arabic termbase: grouping
renders, "Add another rendering" persists a third `preferred` rendering with its comment and
it appears in the CSV export; import preview shows line-numbered errors and the duplicate
warning while a same-concept/different-rendering pair imports with no warning. CSV round-trip
is byte-identical (19 rows in → 0 added / 19 updated → identical re-export).

Docs: `docs/CONTEXT-REPO-CONTRACT.md` evidence note updated (no `format:` bump — the contract
itself was already correct; the writer was not).
