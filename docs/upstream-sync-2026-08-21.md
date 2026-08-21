# Upstream sync — 2026-08-21

Baseline: the last upstream pull was PR #15 (merged 2026-07-14). Since then
`unfoldingWord/bible-editor` main gained ~298 commits; 196 touched backend or
shared-library surface. Every one of those was triaged against this fork's
actual code (bug verified live / already fixed / not applicable), and the
verified fixes below were ported on this branch. This file records what was
**deliberately deferred** so the next sync doesn't re-triage from scratch.
Hashes are upstream commits; fetch with
`git fetch https://github.com/unfoldingWord/bible-editor main`.

## Ported on this branch (2026-08-21)

- tA support-reference chain: `ee09099` `01ffd7b` `389e2f7` `6bc029e`
  (+ CI check `ta-refs.yml`; the check script needs live git.door43.org, so it
  runs in CI, not sandboxes).
- Deploy orders migrations before code: `b800c7f` (first half; poll-batch
  isolation half was already present).
- Export/DCS: `def001e` (`{BOOK}-be-mechanical` branch naming), `dd81c0a` +
  `a169d49` (closed-PR lookup / lingering-PR error tolerance), `5a8ac7f`
  (fake `\x` from `\w` attr residue), `74796c2` (master fetch completeness via
  contents-API size cross-check), `9140004` + tests `904eed1`/`8a5f895`
  (`\s`-family hoist, both usfmFormat mirrors).
- AI-pipeline ingest: `7a535ea` (quote curling: helpers + full wiring),
  `366296f` (tQ tombstone id collision no longer kills the import),
  `ed8c937` (dispatch POST timeout + ambiguous-timeout grace),
  `a2c7e81` (row-create book-case/chapter guard).
- Bug-hunt sweep `90a2e54`: all parts whose bugs exist here — edit-engine
  (skeleton gate, joinWouldFuse, paste ellipsis), outbox races (dropped
  wakeup, timer clobber, revive race), trashed-row content-PATCH tombstoning,
  bookImport duplicate-id, educateQuotes `\n` context. Skipped parts: verses
  NaN (already guarded), comments.ts (subsystem absent), describeShrinkRefusal
  (function absent).
- Outbox/sync: `4815a78` + `8a240f8` (FIFO leapfrog block + per-iteration
  blocked recompute), `31d4784` + `4f357f0` + `2f5ecdc` (confirm before
  discarding 409/failed ops), `71dcece` (draft-save generation fence).
- Marker shape: `9cc0104` + `b0b5ec5` (`\ts\*` recognized in every usfm-js
  shape; nodeForMarker mints parsed shape) + display-layer companions in
  highlight.ts/chapterCopy.ts.
