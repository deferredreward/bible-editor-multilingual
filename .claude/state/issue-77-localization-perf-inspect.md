# issue-77-localization-perf-inspect

PR: https://github.com/deferredreward/bible-editor-multilingual/pull/88 (open)

Implements issue #77: perf fix for the Localization tab freeze (Preferences →
Localization rendered ~3,218 keys / ~6,400 controlled TextFields at once) plus
an inspect-to-edit "localization mode" overlay.

- Perf: `LocalizationSection` in `web/src/components/PreferencesWorkspace.tsx`
  now wraps each namespace group in a collapsed MUI `Accordion`
  (`unmountOnExit`); a non-empty search auto-expands only matching groups.
  Added `id`/`name` to every field.
- New `web/src/i18n/localizationMode.ts` — tiny module-level pub/sub store
  (not React Context) so the toggle survives navigation between the
  Preferences view and the main Shell (they're mutually-exclusive sibling
  views in `App.tsx`).
- New `web/src/components/LocalizationInspector.tsx` — hover-highlight +
  click-to-edit overlay, mounted once in `App.tsx`. Matches hovered DOM text
  against a reverse index built from `flattenEn()`/`i18n.t()` (no
  `data-i18n-key` attributes added anywhere). Known gap: keys with
  `{{interpolation}}` tokens don't hover-match (rendered text has
  substituted values); static UI chrome matches fine.
- `en.json` diff: 6 new keys under `preferences.localization.*`, added as a
  single targeted edit to avoid colliding with the parallel #79 branch
  (book name/abbreviation localization) also touching that file.

Verified: typecheck, `npm --workspace web run test` (15/15), `npm run
build`, and a full browser pass via chrome-devtools MCP (wrangler dev +
built `web/dist`, fresh local D1 with migrations applied) — confirmed the
Localization tab loads with all groups collapsed (no freeze), search
auto-expand works, and the hover→highlight→click→edit→save loop works
end-to-end against the real API (tested on `shell.noNotesForVerse`).

Delete this file once PR #88 merges.
