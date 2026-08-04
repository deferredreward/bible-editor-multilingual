# cranky-pascal-0bf4e6 — functional preview of the UI flows

**PR:** https://github.com/deferredreward/bible-editor-multilingual/pull/151 (open, base `main`)
**Branch:** `claude/flows-functional-preview`, stacked on PR #149 (`claude/adaptive-ui-flows-editor-6c309f`, still open).
Real delta = commits `5a913d3` (wiring) + `270285a` (review fixes).

## Still running
Local Worker on **port 8891** serving `docs/flows/ui` as assets plus `/api/*`:
`cd api && npx wrangler dev --port 8891 --ip 127.0.0.1 --assets ../docs/flows/ui`
Kill it when done with the preview. Local D1 `bible_editor_dev` is seeded with ZEC.

## Open decisions for Benjamin (in findings §4)
- **4.6** All four Admin screens have NO navigation below 700px (measured: 0 of 6 links
  visible at 375px). Needs a narrow-width nav pattern — new design, not a correction.
- **4.5** Tap targets below the WCAG 24px floor (a `<select>` at 22px, a button at 23px;
  Hebrew word buttons 26px). Fixing changes visual density on every screen.
- **4.2** Six screens have only two layouts, not the three D1 specifies — the tablet band
  is largely unimplemented. Either build it or amend D1.
- **4.4** `.cluster-btn` is defined six separate times and has already diverged; it belongs
  in `_tokens.css`.

## Escalate beyond this branch
`analyzeAlignmentDelta` (`api/src/alignmentDelta.ts`) computes losses only for words that
SURVIVE an edit, so a write that empties the word set reports **zero** unexpected losses and
passes the guard. Proven here: `edit_log` id 1458, `ZEC/1/8/ULT`, 38 aligned words → 0,
accepted 200. Fixed in the preview by disabling the save; **not** fixed server-side.
Worth checking whether the production editor can reach the same path.
