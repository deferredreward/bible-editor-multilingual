# Alignment Suggestions — reference & measured improvement log

> Handoff for a fresh agent. Read `CLAUDE.md`, `docs/plan.md`, `docs/handoff.md`
> first, then this. The non-AI alignment-suggestion feature shipped in PR #98.
> This doc is now a **measured** log: an evaluation harness defines "better" with
> a number, and every scoring idea below was accepted or rejected on that
> evidence — don't re-attempt the rejected ones blindly.

## What this feature is

Non-AI word/phrase **alignment suggestions** in the AlignmentPanel. When a
verse's alignment is empty (e.g. ULT text was edited and alignment cleared),
faded dashed **ghost chips** appear in each empty Hebrew/Greek group; click to
accept (no reject — ignoring is free), with a bulk "accept N suggestions". It
replaces gatewayEdit's client-side wordMAP suggester, which was slow and trained
on whatever resources happened to be loaded.

## Architecture — KEEP THIS (it's the whole point)

- **No aligner engine at request time.** The API is a Cloudflare Worker (Hono +
  D1 + R2): no filesystem, ~128 MB. wordMAP-style runtime inference does not
  belong here. (gatewayEdit trains wordMAP live in-browser per book via a Web
  Worker + IndexedDB — exactly the cost we removed. We borrow wordMAP's *math*,
  not its integration. See `../tcc-ge-dcs` `WordAlignerDialog.jsx`.)
- **Precomputed D1 tables, built offline** from the **gold `\zaln-s` alignments
  in the published (canonical) ULT/UST**: `align_freq` (strong → surface
  counts, single words + phrases) and `align_freq_morph` (strong × morph-class →
  surface counts, words only).
- **Refresh cadence = on publish.** Bump the tag in `api/data/canonical.json`,
  re-run the trainer, re-upload. Never trains on user/in-progress data.
- **Division of labor** (fits the stateless endpoint, keeps the client cheap):
  - **Offline**: all corpus-derived counts (`align_freq`, `align_freq_morph`).
  - **Endpoint** (`/api/align/suggest`): one+ indexed D1 lookup + morph
    interpolation → per-candidate `confidence`; lexicon gloss fallback.
  - **Client** (`computeGhosts`): the verse-specific blend (position, occurrence,
    length) over the candidates, then match against the word bank. One fetch per
    verse; edits re-rank locally with no network (good on low-spec/weak links).
- **Anti-goals:** don't move inference to the client; don't train per-keystroke;
  don't train on loaded/non-canonical data; don't commit `scripts/out/*` (gitignored).

## Current state (what shipped, measured on held-out JOS/NAM/ACT, ult)

The held-out eval (`scripts/eval-aligner.mjs`) trains on every aligned book
*except* the held-out set, simulates "alignment cleared" per verse, and scores
top-1 against gold. Headline metric: **precision@1** (of groups given a
suggestion, fraction exactly matching gold); guardrail: **fw-fp** (content
groups whose top suggestion is a glue word — lower is better).

