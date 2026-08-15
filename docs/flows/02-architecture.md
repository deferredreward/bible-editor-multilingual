# Adaptive UI flows — architecture & build spec

**Status:** decision record + build spec. Inputs: [00-code-inventory.md](00-code-inventory.md)
(frontend surfaces/actions, handle registry), [00b-api-inventory.md](00b-api-inventory.md)
(110 endpoints, lock/409 semantics), [01-design-inputs.md](01-design-inputs.md)
(tokens, keeps/drops, decision evidence).

---

## Decisions

### D1 — Work unit: queue-shaped primary, verse-shaped context (one model, three renderings)

The dominant loop (bundle E, review & approve) is a queue, and the unified
queue screen is the single largest simplification available (E/I/J are the
same screen with different nouns). But the verse-shaped mockup's insight —
"everything about this verse in one place" — is real. Resolution: **the queue
is the work unit; the verse is the context unit.**

- **Mobile (<560):** home = queue dispatcher (counts per queue, à la
  `t1-home.html`); each queue is card-at-a-time (Focus Theater verdict).
  A "This verse" affordance on every card opens a bottom sheet with the
  verse's scripture lanes + sibling resources — read-only context, never a
  second work surface.
- **Tablet (560–899):** Translation Desk verdict — queue list on the left,
  active work card as hero (~55%), verse context collapsible on the right/
  below (~35%).
- **Desktop (≥900):** three-region workspace — queue rail (left), work card
  (center), persistent verse-context column (right: paired lanes + sibling
  resources). Batch flow via Next / Approve keyboard affordances.

### D2 — Admin workflow: deep model wired to real handles; stage editor is a future card

`admin-workflow.html`'s operational panels (AI job table, import/source
lifecycle, per-step config) map to real endpoints and ship in the Admin flow.
The Render-style stage-sequence editor has **no backend** — it appears as one
"Workflow stages" card marked `data-handle="TODO:no-backend"`, using
up/down buttons (never native HTML5 drag-and-drop — known hit-testing trap).

### D3 — Deliverable: three role flows × three form factors

Three flows — **Translator**, **Lead**, **Admin** — each a set of linked,
fully responsive HTML screens that restructure at 560/820/900. One HTML file
per screen serves all three form factors (that *is* the adaptive claim);
the hub page previews each screen at the three widths.

### D4 — Tokens, breakpoints, a11y

