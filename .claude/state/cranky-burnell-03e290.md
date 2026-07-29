# cranky-burnell-03e290 — Flexible layout: real panel bodies

Replacing the six placeholder panel bodies in the Flexible layout
("<type> — panel coming in a later pass") with real content. Split into several
small PRs.

(This file previously tracked PR #132, which merged 2026-07-28 — its record now
lives in that PR's thread, per the delete-on-merge convention.)

## Status — all three PRs open, reviewed, awaiting merge

They are a **stack**. Merge in order: #135 → #136 → #137. GitHub retargets each
to `main` as its parent merges.

- **[#135] associated tA/tW article panels — open, review clean.**
  Read-only articles fetched from Door43, keyed to the active note / selected
  word. New: `web/src/lib/taArticle.ts` (+ test),
  `web/src/components/AssociatedArticlePanel.tsx`; both placeholder sites in
  `Shell.tsx` wired up.
- **[#136] `original` panel — open, review found and fixed one real bug.**
  `HebrewLine` + `highlightsFor` lifted into a placeable panel; first consumer
  of `PanelConfig.resource`. `ScriptureColumn` untouched.
- **[#137] `search` panel — open, review clean.** The `SEARCH_IFRAME_URL`
  iframe, extracted; the ResourceColumn tab is left byte-identical.

## Durable lessons from this work

- **Do NOT call `nfc()` in a panel that consumes `highlightsFor`.** The general
  Hebrew rule ("normalize every Hebrew↔Hebrew compare") does not apply at this
  boundary: normalization is already encapsulated inside `highlightsFor` via
  `matchNorm`, and `HighlightKey`s deliberately carry RAW token text.
  Normalizing at the boundary would break key matching, not fix it.
- **Anything consuming `buildVerseIndex` needs an `isFirstOfRange` guard.** The
  index maps EVERY verse of a span to the same row, so a bridged row (`\v 6-9`)
  appears at keys 6,7,8,9 and renders four times without it. `DocColumn.tsx:215`
  and `ScriptureColumn.tsx:1034` both guard; #136 initially did not. The paired
  trap: `isActive` must be "activeVerse falls inside the row's span", not
  `v === activeVerse`, or a bridged row is never active.
- **The seeded ZEC fixture has NO bridged rows** (`verse_end IS NOT NULL AND
  verse_end <> verse` returns zero). Range handling is therefore unreachable in
  local browser testing unless you synthesize a bridged row. Both bugs above
  passed a full browser pass because of this.
- **This repo ships no Greek sample data** — `docs/samples/` is Hebrew OT only
  (ISA, LAM, OBA, ZEC) and `scripts/import-book.mjs` hardcodes `hbo_uhb_*`. The
  UGNT render path can only be exercised with a synthetic row.
- **Untracked files follow a branch checkout.** A `git add -A` after switching
  branches swept another branch's work-in-progress into a PR. Check
  `git status` before staging when juggling stacked branches.

## Deliberately not built (decisions, not oversights)

- **`alignment`** — out of scope. Alignment is currently a *mode* of the single
  `ResourceColumn`, keyed on Shell-level `alignerTarget` / `panelMode`, and its
  dirty state is what `runWithDirtyGate` protects via one shared
  `alignmentDirtyRef`. A placeable alignment panel requires that ref to become
  per-panel — a real redesign of the most brittle surface in the repo. Should be
  its own issue.
- **`articleList`** — no built-in layout uses it (the `translate-words` preset
  that did was retired in PR #123) and the real tW/tA UI is a route. Flagged as
  possibly redundant; confirm it is still wanted before building it.

## Notes for whoever picks this up

- `panelRegistry.ts` descriptors declare `i18nTitleKey: "layout.panel.<type>"`,
  but those keys do not exist in `en.json` — Shell titles panels with
  `panelTitle.<type>` instead, so `i18nTitleKey` is dead today. Left alone.
- Local verification needed **no** `--persist-to`: the short repo path
  (`C:\GH\BEM\repo`) keeps a worktree inside Windows MAX_PATH, so wrangler's
  default in-worktree `.wrangler/state` works. The older "use C:/bem-verify"
  advice is obsolete.
- The tA/tW panels fetch from Door43 directly, so `POST /api/articles/populate`
  is **not** required to see content — a plain book import (ZEC) is enough.
- Browser gotcha: assigning `location.href` a URL that differs only in its hash
  does not reload the page, so a layout switch written to `localStorage` looks
  like it had no effect. Use `location.reload()`.
- Background servers started by a **subagent** die when that agent finishes —
  start them from the main session.
