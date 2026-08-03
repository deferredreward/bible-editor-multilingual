# Design inputs — distilled from all existing mockup lineages

**Purpose:** one decision-ready reference for building the new adaptive
(desktop/tablet/mobile) UI flows, so nobody has to re-read four separate
mockup lineages + five research docs to start. This is a synthesis
document, not a new design — every recommendation below is traceable to a
specific file. Where the four lineages disagree, that disagreement is
described, not resolved; those calls belong to whoever owns the flow spec.

Sources read in full: `docs/mockups/desktop-first/*`, `docs/mockups/simple-mobile/*`,
`docs/mockups/aesthetic-minimal-notes.md/.html`, `docs/flexible-layouts-handoff.md`,
`docs/preferences-panel-design.md` §12, `docs/translation-preferences-research.md` §9,
`STATE.md` (Lessons learned), `docs/plan.md` (UI/aligner sections), `docs/i18n.md`.

---

## 1. Design tokens — proposed single set

Three of the four lineages already share one token system almost verbatim
(`docs/mockups/desktop-first/_design.css`, embedded identically in every
`translator-*.html`/`admin-*.html` in that folder). `simple-mobile/styles.css`
is a genuinely different, unrelated palette (warm paper background, teal
accent `#0b6e63`, Outfit/Source Serif fonts) built before the desktop-first
system existed. `aesthetic-minimal-notes.html` is parked (not building
toward implementation) and uses its own ad hoc inline styles.

**Recommendation: standardize on `docs/mockups/desktop-first/_design.css`'s
token set.** Reason: it's the only one built directly on the unfoldingWord
brand hexes, already has light/dark parity via both `prefers-color-scheme`
*and* an explicit `data-theme` override (needed because the app has its own
theme toggle — see brand colors instructed for this task), already covers
reduced-motion, and is reused unchanged across all 9 files in that lineage —
it's the most load-bearing, most-proven set of the four.

```css
--inspire: #31ADE3;   --inspire-deep: #1B84B8;
--ocean: #014263;
--tech: #231F20;
--cultivate: #70C9CC;
--kindle: #E59D33;

/* light */
--ground: #EDF3F6; --card: #FFFFFF; --card-2: #F3F8FA;
--ink: #1B2A32; --ink-2: #5B7280; --line: #D8E3E9;
--hl: rgba(49,173,227,.18);   /* quote/verse highlight */

/* dark (mirrored via both @media(prefers-color-scheme: dark) and [data-theme="dark"]) */
--ground: #0B1B23; --card: #13272F; --card-2: #0F2129;
--ink: #E3EDF2; --ink-2: #90A6B1; --line: #23404B;
--hl: rgba(49,173,227,.26);

/* semantic — separate from accent, same in both themes conceptually */
--ok / --ok-ink / --ok-soft       (approved)
--warn / --warn-ink / --warn-soft (needs attention)
--skip / --skip-soft              (not needed / skipped)

--font-ui: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
--font-scripture: "Iowan Old Style", Charter, "Palatino Linotype", Georgia, serif;
```

One gap to close before adopting: this token set has no explicit mapping
for `--kindle` as an accent beyond the admin avatar (`.avatar.alt2`) — the
brand's fifth color ("sparingly") needs a defined single use (e.g. a
"needs attention"/nudge accent) so it doesn't get reinvented ad hoc per
screen.