| stage | what | precision@1 | fw-fp | status |
|---|---|---|---|---|
| baseline | freq-share only (PR #98) | 57.5 | 9.3 | — |
| **Phase 1** | weighted-average blend: freq + alignment-position + occurrence | **60.1** | **6.7** | **shipped** |
| Phase 2 | memory-only uniqueness/IDF term | 59.5–59.8 | 6.3–6.4 | **rejected** (precision↔fw-fp trade, no net win) |
| Phase 3 | corpus co-occurrence fallback track | 58.6 | 8.1 | **rejected** (+2.3 coverage but ~98% wrong, flat net-correct) |
| **Phase 4** | morphology-conditioned freq (x-morph) | **61.7** | **6.1** | **shipped (code); needs prod D1 reload** |

Recall@5 is ~81% — the model usually *knows* the gold word; the wins come from
**ranking** it to the top, not from new candidates (corpus co-occurrence proved
gold-unattested cases are genuine ignorance, not mis-ranking).

**Deploy status:** Phase 1 is fully shipped. Phase 4 (morph) is committed and
locally validated (typecheck, eval, data pipeline, live endpoint smoke) but
**production still needs**: apply migration `0025_align_freq_morph.sql` remote, re-run the trainer,
and load both `align_freq` + `align_freq_morph` remote (see "Deploy" below).
The endpoint degrades safely to strong-only if `align_freq_morph` is absent.

## How scoring works (grounded in real wordMAP)

wordMAP's confidence is a weighted **average** of ~10 algorithms / ~16 score
keys (`node_modules/wordmap/dist/Engine.js` `calculateWeightedConfidence`), **not
a product** — so a weak signal is diluted, never zeroing a strong candidate. We
reproduce the subset that needs only the current verse:

- **memory frequency share** — the endpoint's per-candidate confidence,
  morph-interpolated (Phase 4): `λ·P(surface|strong,morph) + (1-λ)·P(surface|strong)`,
  `λ = n_sm/(n_sm + 5)`.
- **alignment position** — `1 - |srcRel - tgtRel|` (wordMAP `AlignmentPosition`).
- **occurrence balance** — `min/max` of in-verse source/target counts
  (`AlignmentOccurrences`). Doubles as a mild anti-glue signal.

Blended as a weighted average in `web/src/lib/alignmentSuggest.ts` (`BLEND_WEIGHTS`,
shared with the eval so there is no scorer drift). Phrases stay strong-only.

## Data flow

```
api/data/canonical.json (pinned ULT/UST @ tag/v88)
        │  scripts/train-aligner.mjs  (walk gold \zaln-s, with morph class)
        ▼
scripts/out/align-freq.sql  +  scripts/out/align-freq-morph.sql   (gitignored)
        │  scripts/apply-align-freq.mjs (chunked d1 execute; --file for either)
        ▼
D1: align_freq(bible,strong,surface,count)        [0024]
    align_freq_morph(bible,strong,morph_class,surface,count)   [0025]
        │  GET /api/align/suggest?bible=&keys=H776~Ncmsc;...   (api/src/align.ts)
        ▼
{ suggestions: { "H776~Ncmsc": { words:[{surface,confidence,count,source}],
                                 phrases:[{phrase,tokens,confidence,count}] } } }
        │  web/src/hooks/useAlignmentSuggestions.ts  (1 fetch/verse, cached by key-set)
        ▼
AlignmentPanel: computeGhosts (blend + match) → ghost chips (click to accept)
```

The request key is a per-source-word `"<rawStrong>~<morphClass>"` composite;
keys are **`;`-separated** (Greek morph classes contain commas). `morphClass` is
mirrored in `scripts/lib/align-corpus.mjs` and `web/src/lib/alignmentSuggest.ts`
— **keep the two in sync** (like `normStrong` already is).

## Key files

| File | Role |
|---|---|
| `scripts/eval-aligner.mjs` | **held-out eval** (`npm run eval:align`); precision@1 / recall@k / phrase-hit / fw-fp. Imports the *real* `computeGhosts`. |
| `scripts/eval-morph.mjs` | morph-class prototype (coarse vs full vs K) — kept as the morph regression eval |
| `scripts/eval-phase3.mjs` | corpus co-occurrence prototype — kept as evidence Phase 3 was rejected |
| `scripts/lib/align-corpus.mjs` | shared gold-walk parsing (`walkAlign`, `morphClass`, …); trainer + evals import it |
| `scripts/train-aligner.mjs` | offline trainer; emits `align-freq.sql` + `align-freq-morph.sql` |
| `scripts/apply-align-freq.mjs` | chunked + retried upload (`--file`, `--remote`) |
| `api/migrations/0024_align_freq.sql`, `0025_align_freq_morph.sql` | the two tables |
| `api/src/align.ts` | `/api/align/suggest`; composite keys, morph interpolation, lexicon fallback |
| `web/src/lib/alignmentSuggest.ts` | `computeGhosts`, blend, `morphClass`/`suggestKey`, `ghostPipColor` (shared w/ eval) |
| `web/src/hooks/useAlignmentSuggestions.ts` | 1 fetch/verse, cached by `(bible, sorted key-set)` |
| `web/src/components/AlignmentPanel.tsx` | builds composite keys, renders `GhostChip`, accept wiring |
| root `package.json` | `train:align`, `eval:align`, `db:align[-morph]:local/:remote` |

## Build / run / measure

```sh
npm run train:align -- --all-ot --nt   # full released Bible (emits both SQL files)
npm run eval:align                      # held-out JOS/NAM/ACT; add books/--bible/--k to vary
npm run db:align:local && npm run db:align-morph:local   # load both into local D1
npm --workspace api run db:migrate:local                 # apply migrations incl. 0025_align_freq_morph.sql
```

**Production deploy (user runs — needs Cloudflare creds):**
1. `npm --workspace api run db:migrate:remote` (applies `0025_align_freq_morph.sql`; do not refer to duplicate-prefix migrations by number alone).
2. `npm run deploy` (Worker carries the composite-key endpoint; SPA carries the blend).
3. `npm run train:align -- --all-ot --nt` then `npm run db:align:remote` **and**
   `npm run db:align-morph:remote`.

**Verify any scoring change:** `npm run eval:align` must hold/improve precision@1
without raising fw-fp. Then browser-smoke ZEC 5:3 (see `CLAUDE.md`): "the earth"
stays a phrase; repeats distribute (position-driven); `נִקָּה` still blank.

## Rejected approaches (measured — don't re-attempt blindly)

- **Phase 2 — memory-only uniqueness/IDF.** Down-weighting globally-common target
  surfaces is a pure precision↔fw-fp trade (no weight gives a net precision win):
  it demotes glue words but also moderately-common *correct* glosses (e.g. "land"
  for H776). The real wordMAP `Uniqueness` is a source/target frequency *balance*
  needing corpus stats, and its anti-glue work is actually done by the frequency
  ratios — a target-only IDF is the wrong shape. Phase 1's occurrence term
  already captured the glue-suppression benefit. (`scripts/eval-morph.mjs` history.)
- **Phase 3 — corpus co-occurrence fallback** (`scripts/eval-phase3.mjs`). A
  gold-priority corpus track lifts coverage +2.3pt but those predictions are
  ~98% wrong (net-correct flat) — gold-unattested strongs are genuine ignorance,
  not something co-occurrence over other books can guess. Uniqueness does **not**
  flip positive when combined with it (tested 2×2). Not worth a multi-million-row
  D1 table. Catching a *currently-edited* book's novel renderings still needs
  runtime co-occurrence over that book — the client cost we removed.

## Further ideas (unmeasured)

Source-context conditioning `P(surface|strong, neighbor-strong)`; global
assignment (optimal bipartite match vs greedy claim); learned blend weights; a
real stemmer. All server-side/precompute and eval-measurable first.

## Hard-won gotchas (will bite a new agent)

- **Trainer key-separator gremlin.** `align-corpus.mjs` joins keys with `SEP =
  "\t"` and builds phrase surfaces with `String.fromCharCode(32)`. Do **not**
  type a lone `" "` as a separator — a literal space written via the editor has
  landed on disk as a NUL byte, and phrase surfaces contain spaces. Detect a
  phrase with `/\s/.test(surface)`.
- **Composite keys use `;` not `,`.** Greek morph classes contain commas
  (`N,,,,NMP,`), so the `keys` param separates composites with `;` and splits
  each on the first `~`. `morphClass` is mirrored client+trainer — keep in sync.
- **wrangler 4.x has no `d1 import`.** Remote `d1 execute --file` on a multi-MB
  file times out; `apply-align-freq.mjs` chunks (~200 stmts) and retries.
- **wrangler dev local persistence + file-watch are flaky on this worktree**
  (junctioned `node_modules`, Windows): `wrangler d1 execute --local` and
  `wrangler dev` can resolve *different* local D1 dirs, and `dev` sometimes
  serves a **stale bundle** (didn't pick up an edit). If a code/endpoint change
  isn't reflected, restart `wrangler dev` (a fresh start re-bundles); if data is
  missing, confirm which `.wrangler/state` `dev` is actually reading.
- **NT Strong's-Plus:** Greek `align_freq` keys are Strong's-Plus (G23160), but
  `lexicon_entries` is classic (G2316). `lexiconKeysFor()` maps G##### → G####.
- **Endpoint is ungated** (like `/api/lexicon`) — GET, no CSRF.
- **Pips:** green ≥0.60, amber ≥0.35, gray <0.35 (`ghostPipColor`).
- **Shared dev:** multiple worktrees may run servers; never kill another's. Pick
  a free port (this project's dev is Windows-side, not WSL).

## Canonical test verse: ZEC 5:3
Open → Alignment → Clear. Expect `הָאָרֶץ → "the earth"` (phrase); repeated
מִזֶּה/כָּמוֹהָ each ghost; `נִקָּה → blank` (ZEC isn't in v88, so no canonical
signal — expected, see the corpus-limit note in Rejected approaches).
