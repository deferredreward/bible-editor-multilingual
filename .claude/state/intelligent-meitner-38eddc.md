# intelligent-meitner-38eddc — i18n triage: Arabic fill + tiered checker

Branch: `claude/eager-bhabha-354d3b` (rebased onto `89512ed`). Commit `41261eb`.
**Not yet pushed; no PR opened.** Awaiting Benjamin's call on the open decision below.

## What landed

`node scripts/check-i18n.mjs` now exits 0 and is wired into CI (`npm run check:i18n`).

- Arabic filled: 443 keys (132 book names + setup/import/layout/preferences/topbar/misc),
  all six CLDR plural categories. AI-drafted by Fable agents against the existing
  `ar.json` for terminology consistency; independently validated for placeholder
  preservation, bidi control chars, key parity.
- Checker tiered via `web/src/i18n/coverage.json`: `gated: ["ar"]` must be complete;
  the other 12 are a one-way ratchet (losing an existing translation fails; a new
  untranslated English string does not). Stale keys + code orphans fail for all.
- 29 stale keys pruned from all 13 locales.
- New: `scripts/i18n-extract-missing.mjs`, `scripts/i18n-apply.mjs`.

## Second wave — Arabic values (Benjamin approved widening scope)

The 189 values that were still English text are now translated, and the checker
gained a rule so it can never happen silently again.

- 189 values replaced (preferences 85, setup/workspace/topbar/noteCard/aligner/lanes
  55, templates/pipeline 49), including 5 holding *stale* English from a superseded
  en.json wording. 0 pre-existing Arabic values were altered; 0 keys lost.
- New gated-tier rule: a value byte-identical to en.json FAILS. 20 legitimate
  exceptions (brands, resource proper names, badge codes, symbols, a
  pure-placeholder string) are allow-listed in `coverage.json` → `sameAsEnglish`.
- `i18n-apply.mjs --overwrite` fills values still in the source language. It refuses
  to touch anything that already has a real translation.

`ar.json` is now genuinely fully Arabic. **It still has had no native review.**

## Gotchas found (worth not rediscovering)

- **"Untranslated" can't be tested with a pure-ASCII check.** An em dash or arrow in
  otherwise-English text makes the string non-ASCII, so `i18n-apply.mjs` tests for a
  *letter outside the Latin script* instead. One key (`scriptureLanes.bookRetryHint`)
  was silently skipped before this was fixed.
- **`en.json` mixes nesting styles.** `preferences.register` is a *string* sitting
  beside literal dotted keys `"register.default"` / `"register.formal"` in the same
  object. Naive flatten→split(".")→re-nest silently destroys the `register` string.
  `i18n-apply.mjs` carries each key's real path segments and has a round-trip guard
  that refuses to write if any key/value would be lost. Don't remove that guard.
- `i18n-apply.mjs` only reorders a locale to en's key order when it *adds* keys; a
  prune-only run preserves existing order (otherwise a 29-key deletion produced a
  639-line diff per file).
- This worktree's `npm install` produced a corrupt tree twice (crash exit
  -1073740791, packages missing their `dist/`). `rm -rf node_modules && npm ci` fixed
  it. `@cloudflare/workers-types` is missing in the **main checkout too**, so
  `npm --workspace api run typecheck` fails machine-wide, unrelated to any branch.
- `npm run typecheck` / `npm run build` need `npm-run-all`, which was one of the
  packages the bad install broke.
