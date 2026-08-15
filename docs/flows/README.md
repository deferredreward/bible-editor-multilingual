# Adaptive UI flows — drafted, code-checked, not yet wired

**What this is:** three role-based UI flows — **Translator**, **Lead**, and
**Admin** — drafted as 13 linked, interactive HTML screens that each adapt
across desktop, tablet, and mobile. Every button, banner, and dialog was
checked against the real codebase: each side-effectful control is annotated
with the actual API endpoint it should call, but nothing is connected yet —
clicking a control shows a toast naming the real call it *would* make.
That's the deliverable: almost drop-in, deliberately unwired.

**How to look at it:** open [`ui/index.html`](ui/index.html) in a browser
(no build step, no server needed). The hub lists all 13 screens and previews
any of them at phone (375), tablet (768), or desktop (1280) width. Dark mode
and an authoring/translation mode toggle are in every screen's top bar.

> **These screens are now also runnable against a real backend.** The
> statement above ("nothing is connected yet") describes the *design* record.
> On this branch the same screens can be served from a local Worker with a
> real database behind them, so the buttons perform actual saves and actually
> hit real version conflicts. See
> [Running the functional preview](#running-the-functional-preview) below, and
> [05-functional-preview-findings.md](05-functional-preview-findings.md) for
> what that surfaced. Opening the files directly still works and still behaves
> as the unwired design draft — the API layer degrades to an honest
> "backend unreachable" state when there is no server.

## The screens

| Flow | Screen | What it does |
|---|---|---|
| Translator | `t1-home` | Home: pick a work queue (counts of what's left), trust chips, banners |
| Translator | `t2-review` | The dominant loop: review/approve AI-drafted notes & questions, card at a time |
| Translator | `t3-scripture` | Edit the literal & simplified translation, paired lanes (ULT→GLT / UST→GST) |
| Translator | `t4-align` | Word alignment: drag canvas on desktop, **tap-to-pair on touch** (see below) |
| Translator | `t5-articles` | Translate tW/tA articles |
| Translator | `t6-words` | Edit word links (TWL): quote builder, suggestions |
| Lead | `l1-ai` | Run AI drafting pipelines, watch job progress, friendly error copy |
| Lead | `l2-style` | Teach the AI the org's style: preferences + context-pack export |
| Lead | `l3-templates` | Curate note templates |
| Admin | `a1-setup` | Stand up an org: 5-step wizard |
| Admin | `a2-import` | Bring in books; scripture-source replacement lifecycle |
| Admin | `a3-team` | Team & roles; org switching |
| Admin | `a4-observe` | Trust & observe: exports, jobs, health, crons |

## The two design decisions (and why)

1. **Queue is the work unit; verse is the context unit.** Most of the app is
   one repeated pattern — source, draft, approve, next — so the queue leads
   everywhere. "Everything about this verse" is always one gesture away: a
   bottom sheet on phones, a split view on tablets, a persistent side column
   on desktop. This collapses what were five separate surfaces into one
   screen shape with different nouns. (Full record: [02-architecture.md](02-architecture.md).)
2. **Admin keeps the deep, real-endpoint model.** The operational panels
   (AI jobs, import, source replacement) are wired to endpoints that exist.
   The "design your own workflow stages" editor has no backend, so it
   appears as one clearly-marked future card — visible direction, honest
   about what's real.

**Mobile alignment** got its own design ([04-mobile-alignment.md](04-mobile-alignment.md)):
on a phone, alignment leads with AI-suggested pairings as ✓/✗ confirm cards
(the same review motion as the rest of the app), with tap-to-pair as the
manual fallback — tap words to select, tap the other language to commit,
an explicit Combine button to group words. Tap mode doubles as the
keyboard-accessible mode on desktop.

## How the wiring annotations work

Every side-effectful control carries:

```html
data-handle="PATCH /api/rows/tn/:id"   data-headers="If-Match"   data-bundle="E"
```

- `data-handle` is copied verbatim from the endpoint inventory — the
  re-audit confirmed **zero invented handles**. Local-only behavior is
  `local:*`; features with no backend yet are `TODO:no-backend`.
- `data-headers` names required concurrency headers. Verse saves carry both
  `If-Match` and `X-Source-Generation` (the backend requires the pair).
- `data-bundle` maps the control to the A–K workflow taxonomy from the
  handoff.

To wire a screen for real: replace the `_shell.js` toast interceptor with
actual fetch calls through the app's API client (`web/src/sync/api.ts` is
the only thing that may talk to `/api/*` — its If-Match / 409 / 401 handling
is what makes the outbox correct), and keep the explicit-Save + IndexedDB
drafts invariant (never blur-save, never a confirm dialog).

**That wiring now exists** as [`ui/_api.js`](ui/_api.js) — a small vanilla-JS
client that mirrors `web/src/sync/api.ts`'s semantics (cookie auth,
`X-CSRF-Token`, `X-Workspace`, `If-Match`, `X-Source-Generation`, silent
refresh on 401, and typed 409/428 classification). `_shell.js` keeps its
toast, but the toast now reports the outcome of a *real* call.

