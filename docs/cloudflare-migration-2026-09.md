# Cloudflare migration — bible-editor-* → bptranslate-* (2026-09)

Issue: [#444](https://github.com/unfoldingWord-box3/BPtranslate/issues/444).

## Why

Every Cloudflare resource this app used was byte-identical to upstream
`unfoldingWord/bible-editor`, on the same unfoldingWord account
(`5a3ffd86280d3ed086be76d955829242`): worker `bible-editor-api` / dev
`bible-editor-api-dev`, D1 `bible_editor` and `bible_editor_dev`, R2
`bible-editor-blobs*`, Workflow `bible-editor-export*`. A `wrangler deploy` from
either repo landed on the same worker. Benjamin's decision (2026-09-15/16): stay
on the unfoldingWord account, but give this app its own resources named after
the app — BPtranslate, rendered DNS-safe as `bptranslate`.

## What is already done (repo + Cloudflare)

Resources created on the unfoldingWord account, all currently empty:

| Old | New | Id |
| --- | --- | --- |
| worker `bible-editor-api-dev` | `bptranslate-dev` | created on first deploy |
| worker `bible-editor-api` | `bptranslate` | created on first deploy |
| D1 `bible_editor_dev` (`ceb458bf-4608-4696-a087-9026618a6cef`) | `bptranslate_dev` | `c4ae5e6d-6fb4-4ffc-a82a-008e793c691c` |
| D1 `bible_editor_mltest_dev` (`52e0b62e-8720-4024-ab4e-2898d2c94ac7`) | `bptranslate_mltest_dev` | `5c09dc0f-7bb4-4177-a167-3ffe17944866` |
| D1 `bible_editor` (`7e566abf-454d-43d6-b24e-11df74f1c0ed`) | `bptranslate` | `247c4a41-eaf4-4d49-bce2-68f4d1bbe00e` |
| R2 `bible-editor-blobs-dev` | `bptranslate-blobs-dev` | n/a |
| R2 `bible-editor-blobs` | `bptranslate-blobs` | n/a |
| Workflow `bible-editor-export-dev` | `bptranslate-export-dev` | registered on deploy |
| Workflow `bible-editor-export` | `bptranslate-export` | registered on deploy |

Config already points at the new names: `api/wrangler.toml`, `docs/deploy.md`,
`CLAUDE.md`, `.github/workflows/deploy-dev.yml`, the two `scripts/*.sql`
runbooks, and every `wrangler d1 ... <name>` command string in `scripts/`,
`tests/` and `docs/` (a `--local` command carrying the old name now fails with
"Couldn't find a D1 DB with the name or binding").

The Durable Object is deliberately not in that table. `CHAPTER_ROOM` /
`ChapterRoom` keep their binding and class name: a DO namespace is scoped to the
script that declares it, so `bptranslate-dev` gets its own namespace for free.
Nothing to migrate — ChapterRoom holds only live WS presence and fanout; HTTP +
`If-Match` is the source of truth.

The old resources are left completely untouched. They still hold all the live
data and still serve `bible-editor-api.unfoldingword.workers.dev` until the
cutover below. Delete them only after the new prod worker has run clean for a
while — and remember upstream `unfoldingWord/bible-editor` deploys to them too,
so that deletion is not this repo's decision alone.

---

## Human steps, in order

Every command below runs from `api/`, with the account pinned (two Cloudflare
accounts are authed on Benjamin's box, so wrangler otherwise fails with "More
than one account available… non-interactive mode"):

```sh
cd api
export CLOUDFLARE_ACCOUNT_ID=5a3ffd86280d3ed086be76d955829242
```

### 1. Register the DCS OAuth applications (two of them)

Door43 matches the redirect URI exactly, so each new hostname needs its own
application. At <https://git.door43.org/user/settings/applications>, create:

- BPtranslate (prod) — redirect URI
  `https://bptranslate.unfoldingword.workers.dev/api/auth/dcs/callback`
- BPtranslate (dev) — redirect URI
  `https://bptranslate-dev.unfoldingword.workers.dev/api/auth/dcs/callback`

Keep the two client id/secret pairs apart; they go to different workers in
step 3. Leave the existing bible-editor applications alone — the old workers
keep using them until they are retired.

Known DCS quirk: if one application ends up with more than one redirect URI, DCS
can pick the first in the list rather than the one you sent. One URI per
application.

### 2. First deploy of the new workers

`wrangler secret put` needs the script to exist, so the dev worker has to be
deployed before its secrets can be set. Build the SPA first — `wrangler deploy`
reads `../web/dist`:

```sh
cd .. && npm run build:web && cd api

npx wrangler deploy
```

That is the dev worker (`bptranslate-dev`, no `--env`) and it is safe now: the
new dev D1s are empty and the default env registers no crons. The prod deploy
(`npx wrangler deploy --env production`) waits until step 7.

### 3. Set the secrets on BOTH new workers

Secrets are per-script. A brand-new script starts with none, so a deploy
succeeds and then sign-in fails at runtime until this step is done.

> ### AI_KEY_WRAPPING_KEY must be copied VERBATIM
>
> It wraps every org's bring-your-own AI provider API key before the ciphertext
> is written to D1 (`api/src/aiKeyCrypto.ts`, table `ai_provider_config`). If a
> fresh key is generated while the old rows are imported, every stored per-org
> key becomes permanently undecryptable — the rows survive, the keys do not, and
> each org has to re-enter its provider key. Copy the existing value out of
> wherever it was recorded when it was first generated; Cloudflare will not show
> it to you again. If it genuinely cannot be recovered, that is survivable but it
> is a decision, not an accident: generate a new one AND clear
> `ai_provider_config` after the import so nobody hits a decrypt error.

Dev worker (no `--env`):

```sh
npx wrangler secret put JWT_SIGNING_KEY          # openssl rand -hex 32, fresh per worker
npx wrangler secret put DCS_CLIENT_ID            # BPtranslate (dev) app
npx wrangler secret put DCS_CLIENT_SECRET        # BPtranslate (dev) app
npx wrangler secret put DCS_SERVICE_TOKEN        # see note below
npx wrangler secret put DCS_TOKEN                # optional admin token, export conflict recovery
npx wrangler secret put BT_API_TOKEN             # uw-bt-bot.fly.dev, reuse the api/.dev.vars value
npx wrangler secret put AI_KEY_WRAPPING_KEY      # VERBATIM copy, see the box above
```

Prod worker (every command gets `--env production`):

```sh
npx wrangler secret put JWT_SIGNING_KEY --env production
npx wrangler secret put DCS_CLIENT_ID --env production
npx wrangler secret put DCS_CLIENT_SECRET --env production
npx wrangler secret put DCS_SERVICE_TOKEN --env production
npx wrangler secret put DCS_TOKEN --env production
npx wrangler secret put BT_API_TOKEN --env production
npx wrangler secret put AI_KEY_WRAPPING_KEY --env production
```

Notes:

- `JWT_SIGNING_KEY` should be fresh per worker. It only signs our own sessions,
  so a new key just means everyone signs in again.
- `DCS_SERVICE_TOKEN` is what lets a worker write to the real DCS org. The
  currently deployed dev worker has one. Leave it unset on the new dev worker if
  you would rather dev exports fail closed as `no_service_token`.
- Confirm what landed with `npx wrangler secret list` and
  `npx wrangler secret list --env production`. Names are listed, values are not.

### 4. Schema on the three new databases

If a database is going to receive a full export in step 5, skip the migration
apply for it: a full `d1 export` carries the schema and the `d1_migrations`
bookkeeping table, so importing into an empty database reproduces both, and a
`migrations apply` afterwards is a no-op catch-up. Applying migrations first and
then importing gives you "table already exists".

For a database you intend to start empty:

```sh
npx wrangler d1 migrations apply bptranslate_dev --remote
npx wrangler d1 migrations apply bptranslate_mltest_dev --remote
npx wrangler d1 migrations apply bptranslate --remote --env production
```

Migration filenames are authoritative — the repo has duplicate numeric prefixes
(`0025_*`, `0026_*`), so never refer to one by number alone.

A production database that starts empty also needs the editor allowlist
restored, because migration `0016` seeds only the admin:

```sh
npx wrangler d1 execute bptranslate --remote --env production \
  --file=../scripts/seed-prod-editor-allowlist.sql
```

### 5. Move the dev data (the rehearsal for prod)

`bible_editor_dev` is about 56 MB; `bible_editor_mltest_dev` about 2 MB.

> The old names are no longer in `wrangler.toml`. For `--remote`, wrangler falls
> back to an account-wide lookup by name, so these should still resolve — but
> that is unverified here (this change is config and docs only; no `--remote`
> command was run). If a command answers "Couldn't find a D1 DB with the name",
> run the export from a checkout of `main` that still carries the old names, or
> pass `--config` pointing at such a file.

Keep the dumps outside the repo:

```sh
mkdir -p ../../bptranslate-migration

npx wrangler d1 export bible_editor_dev --remote \
  --output ../../bptranslate-migration/bible_editor_dev.sql -y
npx wrangler d1 export bible_editor_mltest_dev --remote \
  --output ../../bptranslate-migration/bible_editor_mltest_dev.sql -y
```

Record the source row counts BEFORE importing, so the comparison is against a
written-down number rather than a memory. List the tables, then count each:

```sh
npx wrangler d1 execute bible_editor_dev --remote --json \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;" \
  > ../../bptranslate-migration/tables-dev.json

npx wrangler d1 execute bible_editor_dev --remote --json \
  --command "SELECT count(*) FROM verses;"   # repeat per table name from above
```

Import:

```sh
npx wrangler d1 execute bptranslate_dev --remote \
  --file=../../bptranslate-migration/bible_editor_dev.sql
npx wrangler d1 execute bptranslate_mltest_dev --remote \
  --file=../../bptranslate-migration/bible_editor_mltest_dev.sql
```

A 56 MB SQL file is large for `d1 execute`. If it is rejected or times out,
split it (the export is plain SQL) and apply the pieces in order, or use the
dashboard's D1 import. Do not declare success on a partial import — a partially
populated D1 that later exports to DCS is precisely the failure mode that once
reverted good work on master.

Verify table by table that the new counts equal the recorded ones, then sanity
check the size:

```sh
npx wrangler d1 execute bptranslate_dev --remote --json \
  --command "SELECT count(*) FROM verses;"   # repeat per table
npx wrangler d1 info bptranslate_dev
```

Finally catch up any migrations that landed after the export was taken:

```sh
npx wrangler d1 migrations apply bptranslate_dev --remote
npx wrangler d1 migrations apply bptranslate_mltest_dev --remote
```

### 6. Smoke-test dev on the new hostname

```sh
curl -s https://bptranslate-dev.unfoldingword.workers.dev/api/health
```

Then in a browser on `https://bptranslate-dev.unfoldingword.workers.dev`: sign
in with Door43 (this is what exercises the new dev OAuth app end to end), open a
BSOJ book, edit a note, save, and confirm the workspace switcher still offers
both `bsoj` and `mltest`. `DEV_AUTH_ENABLED` is `true` on the default env so
`/api/auth/dev` would also work, but the point of this step is the real OAuth
round-trip.

### 6a. What does NOT travel with the data: each editor's browser state

The D1 export carries every saved edit. It does not carry anything a translator's
browser is holding, and none of that can be migrated, because all of it is keyed
to the origin — the hostname. A new hostname is a new origin, so on first visit
the new host starts empty for every user:

- **The outbox** (`web/src/sync/outbox.ts`, IndexedDB). Saved edits that have not
  yet reached the server queue here and drain in the background. Anything still
  queued at cutover stays queued **on the old origin**, against the old worker.
- **Note drafts** (`web/src/sync/drafts.ts`, IndexedDB). Typed-but-not-saved note
  text, the thing the "N unsaved" reminder counts. Same story.
- **The session.** Auth is HttpOnly cookies (`api/src/auth.ts`), host-scoped, so
  everyone signs in again and authorises the new Door43 application once.
- Per-viewer conveniences in `localStorage` (last workspace, view preferences).

So the rule for the freeze in step 7 is not just "stop editing". It is:

1. Every editor opens the **old** host, saves anything still open, and waits for
   the sync indicator to report nothing pending. An editor who closes the tab on
   a queued edit strands it.
2. Only then export.
3. After cutover, tell them the first visit to the new host will ask them to sign
   in and to re-authorise the application. That is expected, not a fault.

Worth checking before the freeze ends: query `pipeline_jobs` for non-terminal
rows and let them finish or cancel them, since an in-flight AI job is tracked
server-side and its output would import into the database you are about to stop
using.

### 7. Prod data move and cutover

Same shape as step 5, with `--env production` on every command touching the new
prod database, plus a freeze in the middle: editing on the old prod worker has
to stop before the export, or the edits made between export and cutover are
lost.

```sh
# 1. Announce the freeze (step 8) and confirm nobody is mid-edit.
# 2. Let the nightly export finish, or run one by hand, so D1 and DCS agree.
# 3. Export prod.
npx wrangler d1 export bible_editor --remote \
  --output ../../bptranslate-migration/bible_editor.sql -y

# 4. Record per-table counts on bible_editor, as in step 5.

# 5. Import into the new prod DB.
npx wrangler d1 execute bptranslate --remote --env production \
  --file=../../bptranslate-migration/bible_editor.sql

# 6. Verify counts table by table, and check user_roles specifically —
#    it is prod's real access gate, so a short count locks editors out.
npx wrangler d1 execute bptranslate --remote --env production \
  --command "SELECT role, count(*) FROM user_roles GROUP BY role;"

# 7. Catch-up migrations.
npx wrangler d1 migrations apply bptranslate --remote --env production

# 8. Deploy prod (from the repo root).
cd .. && npm run deploy
```

Post-deploy checks, in this order:

1. `curl -s https://bptranslate.unfoldingword.workers.dev/api/health`
2. Sign in with Door43 on the new host. `DEV_AUTH_ENABLED=false` there, so there
   is no dev-mint fallback if OAuth is misconfigured.
3. Open a BSOJ book and confirm content and history match what prod had.
4. Admin, Run export now, for one book: `dryDcs` first, then for real. Confirm
   the branch lands under `BibleEditorService` as before.
5. `npx wrangler deployments list --env production` shows `bptranslate`.
6. The following morning, confirm the 05:30 UTC export cron ran and the `*/5`
   pipeline-poll cron is firing (`npm --workspace api run tail` with
   `--env production`).

R2 is not covered by any of the above: `bptranslate-blobs*` start empty. Export
snapshots regenerate on the next export and USFM originals are re-importable
from DCS, so starting clean is the pragmatic choice — but if anything in
`bible-editor-blobs` is wanted as evidence, copy it deliberately before the old
bucket is retired.

### 8. Partner comms — the URL changes

`https://bible-editor-api.unfoldingword.workers.dev` becomes
`https://bptranslate.unfoldingword.workers.dev`. Bookmarks, partner
documentation, chat history and training material all point at the old host,
nothing redirects automatically, and the old host keeps serving the old worker
with the pre-freeze data. That last part is the dangerous bit: an editor using
an old bookmark sees a working app, and their edits go nowhere.

- Send the new link to BSOJ and every other editor before the cutover, with the
  freeze window and an explicit "stop using the old link".
- Update uW-side documentation or dashboards that link to the old host.
- Worth considering afterwards: redeploy the old prod worker as a redirect-only
  script so a stale bookmark bounces to the new host instead of quietly serving
  stale data. That writes to a resource upstream also deploys to, so coordinate
  with upstream first.

### 9. Afterwards

- Leave `bible_editor`, `bible_editor_dev`, `bible_editor_mltest_dev`,
  `bible-editor-blobs*` and both old workers in place until the new prod has run
  clean for at least one full nightly-export cycle, ideally a week.
- Keep the SQL dumps outside the repo until then. They are the rollback.
- Rollback is "redeploy the old worker from a checkout that still has the old
  `wrangler.toml`" — the old resources were never written to.
- Only then consider deleting them, and only in coordination with upstream
  `unfoldingWord/bible-editor`, which shares `bible-editor-api`, `bible_editor`
  and `bible-editor-blobs`.

## Known leftovers (not blockers)

- `api/src/index.ts:240` still reports `service: "bible-editor-api"` from
  `/api/health`, and two comments in `api/src` still name the old worker.
  Cosmetic, and `docs/flows/00b-api-inventory.md` documents that string, so
  change both together.
- Commit messages and PR bodies written by the export workflow say
  "bible-editor export" (`api/src/export.ts`, `api/src/exportWorkflow.ts`).
  DCS-side tooling and `scripts/heal-align-1ch-num.mjs` match on that text —
  leave it alone unless the DCS side changes with it.
- `JWT_ISSUER` stays `"bible-editor"` in both envs. It is a token claim, not a
  Cloudflare resource; changing it invalidates issued tokens for no benefit.
- `STATE.md` still names the old databases in historical entries. Left alone on
  purpose: every open branch anchors on that file.
- `.claude/settings.local.json` is machine-local and untracked, so its
  prod-command deny-list cannot ship in a PR. It was updated in place on
  Benjamin's box to guard the `bptranslate` names; any other machine needs the
  same edit by hand.
