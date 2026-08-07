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

**Review record:** two independent cold reviews ran before the PR settled
(Codex was out of credits; Claude stand-ins per the fallback). Round 1: 30
findings → fixed in 0e70399. Round 2 (merge-blockers): 9 findings → fixed in
715880b, verified ALL_FIXED with no new regressions. Lane wording was fixed in
round 1 and verified accurate against bsoj's real laneState (lit lane genuinely
mid-replacement).

**Follow-ups (deliberate, not forgotten):**
- `api.ts` lacks `getRow(kind,id,book)`; the t2 conflict re-read fetches the
  whole chapter as a workaround.
- VerseScreen highlight join collapses repeated identical pointed forms onto
  the first occurrence (UHB stamps no x-occurrence — measured 0/3400 in ZEC);
  documented in-code, read-only impact only.
- AlignmentPanel has no readOnly prop, so a viewer can still drag locally on
  the canvas (gets an honest view-only notice on Save instead of false success).
- `AlignSourceModel.tsx` copies four module-private AlignmentPanel helpers —
  extract into a shared lib.
- i18n sweep: every flow screen ships English literals with `// TODO(i18n)`.
- a1 uses SetupWizard's vertical stepper, not the mockup's side rail.
- Translate-job rows can't distinguish tn/tq resourceType (pre-existing gap).