- Reimport integrity: `da1f24f` (count tombstone-dropped master rows, withhold
  the sync watermark — gate adapted to this fork's generation/source-keyed
  watermark), `d0464de` (reclaim a reissued tombstone's slot; review_kind
  clearing adapted to tn-only schema), `71a5ffb` (chunk applyVerseRows'
  pristine batch under D1's 100-statement cap — chunking half only).

## Deferred — project-sized upstream subsystems (adopt wholesale or not at all)

- **Three-way merge of Door43 master edits into edited rows/verses**
  (`e6bb577` → `812e4ae` → `3e3b8c4`, then `6e9d761` `8a0d173` `c128dd5`
  `9b783ac` `7839a44` `26a4b5a` `39f124d` `d4c123c` `98c81d9` `f9abbc8`
  `161945c` `28c7b7f` `b61d0ad`-adjacent parts). HIGH value: this fork's
  reimport still *skips* rows/verses with `updated_by` set, so a Door43-side
  maintainer correction is reverted by the next nightly export. Upstream's
  answer is a whole subsystem (verseMerge.ts, tsvMerge.ts, ownPublish.ts,
  verse_merge_conflicts, 4+ migrations). Warning from upstream history:
  `e6bb577` alone caused fleet-wide adopt_conflict reverts until `812e4ae` —
  never take the base without its follow-ups.
- **Maintainer USFM/TSV shape preservation chain** (`24d5536` → `b61d0ad` →
  `0a277fc` → `1d31594`, plus `37b4abf` `3275512` `9517ab1` `15c8736`
  `196b785`, backstop `d97d65b` usfmValidate gate). This fork's
  normalizeUsfmFormatting is the pre-#417 version, so nightly exports re-break
  hand-cleaned USFM on master (glued markers, mid-line `\q`, chapter-front
  `\p` runs, `\ts\*` run collapse). `15c8736` is mandatory with `9517ab1`
  (content loss without it).
- **Pipeline import-claim heartbeat rework** (`ee6a2c8` + `518b46c` +
  `2cfca81` + `65ce108` + `04af7c5` + `507897a` + `8ca7743`, one unit).
  This fork's deleteUnkeptTns sweeps job-wide via pending_imports EXISTS with
  no claim heartbeat and a blind error-path release — upstream's DAN 11
  incident (121 applied AI notes deleted on resume) is the same shape.
- **Pipeline force-stop + auto-resume** (`9cf0fff` `f28fd6f` `8256b8e`
  `7e5c2f4` `fae0ab2`; `0609b44` `12bb289` `75bac2e` `58e5b0c` `33de3f9`
  `45bf9ec` `5b34c2d` + migrations, renumbered — fork is past 0067). Fork's
  only backstop today is the 48h auto-fail.
- **Verse save-baseline pin** (`e6623d8` → `1e2ced4`): fork's saveVerseDraft
  still diffs/versions against the live `base` prop → mid-edit rebase can
  silently overwrite. Shell.tsx-heavy; port deliberately.
- **Occurrence hard-reject group** (`e712f64` + `1aa795a` + `2406d61`):
  fork's POST create path can store a NULL twl Occurrence; one such row makes
  DCS validation hard-fail the whole book's PR. Brings occurrenceRule.ts +
  hardRejectGuard wholesale.
- **Blank-note 422 guard** (`9a7d679`, prod incident NUM 22:10 upstream):
  server half is small (422 `blank_note` in rows.ts PATCH) but needs the
  client discard flow (noteGuard.ts + stub quartet `3b79251` `aa429a6`
  `050b941` `18d80ac`) to avoid breaking legitimate clears.
- **Alignment/quote correctness set** (each group all-or-none):
  highlight trio `32f2116` → `66fc25d` → `cd2c432` (OL `\w` x-occurrence
  default-1 bug in collectBareWords); renumber pair `1451c70` + `4b6da9a`;
  TWL split-alignment pair `7916bc1` + `6eed4d8`; quote-builder trio
  `657c400` + `4124013` + `3f9a138`; split-source-milestone ingest `1a379e4`.
- **Shrink-guard override + attribution** (`55f72e6` + `4bc385b` + `22ea54e`
  + `23613ed`; `b5c9ba7` + `72ef468` + `6cbe6b7`): fork's TSV shrink guard has
  no admin unblock path, and its alignment-shrink alert asserts one unmeasured
  cause (exportWorkflow.ts ~2062) with re-sync advice that would destroy
  translator work. Policy split `4d2d3d9` + `d6a658d` (+`15a80d5` `0cb1f3d`)
  ships slips with warnings instead of embargoing whole books.
- **Aligner UI data-loss pair** (`64ac22f`, `0fd9565`): own-save version bump
  wiping in-flight drags / dual-aligner close chain — fork's AlignmentPanel
  diverged; needs hand-verification.
- **Refusal surfacing** (`47b3572`): refusalReason.ts + SyncStatusBar
  wording; the outbox halves (focus revive, refusal-body capture) partially
  landed via the outbox ports; the UI surfacing did not.
- Smaller: `b875fa9` (staleness chip heuristic), `d8b1ee2` (writeAlert
  dismissed-identical skip), `c9278b2` (book-level TSV reimport, subrequest
  headroom), `9738377` (refresh-uhb.mjs — needs fork DB-name/module
  adaptation), `72b0358` `9dfcdb8` `84b3f63` `e3ccb75` (lint additions;
  84b3f63's blank-field export HOLD is the valuable part), `02cee78` +
  `a32da09` (verse-0 create hardening), `196b785` (see USFM chain).

## Ruled not applicable (fork verified)

Book locks (`661f6c0` `865cc55` `444b206` `fc6b57c` `6302828`), comments/
mentions subsystem (`ca1ae25` `156dc5e` `ad4e33b` etc.), alignment_attention
(`f6adbb6` family), reused-source-token lint/marker chain (`a3d9af2` family),
export_reverts classifier pieces, Bearer-auth fallback fix `9cf3409` (fork is
cookie-only), verse-0 deletion `3d063d7`/`d0f...` (fork's 11fbb00), worktree
script fixes (fork forwards to dotfiles copies), and fixes to upstream-only
files (occurrenceRule, applyVerseRows counting rework, blankStub,
chapterZeroGuard, admin.ts, usfmValidate gate wiring).