## Running the functional preview

**What you get:** the same 13 screens, backed by a real Cloudflare Worker and
a real local database seeded with Zechariah. Approve a note and the row's
version actually increments. Save a stale copy and you actually get a merge
conflict.

**One rule that is not negotiable: serve the pages and the API from the same
origin.** Authentication is cookie-based. If you serve these HTML files from
a separate static server on a different port, the browser drops the cookies,
every read still works (most reads are public), and every *write* fails in a
way that looks like a permissions bug. The commands below point the Worker's
asset directory at `docs/flows/ui`, so one server serves both.

From `api/`, with the repo already installed (`scripts/worktree-init.ps1` in a
fresh worktree):

**1. Create `api/.dev.vars`** — without it, `POST /api/auth/dev` returns 500.
It is gitignored; any non-empty value works locally.

```bash
printf 'JWT_SIGNING_KEY=dev-local-preview-key-not-a-secret\n' > api/.dev.vars
```

**2. Migrate and seed the local database** (`--local` only — never `--env production`):

```bash
cd api && npx wrangler d1 migrations apply bible_editor_dev --local
```

```bash
node scripts/import-book.mjs ZEC && cd api && npx wrangler d1 execute bible_editor_dev --local --file=../scripts/out/import-ZEC.sql
```

**3. Make the scripture lanes visible *and* writable.** The dev database ships
provisioned for a mid-migration Arabic project: both scripture lanes are
`LEGACY`, flagged `replacement_required`, marked `textReadOnly`, and carrying a
`pending_target_json`. Three separate consequences, each of which looks like a
different bug:

- the chapter read **silently omits** any lane in `replacement_required`, so
  ULT/UST verses exist in the database but never reach the browser;
- the single-verse read **409s** `lane_replacement_required` for the same
  condition (a different behaviour for the same cause — see findings §2.10);
- verse writes are refused because `textReadOnly` is set.

**Clearing the flags alone does not work** — and this is the trap worth knowing
about. Every authenticated `GET /api/project-config` calls
`maybeHealLaneStateForPreset` (`api/src/scriptureLane.ts:961`), which compares the
lane's *source repo* against the one the active preset wants and rewrites the lane
state whenever they differ. Since this database's preset is `ar-bsoj` (whose lanes
target `ar_avd`/`ar_nav`), simply setting `replacement_required = 0` leaves the
source as the old `ar_glt`/`ar_gst`, so the very next config read undoes your fix.
Opening any Admin or Lead screen is enough to trigger it, which makes the symptom
look intermittent.

The stable fix is to make the lane state *agree* with the preset — point the
active source at the repo the preset wants, then clear the pending target:

```bash
cd api && npx wrangler d1 execute bible_editor_dev --local --command "UPDATE scripture_lane_state SET replacement_required=0, exports_blocked=0, pending_target_json=NULL, active_config_json='{\"label\":\"AVD\",\"source\":{\"owner\":\"BSOJ\",\"repo\":\"ar_avd\",\"ref\":\"master\"},\"export\":{\"owner\":\"BSOJ\",\"repo\":\"ar_avd\",\"baseRef\":\"master\",\"branchPolicy\":\"contributor_book_branch\"},\"textReadOnly\":false,\"alignmentWritable\":true}' WHERE lane='lit';"
```

```bash
cd api && npx wrangler d1 execute bible_editor_dev --local --command "UPDATE scripture_lane_state SET replacement_required=0, exports_blocked=0, pending_target_json=NULL, active_config_json='{\"label\":\"NAV\",\"source\":{\"owner\":\"BSOJ\",\"repo\":\"ar_nav\",\"ref\":\"master\"},\"export\":{\"owner\":\"BSOJ\",\"repo\":\"ar_nav\",\"baseRef\":\"master\",\"branchPolicy\":\"contributor_book_branch\"},\"textReadOnly\":false,\"alignmentWritable\":true}' WHERE lane='sim';"
```

