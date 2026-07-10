# Hebrew Unicode Standardization to the UHB

> Where and why we normalize Hebrew before comparing or keying it. If you touch
> alignment, quote matching, TWL suggestions, or import/export sequencing and
> you're comparing Hebrew strings, read this first.
>
> **If you extend this — add a new normalizing call site, change a helper, or
> discover a new mismatch class — append it to the relevant section and update
> the changelog at the bottom.**

## The core problem

The UHB (Hebrew Bible source) stores combining marks in **traditional Tanakh
order** — consonant → **dagesh** → vowel (e.g. DAGESH, combining class 21,
*before* HIRIQ, combining class 18). Almost everything else — usfm-js output,
AI-emitted `\zaln-s x-content`, TN/TQ quotes, and milestones from ZEC and LAM —
comes out in **Unicode-canonical NFC order** (lower combining-class first →
HIRIQ before DAGESH).

The two strings are **visually identical and identical to a translator, but fail
strict byte equality.** A raw `===` on Hebrew silently misses: lookups fail, the
UI mis-highlights and mis-orders, phantom drop-slots appear in the aligner, and
TWL rows mis-sequence on export.

**Measured impact** (from [handoff.md](handoff.md), "Hebrew Unicode
normalization" row): **0%** of ISA/OBA milestones need normalization, but
**8.5% of ZEC** and **13.8% of LAM** milestones silently mis-resolve without it.
The numbers are highest for books whose milestones come out NFC.

> The upstream fix is to have the AI aligner emit `x-content` byte-identical to
> the UHB `\w text`. Until then, normalization at every compare is mandatory.

## Storage layer vs. compare layer — there is only one matching space

A common confusion: it looks like we match against UHB legacy bytes in some
places and NFC in others. **We don't.** Matching is uniformly NFC. The legacy
bytes only ever matter for *storage*, never for comparison. Two distinct layers:

- **Storage (persisted, legacy Tanakh order).** The UHB source `\w text` is
  stored exactly as it arrives — DAGESH-before-HIRIQ. We keep it verbatim
  because **export must be byte-perfect**; rewriting it to NFC on import would
  break the round-trip against DCS (see the round-trip fidelity invariant and
  the "Hebrew-NFC clobber" note in
  [`importParsers.ts`](../api/src/importParsers.ts)). So stored UHB stays legacy.

- **Compare (ephemeral, always NFC).** Every Hebrew comparison runs **both
  operands** through a fold first — the pattern is always `nfc(a) === nfc(b)`,
  never `a === b`. The legacy UHB string is converted to NFC *on the fly, for
  that one comparison*, and compared against the other side, which is also
  forced to NFC. Examples: `nfc(built.quote) !== nfc(note.quote)`,
  `nfc(a[i].content) !== nfc(b[i].content)`, keys built as
  `${nfc(content)}|${occurrence}`.

So there is exactly **one matching space: NFC.** Nobody compares raw legacy
bytes against anything. Normalizing-at-compare is precisely *how* the two stored
encodings (legacy UHB vs. NFC milestones/quotes) get reconciled without mutating
the canonical source. This is also why you can't "just normalize on import and
forget it": the storage layer is deliberately **not** NFC (it's legacy, for
fidelity), and it's the compare layer that unifies everything to NFC.

The one genuine variation is not *whether* we normalize but *how much* we fold:
the three helpers below tolerate different things (quotes drop joiners;
deny-lists drop all pointing). That's legitimate — a quote-highlight compare and
a consonant-only deny-list compare need different tolerances.

## The three helpers (what each one folds away)

The canonical helpers live in [`web/src/lib/hebrew.ts`](../web/src/lib/hebrew.ts).
A highlight-specific variant lives in `highlight.ts`.

| Helper | Location | Transformation | Use it for |
|---|---|---|---|
| **`nfc(s)`** | [`hebrew.ts:18`](../web/src/lib/hebrew.ts) | `s.normalize("NFC")` — reorders combining marks to canonical order. Strips **nothing**. | The default for every Hebrew↔Hebrew compare or key, where the only difference is legacy vs. NFC mark order. Safe to apply uniformly (no-op on already-canonical strings, including Greek). |
| **`matchNorm(s)`** | [`highlight.ts:36`](../web/src/lib/highlight.ts) | `nfc(s)` **+ strip** word-joiner (U+2060) and ZWJ (U+200D) | Quote↔token highlighting. TN/TQ quotes routinely omit the U+2060 joiner that the UHB token carries (e.g. ZEC 4:10 `הָאֶ֧בֶן`), so equality must ignore joiners too. |
| **`twlFilterKey(s)`** | [`hebrew.ts:34`](../web/src/lib/hebrew.ts) | `NFC` + strip **all** `\p{Mn}` (pointing/cantillation), maqaf (U+05BE), joiner (U+2060), ZWJ, whitespace → **bare consonants** | TWL deny-list matching. Stored deny-lists keep U+2060 + spaces; a browser-resolved quote uses maqaf/space and never U+2060. Folding both to consonant skeletons keeps a rejected suggestion rejected. |

