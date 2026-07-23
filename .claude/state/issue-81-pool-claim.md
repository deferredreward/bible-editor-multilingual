# issue-81-pool-claim (PR-2 of #81)

**Branch:** `pr/issue-81-pool-claim` → PR against `deferredreward/bible-editor-multilingual` main.
**Model (owner):** spare-pool. **Owner decisions for this PR:** (1) scope = claim
mechanism only, NO OAuth-callback change (that's PR-3); (2) pool slots are
**pre-declared `DB_POOLn` native bindings** (not a D1-HTTP-API shim). See memory
`project-deferred-issues-94-84-81-decisions`.

## What this PR adds (no migration — 0058 already has the columns)

- **`api/src/workspaces.ts`**:
  - `claimWorkspace(env, {org,label,exportOwner?})` — flips the oldest live
    `available` slot to `claimed`, stamping org/label/export_owner. Idempotent
    (org already claimed → returns it, `alreadyClaimed`). Returns `null` when the
    pool is exhausted. CAS via `UPDATE ... WHERE status='available'`; recovers
    from a UNIQUE(org) race by returning the winner's slot. Re-primes the
    per-isolate registry cache so the claim is visible to `listWorkspaces` at once.
  - `registerPoolSlot(env, {binding,slug?,databaseUuid?})` — writes an
    `available` row for a deployed binding (validates it's a live D1 = the
    `parseEntry` native-binding gate). Does NOT create a DB or run migrations.
  - `getPoolStatus(env)` — full registry snapshot + counts + per-slot `bindingLive`.
- **`api/src/workspaceRoutes.ts`** — super-admin-gated (inline `isSuperAdmin`),
  registered BEFORE `POST /:slug` so "pool" isn't swallowed as a slug:
  - `GET  /api/workspaces/pool`
  - `POST /api/workspaces/pool`         (register slot)
  - `POST /api/workspaces/pool/claim`   (claim for org; 201 new / 200 idempotent / 503 exhausted)
- **`api/wrangler.toml`** — commented `DB_POOL1` binding template; **`api/src/index.ts`** — `DB_POOL1?` Env field (example, like DB_MLTEST).
- **`docs/workspace-pool.md`** — operator runbook (create+migrate DB → declare
  binding → redeploy → register → claim).
- **Tests:** `workspacesPool.test.mjs` (unit: register/claim/status, ordering,
  idempotency, dead-binding skip, exhaustion, validation) + `workspacePoolRoutes.test.mjs`
  (route: super-admin gating, register/claim happy path, validation/exhaustion).
  Full api suite 168 pass; typecheck clean.

## NOT in this PR

- PR-3: auto-claim at first admin login (wire `claimWorkspace` into the OAuth
  callback in `auth.ts` ~L664–728, detect BE-Admins admin of an unclaimed org via
  `resolveTeamRole(env, org, token)`, claim, re-resolve). Hook points mapped.
- Dynamic DB creation (D1 HTTP API) + runtime migration runner; deprovisioning.

## Human step (DEV FORK ONLY — never `--env production`)

No migration in this PR. To actually exercise the pool: follow
`docs/workspace-pool.md` — create+migrate a `bible_editor_pool1_dev` DB, uncomment
the `DB_POOL1` binding with its id, `wrangler deploy` (dev), then register+claim.
