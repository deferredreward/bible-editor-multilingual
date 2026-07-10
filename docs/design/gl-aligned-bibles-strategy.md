# GL Aligned Bibles (GLT/GST) — Production Strategy

**Status:** Plan only — no code. **Scope:** FEASIBILITY.md Phase 6 ("GL scripture (GLT/GST)"), explicitly **deferred until Phases 0–5 land** [VERIFIED FEASIBILITY.md:130]. This document exists so the Phase 6 decision is made from evidence already gathered, not re-derived under schedule pressure.

Evidence tags: **[VERIFIED file:line]** read in this repo/docs, **[RESEARCHED]** external with source noted in FEASIBILITY.md, **[INFERENCE]** reasoned from verified facts, **[PROPOSED]** design suggestion, unvalidated.

---

## 1. The target contract

For each gateway language, per book, published to git.door43.org under the GL org [VERIFIED FEASIBILITY.md:16-17,22]:

| Repo | Requirement |
|---|---|
| `glt` (GL literal) | USFM3 with `\zaln` word alignment **to UGNT/UHB**; RC `rc0.2` manifest, `subject: "Aligned Bible"`; `checking_level ≥ 3` |
| `gst` (GL simplified) | identical requirements |
| both | DCS repo topic `tc-ready` or `ready-for-use` |

Three non-negotiables follow:

1. **The alignment SOURCE never changes.** GLT/GST align to UHB (Hebrew) and UGNT (Greek) exactly as en_ULT/en_UST do — the `\zaln-s` milestones carry `x-strong`/`x-lemma`/`x-morph`/`x-content` for the *original-language* word. Only the target-language words inside `\w …\w*` change (English → Arabic/Spanish/…). [VERIFIED — FEASIBILITY.md:16; alignment source-word model at web/src/lib/alignment.ts:32-45]
2. **checking_level 3 implies human verification.** Level 3 means church-network-affirmed accuracy checking; no AI output ships at level 3 without human review of every verse's text *and* alignment. [INFERENCE from the contract's intent; the exact checking process per GL org is a governance question, not a tooling one]
3. **Completeness is all-or-nothing per book** — a book missing its `glt`/`gst` (or with a malformed manifest) silently drops the language from tC3's GL dropdown [VERIFIED FEASIBILITY.md:24].

Acceptance test (same as Phase 3): install tC3, point at the GL org, the language appears and word-level checks (which depend on alignment) work.

## 2. Option analysis

### Option A — Bible Editor's custom aligner + AI pre-alignment

**What exists today (Hebrew/Greek → English):**

- A lossless `\zaln` parse/serialize model: target text is a flat stream of words/text/markers, alignment metadata lives in separate source groups, non-contiguous groups split back into valid milestones on serialize [VERIFIED web/src/lib/alignment.ts:1-26]. Round-trip fidelity is byte-clean including empty-attribute edge cases [VERIFIED alignment.ts:36-40] and audited against production ULT/UST encoding [VERIFIED docs/usfm-alignment-audit.md:1-36].
- A custom HTML5 drag-and-drop alignment UI (deliberately not `enhanced-word-aligner-rcl` — bundler reasons, per CLAUDE.md), including a side-by-side dual-Bible variant aligning ULT and UST against a shared Hebrew strip [VERIFIED web/src/components/AlignmentPanel.tsx, SideBySideAligner.tsx:44-50].
- An edit engine whose invariant is "an edit must never unalign words it didn't touch" [VERIFIED CLAUDE.md, web/src/lib/replace.ts contract].
- Non-AI alignment suggestions: an offline trainer walks gold `\zaln` in the published ULT/UST and emits per-Strong's→surface frequency tables into D1 [VERIFIED scripts/train-aligner.mjs:1-14]; the Worker serves ranked candidates with morph interpolation and a lexicon-gloss fallback [VERIFIED api/src/align.ts:1-14,217-258]; the client blends frequency/position/occurrence wordMAP-style into "ghost chip" suggestions [VERIFIED web/src/lib/alignmentSuggest.ts:93-135]. Measured: precision@1 61.7%, recall@5 ~81% on held-out books [VERIFIED docs/alignment-suggestions.md:49-59].