There is also a **search-only** fold, `stripHebrewMarks` /
`stripGreekMarks` in [`sourceSearch.ts`](../web/src/lib/sourceSearch.ts) (NFD →
drop `\p{M}` → NFC) — a full skeleton fold for source-text *search*, distinct
from the three above. Don't reuse it for equality/keying.

### The one rule

> **Every Hebrew↔Hebrew comparison must go through a normalizer before keying or
> equality.** Use `nfc()` by default; `matchNorm()` when quotes are involved
> (joiners drift); `twlFilterKey()` for deny-list matching. A raw `===` on
> Hebrew strings is a bug waiting for ZEC or LAM.

## Where each check runs

### `nfc()` — Hebrew↔Hebrew compares (the bulk)

- **Alignment engine** ([`alignment.ts`](../web/src/lib/alignment.ts)):
  source-word list equality (`~:256`), identity/dedup keys (`~:423`, `~:474`,
  `~:985`), occurrence counting so legacy+NFC dupes count as one word (`~:592`),
  milestone→verse-position resolution (`~:625`, `~:921`).
- **Re-alignment after edits**
  ([`alignmentReassembly.ts`](../web/src/lib/alignmentReassembly.ts)): LCS
  surface keys so survivors match by NFC surface + occurrence.
- **Occurrence totals**
  ([`sourceOccurrences.ts`](../web/src/lib/sourceOccurrences.ts)): true
  per-verse counts keyed by NFC (the `x-occurrence` fields are unreliable).
- **UI compares** — [`Shell.tsx`](../web/src/components/Shell.tsx) (quote-change
  detection, avoids a false "changed" on identical glyphs; also dedup keys),
  [`AlignmentPanel.tsx`](../web/src/components/AlignmentPanel.tsx) (source-position
  resolver), [`UhbStrip.tsx`](../web/src/components/UhbStrip.tsx) (tw-hint map).

### `matchNorm()` — quote highlighting

- [`highlight.ts`](../web/src/lib/highlight.ts) — all quote↔source-text equality.
- [`quoteBuilder.ts`](../web/src/lib/quoteBuilder.ts) — stamps occurrence using
  the *same* fold the highlighter uses, so the count it records is the count the
  highlighter will find (round-trip guarantee).

### `twlFilterKey()` — TWL suggestion deny-lists

- [`useTwlFilters.ts`](../web/src/hooks/useTwlFilters.ts) — unlinked/deleted
  deny-list keys and lookups.

### Backend / API

- **TWL export sequencing** — [`export.ts:105`](../api/src/export.ts),
  `normalizeWordText`. Added `.normalize("NFC")` before lowercase/trim (commit
  `a4346a4f`) so the Hebrew `x-content` matches its slot in the ULT alignment
  map instead of missing it and mis-sequencing the TWL rows.
- **Import dedup** — [`importParsers.ts`](../api/src/importParsers.ts)
  `zalnDedupKey` = `content.normalize("NFC")|occurrence` — collapses a doubled
  source token in one alignment compound (e.g. JER 31:33 `אֶת אֶת בֵּית`).
  Backend mirror of the `alignment.ts` source-milestone dedup.
- **The "Hebrew-NFC clobber" warning** — [`importParsers.ts`](../api/src/importParsers.ts):
  a master fix that reorders combining marks into UHB-legacy order **must
  propagate to D1**, or the nightly reimport reverts it. Regression tests in
  [`importParsers.test.mjs`](../api/src/importParsers.test.mjs).

### Scripts

Analysis/eval scripts each define their own local `nfc`
(`analyze-kings-isa.mjs`, `build-ai-batches.mjs`, `validate-ai.mjs`,
`eval-*.mjs`). `scripts/scan-align-order.mjs` imports the real one from
`hebrew.ts`.

## Changelog

Append here when you extend the normalization layer, so the next person sees
what moved.

- **2026-07-10** — Initial doc. Captured `nfc` / `matchNorm` / `twlFilterKey`,
  their call sites, and the `export.ts` TWL-sequencing NFC fix (commit
  `a4346a4f`, "Normalizing Hebrew for matching with twl sequence"). Added the
  storage-layer (legacy, persisted) vs. compare-layer (NFC, ephemeral)
  distinction — matching happens in exactly one space, NFC.
