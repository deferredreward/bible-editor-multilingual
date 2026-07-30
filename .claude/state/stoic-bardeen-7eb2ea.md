# stoic-bardeen-7eb2ea — note templates: auto-populate + bulk AI draft

## What this branch does
1. Note templates now appear for **every** org automatically. They only ever
   existed after `syncTemplates()` ran, whose sole automatic caller is the
   prod-only `*/5` cron — so any org on a dev worker, or a newly-added
   workspace inside the 6h staleness window, showed "No templates." forever.
   `GET /api/templates` now self-heals on first visit.
2. New "Draft all with AI (N)" button on the templates rail, with progress,
   cancel, and fail-fast.
3. `templates.loadError` — a 403/500 on the list route used to render as the
   "No templates." empty state, indistinguishable from an empty table.

## BLOCKED on another service — read before demoing
`POST https://uw-bt-bot.fly.dev/api/template-quick` **does not exist** (404 as
of 2026-07-30; sibling `/api/tn-quick` 401s, i.e. it exists). So neither the
per-template "Draft with AI" button (shipped in PR #89) nor the new bulk button
can actually produce a translation yet. PR #89's own handoff admitted the
contract was assumed. Full spec for the bot team:
[`docs/template-quick-contract.md`](../../docs/template-quick-contract.md).

Second gate: `BT_API_TOKEN` is absent from `api/.dev.vars` on this box, so
locally the route short-circuits to `503 template_draft_disabled` before it
ever reaches the bot.

## Verified (browser, this worktree: wrangler :8793 + vite :5293)
- Wiped `template_units` + `template_sync_state` in `bible_editor_dev`, hard-
  reloaded → 194 rows written (192 sheet + 2 builtin), UI shows "0/194
  approved" and the grouped rail. No admin action.
- Second `GET /api/templates` served in 9ms — the watermark gate prevents a
  re-sync per request.
- Clicked "Draft all with AI (194)" with no `BT_API_TOKEN`: exactly **3**
  POSTs (the initial concurrency-3 wave) then stop, surfacing "AI not
  configured — an admin must set BT_API_TOKEN." Not 194 doomed requests.
- `npm run typecheck` clean; api 185/185; web 129/129.

## NOT verified
- The successful AI round trip — impossible until the bot endpoint exists.
- Remote/deployed state. `wrangler whoami` authenticates but lists **zero
  accounts** on this box, and `d1 migrations list bible_editor_dev --remote`
  fails `code: 7403`. So it is unconfirmed whether the deployed dev/prod DBs
  have `0054_template_units.sql` applied — note there are two migrations
  numbered 0054, and STATE.md records a prior incident where a collided
  number left prod unmigrated and 500ing. Check before demoing on a deployed
  worker.
- The 13 non-English translations of the 8 new `draftAll*` keys are machine
  translations, not native-speaker reviewed.

## Note for a reviewer
None of the 13 non-English locales had `templates.draftWithAi` at all — PR #89's
single-unit button has been English-only everywhere since it shipped. Left
as-is (out of scope), but it means the locale files are less complete than the
`loadError` precedent suggests.
