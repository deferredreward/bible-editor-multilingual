# cranky-burnell-03e290 — Flexible layout: real panel bodies

Replacing the six placeholder panel bodies in the Flexible layout
("<type> — panel coming in a later pass") with real content. Split into several
small PRs.

(This file previously tracked PR #132, which merged 2026-07-28 — its record now
lives in that PR's thread, per the delete-on-merge convention.)

## Status

- **PR 1 — associated tA/tW article panels: DONE, ready for review.**
  Read-only articles fetched from Door43, keyed to the active note / selected
  word. New: `web/src/lib/taArticle.ts` (+ test),
  `web/src/components/AssociatedArticlePanel.tsx`; both placeholder sites in
  `Shell.tsx` wired up.
- **PR 2 — `original` panel: not started.** Extract the Hebrew/Greek strip
  (`HebrewLine`) out of `ScriptureColumn` into a placeable panel driven by
  `PanelConfig.resource` ("uhb" | "ugnt"). Data already sits on
  `data.verses["UHB"|"UGNT"]` + `lexiconMap` + `data.twl` — no new fetching.
  Every Hebrew↔Hebrew compare must go through `nfc()` from `lib/hebrew.ts`.
- **PR 3 — `search` panel: not started.** Small; it is the
  `SEARCH_IFRAME_URL` iframe from `ResourceColumn`. Keep the same host — it is
  allow-listed in the API's CSP `frame-src`.

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
