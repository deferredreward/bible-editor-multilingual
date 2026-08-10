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

## Open decision (blocking a follow-up, not this branch)

**`ar.json` is 100% key-complete but 178 pre-existing values are still English text**
— preferences 85, templates 28, setup 26, pipeline 20, workspace 13, topbar 3,
noteCard 2, aligner 1. These predate this branch. The checker compares *keys*, not
values, so it cannot see them and reports Arabic as complete.

Since Arabic is the first client language, these should probably be translated before
any Arabic demo. Options: (a) fill them in a follow-up PR, (b) add a non-failing
"value identical to English" report to the checker so the gap stays visible.

## Gotchas found (worth not rediscovering)

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