**Breakpoints — recommend 560 / 820 / 900**, one-line reason: these are
`desktop-first/_design.css`'s own breakpoints (`.grid-2`/`.pair` collapse at
560, `.grid-2`/`.desk-shell` collapse at 820/900) and they already gate the
system's own admin two-column → one-column and sidebar-rail → horizontal-scroll
transforms, so adopting them costs nothing new. The other two lineages
disagree (`simple-mobile`: 800/900; `aesthetic-minimal-notes`: 820, "intended
600/1100") but neither has more than one working collapse point wired to
real components — desktop-first is the only lineage with breakpoints doing
real structural work (rail-to-tabs, grid-to-stack) rather than just phone-vs-desktop.

---

## 2. Per-lineage keep / drop

### `docs/mockups/desktop-first/` (9 screens + `_design.css`)
- **Keep:** the token system (§1). The `.panel` (top/body/foot chrome, foot
  always states live-state-left / next-action-right) — used consistently
  across every admin screen, a solid convention worth carrying forward
  verbatim. The `.steps`/`.step` rail (phone verse-bundle progress chips)
  and the `.stepline`/`.steptile` desktop equivalent (admin-workflow.html) —
  same status-dot vocabulary (draft/approved/edited/skipped) reused at two
  form factors. The lane vocabulary (`.lane-tag`, "ULT → GLT" / "UST → GST")
  — see §6.
- **Drop / weak:** almost no written rationale — these are polished
  artifacts with no decision record (no README, no verdict log like the
  other two lineages have). Treat as *how it should look*, not *why*.
  The admin-workflow.html "8 fixed steps" model is a concrete, opinionated
  product decision baked into a mockup with no discussion trail — see §4.

### `docs/mockups/simple-mobile/`
- **Keep:** the "one job per screen" queue framing (t1→t2/t3/t4, see §3) and
  the resource-type-queue home screen (`t1-home.html`) as *evidence*, even
  if the visual system is dropped. `t4-scripture.html` (ULT→GLT / UST→GST
  lane pair on one focused verse, no tab bar) is explicitly called out as
  "the newest" and the best resolution of the scripture-lane-pair problem in
  this lineage.
- **Drop:** the whole visual system (`styles.css`) — superseded by
  desktop-first's token set (§1). Its Render-inspired admin workflow
  (`a1-workflow.html`) is drag-and-drop stage configuration — see §4 for the
  concrete tradeoff vs. desktop-first's fixed-8-step model.
- **Recorded, unresolved verdict (README, 2026-07-30):** `t3-article.html`'s
  three-tab (Questions / Key terms / Articles) layout is **flagged as too
  busy** — confirmed in the file itself: a `.tabs` bar with 3 `<button
  class="tab">` switching one `#view` region, tabbing across three distinct
  content types on one phone screen. README's own next step: split into
  three focused, tab-free screens, entered from `t1-home.html`, keeping the
  source/target/AI/approve pattern. **This is a live, unresolved TODO — not
  yet re-designed anywhere.**

### `docs/mockups/aesthetic-minimal-notes.md` + `.html`
- **Status: parked, no implementation planned yet** — the doc says so
  explicitly twice.
- **Recorded verdicts (2026-07-30):**
  - **Focus Theater → mobile, "keep exploring."** One note is the job;
    scripture is a quiet reference strip; Save + Approve are the only
    primary CTAs.
  - **Translation Desk → tablet, "keep exploring."** Familiar 3-zone shape
    but inverted emphasis from Classic: notes are the hero (~55%), scripture
    is a tool (~35%), inactive notes collapse to quote + one-line draft.
  - **Prose Continuum → parked, not chosen** for the next pass (manuscript /
    left-border state, tools only on the open note); revisit only if desktop
    reading-first is revisited.
- **Keep as design pressure, not as pixels:** the NN/g "aesthetic and
  minimalist design" heuristic applied against a named list of current
  clutter — TopBar density, ResourceColumn tabs, Notes "translation mode" /
  progress strip, NoteCard's header-chip cluster + Preserve/Hint/TCM/SH
  footer. That clutter inventory is itself a useful backlog for what the new
  flows should visibly simplify.
- **Protect regardless of visual direction:** verse/note navigation,
  quote↔scripture highlight link, source+draft editing, explicit Save/Approve
  (notes save only on Save click — drafts persist in IndexedDB regardless of
  UI skin; this is a hard app invariant, not a mockup detail).

### `docs/flexible-layouts.html` (the only lineage that shipped)
- **Keep:** the panel-decomposition idea (standalone notes/words/questions/
  scripture/original-language panels with clean props) is the foundation
  *every* other flexible-layout feature depends on, and it is explicitly
  the recommended first move for whoever picks this back up. The
  hide/restore-region design (render-time filter over the persisted tree,
  never a tree edit) is a proven, tested pattern worth reusing in any new
  adaptive shell that lets users hide chrome.
- **Drop / not there yet:** movable/reorderable panels, the Flexible ·
  Columns/Nested layouts, side-by-side source→target notes, and simpler
  review-oriented scripture panes are all **designed but not built** — the
  shipped code only rearranges the existing monolithic components behind a
  layout picker. Don't assume any of this lineage's promised richness exists
  in the app today.
- **Hard invariant to respect in any new flow work:** `builtin:classic` must
  stay byte-identical to today's Shell.

---

## 3. Navigation model comparison — verse-shaped vs. resource-first split vs. queue-shaped

Three distinct mental models exist across the lineages, described here
without a recommendation (per the task — the orchestrator decides):

**A. Verse-shaped, all-resources-together**
(`desktop-first/translator-verse.html`, "Finish This Verse — Titus 1:4.")
One verse is the unit of work. A horizontal `.steps` rail lists every
resource item touching that verse (ULT→GLT, UST→GST, a Note, a Question, a
Key Term) as chips with status dots; the user works through all of them for
one verse, then the whole phone flips to a "verse is done" completion screen
with a "Next verse" CTA. Evidence: `STEPS` array in the script mixes
`type: "literal"|"simplified"|"note"|"question"|"keyterm"` in one ordered
list, one card at a time, one shared action bar (Redraft / Not needed /
Approve) whose behavior branches on the current item's type.
- Tradeoff: strong "finish this verse and move on" closure/momentum: the
  translator never context-switches which *skill* they're using mid-verse
  is not a cost here because everything about one verse is front and center.
  Cost: no batch consistency across verses for one resource type (e.g. can't
  approve 20 Key Terms in a row).

**B. Resource-first split**
(`desktop-first/translator-notes.html`, `translator-scripture.html`,
`translator-words.html`, `translator-questions.html` — four separate
screens, one per resource type; also `simple-mobile/t2-note.html`/
`t4-scripture.html`.) The unit of work is one resource type across many
verses/rows — "Translate Notes," "card-at-a-time review" per
`translator-notes.html`'s own page comment. Evidence: each screen has its
own dedicated CSS section (`Page-specific: Translate Notes (card-at-a-time
review)`, `Page-specific: Scripture (ULT/UST → GLT/GST, lane-at-a-time)`)
and its own independent queue/progress state — no shared cross-resource step
rail.
- Tradeoff: strong batch consistency (a translator doing all the Key Terms
  builds a consistent voice for that resource type across the whole book);
  strong "flow state" for one skill. Cost: a verse's context is scattered —
  by the time Notes, Questions, and Key Terms for the same verse are all
  done, the translator has re-visited that verse three separate times in
  three separate sessions.

**C. Queue-shaped (home-as-dispatcher)**
(`simple-mobile/t1-home.html`.) Neither verse-first nor resource-first is
the *entry point* — the entry point is a dashboard of five independent
queues (Scripture text: 214 verses, Translation notes: 42 left, Questions:
18 left, Key terms: 9 left, Articles: 6 left), each with its own count and
one-line description, and the user picks a queue to enter. Evidence: `t1-home.html`'s
`.choice` buttons deep-link straight into resource-first screens
(`t4-scripture.html`, `t2-note.html`, `t3-article.html#questions` etc.) —
so queue-shaped is really a *dispatcher* sitting in front of model B, not a
third work-unit shape in its own right. It does not currently dispatch into
anything verse-shaped (model A) — no mockup wires t1-home into
translator-verse.html.
- Tradeoff: gives translators an explicit choice of what kind of work
  session they want to have (a home screen render of "how much is left," a
  real motivator per the README's Steve-Jobs/iPhone framing) — but as built
  it's coupled to model B, not model A; combining a dispatcher home screen
  with a verse-shaped work unit is an open combination nobody has mocked up.

---

## 4. Admin workflow model comparison — fixed 8 steps vs. Render-style configurable rail

**A. Fixed, opinionated 8-step model**
(`desktop-first/admin-workflow.html`.) The step sequence itself — Draft,
Peer check, Source check, Align, Translate resources, Harmonize, Final
validation, Publish — is **hardcoded** (`STEP_NAMES` array); what's
configurable per step is orthogonal metadata: which content types it
applies to (Literal/Simplified/Notes/Word links/Questions/Articles via
toggleable chips), whether it blocks the next step, whether AI drafts it
automatically, and which translator pair is assigned. The screen is
explicit that no community-check step exists here on purpose ("that happens
downstream... That absence is a decision, not an oversight") and that a
book isn't done until every tW/tA article it references is also
translated. Includes a working "AI pipeline" jobs table (Draft/Align/
Push/Batch per chapter, with retry-on-failure) and a "Scripture source"
replacement lifecycle (reserved→staging→ready→completed) as sibling panels
in the same rail-navigated shell.
- Tradeoff: the step *names and order* are trustworthy and specific to this
  project's real content-editing pipeline (book-package granularity, tN/tW/
  tQ awareness baked in) — but there is zero UI for adding/removing/
  reordering steps; a project wanting a different pipeline shape has no
  affordance here.

**B. Render-style configurable rail**
(`simple-mobile/a1-workflow.html`, explicitly modeled on Render's workflow
config UI per the README.) Two stages are locked at the ends (Draft,
Consultant Approval); everything between (Peer Check, Community Test,
Consultant Check) is drag-and-drop: draggable tiles reorder via native HTML5
DnD, a palette below holds unused optional stages that get dragged onto the
rail, and per-stage "Settings" open a toggle panel (e.g. Peer Check: "Same-
language peers only," "Blind to translator name"). No AI-pipeline table, no
scripture-source lifecycle — purely the stage-sequence editor.
- Tradeoff: generic and flexible — any project could shape its own approval
  chain — but shallower: only 5 possible stages total, no book/content-type
  granularity, no notion of AI automation or scripture-source swaps, and (per
  the org's own recorded lesson on synthetic drag events) native HTML5 DnD
  reordering has known hit-testing/overlay pitfalls worth testing carefully
  if carried forward.

These two aren't really substitutable pieces — A is "configure the *existing*
fixed pipeline's per-step rules + operational panels (AI jobs, source
lifecycle)," B is "let the org *design* its own pipeline shape." Whether the
real product needs both, one, or a hybrid (fixed backbone + optional
insertable checks, which is closer to B's UI wrapped around A's step
semantics) is a product call, not resolved by either mockup.

---

## 5. i18n + RTL constraints for new chrome

From `docs/i18n.md`:
- All UI chrome (buttons, tooltips, dialogs, toasts, banners) goes through
  `i18next` + `react-i18next`; scripture/project content is data, not UI
  strings — new flow chrome must add keys to `web/src/i18n/locales/en.json`
  (source of truth) under a namespace, not hardcode strings.
- Existing namespaces already include `lanes` — i.e. lane-related chrome
  copy already has a home; a new flow's "ULT→GLT / UST→GST" style copy
  should extend that namespace, not invent a new one.
- **Preserve `{{var}}` interpolation placeholders exactly**, and **never
  translate Latin resource tokens** (`ULT`, `UST`, `UHB`, `UGNT`, `Door43`,
  `DCS`, `TW`, `TN`, `TQ`, `TWL`, key hints like `Ctrl+F`) — these are proper
  nouns/shortcuts. Any renamed jargon (§6) that becomes new UI copy inherits
  this same rule for whatever Latin tokens survive a rename.
- **Plurals must supply the right CLDR category set per language**, not just
  `_one`/`_other` — e.g. Arabic needs all six categories, Russian needs
  one/few/many/other, and Farsi/Urdu (despite Arabic script) only ever need
  one/other. New flow copy with counts ("N left", "N of 5 done" — both
  patterns already used in the mockups) must go through this, not a
  hand-rolled plural check.
- Run `node scripts/check-i18n.mjs` before considering any new locale/key
  set complete; it fails CI on missing keys, missing plural categories, or
  stale keys.
- **RTL is a known trap** (`STATE.md` Lessons learned + org memory): MUI's
  stylis RTL plugin flips `sx={{ direction: 'rtl' }}` in ways that break
  Arabic UI. The fix already applied elsewhere in this codebase is **use the
  `dir` attribute + `textAlign: 'start'`, never `sx` `direction: 'rtl'`**.
  Any new adaptive-flow component with directional layout must follow this
  same rule from the start, not rediscover the bug. Font choice for RTL
  scripture panes is also flagged as provisional (Source Serif Pro lacks
  Arabic glyphs, currently falls back to Cambria/Times) — a "good enough for
  now, revisit if native speakers flag it" state, not a solved problem.

---

## 6. Jargon / renaming candidates and existing glossary

- **GLT/GST vs. ULT/UST vs. "literal"/"simplified":** all four lineages
  already converge on the same paired vocabulary — **ULT is the English
  literal source, GLT is the translated-literal target; UST is the English
  simplified source, GST is the translated-simplified target.** This is
  rendered consistently as `"ULT → GLT"` / `"UST → GST"` lane-tag chips
  across `desktop-first/_design.css` (`.lane-tag`), `translator-verse.html`,
  `translator-scripture.html`, and `simple-mobile/t4-scripture.html`. This
  is the most stable piece of jargon in the whole corpus — treat it as
  settled, not a renaming candidate, but it **is** jargon that needs a
  first-use tooltip/glossary entry for new users (nowhere in the mockups is
  GLT/GST spelled out on-screen for someone unfamiliar with the acronyms).
- **"Lanes"** is already a live i18n namespace (`docs/i18n.md`) and a CSS
  concept (`.lane`, `.lane-tag`, `.lane-arrow`) — not a mockup-only
  invention; safe to keep using in the new flows' vocabulary.
- **Template rail group headers:** not directly evidenced in the mockups
  read for this task (they live in `TemplateWorkspace`/production code per
  `CLAUDE.md`'s note on note templates) — flagging as **outside the
  evidence this pass covered**; if the new flows touch template rails, that
  needs its own look at `web/src/components/TemplateWorkspace.tsx` rather
  than being asserted here.
- **"AI menu mixing three mental models"** — I could not find a single
  literal "AI menu" widget that conflates three usage modes in the code
  skimmed for this task (`NoteCard.tsx`'s "AI" element is a passive
  provenance `Chip`, not a menu). What *is* evidenced, from
  `aesthetic-minimal-notes.md`'s clutter inventory, is that the current
  NoteCard bundles: (a) AI generation actions (redraft/regenerate), (b)
  manual edit affordances, and (c) approval-workflow state (Preserve/Hint/
  TCM/SH footer chips) all in one card's chrome — which is plausibly the
  "three mental models" the task description is pointing at, but I'm
  stating this as an inference from the clutter list, not a verified
  single-menu finding. **Confidence: low on the specific "menu" framing,
  moderate on the underlying clutter claim** — worth a targeted look at
  `NoteCard.tsx`'s action-button cluster before the new flows design commits
  to a specific fix.

---

## 7. Accessibility / reduced-motion / dark-mode patterns worth preserving

All from `docs/mockups/desktop-first/_design.css`, proven across 9 files:
- `@media (prefers-reduced-motion: reduce) { *, *::before, *::after {
  animation: none !important; transition: none !important; } }` — a single
  blanket rule, not per-component opt-outs. Simple and worth keeping as-is.
- `:focus-visible { outline: 2px solid var(--inspire); outline-offset: 2px;
  }` — one universal focus ring tied to the brand accent, not per-widget.
- Dark mode is supported **two ways simultaneously and consistently**:
  `@media (prefers-color-scheme: dark)` (system preference) *and*
  `:root[data-theme="dark"]`/`[data-theme="light"]` (explicit app-level
  toggle override) — every themed value (ref color, note-body bold color,
  eyebrow color, button color) is set three times (default/media/attribute)
  to keep both mechanisms in sync. Any new component must follow this same
  triple-declaration pattern or it'll silently ignore the in-app theme
  toggle while still responding to OS-level dark mode (or vice versa).
- Status/semantic colors (`--ok`, `--warn`, `--skip`) are declared
  **separate from the brand accent** (`--inspire`) specifically so
  approve/warn/skip states don't collide visually with interactive/brand
  accents — worth preserving as a rule, not just as specific hex values.
- `aria-current="true"`, `aria-pressed`, `aria-checked`, `role="switch"`,
  `role="list"`/`role="listitem"` are used correctly and consistently for
  the rail nav, segmented controls, toggle switches, and step tiles — a
  real (if unstated) accessibility baseline already established across the
  desktop-first lineage, worth keeping as the bar for new components.

---

## Executive summary (for the orchestrator)

**Tokens/breakpoints:** adopt `desktop-first/_design.css` wholesale (brand
hexes already mapped, light+dark via both media-query and `data-theme`,
reduced-motion handled) with breakpoints 560/820/900 — it's the only
lineage with breakpoints doing real structural work, not just phone-vs-desktop.

**Top 5 keeps:**
1. `desktop-first`'s token system + `.panel` (top/body/foot, foot=state-left/
   action-right) admin chrome pattern — proven across 9 files.
2. `t4-scripture.html`'s ULT→GLT/UST→GST paired-lane, no-tab-bar verse
   screen — the best-resolved take on the scripture-lane problem.
3. Flexible-layouts' panel-decomposition architecture (standalone notes/
   words/questions/scripture panels) — foundational, explicitly the
   recommended next build step, `builtin:classic` must stay byte-identical.
4. Flexible-layouts' hide/restore-region pattern (render-time filter, never
   a tree edit) — tested, reusable for any new adaptive chrome-hiding.
5. Aesthetic-minimal-notes' verdicts as target-form-factor evidence: Focus
   Theater → mobile, Translation Desk → tablet (notes as hero, ~55/35 split)
   — both "keep exploring," not yet built.

**Top 3 drops:**
1. `simple-mobile/styles.css`'s entire visual system (teal/paper palette,
   Outfit/Source Serif) — superseded by the brand token set.
