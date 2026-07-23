# Loop state · bible-editor

> The agent forgets; this file does not. It holds what this project **is** — what's blocked
> on a human, the durable lessons that aren't in the code, and the standing goals.
>
> **This file must not contain a session log.** No "Last run", no "Completed", no
> "In progress". Those sections were removed on 2026-07-20: every parallel worktree wrote
> them at the same anchor line, so git got N blocks claiming one position and the file
> conflicted on essentially every merge (the log had reached ~1,780 of 1,866 lines).
> What just happened belongs in **the commit message and the PR description** — written
> once, per branch, and structurally incapable of conflicting.
>
> - **In-flight status goes in `.claude/state/<worktree-name>.md`** — one small file per
>   worktree, deleted when its PR merges. Separate files never collide.
> - **Never commit a STATE.md-only change to main.** A note *about* a PR belongs in that
>   PR's thread; a code-free commit to a shared file makes every open branch stale.
> - A conflict that *does* survive here is now meaningful: two sessions learned
>   contradictory things, and that's worth stopping for.
>
> Pair it with the standing spec: [`CLAUDE.md`](CLAUDE.md) (how to work here) and
> [`docs/plan.md`](docs/plan.md) / [`docs/handoff.md`](docs/handoff.md) (where the project is going).
> Deliberately-postponed work lives in [`docs/deferred.md`](docs/deferred.md), not here.

## Escalated / blocked on a human (not a code change Claude can land alone)

- **Apply migration `0062_book_source_kind.sql`** — local (`bible_editor_dev --local`)
  and, when the Aquifer-per-range PR lands, prod. Adds `kind TEXT NOT NULL DEFAULT
  'dcs'` to `book_source_overrides` for the issue #103 follow-up (Aquifer as a
  per-chapter-range tN source). Existing rows default to `'dcs'` (no behavior
  change). The feature is inert until applied. (DEV fork only; never
  `--env production` here.)
- **Apply migration `0043_pipeline_job_source_generation.sql`** — local (`bible_editor_dev --local`) and prod (`bible_editor --remote --env production`) before relying on pipeline source stamps or `staging` book-status CAS. Code landed on `feat/scripture-repo-preferences`; D1 not applied this session.
- **Apply migration `0059_scripture_lane_carry_forward.sql`** — local (`bible_editor_dev --local`) and, when PR-2 lands, prod. Adds `mode` + `carried_forward` to `scripture_lane_replacement_books` for issue #94 carry-forward. PR-1 code (`copyBookForward` in `scriptureLane.ts`) is DORMANT — nothing calls it yet — so applying is only strictly needed before PR-2 wires startReplacement/routes/UI. (DEV fork only; never `--env production` here.)
- **Prod `DEU 27:22` TN content-dup** — 2 live PRISTINE notes, same content (occ 1, quote `שֹׁכֵב֙ עִם`,
  note "See how you translated 'lies with'…") under ids `y3oq` + `oi0y` (both valid ids — a pure
  doubling, not a digit-first id). The new reimport Guard 2 PREVENTS new doubles but does NOT remediate
  this existing pair (it's insert-time only). Remediate by soft-deleting one copy (`scripts/dedup-tn.mjs`
  or the prod verse-repair pattern: version+1 + edit_log). Found 2026-06-18 via a corpus-wide live
  pristine content-key scan (only 1 such group corpus-wide). (memory: tn-ai-duplication-roundtrip)
- **en_ust master `PSA 24:6` UST** — unclosed `\qs` Selah still malformed on master; D1 already healed (v2).
  Needs the `-be-` export branch merged to land the fix. (memory: selah-qs-malformation-psa246)
- **Prod `MIC 5:5`** — bracket/period-marker engine bugs fixed in code, but the already-stored verse
  still needs re-alignment / re-import. (memory: mic-bracket-and-period-marker-bugs)
- **AI TN doubling, master `ISA 10:29`** — remediate doubled notes via `scripts/dedup-tn.mjs`;
  D1 copy `ISA 29:30` also affected. Root fix shipped; existing rows still need the cleanup pass.
  (memory: tn-ai-duplication-roundtrip)
- **Dangling `-be-` export refs** — `DCS_SERVICE_TOKEN` can't delete branches; drifted branches must be
  cleared by hand with a maintainer PAT. (memory: export-service-token-no-delete, export-branch-no-rebase-drift)

## Lessons learned (write durable, cross-session facts here — not in chat)

For the full corpus, see the memory index at
`C:\Users\benja\.claude\projects\C--Users-benja-Documents-GitHub-bible-editor\memory\MEMORY.md`.
Highlights that bite repeatedly:

- **Workspace roster is DB-backed as of PR-1 of #81, with a strict fail-soft chain.** `workspaces.ts`
  reads the roster from the `workspaces` registry table on the SHARED DB (migration 0058), loaded once
  per isolate by the async `primeWorkspaces(env)` that the entry points (`index.ts` fetch/scheduled,
  `exportWorkflow.ts`) await before the *synchronous* `resolveWorkspace`/`listWorkspaces`. Ordering is
  **registry → WORKSPACES env var → implicit default** and MUST never throw. Two traps that shaped it:
  (a) seed the table from the env var only, **never the implicit default** — seeding a `{slug:default}`
  row would freeze `VIEWER_ORG` (which the implicit default reads dynamically); (b) D1 returns NULL for
  absent `export_owner`, and `parseEntry` rejects a non-string/non-undefined `exportOwner`, so map
  NULL→undefined before validating. Only `status='claimed'` rows are listable; the other statuses
  (available/provisioning/failed/retired) are spare-pool lifecycle bookkeeping for later PRs.
