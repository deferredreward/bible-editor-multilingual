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

**Status:** SHIPPED 2026-07-20. At OAuth callback we now read the signing-in
user's Door43 teams and grant admin/editor from them.

**How it works:** `api/src/dcsTeams.ts` calls `GET /api/v1/user/teams` with the
*user's own* access token (no elevated service-token scope), keeps only teams
inside the configured project org (`getProjectConfig().org`), and maps team
name → role. Defaults are `BE-Admins` → `admin` and `BE-Editors` → `editor`,
overridable per environment via `DCS_TEAM_ADMIN` / `DCS_TEAM_EDITOR`. The
result is cached into `user_roles` (migration `0055_user_roles_source.sql` adds
a `source` column: `'manual'` vs `'dcs_team'`) so `/api/auth/refresh` keeps
working off a plain D1 read. Teams are still created/managed only in Door43's
own team UI — the app never writes membership.

Precedence, one rule (revised by the org/team ↔ auth integration PR): **Door43
teams win; a manual row is only a fallback for users with no team signal at
all.** All covered by `api/src/dcsTeams.test.mjs`:
- `dcs_team` rows track their team exactly, in both directions, including
  removal once the user leaves the team.
- A team signal (admin *or* editor) OVERWRITES a `manual` row — role and
  `source` both — so once Door43 knows about a user, moving them between
  teams there is authoritative in both directions (the earlier "teams may
  only raise" rule made the documented management path silently do nothing
  for allowlisted users). The prior manual role is STASHED in
  `user_roles.manual_role` (migration 0057): when the team signal later
  disappears — the user left the team, or the team was renamed/deleted,
  which is indistinguishable — the row is RESTORED to the stashed manual
  grant instead of deleted, so a team rename can never wipe the manual
  allowlist org-wide. Pure team creations (nothing stashed) still delete.
  A manual row team sync never claimed is untouched by a no-signal sync.
  An admin PUT takes manual ownership (source='manual', stash cleared);
  its response's `wasTeamManaged` drives the "will be re-taken by team
  sync" warning.
- A `user_roles` row also GRANTS WORKSPACE ACCESS by itself: login
  resolution (cookie/last-used retention) and the switch route treat a
  workspace as allowed if the user is a Door43 org member OR already holds
  a role row in that workspace's database — otherwise a manually
  allowlisted outsider would be evicted from their org at every login.
- Membership of the org's Owners team grants NOTHING — only the configured
  admin/editor team names map to roles (rename the team or set
  `DCS_TEAM_ADMIN`/`DCS_TEAM_EDITOR`). A near-miss — the user has teams in
  the org, none matching the configured names, e.g. a team created as
  "BE-Admin" against the default plural "BE-Admins" — logs a diagnostic
  (`wrangler tail`) naming the org, the configured names, and their actual
  teams.
- The last remaining admin is never demoted *or* deleted, matching the guards
  in `adminUserRoutes.ts` — `/api/admin/users` is itself admin-gated, so a
  zero-admin project could only be repaired with raw SQL against D1.
- Anything that leaves membership *unknown* — network error, non-2xx,
  unparseable body, or a paginated list truncated at the page cap — skips the
  sync entirely rather than being read as "on no teams". Failures are logged
  (`wrangler tail`) so a permanently broken lookup, e.g. an OAuth grant lacking
  org-read scope, is distinguishable from a user genuinely being on no team.
- The org is read straight from `project_config`, NOT via `getProjectConfig`,
  which silently falls back to the default unfoldingWord preset on a read error
  — that fallback would revoke every GL project's team roles on a transient D1
  hiccup. If the org can't be established, the sync is skipped.
- Revocation latency: `/api/auth/refresh` re-checks a cached team role once it
  is older than an hour (`RESYNC_AFTER_SECONDS`), reusing the DCS token already
  stored on the users row. Without that, removing someone from a team wouldn't
  take effect until their next full sign-in — up to the 14-day refresh window.
  **This is best-effort, not a guarantee — see the follow-up below.**
- `viewer` is still dynamic (org membership), never cached in `user_roles`.
- Nothing in this path may break sign-in: the whole block is wrapped so that a
  D1 error (notably `no such column: source`, in the window between deploying
  the worker and applying migration 0055) leaves the allowlist untouched
  instead of 500-ing the OAuth callback for every user.

**Follow-up — persist the OAuth refresh token so team revocation is reliable.**
The refresh-time re-check above uses `users.dcs_access_token`, captured at
sign-in. We never store the OAuth `refresh_token`, and Gitea's access tokens are
short-lived, so in practice that token is usually dead by the time the hourly
re-check wants it: `/user/teams` 401s, the result is "unknown", and the cached
role survives until the user's next full sign-in. **Net effect: removing someone
from a Door43 team is not a prompt revocation.** For anything time-critical,
remove the row in the Preferences panel *and* take them out of the team.

