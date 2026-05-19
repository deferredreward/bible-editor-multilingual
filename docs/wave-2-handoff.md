# Wave 2 handoff

You are picking up Wave 2 of the security hardening plan. Wave 1 shipped and is smoke-verified on local; production deploy is pending. Read this end-to-end before doing anything else.

## Status

- **Wave 1** (P0 + HIGH) is on `origin/main` as commits `00407642 → 91829ef3 → 3fa9eb5f`.
- Local main checkout (`C:\Users\benja\Documents\GitHub\bible-editor`) is up to date. Local D1 has migrations `0001`-`0017` applied.
- Smoke-tested via Claude-in-Chrome MCP (per [CLAUDE.md](../CLAUDE.md) "Browser-driven verification"): sign-in, edit a note, save (v1 → v2), version-chip click, history dialog (2 entries, no React key warnings), outbox cleaned. Clean.
- **NOT yet deployed to production** (`bible-editor-api.unfoldingword.workers.dev`).

Confirm with the user before starting Wave 2: **deploy Wave 1 first, or fold Wave 1+2 into one prod deploy?** Recommended: deploy first (smaller blast radius, easier rollback).

```sh
cd C:\Users\benja\Documents\GitHub\bible-editor
npx wrangler --cwd api d1 migrations apply bible_editor --remote --env production
npm run deploy
```

## Wave 2 scope (trimmed)

The original plan in `~/.claude/plans/compare-with-these-and-imperative-ember.md` lists 5 sub-items for Wave 2. Two folded into Wave 1:

- 2.2 history auth — DONE (`requireEditor` is on `GET /api/rows/:kind/:id/history`)
- 2.5 JWT algorithm pin — DONE (`jwtVerify(..., { algorithms: ["HS256"] })` in `verifyToken` and `refreshToken`)

Three remain, plus one Wave-1-adjacent cleanup:

### 2.1 OAuth token: query string → URL fragment

- [api/src/auth.ts:214](../api/src/auth.ts:214): `${origin}/?_auth=${...}` → `${origin}/#_auth=${...}`
- [web/src/App.tsx:42-48](../web/src/App.tsx:42): read from `location.hash` instead of `location.search`, parse `#_auth=...`, strip via `history.replaceState`
- **Why**: query strings land in browser history, referer headers, Cloudflare access logs. Fragments are browser-only.
- Wave 3 will replace `localStorage` entirely with `Secure HttpOnly SameSite` cookies — this is the interim fix.

### 2.3 Outbox max-attempts + UI recovery

- [web/src/sync/outbox.ts:397](../web/src/sync/outbox.ts:397): cap `attempts` at 20; on overflow, transition to `kind: "fatal"` with `lastError = "max_attempts_exceeded"`. Add `outbox.discard(opId)` and `outbox.retry(opId)` helpers.
- New: minimal "Failed ops" drawer in [web/src/components/SyncStatusBar.tsx](../web/src/components/SyncStatusBar.tsx) listing failed ops with **[Retry]** / **[Discard]** buttons.
- **Why**: during Wave 1 smoke testing, a stale token caused 403s on one row's PATCH. The op landed at `attempts=27, status=failed` but there was no UI to see or recover it — the SyncStatusBar just showed "1 FAILED". Had to clean it up via DevTools `indexedDB` access.

### 2.4 D1-backed book-import lock + stale-sweeper

- [api/src/bookImport.ts:60-110](../api/src/bookImport.ts:60): replace `const inFlight = new Set<string>()` (per-Worker-isolate, useless across edge nodes) with a row in a new `book_import_locks` table.
- New migration `api/migrations/0018_book_import_locks.sql`: `(book TEXT PRIMARY KEY, started_at INTEGER NOT NULL, started_by INTEGER REFERENCES users(id))`. `INSERT OR IGNORE` to acquire; `DELETE` in `finally` to release.
- Stale-sweep in the existing `*/5` cron at [api/src/index.ts:177-179](../api/src/index.ts:177): `DELETE FROM book_import_locks WHERE started_at < unixepoch() - 600` (10-min TTL — book imports take 5-60s).
- **Why**: H2 from the red-team — two concurrent POSTs to `/api/books/LUK/import` from different Worker isolates would both pass the `inFlight` check and race the DELETE batch.

### Bonus: book-scope `latest_source` subquery

While in [api/src/chapters.ts:32-50](../api/src/chapters.ts:32) — the `latest_source` correlated subquery for tn/tq is still:

```sql
SELECT source FROM edit_log WHERE kind = 'tn' AND row_key = t.id ORDER BY id DESC LIMIT 1
```

After Wave 1's 0017 migration, `edit_log` has a `book` column. Two-line fix: `AND (book = t.book OR book IS NULL)`. Folds naturally with Wave 2's composite-key theme.

