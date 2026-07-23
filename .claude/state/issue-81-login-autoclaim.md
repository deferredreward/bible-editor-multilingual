# issue-81-login-autoclaim (PR-3 of #81)

**Branch:** `pr/issue-81-login-autoclaim`, **stacked on** `pr/issue-81-pool-claim`
(PR-2). PR opened with base = the PR-2 branch; GitHub auto-retargets it to `main`
when PR-2 (#110) merges. **Model (owner):** spare-pool; auto-claim on first admin
login (memory `project-deferred-issues-94-84-81-decisions`).

## What this PR adds (no migration, no new bindings)

- **`api/src/workspaceProvision.ts`** — `autoClaimAdminOrg(env, {accessToken,
  memberOrgs, existingOrgs}, deps?)` + pure `selectClaimableAdminOrgs(...)`.
  Picks the first org (canonical DCS casing, deterministic sort) the user
  administers via the **BE-Admins** team, that has no workspace yet and that they
  are a confirmed member of, and claims a spare-pool slot for it via PR-2's
  `claimWorkspace`. Returns null (no claim) when: orgs unknown, DCS unreachable,
  not an admin of any unclaimed org, or the pool is exhausted.
- **`api/src/auth.ts`** — wired into `callbackDcsAuth`, immediately after the
  existing `no_match` role-row rescue and BEFORE `wsEnv` is built. On `no_match`
  it calls `autoClaimAdminOrg`; on a claim it re-runs `resolveLoginWorkspace`
  against the reprimed roster so `wsEnv` + team-sync + allowlist gate +
  project_config seed all run against the new workspace. Wrapped in try/catch —
  **never breaks sign-in**; any failure leaves the pre-existing deny path intact.
- **`docs/workspace-pool.md`** — auto-claim section updated (was "PR-3 TODO").

## Design decisions (owner was away; conservative + documented)

- **Trigger = `no_match` only.** A user who already has a workspace home isn't
  auto-onboarded into other unclaimed admin orgs (avoids surprise pool drain);
  they use the manual `/pool/claim` or a future UI. Super-admins never hit
  `no_match` (they match all orgs), so they don't trigger it.
- **One claim per login** (first admin org, sorted) — bounded pool consumption.
- **Require confirmed membership** (`memberOrgs`) in addition to the admin team,
  so the claim always yields a resolvable workspace.
- **label = org name** (matches the implicit-workspace label idiom); exportOwner
  left default.

## Tests (full api suite 170 pass; typecheck clean)

- `workspaceProvision.test.mjs` — unit: selection (admin-team only, excludes
  editor/existing/non-member/invalid-ident, dedup, sorted) + autoClaimAdminOrg
  fail-soft guards (orgs unknown, DCS null, not-admin, already-claimed, pool
  exhausted stops).
- `callbackAutoClaim.test.mjs` — E2E: real `callbackDcsAuth` + node:sqlite shared
  DB (with 0058 registry + an available DB_POOL1 slot) + a pool DB, DCS stubbed.
  First admin login for an unclaimed org → pool1 claimed for NewOrg, be_ws=pool1,
  JWT role=admin, admin dcs_team role synced into the claimed DB, last-used
  persisted.

## NOT in this PR (later)

Dynamic DB creation (D1 HTTP API) + runtime migration runner; deprovisioning.
STOPPED before that stage — it creates real Cloudflare D1s over an API token and
needs the owner's infra decision (which was flagged, not yet made).
