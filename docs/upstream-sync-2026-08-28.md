# Upstream sync — 2026-08-28

Baseline: the previous triage is `docs/upstream-sync-2026-08-21.md` (read it
first — its Deferred and Ruled-not-applicable lists still stand and are not
repeated here). This pass covered every `unfoldingWord/bible-editor` main
commit merged after that snapshot, roughly 2026-08-19 → 2026-08-27
(`50936c8c` … `1f98c0cd`, ~75 non-merge commits). Hashes are upstream commits;
fetch with `git fetch https://github.com/unfoldingWord/bible-editor main`.

Context worth knowing: upstream ran the mirror-image of this routine on
2026-08-24 (their `b47553c0`) and recorded in their STATE.md that our fork's
commits offer them nothing portable — the divergence is real in both
directions, and most of their new work this window is in subsystems we don't
have.

## Ported on this branch (2026-08-28)

- `8f6eec57` — allow `figs-you` tA support reference (taSupportReferences.ts
  was byte-identical; clean cherry-pick).
- `37f40985` — **replace.ts marker-chip capture guard (#606).** A DOM capture
  that lost every marker chip with no word changed no longer wipes the verse's
  `\q` lineation (upstream prod lost HOS ULT 11:9/11/12's poetry markers this
  way, silently, for a fortnight). Our `replace.ts` was byte-identical to
  upstream's pre-fix file, so engine + tests applied verbatim; Shell.tsx
  call-site adapted (`base` vs their `effectiveBase`) and the restored-marks
  toast wired through i18n (`shell.markersRestored`, en + gated ar). Their
  incident-repair scripts were not taken. Durable lesson recorded in STATE.md.
- `bf21183c` — **Find overlay repaint (#642), the live trigger for #606.**
  Our editable cells had the same defect: `html = findHTML ?? noteHTML`
  repainted a contentEditable cell from marker-free `plain_text` while Find
  was open, so a save capture carried no chips. Chip render now wins for the
  active/editable cell in ScriptureColumn/DocColumn/BookView, with
  `overlayFindMarks` painting match marks onto it. Rode along:
  `stripToVisibleText`/`isPaintableHtml` helpers (from their #529/#568 chain —
  helpers only, see Deferred). Their highlight.test.mjs doesn't exist here, so
  the new cases landed as `overlayFindMarks.test.mjs`.
- `828f33cf` — outbox: a `locked` drainPass result whose IndexedDB persist
  failed is no longer announced to listeners (`shouldAnnounceResult` in
  outboxTargeting.ts). Our drainPass had the same unconditional dispatch after
  the persist catch; adapted around our `settleAfterDispatch` structure.
- `36e2fd02` (rows.ts half only) — **no-change writes stop burning versions
  (#539 items 3 + F3).** The no-op short-circuit no longer requires the
  restore marker to match, so restoring a version whose text the row already
  holds is a genuine no-op; the one carve-out keeps the full-write path for a
  trashed tn row so the save still revives it before the 05:30 finalize.
  Pre-image was byte-identical; the upstream regression test
  (`rowRestoreNoop.test.mjs`) runs verbatim against our real router +
  migrations. Their verse-merge and RowHistoryDialog halves are N/A here.

Validation: `npm run typecheck`, `npm --workspace web run test` (210/210),
`npm --workspace api run test` (228/228), `node scripts/check-i18n.mjs`,
`npm run build` all clean. Playwright e2e not run in this environment.

## Deferred this window (verified relevant-or-plausible, needs hand-work)

- **Alignment draft generation-gate** (`41e67a04` + `a95f0169`): a landed
  alignment save wipes a draft written by continued dragging after Save
  (their #508), and crash-draft cleanup isn't generation-gated. Our
  `alignmentDrafts.ts` is close (their pre-fix + our workspace/sourceGen/
  quarantine extensions — the onOutboxResult delete is NOT generation-gated
  here either), but the fix threads `alignmentDraftGeneration` through
  AlignmentPanel's save path, and our AlignmentPanel has diverged ~900 lines.
  Joins the previously deferred aligner UI data-loss pair (`64ac22f`,
  `0fd9565`) — port the three together, by hand, with browser verification.
- **Verse-op 409 rebase** (`c3b6cae2` + test `fed26aa4`): re-arming a verse op
  after 409/version-thread rebases it onto the server row (new
  `verseRebase.ts`). Our outbox's conflict flow diverged (row auto-heal +
  merge prompt); needs a deliberate port decision, not a cherry-pick.
- **Render-blanking guards' component wiring** (`d266a1dc` #533, `7a23acd8`
  #568): the helpers (`isPaintableHtml` etc.) are now in our highlight.ts via
  the `bf21183c` port, but the component/useChapter wiring that stops writing
  empty renders into the pane was not taken — our render fallback paths had
  already diverged from their pre-image. Check whether our marker-only /
  empty-tree verses can blank, then wire by hand.
- **Verse save-baseline pin family** (`68a76e13`, `30bbada1`, `5d91813b`):
  still blocked on the deferred pin subsystem (`e6623d8` → `1e2ced4`, see
  2026-08-21 doc).
- **Tombstone sweep group** (`3c7d0b5d` option 3, `84553bff` compare-and-set,
  `68473196` changed-empty starvation): our bookReimport has its own
  tombstone/reissue handling (`isReissuedTombstone`, generation-keyed
  watermark) — the sweep concept may be worth adopting but not by patch.
- **Stale-base translationCore re-export gate** (`1f98c0cd`, new
  staleBaseGate.ts + migration + admin surface) and **allowIdBlocked
  override** (`436d6661`): entangled with their admin.ts /
  exportRequestBodies.ts / verse-merge stack, none of which exist here.

## Ruled not applicable this window (fork verified)

- Everything in the verse-merge / masterLineage / verseMergeConflicts /
  editLogSweep / applyVerseRows families (~30 commits: `37759578` `0d36f7e4`
  `c4d11a58` `88056249` `ca20625e` `fa030f03` `b839f65c` `1cfd7272`
  `82893e2d` `6c060053` `a610a95a` `7f2f6f55` `cd6e5209` `df03e843`
  `d6ac9532` `182f012e` `85bae965` `cb5ae2ad` `82d3cbd0` `d1e6a9cb`
  `14febecb` `ead9a1a8` `4e257469` `cc6b23cc` `0e490516`, ref_moved clears
  `54d7c5c8` `3cf581e0` `a3f6a10c` `34acedcf` `cf840fd1`, migration guard
  `47cd8deb`) — the subsystems don't exist here (no verseMerge.ts,
  masterLineage.ts, editLogSweep.ts, verse_merge_conflicts, ref_moved,
  RowHistoryDialog, SyncWarningsIndicator).
- Book-locks / published-book-branch admin surface (`7752775e` `1cdd8574`
  `f38aed5c` `85a8e640` `b4100c01` `32666629` `1aafcc30` `aaec586f`
  `74dc9797` `325842a8` `9c86f4db`) — no bookLock.ts / publishedGuard.ts /
  admin.ts / AdminPanel/BookLocksDialog here (per 2026-08-21 ruling).
- `a3ab67ef` (unpinned master fetches rerouted to api/v1) — **checked, bug
  not present**: our `dcsRawUrl` builds `raw/branch/<ref>` for any non-SHA
  ref and never routes content through api/v1.
- Incident/repair scripts (`07ea7977` `4264d02e` `2133d7b6` `4e39121b` parts)
  — upstream-prod D1 repair tooling.
- Test-infra only: `158d7be7` (glob runner — we already glob), `a01f4a34`,
  `b77fedb2`, `5d91813b` e2e half, `50936c8c`, `60096818` docs.
