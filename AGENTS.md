# AGENTS.md

Primary agent/dev guidance for this repo lives in [`CLAUDE.md`](CLAUDE.md) (architecture, save
protocol, common commands) and [`README.md`](README.md). Read those first. This file adds only the
non-obvious cloud/dev-environment caveats.

## Cursor Cloud specific instructions

Single-product npm-workspaces monorepo (`api/` Cloudflare Worker + `web/` React/Vite SPA). In dev
the two run as separate processes; Vite (`:5173`) proxies `/api/*` to Wrangler (`:8787`).

### Node version
- The project pins **Node 24.15.0** (`.node-version`, Volta in `package.json`). Type-stripped `.ts`
  test files and Wrangler need it.
- The sandbox ships a bundled `/exec-daemon/node` (v22) that would otherwise shadow nvm's node on
  `PATH`. Node 24 is installed via nvm and made to win via a `PATH` prepend in `~/.bashrc`
  (`export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"`). Run `node --version` and expect
  `v24.15.0`; if you get v22, re-source `~/.bashrc` or prepend that path.

### One-time local setup (already applied in the VM snapshot; redo only if missing)
These produce gitignored local state, so a plain `git pull` never touches them, but a fresh VM would
need them again:
1. `api/.dev.vars` must exist with a non-empty `JWT_SIGNING_KEY`, else `POST /api/auth/dev` returns
   `jwt_signing_key_not_configured` and **every write 401s**. Create it:
   `cd api && printf 'JWT_SIGNING_KEY=%s\n' "$(openssl rand -hex 32)" > .dev.vars` (or copy
   `api/.dev.vars.example`). Wrangler does NOT hot-reload `.dev.vars` — restart `npm run dev` after
   changing it.
2. Local D1 is empty until migrated + seeded: `npm --workspace api run db:migrate:local`, then
   `node scripts/import-book.mjs ZEC` and
   `cd api && npx wrangler d1 execute bible_editor_dev --local --file=../scripts/out/import-ZEC.sql`.
   Seed into **`bible_editor_dev`** (the dev DB name), not `bible_editor` (prod). Without this the
   app loads but shows no book content. (Playwright's global-setup re-seeds ZEC automatically.)

### Running
- `npm run dev` (repo root) starts both servers. Open http://localhost:5173. In dev the SPA
  auto-mints a session via `POST /api/auth/dev` (admin `dev` user) — no DCS OAuth needed.
- First-load auth race: a transient "session expired"/"SIGN IN" banner can flash before the mint
  settles; it self-heals after a reload / re-mint. Writes require the cookie session **plus** CSRF
  double-submit (the client mirrors the `be_csrf` cookie into an `X-CSRF-Token` header).

### Verifying edits actually persisted (not just local UI)
- Every edit is buffered in an **IndexedDB outbox** and drained to the server. Text surviving a
  reload can be the outbox *replaying a still-queued op* rather than true server persistence — so
  confirm the server side: look for a `PATCH ... 200 OK` line in the Wrangler log and/or query local
  D1 (`cd api && npx wrangler d1 execute bible_editor_dev --local --command "..."`).
- Notes save on the note card's explicit **Save (floppy) icon** or on deactivation/unmount — **not**
  on blur; simply clicking another verse may not flush. Click the blue Save icon to force it.
- Timeline lane checkboxes (T/N/TWL/Q) are tiny and rendered per-user; they are unreliable to read
  from screenshots/video. Verify via the `verse_lane_checks` table or the `verseLaneChecks` field of
  `GET /api/chapters/{book}/{chapter}`.

### Lint / test / build (see `package.json` for the canonical list)
- Typecheck: `npm run typecheck` (tsc across both workspaces).
- Unit tests: `npm --workspace web run test` and `npm --workspace api run test` (Node type-strip
  runners; the web `replace`/`alignment` suites are the edit-engine safety net).
- Build: `npm run build` (api typecheck + web Vite build → `web/dist`).
- E2E: `npm run test:e2e` (Playwright; auto-starts `npm run dev`, health-polls `/api/health` through
  the proxy, and re-seeds ZEC first).
