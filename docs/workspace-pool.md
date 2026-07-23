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

Currently manual (PR-2), super-admin only:

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

**Auto-claiming at first admin login (the OAuth-callback wiring) is PR-3.** This
endpoint is the seam it will reuse (`claimWorkspace` in `workspaces.ts`).

## Not yet built (later PRs of #81)

- PR-3: auto-claim at first admin login (BE-Admins team member of an unclaimed org).
- Dynamic DB creation via the D1 HTTP API + a runtime migration runner (to make
  step 1–2 above a super-admin/cron action instead of a manual wrangler run; the
  binding declaration + redeploy in step 3–4 remain inherent to native bindings).
- Deprovisioning/retirement of abandoned orgs (decision: keep the data; never
  auto-hard-delete).