2. `t3-article.html`'s three-tab busy layout — README already flags this as
   unresolved and recommends splitting into three focused screens.
3. Aesthetic-minimal-notes' "Prose Continuum" concept — explicitly parked,
   not chosen for the next pass.

**Verse-vs-queue, sharpest evidence each side:** Verse-shaped
(`translator-verse.html`) delivers one shared step-rail + one action bar
spanning literal/simplified/note/question/key-term for a single verse, with
an explicit "verse is done" completion screen and Next-verse CTA — strong
per-verse closure, no built path for batch-consistency across many verses
of one resource type. Queue/resource-first (`t1-home.html` → `t2-note.html`/
`t4-scripture.html`/`t3-article.html`) dispatches from a per-resource-type
count dashboard (214 verses / 42 notes / 18 questions / 9 terms / 6
articles) into single-resource "card-at-a-time" queues — strong batch
consistency and flow, but a verse's notes/questions/terms get visited in
three separate sessions, and no mockup currently combines the queue
dispatcher with the verse-shaped work unit.

**Admin-workflow, sharpest evidence each side:** the fixed-8-step model
(`admin-workflow.html`) hardcodes step names/order but makes per-step
content-type applicability, blocking, AI-auto-draft, and pair-assignment
configurable, plus ships real operational panels (AI pipeline job table
with retry, scripture-source swap lifecycle) — deep but not
reshapeable. The Render-style rail (`a1-workflow.html`) makes the stage
*sequence itself* drag-and-drop configurable (locked Draft/Consultant-
Approval ends, optional stages draggable from a palette) but has no
content-type/book granularity and no operational panels — flexible but
shallow, and its native HTML5 DnD carries a known hit-testing risk flagged
in org memory.
