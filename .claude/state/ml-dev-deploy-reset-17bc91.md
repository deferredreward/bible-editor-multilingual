# ml-dev-deploy-reset-17bc91 — adaptive flows React port

Branch: `claude/adaptive-flows-react-port-bcb01e` (off main @ 32e2e78)

## What this worktree is for

Porting the adaptive UI flows into the real React app (`web/`), responsive, plus
bringing the book-package exegete preview in as a real editable surface.

**The framing shifted after research.** 11 of the 13 drafted flow screens already
have working React equivalents. What the mockups actually contribute is three
separate things:

1. A responsive layout contract the React app had none of (zero viewport
   awareness in `Shell`/`WorkspaceLayout` — not one media query).
2. Two genuinely-new surfaces: t1 translator home (queue dispatcher) and
   a4 admin observe. No equivalent exists for either.
3. 18 measured API-contract findings, recorded in
   `docs/flows/05-functional-preview-findings.md` on branch
   `origin/claude/flows-functional-preview` (PR #151).

The book-package page is a fourth, unrelated thing: an exegete "is this verse
coherent?" view that joins original/literal/simplified on the *alignment* rather
than stacking them in panels. Nothing in the app does this.

## Decisions (Benjamin, 2026-08-06)

- **Order:** responsive foundation first, then the book-package view.
- **Bands:** three real bands everywhere (not two, not "where it earns it").
- **Book-package editing:** everything writable *including* verse text. Verse
  writes MUST route through `smartEditVerse` / `smartReplaceVerse` — the risk was
  raised and reaffirmed. Add regression cases to `web/src/lib/replace.test.mjs`.

## PR sequence

1. **Responsive foundation** — DONE, this branch, verified in-browser.
2. Mobile/tablet navigation pattern (fixes the nav dead-end below 700px that all
   four Admin screens have: they hide their only nav with nothing replacing it).
3. Book-package coherence view, read paths.
4. Book-package write paths incl. verse text via `smartEditVerse`.
5. t1 translator home queue dispatcher.
6. a4 admin observe dashboard.
7. Fold in the API-contract findings that touch the real client: 428 handling
   (distinct from 409 — it means "you didn't say which version"), `If-Match: 0`
   on the first preferences write, corrected routes (`/api/chapters/:book` not
   `/api/books/:book`; `/api/articles/:resource` not `/api/articles`), per-kind
   `chapter_locked` gating (tn PATCH is exempt, tq/twl are not), and
   `workspace_mismatch` 409.

## Source material

- Flows docs + 13 vanilla screens: `origin/claude/flows-functional-preview`
  (`docs/flows/`). Read `05-functional-preview-findings.md` first.
- Book-package mockups were **uncommitted** in sibling worktree
  `flows-preview-mockups-ea0661` at `docs/mockups/book-package/`. Backed up to
  this session's scratchpad. **Still uncommitted — needs preserving properly.**
  Primary pages: `verse.html` (Read/Audit modes) and `focus.html` (single
  column, computed verdict line). `ledger.html` / `sweep.html` are earlier
  project-manager screens. The join logic to reimplement lives in `_vlib.js`:
  `decorate()` / `groupsFor()` (alignment inversion), `coherence()` (content-word
  hole flags split by real morphology; function words stay quiet),
  `unitRows()` (audit table).

## Known open questions, not yet resolved

- **Classic layout has only 2 regions, so its tablet band renders identically to
  desktop.** The band system does deliver three distinct bands for layouts with
  3+ regions (cap 2 at tablet + switcher). But with Classic — the default — a
  768px tablet looks exactly like 1400px. Given the "three bands everywhere"
  decision this is a real gap; candidate treatments are collapsing the rail at
  tablet and/or shifting the default split ratio. Deliberately not guessed.
- Tap targets below the WCAG 24px floor elsewhere in the mockups (a select at
  22px, a button at 23px). Raising the floor changes density on every screen.
- Benjamin reported "text running together" somewhere — screen and width unknown,
  not reproduced yet.
- `.cluster-btn` is defined six times across the mockups and has diverged. Worth
  extracting before porting so the port consumes one component.

## Deferred out of this branch

- `api/src/alignmentDelta.ts` counts alignment losses only among words that
  survive an edit, so a write emptying the word set passes the guard reporting
  zero losses (receipt: `edit_log` id 1458, 38 aligned words to 0, accepted 200).
  Spun off as its own task — do not grow this branch with it.

## Verification notes for whoever picks this up

The in-app browser (`mcp__Claude_Browser__resize_window`) overrides viewport
metrics via CDP and fires **no** `resize` and **no** `matchMedia` change events.
`matchMedia().matches` polls correctly, but React never re-renders, so responsive
behaviour looks broken when it isn't — it only updates after a reload. Use the
chrome-devtools MCP `resize_page` instead: it resizes the real window and does
fire both events. Its narrow floor is ~500px, which is still inside the phone
band (<560), so the phone band's static layout is testable there, but a LIVE
transition through exactly 375px (resize-in-progress, not reload-at-width) is
not — a code comment in `WorkspaceLayout.tsx` documents an 82px measurement
taken at 375px separately, via a different browser surface's static layout,
not through a live resize in this harness. The two are not in tension: one is
"what does 375px look like", the other is "what happens while shrinking down
to it live" — this harness only answers the second, and only down to ~500px.
