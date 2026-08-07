# One verse, is it coherent? — exegete mockups

Semi-functional desktop mockups of a **book-package preview for the editor / exegete**:
open one verse, see all of it, and judge whether it hangs together. Designed against
Nielsen Norman Group's *Aesthetic and Minimalist Design* heuristic.

These replace what gatewayEdit's six-panel preview and the current flexible view do, with
the permanent chrome taken out. Status: **mockups** — no backend, nothing writes.

## Run

```bash
python -m http.server 8892 --bind 127.0.0.1
```

Open <http://127.0.0.1:8892/index.html>. The pages also work from `file://` — classic
`<script src>`, no fetch, no modules.

## The screens

| File | For |
| --- | --- |
| `index.html` | The argument, the worked example, and what was removed |
| `verse.html` | **Investigate one verse.** Original / literal / simplified plus one detail area. `Read` and `Audit` modes |
| `focus.html` | **Decide and move on.** One column, top to bottom, arrow keys step verses |

**verse.html** — click any word in any of the three texts and the same place lights up in
all three, because everything is anchored to the original word. *Read* shows the three
texts as prose; *Audit* shows one row per original word with what each translation made of
it. Selecting a note shows its real translationAcademy article; selecting a term link shows
its real translationWords article. `←` `→` step verses, `r`/`a` switch mode, `Esc` clears.

**focus.html** — a computed opening line saying whether anything needs reconciling, then
the three texts, then each note with **what both translations actually did with its words**,
with the article folded away behind a summary. `←` `→` step verses.

## The one design idea

Both legacy screens stack resources in boxes and leave the reader to correlate them by eye.
But the literal and simplified texts are each *already aligned* to the same original words.
Joining them on that alignment — rather than showing them side by side — turns "is this
coherent?" from a reconstruction into a lookup.

ZEC 1:1, where a note calls `הָיָה דְבַר־יְהוָה אֶל־זְכַרְיָה` an idiom:

| | |
| --- | --- |
| Original | הָיָה דְבַר־יְהוָה אֶל־זְכַרְיָה |
| Literal | the word of Yahweh came to Zechariah |
| Simplified | I am Zechariah, Yahweh gave me this message: |

The literal text keeps the idiom; the simplified replaces it with a plain statement and
fronts the speaker. Nothing had to be cross-referenced by hand.

## What was removed

- **Per-panel toolbars.** gatewayEdit gives each of six panels a drag handle, minimise,
  save, link, hide and kebab — roughly thirty controls competing with the text. None here.
- **Panel headers and tabs.** A heading and a count is enough.
- **Progress strips, `done`/`all` toggles, APPROVE ALL, NEW, translation-mode chips, per-row
  save and delete.** This is a reading and checking surface; workflow chrome does not belong.
- **Resizable, rearrangeable regions.** One control per screen, and it names a task
  (*Read* / *Audit*), not a panel.

Kept: the original with its morphology, both renderings, notes with their real articles,
term links with theirs, and the questions.

## Flags are observations, and stay quiet

A missing *content* word is worth seeing; a missing preposition or object marker is normal,
and flagging it is the noise the heuristic warns against. Holes are split using the real
morphology — only a missing content word raises the amber line, function words get a quiet
mention. Across Zechariah 1 that is **3 of 21 verses** raising anything.

Nothing is a verdict. The screens say where the three texts diverge and leave the call to
the reader.

## Files

| File | Role |
| --- | --- |
| `_extract-verse.mjs` | Generator → `_verse.js` |
| `_verse.js` | Generated: UHB words + morphology, ULT/UST alignment groups, units, tN/tQ/tWL, tA/tW article prose |
| `_vlib.js` | Derivation and rendering: anchoring, coherence observations, markdown |
| `_pkg.css` | Tokens and components, carried over from `../desktop-first/_design.css` |

```bash
node --experimental-strip-types --no-warnings docs/mockups/book-package/_extract-verse.mjs
```

Type stripping is needed because the generator imports the product's own morph decoder.

## Everything on screen is real

Zechariah 1 — 21 verses, 334 original words, 58 notes, 66 word links, 10 questions.

| What | Source | Coverage |
| --- | --- | --- |
| Original text, lemma, morphology | `hbo_uhb_38-ZEC.usfm`, decoded by `web/src/lib/morph.ts` | 334 / 334 words |
| Literal rendering + alignment | `en_ult_38-ZEC.usfm` | 302 groups mapped |
| Simplified rendering + alignment | `en_ust_38-ZEC.usfm` | 217 groups mapped |
| Notes | `en_tn_tn_ZEC.tsv` | 58 / 58 quotes anchored |
| Word links | `en_twl_twl_ZEC.tsv` | 66 / 66 anchored |
| Questions | `en_tq_tq_ZEC.tsv` | 10 rows |
| translationAcademy prose | local `en_ta` checkout | 18 articles, 0 missing |
| translationWords prose | local `en_tw` checkout | 24 articles, 0 missing |

Morphology is decoded by the product's own tested decoder, not a re-implementation.

### The bug worth knowing about

Joining two translations on their alignment sounds trivial. Alignment `x-occurrence` counts
occurrences of the **exact pointed form**, not the consonantal skeleton. In ZEC 1:3 the
three instances of `צבאות` carry three different accentuations and are each "occurrence 1",
while the two identically pointed `יְהוָ֣ה` are occurrences 1 and 2. Keying on a stripped
skeleton — the obvious first attempt, and what this did at first — welded distinct words
together and produced "sayssays … of Armies of Armies of Armies". Keying on the exact form
fixed it: of 695 milestones, 686 match exactly, 5 on Strong's number, 4 on consonants
alone, 0 not at all.

## Honest limits

- **Zechariah 1 only** — 21 verses, to keep the fixture a sensible size. The extractor takes
  a chapter constant.
- **Desktop only, deliberately.** Both screens say so below 1100px rather than hiding
  something that matters.
- **Article prose is a build-time snapshot** from local `en_ta` / `en_tw` checkouts, not a
  live fetch. Paths are hard-coded in the extractor.
- **Verified by driving the pages in a browser:** verse stepping, both modes, selection
  propagating across all three texts, note and term detail with real article prose, morphology
  display, flag demotion for function words, keyboard navigation, theme toggle, the
  narrow-width guard, and no horizontal overflow at 1600×950.
- **Not verified:** pixel-level visual polish — the browser pane would not composite, so
  screenshots were unavailable and checks were structural and behavioural. Hebrew rendering
  depends on installed fonts (`SBL Hebrew` first).

## Also here: the first attempt

`ledger.html` and `sweep.html` answer a project-manager question — *where is the work across
a whole book, and is the package internally consistent?* Kept because that job is real.
Among other things they show that Zechariah's notes quote Hebrew in chapters 1–5 and 13 but
English in chapters 6–12 and 14, and that 15 note quotes no longer match the literal text.
Their data comes from `_extract.mjs` → `_zec.js` and `_pkg.js`.
