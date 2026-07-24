# In-flight · Top bar redesign (Option 1b)

**Branch:** `claude/top-bar-redesign-b9c4d0`
**Status:** implemented, typecheck + build + unit tests green, smoke-tested in a real
(non-headless) Chrome tab via Claude-in-Chrome. **Not yet committed** — user asked to
"implement", not to commit/PR; changes are sitting in the worktree.

## What this is

Design handoff `Top bar redesign thinking.zip` (user-supplied, unzipped to
`design_handoff_topbar/` in scratch) specified three prototype options for
`TopBar.tsx`; **Option 1b ("two anchors + overflow")** is the chosen direction —
right side collapses to exactly 4 anchors: merged **Status** chip, filled **AI**
button, **More** menu (Content/Resources/View), **Account** menu (identity, Mode
segment, Organization, Preferences, Sign out). Fixes the two look-alike download
icons (Import now `CloudDownloadOutlined`, Export now `FileDownload` — distinct
glyphs) and stops the bar wrapping to two rows.

## Files touched

- `web/src/components/TopBar.tsx` — full rewrite. New `ResizeObserver`-based
  `useContainerNarrow` hook (measures the bar's own width, not the viewport, per
  the design's CSS-container-query intent) drives the ~820px collapse. Root `Stack`
  needs `width:"100%"` + `minWidth:0` — **without these the flex item's default
  `min-width:auto` lets it overflow its parent instead of shrinking, which both
  silently clips the right cluster AND starves the ResizeObserver of a real
  "available width" to measure.** Found and fixed this via computed-style
  inspection since ResizeObserver never fires in this session's browser tooling
  (see Known gap below).
- `web/src/components/StatusIndicator.tsx` (new) — merged Status chip + popover.
  Idle rows render mockup-exact plain sentences ("All edits saved to the cloud" /
  "No AI pipelines running"); non-idle rows embed the REAL `SyncStatusBar`
  (`hideFloating`) / `PipelineStatusBar` (no `toast` — see below) so 100% of
  existing interactive behavior (retry/discard/cancel/jump-to-draft) survives,
  just relocated into the popover instead of duplicated as plain text.
- `web/src/components/SyncStatusBar.tsx` — extracted `useSyncSummary()` hook
  (pure refactor, no behavior change) + two new bool props `hideInlineChip` /
  `hideFloating` so one always-mounted instance (floating conflict/failed panel +
  discard dialog only) and one popover-embedded instance (inline chip only) can
  coexist without duplicating the floating panel.
- `web/src/components/PipelineStatusBar.tsx` — exported `ToastMsg`, added
  `hideChip` bool (same always-mounted-for-the-toast + popover-embedded-for-detail
  split). **Known, accepted trade-off:** the "already running — auto-open and
  point at it" focus request (`pipelineStore.onFocusRequest`) needs a live,
  non-hidden chip to anchor to, so it only fires from the popover-embedded
  instance while that popover happens to be open. Narrow edge case (concurrent
  pipeline-start collision); the Snackbar toast (primary feedback) still always
  fires from the always-mounted instance regardless.
- `web/src/components/BookLintIndicator.tsx` — added `variant?: "chip" | "row"`;
  `"row"` is a full-width link row for the Status popover, same Menu/issue-list
  underneath.
- `web/src/components/WorkspaceSwitcher.tsx` — added `variant="menuItem"` (same
  non-interactive "go switch it in Preferences" behavior as `"indicator"`, styled
  as a MenuItem row for the Account menu; still `null` in single-org installs).
- `web/src/components/ExportUsfmButton.tsx` — `forwardRef` + `hideTrigger` prop;
  exposes `openMenu(anchorEl)` so the More menu's "Export USFM" row can open this
  component's existing scope/version Menu without its own IconButton trigger.
  Verified end-to-end in the smoke test (More ▸ Export USFM → correct submenu).
- `web/src/components/LogosSyncToggle.tsx` — default visibility flipped to
  **hidden-by-default** (`useLogosSyncVisible()` hook, backed by the same
  `be:logosHidden` localStorage key — explicit prior values, "true" or "false",
  are preserved either way). Dropped the widget's own internal kebab/hide menu;
  visibility is now solely owned by the TopBar "More ▸ View ▸ Show Logos sync"
  toggle. Verified: toggling it on in the smoke test correctly mounted the widget
  in the left cluster.
- `web/src/components/Shell.tsx` — removed the left-rail logout `IconButton`
  (logout moved to the Account menu, per upstream PR #359 as the design doc
  cites); both `TopBar` call sites updated to the new flat prop surface (raw
  lint/pipeline-toast data instead of pre-rendered nodes — `WorkspaceSwitcher`
  and `LogosSyncToggle` are no longer Shell-rendered props, TopBar owns them
  directly now); mounts a trigger-less `<ExportUsfmButton hideTrigger ref=.../>`
  wired to TopBar via an `onOpenExportMenu` callback.
- `web/src/App.tsx` — passes `meUsername={auth.me?.username}` down to `Shell`
  (new prop) for the Account menu's `@username` identity line.
- `web/src/i18n/locales/en.json` — new keys under `topbar.status.*`,
  `topbar.more.*`, `topbar.account.*` (English only — `fallbackLng: "en"` covers
  the other 12 locales).

## Verified (Claude-in-Chrome, real non-headless Chrome tab, dev-auth as admin)

Status popover (all-saved/no-pipelines/build-sha), More menu (Content section
with visually distinct Import/Export icons + correct subtitles, Resources
gating, reading-size stepper, dark-mode toggle — flips theme + label live,
Interface language row, Show Logos sync toggle — correctly mounts the widget),
Export USFM menu wiring (opens the real scope/version submenu), Account menu
(identity `@dev` + `BSOJ (العربية)`, Mode segment flips `authoring`↔`translation`
via a real `PATCH /api/project-config/mode` **and does not close the menu**,
Organization row, Sign out).

## Known gap — not live-verified

The `ResizeObserver`-driven narrow-width collapse (hide "go to ref" + Logos
widget below ~820px bar width, "More" label collapses to icon-only) could not be
exercised live: **both available browser surfaces in this session report
`document.hidden = true`** (off-screen/virtual window — `resize_window` fails
with "bounds must be at least 50% within visible screen space" on the
Claude-in-Chrome real-browser surface too), and Chrome throttles/suspends
ResizeObserver callbacks entirely on hidden pages — confirmed empty even after a
2.5s wait observing `document.body` directly. This is a testing-environment
limitation, not code under test. What IS verified: after the `width:100%` +
`minWidth:0` fix, `getComputedStyle` on the bar's root `Stack` correctly reports
the actual available width (not an inflated content-driven one) at a 700px
viewport — so the width math ResizeObserver depends on is provably correct; only
the live *firing* of the callback couldn't be observed here. **Whoever picks
this up next: do a real, focused-window resize check (drag the actual OS
window narrower) before merging**, just to close this last gap.

## Not done (explicit follow-ups, out of scope for this pass)

- The "AI" button (`PipelineMenu`'s own `<Button variant="contained">`, made
  filled in-place — one-line change in `PipelineMenu.tsx`) does **not** collapse
  its "AI" text label at the narrow breakpoint (would require threading
  `isNarrow` from `TopBar` through a `compact` prop into a component this pass
  otherwise didn't touch). Low risk — "AI" is 2 characters, not the overflow driver.
- No commit made yet. Diff is sitting in the worktree; user has not asked for a
  commit/PR.