Verified: after this, three consecutive `GET /api/project-config` calls leave
`config_revision` unchanged, `GET /api/chapters/ZEC/1` returns `UHB` + `ULT` +
`UST`, and a real verse `PATCH` with `If-Match` + `X-Source-Generation` succeeds.

Skip this step if you specifically want to see the lane-replacement lifecycle
states rather than edit scripture.

> Switching the project to a matching English preset would be the *tidy* fix, but
> `PUT /api/project-config` returns `409 project_not_empty` on a populated
> database — "one D1 per org/project is the current tenancy model." A truly clean
> environment needs a fresh per-org database, not a preset change.

**4. Start the Worker, serving the screens as its assets.** Pick a port you
have confirmed is free — **never 3000** (reserved for an SSH tunnel), and do
not assume 8787 is free, because sibling worktrees commonly hold it:

```bash
cd api && npx wrangler dev --port 8891 --ip 127.0.0.1 --assets ../docs/flows/ui
```

**5. Open it:** <http://127.0.0.1:8891/index.html> for the hub, or any screen
directly (e.g. `/t2-review.html`). The Worker redirects `/foo.html` to `/foo`;
browsers follow that transparently.

A dev session is minted automatically on first load via `POST /api/auth/dev`
(localhost-gated, and only while `DEV_AUTH_ENABLED="true"`), so there is no
sign-in step.

### What is real, and what is honestly degraded

| Screen | State in this environment |
|---|---|
| `t1`, `t2`, `t6` | **Fully real** — real Zechariah notes, questions and word links; real saves and real version conflicts |
| `t3` | Real UHB/ULT/UST panes, verse status and lane checks. **Verse *save* is disabled** — the preview cannot rebuild the word-alignment tree, and saving would erase the verse's alignment (findings §4.8) |
| `l2`, `l3`, `a3`, `a4` | **Real** — preferences, 194 real note templates, the user allowlist, health/jobs/exports |
| `t5` | Real endpoint; effectively empty — one tW article (`kt/god`) was imported through the real endpoint during the drive, no tA articles |
| `t4` | Real words and lexicon calls; alignment *save* is disabled on purpose (findings §4.8) |
| `l1`, `a2` | Real job list; **AI pipelines return 503** because `BT_API_TOKEN` is absent — this is the spec's "AI not configured" state, exercised for real |
| `a1` | Local config steps are real; org lookup needs live Door43 and degrades honestly offline |

**Approve is not exercisable here.** `POST /api/rows/{tn,tq}/:id/validate` returns
`404` for every row in this seed: the server requires `translation_state` to be
non-NULL, and nothing has been through the AI pipeline. Correct API behaviour,
simply unreachable without a pipeline run.

The local lexicon table is empty, so `GET /api/lexicon/:strong` returns 404
everywhere; `scripts/import-lexicon.mjs` would populate it.

## The paper trail

| Doc | Contents |
|---|---|
| [00-code-inventory.md](00-code-inventory.md) | Every frontend surface & action in the real app (~65), mapped to bundles A–K |
| [00b-api-inventory.md](00b-api-inventory.md) | All 110 backend endpoints: auth, headers, 409/lock semantics |
| [01-design-inputs.md](01-design-inputs.md) | The four mockup lineages distilled: tokens, keeps/drops, decision evidence |
| [02-architecture.md](02-architecture.md) | Decision record + build spec (handle convention, required states) |
| [03-coverage.md](03-coverage.md) | Coverage audit: every inventory action → which screen covers it |
| [04-mobile-alignment.md](04-mobile-alignment.md) | Tap-to-pair alignment interaction design |

## Known limits (honest edges)

- Copy is un-i18n'd English throughout (all strings are destined for i18next
  keys per `docs/i18n.md`).
- **Superseded on this branch:** the original draft state was "no control
  performs a network call". Controls now perform real calls when a backend is
  running (see [Running the functional preview](#running-the-functional-preview));
  with no backend they degrade to an honest unreachable state rather than
  pretending to succeed.
- Two backend gaps surfaced by the audit are *represented honestly* rather
  than papered over: article history has no endpoint (`TODO:no-backend`),
  and TWL has no approve lifecycle (t6 says so on-screen).
- Deliberately out of scope: `/api/l10n/*` (separate admin i18n-chrome
  editor), `POST /api/templates/sync` + `GET /api/note-templates` (backend
  plumbing, not lead-facing actions).
- Long RTL verses (Psalms-scale) haven't been stress-tested in the tap
  aligner's source ribbon — flagged in 04-mobile-alignment.md.