## Wave-1 gotchas to inherit

1. **Stale localStorage tokens.** Tokens minted before Wave 1 have no `role` claim → `/api/auth/me` returns `role: null` → "Not authorized" screen. [web/src/App.tsx](../web/src/App.tsx) auto-recovers in dev by dropping the token. Wave 3's cookie session obviates this. **If you change auth shape, think about whether stale tokens need a graceful path.**

2. **Dev "user" is auto-granted admin.** [api/src/auth.ts](../api/src/auth.ts) `mintDevToken` does `INSERT OR IGNORE INTO user_roles VALUES (username, 'admin')` for unknown dev usernames. Production OAuth path requires manual seed in `user_roles`.

3. **Vite watches the MAIN checkout, not the worktree.** When editing for live testing, edit files in `C:\Users\benja\Documents\GitHub\bible-editor\<path>`, not in `.claude/worktrees/<id>/<path>`. To live-test a worktree change: commit on the worktree branch, push, then `git pull` in main. Or just edit both copies during the test cycle.

4. **`edit_log.book` was backfilled in 0017.** Pre-Wave-1 audit entries have `book` populated for non-orphan rows. History query handles via the `(el.book = ?3 OR el.book IS NULL)` fallback — keep that pattern if you add more book-scoped queries against `edit_log`.

5. **The bra8 "5x v1 history" issue (fixed in `91829ef3`).** `preserve` / `hint` / `keep` audit rows write `new_version = prev_version`. History query now filters to `action IN ('create','update','delete','restore')` — keep that exclusion if you add new action types.

6. **Worktree node_modules junction.** `scripts/worktree-init.ps1` from the worktree root junctions `node_modules` from main. Run on fresh worktree.

## Tests Wave 1 did NOT cover

Worth running these as part of Wave 2 verification, or earlier:

- **Cross-book id collision**: import two books with a deliberately overlapping `tn_rows.id` (force via fixture edit), run a pipeline on book A, confirm book B's colliding row is untouched. The [api/src/pipelineImport.ts](../api/src/pipelineImport.ts) book-scoping changes are the high-value bit of Wave 1 and weren't exercised end-to-end.
- **Verse content schema rejection**: `curl -X PATCH /api/verses/ZEC/1/1/ULT -H "If-Match: 1" -d '{"content":null}'` → expect 400 `invalid_body`.
- **Admin gating on `/api/exports/run`**: editor token → 403; admin token → 200.

## Verification (per [CLAUDE.md](../CLAUDE.md))

Drive Chrome via Claude-in-Chrome MCP. `npm run dev` runs cleanly as a `Bash run_in_background` task (the old handoff doc's "vite needs the user" claim is wrong — corrected).

Wave-2-specific smoke checks:
- **Fragment**: sign out, sign in via DCS, confirm DevTools Network shows `/?_auth=` is absent from the redirect URL; token is in `location.hash` only and stripped after.
- **Outbox max-attempts**: throttle `/api/rows` to offline in DevTools Network, make 21 edits, confirm op transitions to `failed` and the drawer shows it with retry/discard.
- **Import lock**: two terminals race `POST /api/books/LUK/import` simultaneously; one returns 200, the other 409 `in_progress`. Confirm no duplicate row inserts (`SELECT COUNT(*) FROM verses WHERE book='LUK'`).

## Shipping pattern (matches Wave 1)

1. Work on a feature branch in a worktree (or this one — `claude/dreamy-jones-41e59b`).
2. `npm run typecheck` + `npm run build` clean.
3. `npx wrangler --cwd api d1 migrations apply bible_editor --local` for any new migrations.
4. Drive Chrome MCP to smoke-test.
5. Commit: `git -c user.email=ju-cldai724@abidinginhesed.com -c user.name=Benjamin commit -m "$(cat <<'EOF' ...)"`
6. Push to main directly: `git push origin <branch>:main`.
7. Pull into main checkout: `cd C:\Users\benja\Documents\GitHub\bible-editor && git pull --ff-only origin main`.
8. (When ready for prod) `npx wrangler --cwd api d1 migrations apply bible_editor --remote --env production && npm run deploy`.

## References

- Plan: `~/.claude/plans/compare-with-these-and-imperative-ember.md` (Wave 2 §, Wave 3 §)
- Project guide: [CLAUDE.md](../CLAUDE.md)
- Original handoff (pre-Wave-1, longer): [docs/handoff.md](handoff.md)
- Wave 1 commits: `git log --oneline d726eb49..HEAD -- ':!docs/wave-2-handoff.md'`
- Red-team source: search the conversation for "verified findings" or read the consolidated table in the plan file