To close it: store `refresh_token` (+ expiry) from the token exchange in
`callbackDcsAuth`, and in `maybeResyncTeamRole` exchange it for a fresh access
token when the teams call returns 401 before giving up. Deliberately not done in
the shipping PR — it is new code in the sign-in path that can't be exercised
without a live Door43 OAuth session, and getting it wrong locks everyone out.
Failing closed (dropping a role that can't be re-verified) was considered and
rejected: a structurally broken lookup, e.g. an OAuth grant lacking org-read
scope, would then escalate from "feature does nothing" to "nobody can work".

**Not verified:** the live round-trip against
`https://git.door43.org/org/BibleEditorMLTest/teams` — the teams API needs an
authenticated session, so the *actual* team names in that org were never read.
If they aren't literally `BE-Admins`/`BE-Editors`, set `DCS_TEAM_ADMIN` /
`DCS_TEAM_EDITOR` rather than changing code.

### Per-user org switching (membership-scoped)

**Status: SHIPPED (core)** — on branch `worktree-feat-org-workspaces`. A
signed-in user can now switch between registered Door43 orgs without wiping
the database. Today's `project_not_empty` 409
(`api/src/projectConfigApply.ts:159`) is untouched and still correct — it
guards *repointing one database at a different org*, which is no longer how
you change orgs.

**The model that shipped ("workspaces"):** one D1 database per org, declared
in `api/wrangler.toml`'s `WORKSPACES` var; a `be_ws` cookie picks the
workspace; `index.ts`'s `fetch` wrapper swaps `env.DB` in exactly one place
via `workspaceEnv()` so none of the ~494 `env.DB` call sites changed.
`SHARED_DB` (bound to the same database) holds accounts, sessions, lexicon,
alignment frequencies and UI-string overrides so a switch doesn't sign you
out or force a per-org lexicon import. `user_roles` is deliberately per-org.
Unset/empty `WORKSPACES` = exactly today's single-org behavior.

**What is still deferred** (be specific, these are the real remaining gaps):

1. **Adding an org needs a deploy.** A new org means `wrangler d1 create`, a
   new `[[d1_databases]]` binding, a `WORKSPACES` entry, deploy, migrate.
   Fully self-serve provisioning would mean talking to D1 over the HTTP API
   instead of a native binding (losing local-dev parity and needing its own
   migration runner) — deliberately not attempted. Needs its own design
   pass; don't attempt as a quick patch.
2. **`users.last_book/last_chapter/last_verse` is shared, not per-org**, so
   the "resume where you left off" position follows you across orgs. Minor,
   but wrong.
3. **Narrow outbox race on very first load.** The outbox database name
   depends on the workspace slug, which is only known once
   `/api/auth/me` returns. `App.tsx` reconciles and reloads once, but an edit
   queued in that sub-second window lands in the pre-reconciliation database
   and is not drained. Fix would be to defer outbox opening until the slug is
   known.
4. **Per-workspace R2.** `BLOBS` is still a single bucket shared by all
   workspaces. Export snapshots/USFM originals from different orgs share a
   keyspace — check for key collisions before running a second org's export
   in production.
5. **`GET /api/exports/instance/:id` resolves Workflow instances globally.**
   Instance ids are predictable (`nightly-<slug>-<date>`), and the route
   doesn't check that the id belongs to the caller's current workspace —
   an admin in one org can read another org's export status/errors by
   guessing the id. Admin-only information leak, low severity, not fixed in
   this PR.

**Bootstrapping a brand-new org's roles — SOLVED (team-derived), escape
hatch retained.** The finer-grained answer landed with the org/team ↔ auth
integration PR: a fresh org's first admin now comes straight from Door43
team membership. The OAuth callback resolves the login workspace from the
user's actual DCS orgs (be_ws cookie → persisted last-used workspace →
single org match → first match + picker prompt) instead of forcing
first-time users into `WORKSPACES[0]`, runs the team sync + role resolution
against THAT workspace's database, and — when the resolved role is admin —
seeds the workspace's `project_config` from its org preset so the first
admin lands ready to run Setup. Switching into a workspace also team-syncs
against the target DB first, so a first-time entrant gets their team role
immediately instead of landing as viewer until their next full sign-in.
`SUPER_ADMINS` remains as the blunt-instrument escape hatch (admin in every
workspace, no team needed) for repairing an org whose team setup is itself
broken.

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

## No re-source/reset operation in the books API

**Status:** not started — a naming/shape observation from a code review, not a
bug. `force` on `POST /api/books/:book/import` is really a *second, different*
operation ("wipe this book's notes/questions and re-source them from the
English source") that happens to share a URL with "import this book if it
isn't imported yet." Passing `force: true` bypasses two of the handler's
early-return branches, flips the auth check from editor-level to admin-only
partway through the same function, and adds a 409 confirm-negotiation step
(`has_local_edits` + `confirmDiscardEdits`) that the plain import path never
needs.

**What's wanted (if we ever clean this up):** split it into its own route,
e.g. `POST /api/books/:book/resource`, with `requireAdmin` as ordinary
declarative middleware instead of an inline mid-handler check, delegating to
the same underlying `importBookFromDcs`. This would be a pure code move — no
behavior change — since the logic already exists and is already gated
correctly at runtime; it's just reachable through one overloaded URL instead
of two purpose-named ones. Low priority: this is a single-client internal
API (only this app's own frontend calls it), so the current URL shape is not
a compatibility commitment and can move whenever it's convenient.

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