**What is language-neutral already:** the parse/serialize model, the DnD UI mechanics, the position/occurrence blend signals, the D1 schema (`align_freq` is keyed by `bible`, so `glt-ar` rows coexist with `ult`) [VERIFIED api/src/align.ts:151-153 — `bible` is a query param, default "ult"].

**What is English-hardcoded and must change for Arabic/Spanish targets:**

- The **stemmer** rescues English inflection only (`ing/ed/es/ly/s` suffixes) [VERIFIED alignmentSuggest.ts:77-84]. Arabic morphology (templatic, prefixed/suffixed clitics) gets zero rescue; matches degrade to exact-surface. Spanish fares somewhat better but still misses verb conjugation.
- The **lexicon fallback** tokenizes English glosses/definitions with an English stopword list [VERIFIED api/src/align.ts:70-101] — useless for non-English targets; must be disabled or replaced per language.
- The **Hebrew object-marker rule** hardcodes the single permitted candidate `"and"` [VERIFIED alignmentSuggest.ts:184-187] — the linguistic insight (H853 carries no target content) transfers, the surface string does not.
- The **frequency tables themselves** — the real engine — are trained on English gold alignments and are worthless for any other target language. This is the cold-start problem (§3).

**Trade-offs.** Pro: the hardest, most fidelity-critical machinery (lossless `\zaln` round-trip, alignment-preserving edits, the review UI, the publisher path) already exists and is battle-tested; suggestion quality is a productivity dial, not a correctness gate — a GL translator can align with zero suggestions, just slower. Pro: fits the Phase 1 config layer (per-language source Bible panes) and the store — `verses` is keyed by `bible_version` with an open-ended comment (`'ULT' | 'UST' | 'UHB' | 'UGNT' | ...`) [VERIFIED api/migrations/0001_init.sql:82-96], so GLT/GST panes are new `bible_version` values, not schema work. Con: human alignment labor is the dominant cost regardless of tooling (~31k verses per full Bible [INFERENCE — standard canon count]); suggestion quality for a cold-start language will start well below the 61.7% English figure; RTL rendering of the target word chips is untested [INFERENCE — per-field RTL exists in the editor per FEASIBILITY.md:37, but the aligner's chip layout has never rendered an RTL target].

### Option B — Aquilla for drafting + external alignment

Hands-on evaluation (2026-07-09) established Aquilla ingests USFM, has strong per-cell translate/validate UX with correct RTL, an editable per-project AI prompt, and explicit external-agent hooks — but **every export is lossy except XLIFF 1.2**, and no evidence of any `\zaln` awareness exists [VERIFIED FEASIBILITY.md:52-64]. So even in the best case Aquilla produces *unaligned GL verse text*; alignment still happens in the Bible Editor aligner (Option A's UI), and the draft must survive an Aquilla→XLIFF→verses import path without corruption. Its AI translated protected original-language content in the tN test [VERIFIED FEASIBILITY.md:64] — a warning sign for USFM markup fidelity too. Outreach questions covering round-trip, segment identity, protected content, and API docs are pending [VERIFIED aquilla-outreach-email.md:13-23]. **Verdict:** possible *drafting complement*, never the alignment answer; unusable until outreach answers land.

### Option C — Wait for tC4 drafting/alignment tooling

tC4/Pankosmia is the future *downstream* drafting/checking desktop, timeline hoped end of 2026 [VERIFIED FEASIBILITY.md:49]. Its alignment surface does not exist yet — the ecosystem audit found no Proskomma-native alignment editor in any active repo; everything still falls back to `word-aligner-rcl` adapters [VERIFIED docs/usfm-alignment-audit.md:24-34]. Waiting means: unknown ship date, alignment targeted at downstream-translation→GL rather than GL→OL [INFERENCE from tC4's scope — unconfirmed whether GL→OL alignment is even planned], and zero control over fidelity requirements. **Verdict:** not a plan; at most a re-evaluation trigger.

### Option D — SIL Serval / MT-assisted drafting feeding the Bible Editor aligner

Serval is an open REST API around trained NMT (NLLB-200) for scripture drafting [RESEARCHED — FEASIBILITY.md:65]. It could produce a first-pass GL draft, but: (a) GLT/GST must track *ULT/UST meaning* closely, and a general MT model translates freely rather than following the literal/simplified register; (b) NLLB-quality for the literal register in Arabic/Spanish is unmeasured here; (c) Serval does not align. [INFERENCE on (a)/(b)] The bp-assistant LLM pipeline (Phase 0's `translate` contract) offers prompt-level control over register and few-shot examples that MT does not. **Verdict:** a candidate *drafting engine* to benchmark against the LLM pipeline on a golden set, nothing more.

## 3. What "AI pre-alignment" could look like — and the cold-start problem, honestly

The existing suggester is frequency memory: it only knows `(strong → target surface)` pairs it has *seen in gold alignments* [VERIFIED train-aligner.mjs:3-8]. For English, gold = the published ULT/UST. For Arabic, **there is no gold**: Van Dyke is not aligned [VERIFIED FEASIBILITY.md:86 — Van Dyke is proposed as a reading *pane*, nothing more], and no `\zaln`-aligned Arabic Bible is known to exist [RESEARCHED — none found; absence of evidence, flagged]. Per-language frequency training therefore has nothing to train on at day zero.

Three escape routes, usable in combination [all PROPOSED]:

1. **LLM pre-alignment (recommended seed).** For each verse, give a frontier model the UHB/UGNT words (with Strong's/lemma/morph, already in the verse JSON) plus the drafted GL verse, and ask for word-group correspondences as structured output. The Bible Editor renders these as pre-filled alignments *flagged unverified*; the human corrects them in the existing AlignmentPanel. This is a new bp-assistant skill riding the existing pipeline queue [VERIFIED — the queue/auto-apply plumbing exists per FEASIBILITY.md:36]. Unknown: LLM alignment accuracy for Arabic — must be measured on a golden set (~2 hand-aligned chapters) before trusting it, exactly like the Phase 0 eval discipline.
2. **Statistical alignment over an existing parallel corpus.** UHB↔Van Dyke are verse-parallel; classical aligners (eflomal / fast_align / awesome-align) can produce noisy Hebrew↔Arabic lexical priors offline, loaded into `align_freq` under a distinct `bible` key. Caveats: output is probabilistic, Van Dyke's textual base differs from UHB in places, and the *surfaces* are Van Dyke's, not the GLT's — useful as suggestion priors only, never as pre-filled alignments. [PROPOSED; feasibility of the toolchain is [RESEARCHED]-grade, quality is unmeasured]
3. **Self-training flywheel (the durable answer).** Every human-verified GLT book becomes gold; re-run `train-aligner.mjs` pointed at the GL repo and the suggester improves book over book. The trainer is already parameterized by repo/ref via `canonical.json` [VERIFIED train-aligner.mjs:43-67]; the change is a per-language manifest. Expect the first books to be slow and the curve to bend after the Torah-sized corpus exists.

Suggester internationalization work regardless of seed: per-language stemmer strategy (or exact-match-only), disable the English lexicon fallback, generalize the object-marker rule's target string, RTL chip rendering. [INFERENCE — enumerated from the hardcodings verified in §2a]

## 4. The drafting question

GLT/GST are **translations of ULT/UST meaning**, not fresh translations from Hebrew/Greek — that is what makes them literal/simplified *gateway* texts mirroring the English pair. The realistic pipeline is therefore:

```
ULT (en) ──bp-assistant translate──► GLT draft (GL)  ──human review──►
GLT text ──LLM pre-align + human verify (AlignmentPanel)──► \zaln to UHB/UGNT ──► publish glt
```

(and identically UST → GST). The English is an *intermediate*: it never appears in the published alignment, which points at UHB/UGNT throughout. [INFERENCE — this mirrors how en_ULT itself relates to its sources, and matches the §1 contract]

The store already fits: `verses` rows are keyed `(book, chapter, verse, bible_version)` [VERIFIED api/migrations/0001_init.sql:85-96], so `GLT`/`GST` drafts are additional versions alongside `ULT`/`UST`/`UHB` panes; the SideBySideAligner's dual-target-one-source pattern [VERIFIED SideBySideAligner.tsx:44-50] is exactly the GLT+GST-against-UHB workflow. Drafting itself is the Phase 0 Translation Assistant contract applied to verse text instead of note text — same queue, same review-approve UX shape as Phase 2. One drafting bake-off is warranted: bp-assistant LLM vs. Serval MT vs. Aquilla, scored on a golden set of ~50 verses per register per language before committing. [PROPOSED]

## 5. Recommendation, triggers, dependencies, effort

**Recommendation: Option A — Bible Editor aligner + LLM pre-alignment, drafting via the bp-assistant translate pipeline — as the default plan, with two explicit re-evaluation gates before any Phase 6 code is written.** This is the FEASIBILITY §6 open question 5 answered provisionally: A is the only option where the fidelity-critical piece (lossless `\zaln` round-trip + human verification UI) already exists and is under our control.

**Decision points / triggers that would change the choice:**

| Trigger | Effect |
|---|---|
| Aquilla outreach answers: original-format USFM round-trip + protected content + API docs all confirmed [VERIFIED — questions at aquilla-outreach-email.md:13-23] | Adopt Aquilla as the *drafting* front-end (its per-cell UX is genuinely better [VERIFIED FEASIBILITY.md:55-56]); alignment stays in Bible Editor |
| Aquilla answers negative or absent by Phase 6 start | Drop Option B entirely |
| tC4 Phase 1 ships with a GL→OL alignment surface before Phase 6 starts | Run a 1-week spike comparing it against the Bible Editor aligner; switching is only justified if its fidelity ≥ ours |
| LLM pre-alignment golden-set accuracy < ~50% acceptable-as-drafted [PROPOSED threshold — calibrate against the English 61.7% suggestion baseline] | Fall back to suggestions-only mode (route 2/3 of §3); budget more human alignment hours |
| Serval beats bp-assistant on the drafting golden set | Swap the drafting engine; nothing else changes |

**People / staffing dependencies:** a GL lead translator team owning draft review and alignment verification per language (checking_level 3 is *their* attestation, not ours — the largest single dependency and outside tooling control); Benjamin's review bandwidth for the code phases; bp-assistant multi-tenancy resolved (FEASIBILITY §6 item 3) before a second language starts; 2 hand-aligned golden chapters per pilot language (GL team + one OL-competent checker).

**Effort (AI-paced coding, calendar scales with review bandwidth; all figures are informed judgment, not measurements):**

| Work item | Est. |
|---|---|
| Drafting pipeline (translate-verse skill + review UX reuse) | 1–2 wks |
| Aligner i18n (stemmer/lexicon/rules/RTL chips) | 1–2 wks |
| LLM pre-alignment skill + golden-set eval | 1–3 wks |
| Per-language trainer manifest + self-training loop | ~1 wk |
| Publisher: glt/gst manifests, checking_level, tc-ready + tC3 acceptance test | ~1 wk |

Total ≈ **5–9 weeks of build**, consistent with the 4–8 wk Phase 6 row plus its stated "highest uncertainty" [VERIFIED FEASIBILITY.md:130]. The build estimate excludes the dominant real cost: **human drafting-review and alignment-verification hours per book**, which no option on this list removes — tooling only changes the slope. A per-book throughput number does not exist yet and should be measured on the pilot's first book before promising any language a schedule.

## 6. Phasing statement

**This is Phase 6.** Nothing here starts until Phases 0–5 land (Translation Assistant, config layer, translate/review UX, publisher, tW/tA modules, UI i18n/RTL) [VERIFIED FEASIBILITY.md:122-130]. The only Phase-6 work permitted early is free: collecting the Aquilla answers, and hand-aligning the golden chapters whenever the pilot GL team has slack — both de-risk the decision without writing code.
