# Deferred work

These are items from the original plan / red-team review that intentionally
weren't shipped in the current pass. Each carries enough context to pick up
cold. The fixes that *did* land are summarized at the bottom.

## Scripture-translation demo prep (2026-07-17)

Deferred during the Monday-demo unblock session (org BSOJ, `ar-bsoj` preset).
Context: `STATE.md` entries `claude/scripture-translation-demo-unblock-b59d07`,
`feat/admin-user-management`, `feat/onboard-translate-smoke`,
`feat/aquifer-pull-button`.

### Import fallback to latest en_tn when the org repo is stale/absent

**Status:** IN PROGRESS — Benjamin kicked this off as a separate background
session on 2026-07-17 (spawned task `task_2058a458`). Check for a branch/PR
before starting fresh work here.

**The problem:** book import always fetches from the configured org's own
repos (`api/src/dcsSources.ts:79-95`, `const org = cfg.org` — no fallback to
`cfg.translationSource`). For org BSOJ, several books' `ar_tn`/`ar_tq` were
generated from an *old* `en_tn` and no longer share row IDs with the current
`unfoldingWord/en_tn` (measured ~2% overlap for MAL). Consequence: (a)
translators see stale English notes with no way to refresh them, and (b) the
AI-translate pipeline drafts against *current* `en_tn` IDs, so applied output
can't correlate to the imported rows — the "bot translates new English, no ID
match" failure mode.

**Why it's not trivial:** the fix touches import, reimport (self-heal),
and export-provenance tracking together — see the task's own investigation
brief for the design questions (trigger heuristic, reimport consistency,
translation_state on fallback rows, export provenance so unfoldingWord
English doesn't get pushed back to the org's own repo).

### Door43 teams as role source (read-side)

**Status:** not started. In-app user management (`user_roles` table +
Preferences panel, `feat/admin-user-management`) shipped instead for the demo;
this is the deferred richer version.

**What's missing:** at OAuth callback, call `GET /api/v1/user/teams` with the
*user's own* access token (no elevated service-token scope needed — this is
the read-only half of what was actually asked for: "groups on Door43 orgs that
BibleEditor can see"). Map `BE-Admins`/`BE-Editors` team membership in the
configured org to `admin`/`editor` roles, and cache the result into
`user_roles` on login so token refresh (which re-reads that table,
`api/src/auth.ts`) keeps working without a DCS round-trip on every request.
Teams themselves are created/managed in Door43's own team UI — the app never
writes team membership, only reads it.

### Per-user org switching (membership-scoped)

**Status:** not started. Today one D1 database holds exactly one org (the
interim tenancy model); switching orgs on a populated database 409s
`project_not_empty` (`api/src/projectConfigApply.ts:159`) and requires an
admin-run reset + re-onboard.

**What's wanted:** a non-admin user should be able to switch between orgs
they are a Door43 member of (not arbitrary orgs), without wiping the shared
database. This is a bigger architectural change than the read-side teams
item above — it implies either per-org D1 routing or a different
data-partitioning model, since today's "one org per DB" assumption is baked
into `project_config`, the lane tables, and the export-owner resolution.
Needs its own design pass; don't attempt as a quick patch.

### Admin-controlled per-user translate/edit toggle

**Status:** not started. Today "translate vs. author" is a *project*-level
property (`translationSource` set/unset by the preset,
`isTranslationProject()` in `api/src/projectConfig.ts`), not a per-user
setting.

**What's wanted:** a toggle a user can flip between translate-review mode
(source pinned above editable AI drafts, approve buttons) and direct-edit
mode, where an *admin* controls whether a given user is allowed to see/use
that toggle at all. This is distinct from the role system (admin/editor/
viewer) — it's a permission on a capability, not an identity role. No
schema or UI exists for this yet.

### Clear the Aquifer export hold after approval