- **RTL scripture font choice is provisional.** As of the RTL-display fix (branch
  `claude/rtl-language-display-bee8f4`), non-original RTL panes (e.g. Arabic AVD/NAV) render in the
  normal reading stack `"Source Serif Pro","Cambria","Times New Roman",serif` at the standard reading
  size — deliberately NOT the Hebrew original's enlarged SBL-Hebrew treatment (that stays keyed to
  `bibleVersion === "UHB"` alone). Source Serif Pro lacks Arabic glyphs, so Arabic falls back to
  Cambria/Times, which do cover it. **If native Arabic (or other RTL) speakers find the rendering
  ugly/unreadable, switch to an SIL font with real Arabic coverage** (e.g. Lateef, Scheherazade New,
  Harmattan) — bundle it and prepend it to the non-Hebrew branch of the font stacks in
  `web/src/components/{DocColumn,BookView,ScriptureColumn}.tsx` (the `hebrewSource ? SBL : reading`
  ternaries). Direction/alignment are already correct and language-driven (`versionIsRtl` in
  `web/src/lib/versionLabels.ts`); this is purely a glyph-quality follow-up.
- **A synthetic fallback identity for translatable content is a data-loss trap, not a kindness.**
  The note-template sync (`api/src/templateSync.ts`) originally invented a positional id
  (`<supportRef>-p<n>`) when the source sheet had no id column. Those rows are translatable, so the
  moment real ids appeared every one of them would soft-delete and re-insert blank, orphaning any
  translation done in between. Writing *nothing* until identity is trustworthy is strictly safer —
  the sync now aborts with a warning instead. Generalize: when identity is the thing you're missing,
  don't guess it; refuse to write.
- **Fresh worktree:** run `scripts/worktree-init.ps1` to junction `node_modules` from main —
  never reflexively `npm install` on a branch (it leaks deps into main). Only `npm install` in MAIN.
- **Don't kill shared dev servers.** Multiple worktrees share Chrome MCP + dev ports (5173/5174/8787).
  Pick a free port or ask; never `taskkill` a port owner. `5173` is svchost-reserved on this box — relocate vite.
- **Migrations collide across parallel worktrees.** Check `wrangler d1 migrations list --remote` after any
  schema PR; a collided migration number left prod unmigrated → list-route 500s once already.
- **PR already merged?** Before pushing, run `gh pr view --json state,mergedAt`. If merged, rebase onto main,
  branch fresh, open a new PR — do not push to the merged branch. This happens regularly.
- **Hebrew compares must go through `nfc()`** (`web/src/lib/hebrew.ts`) — UHB stores combining marks in legacy
  order; milestones come out NFC. Skipping this silently breaks alignment matching.
- **`usfm-js` parks leading punctuation/markers on the node's `text`** — markers can carry text; opening
  quotes after a marker live on the marker node, not as a sibling.
- **Export USFM puts punctuation outside `\w` (`\w earth\w*.`) on purpose** — correct uW form, not churn; don't "fix" it.
- **An env-clone helper that swaps bindings by name must resolve those bindings from the original env**, or it silently
  returns the currently-active one when re-applied (`workspaceEnv` in `api/src/workspaces.ts` bit this — fixed by always
  reading off a `BASE_ENV` reference). More generally: **per-org identity cached in a token (e.g. a `role` claim) has to
  be re-resolved when the org changes, not just at sign-in** — a workspace/org switch that only swaps the active database
  while leaving a stale claim in the session token is a privilege-escalation seam, not a cosmetic bug.
- **`node:sqlite` (`DatabaseSync`) works for D1 schema/trigger testing.** Node 24's built-in SQLite supports `unixepoch()`,
  `?1`/`?2` positional params, triggers with `RAISE(ABORT)`, and CHECK constraints. Use an in-memory DB + the migration
  CREATE TABLE/TRIGGER statements to unit-test schema invariants without Miniflare. Wrap multi-statement batches in
  `BEGIN`/`COMMIT` with try/catch `ROLLBACK` to match D1 batch atomicity (SQLite's `RAISE(ABORT)` only rolls back
  the current statement, not the whole transaction).
- **Any new module-level cache in `api/src` must be workspace-keyed.** With per-org workspaces
  (`worktree-feat-org-workspaces`), a cache keyed only by e.g. `"project-config"` is shared across every org
  because it lives at the Worker *isolate* level, not per-request. `getProjectConfig`'s 60s cache (and
  `catalogs`/`twlFilters`/`twlSuggest`) leaked another org's config — including `org`/`exportOrg` — after a
  switch until keyed by `WORKSPACE_SLUG`.
- **Cloudflare Workflows do not inherit the per-request env clone** — they read the raw Worker `env` via
  `this.env`, not whatever `workspaceEnv()` swapped in for the triggering request. `ExportWorkflow` rendering
  the wrong org's D1 into the wrong org's DCS repos (plus colliding `nightly-${day}` instance ids masking a
  second org's export entirely) was only caught by actually running two workspaces side by side. Same caution
  applies to anything else handed to a Workflow/Queue/alarm rather than a request closure — re-point `this.env`
  explicitly from params at the top of the handler.

## Stop conditions / goals

- No standing automated loop is wired to this file yet. When one is, record its goal here, e.g.:
  - `/goal "npm run typecheck && npm run build clean"` — met on `<commit>` at `<time>`.
