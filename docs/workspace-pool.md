# Spare-pool D1 provisioning (issue #81)

How a new Door43 org gets its own D1 database in this deployment. The model is
**spare-pool**: pre-provision empty, migrated D1 databases, and claim one for an
org at onboard. The hot path stays on **native Cloudflare bindings** (`env.DB_x`)
— chosen over create-a-DB-over-the-HTTP-API-at-login so request latency, local
`wrangler dev` parity, and the `If-Match` save protocol are unaffected.

The tradeoff of native bindings: a binding is fixed at deploy time. **Growing the
pool needs a redeploy** (to declare more `DB_POOLn` bindings). **Claiming a slot
for an org does not** — it's a registry row update at runtime.

## The registry

The `workspaces` table (migration `0058_workspaces_registry.sql`, on the SHARED
DB) is the roster. Each row is one workspace/slot with a `status`:

| status | meaning |
| --- | --- |
| `available` | a migrated, empty DB binding waiting to be claimed |
| `claimed` | assigned to an org; this is the only status `listWorkspaces` returns |
| `provisioning` / `failed` / `retired` | lifecycle bookkeeping (later PRs) |

`workspaces.ts` reads the `claimed` rows as the roster, falling back to the
`WORKSPACES` env var then the implicit default (see `primeWorkspaces`). It never
throws on a bad read — see PR-1.

## Adding pool capacity (operator, requires a redeploy)

> DEV FORK ONLY. Never `--env production` here; never target upstream unfoldingWord.

1. Create an empty D1 database and note its id:
   ```sh
   cd api && npx wrangler d1 create bible_editor_pool1_dev
   ```
2. Migrate it (brings it to the current schema so a claimed org starts clean):
   ```sh
   npx wrangler d1 migrations apply bible_editor_pool1_dev --remote
   ```
3. Declare the native binding in `api/wrangler.toml` (uncomment the `DB_POOL1`
   template under the `DB_MLTEST` block) with the real `database_id`. Name it
   `DB_POOLn` so the default slug derivation (`pool<n>`) applies.
4. Deploy the **dev** worker (plain `wrangler deploy`, no `--env`):
   ```sh
   npm run build:web && cd api && npx wrangler deploy
   ```
5. Register the binding as an `available` slot (super-admin session):
   ```sh
   curl -X POST https://<dev-worker>/api/workspaces/pool \
     -H 'content-type: application/json' -H "x-csrf-token: <tok>" \
     --cookie 'be_access=<super-admin-jwt>; be_csrf=<tok>' \
     -d '{"binding":"DB_POOL1"}'
   ```

`GET /api/workspaces/pool` (super-admin) shows the whole registry with a
`bindingLive` flag per row, so you can see which `available` slots are actually
claimable versus declared-but-not-yet-deployed.

## Claiming a slot for an org

Two ways in, both landing on the same `claimWorkspace` mechanism.

### Automatic: first admin login (PR-3)

When someone signs in who is an **admin of a Door43 org that has no workspace in
the registry**, the OAuth callback claims a slot for that org and lands them in
it — no operator, no redeploy. "Admin" means membership of the org's configured
admin team (`BE-Admins`, or `DCS_TEAM_ADMIN`): being an org **Owner** in Door43
is not enough, and editors never claim — onboarding an org is an administrative
act.

- At most **one** slot per login. An admin of two un-onboarded orgs onboards the
  second on their next sign-in.
- The org is stored with DCS's own casing (read off the teams payload we already
  hold), matching the `COLLATE NOCASE` tenancy index from `0068`. The label
  defaults to the org name; an operator can relabel the row afterwards.
- Repeat logins claim nothing: the org is in the roster by then, so it isn't a
  candidate and no teams call is made for it.
- **Fails soft, always.** An exhausted pool, a DCS outage, or a D1 error is
  logged and sign-in continues against the pre-existing roster — it can never
  500 the callback. `[autoClaim] pool exhausted` in `wrangler tail` is the
  signal to add capacity (above).
- Super admins skip it: their org set is synthesized from the existing roster,
  so it never contains an unregistered org. They use the endpoint below.

Code: `api/src/workspaceAutoClaim.ts`, called from `callbackDcsAuth` in
`api/src/auth.ts`. Tests: `api/src/workspaceAutoClaim.test.mjs`.

### Manual: the super-admin endpoint (PR-2)

Still available, and the only route for an org whose admin can't sign in yet:

```sh
curl -X POST https://<dev-worker>/api/workspaces/pool/claim \
  -H 'content-type: application/json' -H "x-csrf-token: <tok>" \
  --cookie 'be_access=<super-admin-jwt>; be_csrf=<tok>' \
  -d '{"org":"NewOrg","label":"New Org","exportOwner":"NewOrgExport"}'
```

- Picks the oldest `available` slot whose binding is live, flips it to `claimed`,
  and stamps `org`/`label`/`export_owner`.
- **Idempotent**: re-claiming for an org that already owns a slot returns that
  slot (HTTP 200, `alreadyClaimed: true`) and consumes nothing.
- `503 pool_exhausted` when no live `available` slot remains — add capacity.

## Not yet built (later PRs of #81)

- Dynamic DB creation via the D1 HTTP API + a runtime migration runner (to make
  step 1–2 above a super-admin/cron action instead of a manual wrangler run; the
  binding declaration + redeploy in step 3–4 remain inherent to native bindings).
- Deprovisioning/retirement of abandoned orgs (decision: keep the data; never
  auto-hard-delete).
