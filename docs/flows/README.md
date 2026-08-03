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

- These are **drafts**: demo state is local JavaScript, copy is
  un-i18n'd English (all strings are destined for i18next keys per
  `docs/i18n.md`), and no control performs a network call.
- Two backend gaps surfaced by the audit are *represented honestly* rather
  than papered over: article history has no endpoint (`TODO:no-backend`),
  and TWL has no approve lifecycle (t6 says so on-screen).
- Deliberately out of scope: `/api/l10n/*` (separate admin i18n-chrome
  editor), `POST /api/templates/sync` + `GET /api/note-templates` (backend
  plumbing, not lead-facing actions).
- Long RTL verses (Psalms-scale) haven't been stress-tested in the tap
  aligner's source ribbon — flagged in 04-mobile-alignment.md.
