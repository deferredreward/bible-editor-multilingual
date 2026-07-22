# issue-81-workspace-registry (PR-1 of #81)

**Branch:** `pr/issue-81-workspace-registry` → PR against `deferredreward/bible-editor-multilingual` main.

**Model chosen (owner):** SPARE-POOL — claim a pre-provisioned empty DB, NOT create-live-over-HTTP.
See memory `project-deferred-issues-94-84-81-decisions`.

## What this PR does (roster becomes data, zero behavior change)

- **Migration `0058_workspaces_registry.sql`** — `workspaces` registry table on the SHARED DB
  (accounts/sessions/lexicon; the binding present in every deployment via `sharedDb()`). Columns:
  `id`, `slug UNIQUE`, `label`, `org UNIQUE` (nullable — spare slots have no org; SQLite allows
  many NULLs under UNIQUE), `binding`, `database_uuid` (nullable), `export_owner` (nullable),
  `status` (CHECK: available/claimed/provisioning/failed/retired, default `available`), timestamps.
  Only `claimed` rows are listable. PR-1 writes only `claimed` rows.
- **`api/src/workspaces.ts`** — `listWorkspaces`/`resolveWorkspace` now read the registry, falling
  back **registry → WORKSPACES env var → implicit default**. New async `primeWorkspaces(env)` loads
  the registry once per isolate into a per-shared-DB `WeakMap`; seeds the table from the env var when
  empty (never the implicit default — that stays dynamic so `VIEWER_ORG` isn't frozen). Fails soft:
  any read/seed error → env-var fallback, never throws/500s. `parseEntry`'s native-binding check is
  preserved and applied to registry rows (the future pool-slot validity gate).
- **`api/src/index.ts`** — `fetch` is now `async` and awaits `primeWorkspaces(env)` before the
  synchronous `resolveWorkspace`; `scheduled` primes before iterating. **`exportWorkflow.ts`** primes
  before resolving `params.workspace` (Workflows read raw `this.env`).
- **Tests:** `api/src/workspacesRegistry.test.mjs` (fallback ordering, seeding, throwing-registry
  fail-soft, dead-binding drop, prime idempotency, migration CHECK/UNIQUE invariants).

## NOT in this PR (later PRs of #81)

D1 HTTP API, runtime migration runner, pool bindings, auth-callback claiming, deprovisioning.

## Human step before/after deploy (DEV FORK ONLY — never `--env production`)

Apply the migration to the **dev** D1 (validated via `node:sqlite`, not yet applied to any remote DB):

```sh
cd api && npx wrangler d1 migrations apply bible_editor_dev --local
# remote dev target (no --env production): npx wrangler d1 migrations apply bible_editor_dev --remote
```

Deep-worktree path may hit `SQLITE_CANTOPEN` on Windows — use `--persist-to "C:/<short>"`
(memory `reference-wrangler-worktree-path-length`).