Adopt `docs/mockups/desktop-first/_design.css` wholesale as `ui/_tokens.css`,
with one addition: `--kindle` is defined as the **nudge/needs-attention
accent** (its single sanctioned use). Breakpoints 560/820/900. Keep the
blanket reduced-motion rule, the universal `:focus-visible` ring, the
triple-declaration dark-mode pattern (`default` + `prefers-color-scheme` +
`[data-theme]`), and semantic status colors separate from brand accent.
All directional layout uses `dir` attribute + logical properties
(`text-align: start`, margin-inline) — never hard left/right — per the RTL
lesson. Copy is draft English; every string is destined for i18next keys
(note in README, don't build i18n into mockups).

---

## Handle annotation convention ("almost drop-in, not connected")

Every actionable control carries:

```html
data-handle="PATCH /api/rows/tn/:id"     <!-- or: local:drafts.put · ws:hint · TODO:no-backend -->
data-headers="If-Match"                  <!-- only when concurrency headers apply -->
data-bundle="E"                          <!-- A–K taxonomy -->
```

Verse-text saves carry `data-headers="If-Match, X-Source-Generation"` (both
required — layered, not either/or). `ui/_shell.js` intercepts every click on
`[data-handle]` and shows a toast naming the handle it *would* call; no
network calls, no form submits. Handles must be copied from the registry in
00-code-inventory.md / 00b-api-inventory.md — never invented. Anything with
no real endpoint is `TODO:no-backend`, never a plausible-looking fake path.

## States every relevant screen must render (from the inventories)

1. **Chapter locked** — discovered reactively on a failed write (409
   `chapter_locked`), never via a GET: render as a banner + disabled-inputs
   state, with "mark notes to keep" affordance.
2. **Version conflict** — 409 `version_mismatch`: merge prompt (mine/theirs),
   op re-queued.
3. **"New AI drafts are ready — save your work, then refresh"** banner
   (delivery is not real-time; 5–8 min lag observed).
4. **"N unsaved"** reminder pointing at Save (drafts persist in IndexedDB;
   save is explicit-click only — never blur-save, never confirm-dialog).
5. **Context pack chip** — `Context pack ready (sha)` as the trust indicator.
6. **AI not configured** — BT_API_TOKEN absent disables pipeline routes
   *including job-status reads*: graceful empty state, not an error.
7. **Mode gating** — authoring vs translation mode hides surfaces (translate
   pipelines, templates/articles menus). Mockups include a preview toggle.
8. **"x of y"** counters everywhere the inventory shows them.
9. **Org switch = full app reload** — the account menu says so.

## Screen list & bundle coverage

| Flow | Screen | Bundles | Key inventory sections to consume |
|---|---|---|---|
| Translator | `t1-home.html` — queue dispatcher + trust chips | E, K | dispatcher counts, banners, account/status menus |
| Translator | `t2-review.html` — unified review queue (notes + questions): approve / approve-all / suggest / template / edit+Save / history / 409s / lock | E, F | NoteCard actions, drafts store, NoteHistoryDialog, QuoteBuilderPopper |
| Translator | `t3-scripture.html` — paired lanes ULT→GLT / UST→GST, verse edit, verse status, ChapterBoard, LayoutMenu note, verse history | G | verse PATCH dual headers, statuses, VerseHistoryDialog |
| Translator | `t4-align.html` — alignment canvas + side-by-side variant; mobile gets a graceful "larger screen" state | H | aligner, SideBySideAligner |
| Translator | `t5-articles.html` — tW/tA article queues + editor (split screens, no tabs — per recorded verdict) | J | article parts, drafts (book-agnostic DraftMeta) |
| Lead | `l1-ai.html` — run pipelines (3 base + 2 translate-mode), job progress (batch x/y), confirm/conflict dialogs, lock implications | D, K | AI menu items, pipeline job polling, PipelineErrorKind friendly copy (fix the raw-enum gap) |
| Lead | `l2-style.html` — preferences sections + context pack export + pack sha + templates.tsv count | C | preferences pages, export, shared prefs version |
| Lead | `l3-templates.html` — template curation queue (Draft-with-AI / Save / Approve / history) | I | TemplateWorkspace, TemplateHistoryDialog |
| Admin | `a1-setup.html` — org setup wizard (5 linear steps), WorkspaceChoiceDialog | A | setup flow |
| Admin | `a2-import.html` — book picker + wait states, ImportFromDoor43Dialog | B | import routes, job progress |
| Admin | `a3-team.html` — team/user management, org switch | A/team | admin routes |
| Admin | `a4-observe.html` — dashboard: export runs, pipeline jobs, health, pack status; "Workflow stages" future card (TODO:no-backend, up/down not DnD) | K | exports instance status, health, crons |

Cross-cutting: TWL has **no approve lifecycle** (real gap — render word-links
read-only in queue context, note the gap); templates/articles have **no
client-side role gating** (mirror reality; note it). `#/templates` currently
has no TopBar — the new flows give every screen the same shared top bar
(deliberate fix, noted in README).

## Build rules for executors

- Read your screens' bundle sections in 00-code-inventory.md **in full** and
  include every action listed there — the verification pass will diff your
  screens against the inventory, and misses are defects.
- Static HTML + vanilla JS only, no build step, no external requests. Shared
  assets: `ui/_tokens.css`, `ui/_shell.js` (already built — do not modify;
  extend per-screen styles in a `<style>` block like the desktop-first
  lineage does).
- Every screen: `<html lang="en" dir="ltr">`, works at 375px, 768px, 1280px;
  no horizontal body scroll at any width; dark mode + reduced-motion via
  tokens; `aria-current` / `aria-pressed` / roles per the desktop-first bar.
- Interactive enough to feel real: local state in JS (approve advances the
  queue, counters decrement, banners dismiss), but every side-effectful
  control routes through the `data-handle` toast.
- Navigation between your flow's screens via plain relative links in the
  shared shell nav; also link back to `../index.html`.
