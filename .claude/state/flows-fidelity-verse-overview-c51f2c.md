# flows-fidelity-verse-overview-c51f2c — full flows port + verse overview

Delete this file when the PR merges.

**What this branch is:** all 13 flow screens from `docs/flows/ui/` ported into the
React app as real routes (foundation + t1–t6, l1–l3, a1–a4), plus the verse
fidelity overview (`#/verse/{book}/{ch}/{v}`) ported from
`docs/mockups/book-package/verse.html`. Stacked on PR #152 (bands) → PR #151
(mockups + ReviewQueue). Merge order: #152 → #151 → this branch's PR.

**Verified:** `npm run typecheck` and `npm run build` green on the final tree;
all 14 routes driven in a browser against the seeded local dev DB (ZEC real
data: 59 notes, 66 links, 194 template units render live). Not verified: visual
dark-mode/band QA per screen, save round-trips on every screen (t2 review save
was verified in the predecessor session; t3/t4 save paths are transcriptions of
Shell's, read-verified only), the 409/If-Match:0 paths on l2.

**Follow-ups (deliberate, not forgotten):**
- Empty-target-lane wording on t3/t4/t6 says "awaiting replacement" for lanes
  that are simply untranslated; VerseScreen's wording ("not drafted yet — normal
  in a translation-mode workspace") is the model. One small pass.
- `api.ts` lacks `getRow(kind,id,book)`; the t2 conflict re-read fetches the
  whole chapter as a workaround.
- `AlignSourceModel.tsx` copies four module-private AlignmentPanel helpers —
  extract into a shared lib.
- i18n sweep: every flow screen ships English literals with `// TODO(i18n)`.
- a1 uses SetupWizard's vertical stepper, not the mockup's side rail.
- Translate-job rows can't distinguish tn/tq resourceType (pre-existing gap).