**Status:** not started. `POST /api/books/:book/aquifer-drafts`
(`api/src/aquiferImport.ts:229-231`) stamps
`book_imports.tn_source = 'aquifer:arb'` so the nightly DCS reimport skips
tN for that book (it would otherwise clobber the just-imported Aquifer
drafts with a re-fetch of the org's own stale tN). That flag is never
cleared, so **validated Aquifer-derived Arabic tN can never reach DCS export**
even after a translator approves every row.

**What's missing:** once all Aquifer-sourced rows for a book reach
`translation_state = 'validated'` (or some other signal the team is happy
with), clear `tn_source` back to null/the normal source so the book
re-joins the export pipeline. Needs a decision on the trigger (all-approved?
an explicit admin action?) and a check that the export path doesn't need to
know the *provenance* was Aquifer once it's approved — only that it's
validated.

### Live AI-translate bot round-trip (verification gap, not a code gap)

**Status:** the pipeline code (queue → dispatch → poll → import → review →
approve) is fully wired and unit-tested, but the actual live round-trip
against `uw-bt-bot.fly.dev` for org BSOJ was **not exercised in this
session** — it requires a DCS OAuth-authenticated browser session, which
only Benjamin can drive (dev-auth is disabled on the deployed dev worker).
Do this before Monday, not during: sign in, import PHM, translate a tQ row
live, confirm the job reaches `done` and the applied row lands correctly.

## Auth cleanup

**Status:** DCS OAuth, `/api/auth/me`, `/api/auth/refresh`, `/api/auth/logout`,
dev sign-in, HttpOnly Access/Refresh cookies, and CSRF-protected writes have
shipped.

**What's missing:**
- Drop the temporary `Authorization: Bearer` fallback once no browser clients
  can still hold old localStorage tokens.
- Consider a small admin/session view if production needs manual revocation
  beyond the existing session-row checks.

## Nightly DCS export hardening

**Status:** The 06:00 UTC cron starts the export Workflow, renders TSV/USFM
from D1, stages snapshots to R2, commits to DCS when `DCS_SERVICE_TOKEN` is set,
and records `export_snapshots`.

**What's missing:**
- Production alerting for failed workflow instances.
- A friendlier admin/status surface beyond the current export endpoints and
  Cloudflare Workflow view.

## Presence — ChapterRoom Durable Object

**Status:** ChapterRoom is routed and the frontend subscribes for row/verse
change broadcasts; the concurrency suite covers PATCH, POST, and DELETE push.
The remaining deferred piece is true peer presence/cursors.

**What's missing:**
- Cursor/presence message schema: `{type: "cursor"|"saved"|..., ...}`.
- UI affordance for peer active-resource dots.
- Optional short-lived WS tickets if the bearer-subprotocol fallback is removed.

## Service worker + outbox-on-close warning

**Status:** Neither exists. The outbox already survives reload via
IndexedDB, but a `beforeunload` warning would catch the case where the
user closes the tab between drain ticks.

**What's missing:**
- `web/src/sw.ts` registered from `main.tsx`. Cache the SPA shell + drain
  the outbox when the worker wakes (Background Sync API).
- A `beforeunload` listener in `web/src/App.tsx` that calls
  `outbox.list()` and prompts if any op isn't `"ok"`. The user can already
  see the same info via `SyncStatusBar`, but a confirmation dialog
  prevents an accidental close.

## True conflict diff/merge UI

**Status:** `SyncStatusBar.tsx` re-arms a conflicted op with the server's
current version — last-edit-wins. That's safer than the previous "silent
stall", but the user can't see *what* the upstream change was.

**What's missing:**
- A modal that renders the local patch vs `conflictCurrent` side by side,
  with field-level "keep mine" / "take theirs" / "merge" actions.
- Per-field merge rules for the structured fields (`quote` and `occurrence`
  are coupled; `note` is free text; `support_reference` is enum-ish).
- See `docs/plan.md §Save protocol step 4` for the original intent.

## Catalogs from canonical ta/tw repos

**Status:** `api/src/catalogs.ts` bootstraps suggestions from whatever's
already in `tn_rows.support_reference` / `twl_rows.tw_link`. Typos
propagate.

**What's missing:**
- A `book_imports`-style importer that pulls
  `unfoldingWord/en_ta/translate/.../*.md` and
  `unfoldingWord/en_tw/bible/*/*.md` into dedicated tables
  (`ta_articles`, `tw_articles` with id, title, body, last_synced).
- Switch the catalog route to read from those tables.
- Refresh nightly alongside the DCS export.

## Import / export hardening

**Status:** Book import, reimport, nightly export, and AI-output import all
exist. Corrupt stored `content_json` now fails read/export paths loudly instead
of being returned as `null` or skipped.

**What's missing:**
- Round-trip tests against a known-good fixture (e.g. `ZEC` or `OBA`)
  covering split alignments, punctuation, and nested milestones.
- Alerting/health checks for corrupted rows discovered in production.

## Per-row keystroke write-ahead

**Status:** Notes (`NoteCard.tsx`), words (`WordsTable.tsx`), and
questions (`QuestionsTable.tsx`) batch in refs and flush to the outbox on
blur / session-end / unmount. Verse content edits are debounced (350 ms)
and flushed on unmount.

**Trade-off:** A browser crash mid-typing loses the in-progress keystroke
buffer for notes/words/questions. The outbox safely handles everything
that's been flushed.

**What's missing if it matters:** Convert the row-editor flush path to
enqueue each debounced patch instead of holding it in a ref. Expect more
churn in the outbox (one op per ~350 ms of typing instead of one per
session) but stronger crash safety.

## UX correctness items (smaller scope)

| Item | Where | Notes |
|---|---|---|
| Yellow-dot flags intentionally-unaligned source words | [lib/alignment.ts:233-241](../web/src/lib/alignment.ts) | Function words (Hebrew prepositions, articles) get flagged as "TODO" forever. Need a "deliberately skip" marker. |
| `verseHasUnalignedWork` full-parses every call | same | Cache per (chapter, verse) so the rail isn't re-parsing 30× on chapter swap. |
| Hebrew separator regex | [lib/replace.ts:54](../web/src/lib/replace.ts) | `\s+` doesn't cover maqaf (`־`), paseq (`׀`), sof pasuq (`׃`). Likely irrelevant since find/replace is GL-only, but flagged. |
| `localizedRewriteVerse` NFC mismatch | [lib/replace.ts:381-396](../web/src/lib/replace.ts) | Case-sensitive plain↔raw mapping desyncs on differing NFC forms. Narrow edge. |
| Mixed MUI versions | [web/package.json:14-19](../web/package.json) | `@mui/styles@^6.5.0` is a deprecated v5-era package; safe today because nothing imports it. |
| Deprecated `@mui/styles` still installed | [web/package.json](../web/package.json) | Safe today because nothing imports it; remove when theme cleanup happens. |
| `AGENTS.md` vs `CLAUDE.md` duplication | repo root | Both files have identical 176-byte content. Pick one and symlink. |
| `tn_rows.sort_order` migration overwrites on rerun | [migrations/0003_tn_sort_order.sql](../api/migrations/0003_tn_sort_order.sql) | Add `WHERE sort_order IS NULL`. Same for `0004_twl_sort_order.sql`. Cheap. |
| Corrupt `content_json` alerting | [api/src/contentJson.ts](../api/src/contentJson.ts) | Reads/export now fail loudly; add production alerting or a health-check query if corruption is ever observed. |

## Surface `\ts\*` chunk markers from imported USFM

**Status:** Front-end ([PR #77](https://github.com/deferredreward/bible-editor/pull/77) onward) now renders, edits, and round-trips `\ts\*` chunk milestones — the moment they show up in `content_json.verseObjects` as `{tag:"ts", content:"\\*"}`, they appear in all three scripture views as a dashed chunk divider, are editable as a chip, drift to the next verse like `\q1`, and tokenize back on save.

**The gap:** `usfm-js` silently drops them at parse time. Measured on `docs/samples/en_ult_38-ZEC.usfm`: 154 raw `\ts\*` lines in source, 1 surviving node in the parsed JSON. So even after re-importing every book, the chunk markers stay invisible to the editor because they never enter D1 in the first place.

**Why this is OK to defer:** none of our current internal tooling actually consumes `\ts\*` for anything load-bearing — it's metadata for chunking translation work, useful for translators who want to see the chunk boundaries the source team set, but nothing downstream breaks without it. So this is a UX nice-to-have, not a data-integrity bug.

**Plan if we do want to fix it:**

1. **Post-process injection in the importer** (preferred). Re-scan the raw USFM line-by-line in parallel with `usfm.toJSON`, tracking which `\v N` block each `\ts\*` falls inside (or before, since usfm-js's convention is that markers preceding `\v` attach to the prior verse's verseObjects — `extractTrailingMarkers` already drifts them forward). For each `\ts\*` found, splice a `{tag:"ts", content:"\\*"}` node into the appropriate `verseObjects` array at the right offset.
   - Touch points: [scripts/import-book.mjs](../scripts/import-book.mjs) (one-shot path) and [api/src/importParsers.ts](../api/src/importParsers.ts) (the shared importer used by the inbound-from-DCS pipeline).
   - Round-trip safety check: `usfm.toUSFM` should re-emit `\ts\*` from `{tag:"ts", content:"\\*"}` cleanly — verify with a parse → serialize diff on ZEC.
2. **Alternative — pre-process swap.** Convert `\ts\*` to a placeholder marker usfm-js does preserve (e.g. a custom `\zts\*` milestone) before `toJSON`, then unswap on export. Quick but adds a hidden encoding that future readers of `verseObjects` won't expect.
3. **Patch / fork usfm-js.** Biggest lift; no obvious benefit over (1).

**Once data is flowing, re-import every book** to populate the missing nodes in existing rows. No frontend changes needed.

## What did land in this pass

- CORS: env allowlist replaces the origin-echo CSRF hole.
- Auth: `jose`-based HS256 verification, `requireAuth` gates every write,
  identity propagates to `updated_by` and `edit_log.user_id`. Dev token
  endpoint for local development.
- Optimistic concurrency: `If-Match` mandatory; the version check lives
  inside the `UPDATE … WHERE id = ? AND version = ?`. Two concurrent
  writers can no longer both succeed at the same version.
- Audit log atomicity: row + audit ship as one D1 batch with
  `INSERT … SELECT WHERE EXISTS` so the audit insert is conditional on the
  UPDATE matching.
- `bibleVersion` allowlist (ULT/UST/UHB/UGNT) on verse routes.
- Outbox hardening: in-flight ops are re-armed on startup; 408/425/429/5xx
  are now retried; per-target conflict isolation (one hot row doesn't
  freeze the queue); persist-error path resets to `pending` instead of
  stranding; `resolveConflict` re-arms every sibling op for the same
  target so one upstream change produces one resolution prompt.
- Stacked editor `ActiveLine` now saves: `onInput` debounced (350 ms),
  flushed on blur and unmount, with the highlight-resync effect guarded
  so it doesn't reset the caret on round-trip.
- `setVerseDone` routed through the outbox (offline-safe).
- `moveTarget` rejects unknown destination groups.
- Find/replace skips read-only versions, re-derives match positions per
  iteration (no more index drift after `normalize()`), and surfaces an
  alert when alignment milestones were destroyed.
- Sync-status pill in the corner with a "resolve N conflicts" action so
  `outbox.resolveConflict` has a UI caller.
- `DocColumn` flushes its debounced edit on unmount.
