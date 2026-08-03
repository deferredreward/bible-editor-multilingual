# 03 — Coverage audit: drafted UI-flow mockups vs. the inventories

Purpose: prove "nothing left out" for the 12 screens in `docs/flows/ui/`, or list exactly
what is. Three audits per the brief: (1) handle validity — scriptable, every
`data-handle` extracted and checked against `00b-api-inventory.md`; (2) action coverage —
manual walk of every bundle A–K action in `00-code-inventory.md` against the 12 screens;
(3) endpoint reverse pass — every UI-facing endpoint in 00b's flat table checked for a
call site or a justified absence.

Severity legend: **INVENTED** (fabricated handle — highest severity) · **MISS** (real
action/endpoint, not covered, no in-artifact justification found) · **NEAR-MISS**
(covered but with a convention deviation) · **DELIBERATE** (covered by omission, with a
recorded reason found in the artifacts or the architecture spec) · **OK** (covered).

Method note up front: for six items the audit brief said were "flagged as deliberately
omitted" in the builders' own reports (book-lint indicator, lane-replacement full job
polling, QA-rules CRUD, `/api/l10n/*`, templates/sync + note-templates source proxy,
NoteCard sparkles on t2), I could only find an explicit in-artifact justification for
two of them (QA rules; the NoteCard-sparkles claim, which is simply true). The other
four are real, confirmed omissions with **no comment, README, or commit-message note
anywhere in this repo** acknowledging them as intentional — I looked at the single
commit that added all 12 screens (`7da6a48`), `01-design-inputs.md`, and
`02-architecture.md`, and none of the three mentions them. I've labeled those four
**MISS** rather than **DELIBERATE** below, and said so explicitly at each one — an
unverified "it was deliberate" claim would be exactly the kind of ungrounded assertion
the evidence-first rule exists to prevent. If a builder report exists outside this
repo, it should be linked into the architecture doc so this audit (and the next one)
can verify it directly.

---

## Audit 1 — Handle validity

**Method:** `grep -ohE 'data-handle="[^"]*"' docs/flows/ui/*.html`, deduplicated, each
real (`METHOD /path`) value checked against 00b's flat endpoint table (110 rows). Header
check: every PATCH/PUT/DELETE endpoint 00b documents as requiring `If-Match` (and, for
ULT/UST verse saves, `X-Source-Generation`) was checked for a matching `data-headers`
attribute at every call site, not just once per file.

**Result: 61 distinct real `data-handle` values across the 12 screens, plus 10 distinct
`local:*` values and 1 `TODO:no-backend` value. Zero are invented — every real value
matches a confirmed route in 00b.** No missing-header defects found.

| # | Finding | Severity |
|---|---|---|
| 1 | All 61 distinct `METHOD /path` handle values (spanning ~55 of the 110 cataloged endpoints once dynamic tn/tq and tw/ta swaps are counted once each) resolve to a route that exists in 00b-api-inventory.md's flat table. Full list cross-checked line-by-line; none fabricated. | **OK** |
| 2 | Every occurrence of a header-bearing endpoint carries the right `data-headers`: `PATCH /api/rows/tn/:id` → `If-Match` (5/5 occurrences in t2-review.html, plus the history-dialog "Switch to vN" and the 409-dialog "Keep mine" button); `PATCH /api/verses/.../:bibleVersion` (and its ULT/UST literal variants) → `If-Match, X-Source-Generation` (7/7 occurrences across t3-scripture.html and t4-align.html, including the verse-history "Restore vN" buttons and the side-by-side "Save line" buttons); `PATCH /api/articles/:resource/unit` → `If-Match` (t5-articles.html); `PATCH /api/templates/unit` → `If-Match` (l3-templates.html); `PUT /api/translation-memory/prefs` → `If-Match` (2/2, l2-style.html); `PATCH /api/translation-memory/terms/:id` → `If-Match` (3/3, l2-style.html). Zero omissions found. | **OK** |
| 3 | `t3-scripture.html` (chapter-board per-cell checkbox, ~line 278) builds its `data-handle` by JS string concatenation: `"PATCH /api/chapters/:book/:chapter/:verse/lanes/' + lane + '"`. A naive `grep -oh` reports this as a single malformed literal path (it did, in my first pass). Reading the surrounding script shows `lane` is substituted with a real value (`text`/`tn`/`tw`/`tq`) at render time, so at runtime this resolves to exactly `PATCH /api/chapters/:book/:chapter/:verse/lanes/:lane`, a real route. Not a defect — flagged only so a future mechanical-only pass doesn't misreport it as invented. | **OK** (methodological note, not a defect) |
| 4 | `t3-scripture.html` (2 instances) and `t4-align.html` (3 instances, across the main canvas Save button and both side-by-side "Save line" buttons) hardcode the literal bible-version value into the path — `PATCH /api/verses/:book/:chapter/:verse/ULT` / `.../UST` — instead of using the `:bibleVersion` placeholder the 02-architecture.md convention and 00b's own route use. The endpoint is real and the header set is correct in every instance; this is a naming-convention deviation, not a wrong or fake endpoint. (Contrast: the verse-history dialog's own two "Restore vN" buttons in the same t3-scripture.html correctly use `:bibleVersion`, so the file is inconsistent with itself, not just with the convention.) | **NEAR-MISS** |
| 5 | `PATCH /api/project-config/lanes/:lane` (a1-setup.html, Step 4's 409-revert demo) carries no `data-headers` at all. Checked against 00b: this endpoint's concurrency guard is a body field (`configRevision`, checked server-side against `409 config_revision_mismatch`), not an HTTP header — so there is nothing for `data-headers` to name here under the documented convention (which only calls out `If-Match`/`X-Source-Generation`). Not a defect, but worth noting the convention has no way to surface body-level CAS tokens the way it surfaces header-level ones. | **OK** (convention gap, not a screen defect) |

---

## Audit 2 — Action coverage (bundle-by-bundle walk)

Each row is one action or action-cluster from 00-code-inventory.md §A–K. "Screen(s)"
names where it's covered (including reasonable redesign-equivalents); MISS rows have no
covering screen.

### Bundle A — Stand up an org
| Action | Screen(s) | Severity |
|---|---|---|
| A.1 Org identity, resource-language, retry-detection | a1-setup.html Step 1 | OK |
| A.2 Upstream sources per resource, verify-on-blur, retry, blocking Alert | a1-setup.html Step 2 | OK |
| A.3 Lane target/edit-align/upstream toggles | a1-setup.html Step 3 | OK |
| A.4 SourceOverrideField (verify states) | a1-setup.html (Steps 2/3), a2-import.html (per-book override add) | OK |
| A.5 Review & Apply, 409 `lane_source_change_requires_migration` + revert | a1-setup.html Step 4 | OK |
| A.6 Done step, exits to Import/editor/team | a1-setup.html Step 5 | OK |
| GET `/api/orgs/search` (org-name autocomplete) | none | **MISS** — low severity; 00-code-inventory itself marks this route `[INFERRED]` (no confirmed UI call site in the real app either), so its absence here may simply mirror an already-unused route. |
| A.7 LaneCard "Change source" full flow: validate → affected-books dialog → per-book replace/keep/waive/retry → Activate → Back-out, with job polling | none — only the Apply-time 409 revert-lane button in a1-setup.html Step 4 touches `PATCH /lanes/:lane` | **MISS** — this is the "lane-replacement full job polling" item the brief said was recorded as deliberate; I found no in-repo note saying so (see Method note above). 8 of 9 scripture-lane-admin endpoints (`validate`, `affected-books`, `replacements`, `replacements/:jobId`, `retry-book`, `waive-book`, `activate`, `cancel`, `back-out`) have zero call sites across all 12 screens. |
| A.8 Users: add/edit/delete role, roster reconciliation, purge-manual | a3-team.html | OK |
| Unmapped: Workspace switching (`WorkspaceSwitcher`/`WorkspaceChoiceDialog`) | t1–t5 account menus, a1-setup.html (preview dialog), a3-team.html | OK |
| Unmapped: Localization editor + LocalizationInspector (`/api/l10n/*`) | none | **MISS**, but arguably out-of-scope-by-spec: 02-architecture.md's screen table never assigns this surface to any of the 12 screens, and 00-code-inventory.md itself buckets it under "Unmapped" (not part of the A–K taxonomy the screens were built against). I'm calling it MISS rather than DELIBERATE because no artifact says so explicitly — but it's the one where "out of scope by omission from the spec" is the most plausible reading. |
| Unmapped: LogosSyncToggle, SearchPanel (external iframe tool) | none | **OK** (out of scope) — both are explicitly called out in 00-code-inventory as zero-server-interaction personal-convenience/external-tool surfaces, not content workflows; reasonable to exclude from an adaptive-flow rebuild. |

### Bundle B — Bring in a book
| Action | Screen(s) | Severity |
|---|---|---|
| B.1 Book rail, search, imported/not-imported chips, retry on failed list | a2-import.html | OK |
| B.2 Intent toggle, primary action (Import/Open/Re-pull), book-level AI Translate | a2-import.html | OK |
| B.3 Re-pull dialog (chapter range, 5 resource checkboxes) | a2-import.html | OK |
| B.4 Source overrides: read (any role), add (admin, DCS+Aquifer) | a2-import.html | OK |
| B.4 Source overrides: **Remove** button per override | none | **MISS** — a2-import.html's advanced accordion only shows a static read-only list plus an "Add override" form; there is no per-row Remove control, though `PUT .../sources {clear:true}` is a real, distinct action in the inventory. |
| B.5 AI menu's Import/Pull entries (cross-ref D) | l1-ai.html | OK |
| K.7 `GET /api/books/:book/lint` (BookLintIndicator) | none | **MISS** — see Method note; no artifact acknowledges this omission. |

### Bundle C — Teach the AI our style
| Action | Screen(s) | Severity |
|---|---|---|
| C.0 Rail, Org switcher, ContextPackStatusControls (Export now / force) | l2-style.html | OK |
| C.1 Brief (fields + Save + 409-keeps-edits) | l2-style.html | OK |
| C.2 Instructions / Common issues (char caps, Preview, Save) | l2-style.html | OK |
| C.3 Terminology (search/filter, import CSV dry-run+apply, export, add term/rendering, edit, delete, 409 `duplicate_term`) | l2-style.html | OK |
| C.4 Examples (resource toggle, search, Revoke) | l2-style.html | OK |
| C.5 / Unmapped: Localization editor (admin UI-chrome i18n) | none | see Bundle A row above — same finding, not re-counted |
| QA rules (structural tN checks config UI) | l2-style.html, explicitly `data-handle="TODO:no-backend"` with an in-panel caption: *"Design-complete, build-deferred… No API for this section exists yet."* | **DELIBERATE** — the one item on the brief's list with a direct, verifiable in-file citation. |
| `POST /api/templates/sync` (admin manual English-sheet resync) | none | **MISS**, low severity — 00-code-inventory itself marks this `[INFERRED]` with "no UI call site traced" even in the real app, so this may not be a real gap so much as an already-orphaned route. |
| `GET /api/note-templates` (English source proxy) used *within the template-curation tool itself* | not on l3-templates.html (it shows a static "Source (English, read-only)" block with no handle); it *is* used elsewhere, on t2-review.html's NoteCard TEMPLATE button | **NEAR-MISS** — the underlying action (browsing curated English templates) is covered on a different screen (t2), just not wired with an explicit handle where 00-code-inventory's I.2 describes it (inside the template editor's own source panel). |
| `GET /api/translation-memory/terms/count`, `GET /api/exports`, `GET /api/exports/resources`, `GET /api/translation-memory/export-status` | shown only as static caption text ("Loaded via `GET ...`"), never as an actual `data-handle` on an interactive control | **NEAR-MISS** (×4) — the endpoint is *named* on-screen (so a reviewer can see it's accounted for), but per the stated convention only actionable controls carry `data-handle`; these are passive reads with no control to attach one to, which is a reasonable simplification, not an omission of the underlying capability. |

### Bundle D — Bulk draft a chapter (AI menu pipelines)
| Action | Screen(s) | Severity |
|---|---|---|
| D.1 Menu: 3 base pipelines + 2 translate-mode items, correctly *not* a 6th chain-macro item (matches the inventory's own finding that it's unwired) | l1-ai.html | OK |
| D.1 Import-from-Door43 / Pull-Aquifer / Re-source-from-English menu items | l1-ai.html | OK |
| D.2 Start-confirmation dialog (range, generate checkboxes, 409 "Already running" dialog with no take-over) | l1-ai.html | OK |
| D.4 NoteCard one-shot "Suggest" (`POST /api/tn-quick`) | t2-review.html (button labeled "✨ Suggest") | **OK — verified present**, confirming the brief's specific claim. |
| D.5 Template one-shot + bulk "Draft all with AI" | l3-templates.html | OK |
| D.6 Book-level AI Translate | a2-import.html | OK |
| D.7 Queue plumbing: single global bot slot, priority order, "while you were away" toast + dismiss | l1-ai.html | OK |
| K.1/K.2 friendly copy for all 9 `PipelineErrorKind` values incl. `interrupted`, chapter-lock banner, "drafts ready" banner, stage-bar per pipeline type, foreign-job read-only, Cancel/Retry/Dismiss, AI-not-configured empty state (job-status reads gated too) | l1-ai.html | OK — this is the most thoroughly covered bundle in the whole set. |
| `GET /api/twl-suggestions/...`, `GET /api/twl-filters/:book` (TwlSuggestions panel) | none | **MISS** — see Bundle F.4 finding below; tied to the same underlying gap. |

### Bundle E — Review & approve drafts
| Action | Screen(s) | Severity |
|---|---|---|
| E.1/E.3 Approve-all (notes, questions) | t2-review.html | OK |
| E.2/E.4 Per-card Approve/Unapprove | t2-review.html | OK |
| E.5 TWL has no approve lifecycle | t2-review.html renders word-links read-only in the context panel with an explicit caption: "Word links have no approve lifecycle — shown here for reference only." | **OK** — this exactly matches 02-architecture.md's own instruction ("render word-links read-only in queue context, note the gap"). |
| E.6 Examples "Revoke" | l2-style.html | OK |

### Bundle F — Author or repair one note
| Action | Screen(s) | Severity |
|---|---|---|
| F.1 Save / Approve / Suggest / Template / Preserve / Hint / Trash | t2-review.html | OK |
| F.1 **Restore** (only-when-trashed icon, `POST /api/rows/tn/:id/restore`) | none | **MISS** — confirmed by grep: the string "restore" (case-insensitive) does not appear anywhere across all 12 screens. No trashed-state demo exists to hang it on either. |
| F.1 **Undo** icon (revert to last-saved) | none on t2-review.html (present as a real, working control on t3-scripture.html/t4-align.html, but for verse text, not for notes) | **MISS** for the note-specific Undo; the *concept* is demonstrated elsewhere. |
| F.1 "+" insert-after, drag-grip reorder, reference-chip retarget/bridge-span menu, AI-provenance chip | none | **MISS** (×4, low-to-moderate severity — these are secondary NoteCard chrome, not the primary save/approve loop) |
| F.2 NoteHistoryDialog (version list, snapshot/diff, "Switch to vN" routes through Save) | t2-review.html | OK |
| F.3 QuestionCard (translation-mode) | t2-review.html (unified queue swaps kind) | OK |
| F.3 QuestionsTable (English-authoring / non-translation-mode dense grid, editable Ref field) | none | **MISS** — the Mode toggle exists (t1/l1/l2 etc.) but no screen actually re-renders as the distinct authoring-mode QuestionsTable grid; toggling Mode on t2-review.html has no visible effect on its layout. |
| F.4 WordsTable (per-row quote/occurrence, TW-article picker + disambiguation, Locate, kill-switched manual reorder) | none | **MISS** — no screen provides a TWL editing surface at all; TWL only appears as read-only display (E.5) or as an import-time resource checkbox. |
| F.4 QuoteBuilderPopper (click/shift-click source words, toggle alignment-ancestor chips, live preview) | t2-review.html has a "Build from source" button, but it only fires a static toast — *"Quote builder — click source words to select a run (local only)"* — not the actual word-selection interaction | **NEAR-MISS** — the entry point exists and is correctly labeled `local:*` (no fake backend call), but the interactive behavior itself isn't modeled, unlike the alignment canvas in t4-align.html which does show real (if static) card/word affordances. |
| F.4 TwlSuggestions (Add / Reject / read-article, deny-list filtering) | none | **MISS** — same underlying gap as the D/TWL-suggestions row above. |

### Bundle G — Edit literal/simplified scripture text
| Action | Screen(s) | Severity |
|---|---|---|
| G.1 Rows-mode text edit, paragraph-marker toolbar, Save/Undo, verse status, verse history+restore | t3-scripture.html | OK |
| G.2/G.3 Columns mode / Book mode as *distinct* rendering modes | not distinctly modeled — t3-scripture.html is a single paired-lane (ULT→GLT / UST→GST) view | **DELIBERATE** — this matches 02-architecture.md Decision D1 ("one model, three renderings" collapses rows/columns/book into the queue-vs-verse-context model) and 01-design-inputs.md's explicit recommendation to keep `t4-scripture.html`'s no-tab-bar paired-lane view as "the best-resolved take on the scripture-lane problem." A real, cited design decision, not an oversight. |
| K.3 ChapterBoard (verse×lane grid, per-cell + bulk check-all, progress footer) | t3-scripture.html | OK |
| G.4 Find/Replace overlay (regex/case/Strong's, Bible+TN scope, replace / replace-all with blast-radius confirm) | none | **MISS** — confirmed by grep across all 12 screens for "find/replace", "regex", "Strong's number": zero hits. No screen or architecture-doc note addresses this. |
| G.5 / Unmapped Export USFM, Copy Chapter (client-side, non-mutating) | none | **MISS**, low severity (these perform no server write, so their absence doesn't affect data-handle correctness, but they are real, named user-facing actions in the inventory with zero equivalent anywhere). |
| Unmapped: TN-scope Find/Replace (shares the same overlay as G.4) | none | same MISS as G.4, not double-counted |

### Bundle H — Align words
| Action | Screen(s) | Severity |
|---|---|---|
| H.1 Toolbar (unaligned count, selection count, Colors/Hover-link/Show-unaligned toggles), source strip, drag-and-drop card grid (static demo, correctly captioned as such), ghost-suggestion accept/dismiss, per-card Clear, Accept-all-suggestions, Clear/Reset/Save | t4-align.html | OK |
| H.2 Side-by-Side Aligner (prev/next, Hebrew-info toggle, per-side ReadingLine Save/Undo, locked-while-dirty behavior, hover-link default-on) | t4-align.html | OK |
| Mobile fallback ("needs a larger screen") | t4-align.html | OK — matches the brief's explicit requirement. |

### Bundle I — Curate note templates
| Action | Screen(s) | Severity |
|---|---|---|
| I.1 Rail (search, bulk "Draft all with AI", stale/unsaved dots, grouped by type, approved-count) | l3-templates.html | OK |
| I.2 Editor (load, History icon, Draft-with-AI, Save, Approve/Unapprove, Preview/Edit toggle, 409 rebase, collapsed-validated banner) | l3-templates.html | OK |
| I.3 TemplateHistoryDialog (Source/Target toggle, snapshot/diff, "Use vN") | l3-templates.html | OK |
| No client-side role gate (matches reality) | l3-templates.html, explicitly noted in-page | OK |
| `GET /api/templates` (rail list load) | not wired as an explicit handle (rail is static demo data) | **NEAR-MISS**, same passive-load pattern as the Bundle C list above. |

### Bundle J — Translate tW/tA articles
| Action | Screen(s) | Severity |
|---|---|---|
| J.1 Rail (tW/tA segmented — not tabbed, per the recorded verdict; search, approved-count, Populate-from-books) | t5-articles.html | OK |
| J.2 Editor (parts, per-part Preview/Edit, Save all-dirty-parts, Approve/Unapprove skip-untouched, Translate/Re-run AI) | t5-articles.html | OK |
| J.1 **"Add [query]"** (empty/no-match state → `POST /api/articles/:resource/add`) | none | **MISS** — only Populate-from-books is present; there's no add-by-id affordance. |
| Article history | t5-articles.html shows a History button that opens a dialog stating, correctly, *"No history endpoint exists for tW/tA articles today (unlike note templates) — this is a real gap, not a mockup omission."* Verified against 00b: articles.ts indeed has no history route. | **DELIBERATE** — accurately documented and independently verified true. |

### Bundle K — Trust & observe
| Action | Screen(s) | Severity |
|---|---|---|
| K.1 Chapter-lock banner, "mark notes to keep," locked-edit-dropped toast concept, completion routing (ready-to-refresh banner, plain success, failed w/ friendly `error_kind` copy) | t1-home.html, t2-review.html, l1-ai.html | OK |
| K.2 Status pill/popover, job list (icons/subline/queue-position/foreign-job/stage-bar), Cancel/Dismiss, Refresh/Dismiss-all | t1-home.html, l1-ai.html | OK |
| K.3 ChapterBoard | t3-scripture.html | OK (counted once, see Bundle G) |
| K.5 Version-mismatch/app-update nudge (`useAppVersion`, "Refresh" affordance) | none | **MISS**, low severity |
| K.6 SyncStatusBar (saved/saving/conflicts/failed/offline/unsaved-drafts pill) | Partially — "N unsaved" chips exist on t2-review.html, l2-style.html, l3-templates.html, t5-articles.html; the fuller saved/saving/offline state machine is not distinctly modeled anywhere | **NEAR-MISS** |
| K.7 BookLintIndicator | none | **MISS** (counted once here, cross-referenced from Bundle B) |
| K.8 WS presence (`useChapterRoom`, live reconciliation) | none — no screen uses a `ws:*` handle at all, despite the convention explicitly allowing one | **OK** — WS is a background hint mechanism with no direct user-facing control per the inventory itself ("every message is a hint, never authoritative"); there is no action for a mockup to attach a handle to. Not counted as a MISS. |
| K.9 UnsavedToasts (off-screen verse-draft toast stack, aggregate "Review" chip) | none distinctly — t3-scripture.html is single-verse-focused so there's nothing "off-screen" to collect | **MISS**, low severity, a direct consequence of the (DELIBERATE) single-verse redesign in G.2/G.3 above. |
| Health check, export-run list/details/force, cron schedule (incl. correctly-flagged dormant reimport cron), spare-workspace-pool | a4-observe.html | OK |
| "Workflow stages" future card (up/down, never native DnD, `TODO:no-backend`) | a4-observe.html | **DELIBERATE** — matches 02-architecture.md Decision D2 exactly, cited in-file. |
| TopBar "More▸View" (text-size stepper, interface-language submenu) | Theme toggle only (present on every screen); text-size stepper and language submenu absent everywhere | **MISS**, low severity |
| K.4 Original-language reference (hover tooltip, pinned lexicon popover) | Hebrew/Greek text is shown statically (t2, t3, t4) but with no interactive hover/pin lexicon lookup wired to a handle | **MISS**, low severity |

### Required states (02-architecture.md, items 1–9)
All nine are demonstrated on at least one screen: (1) chapter-locked banner — t1/t2/l1; (2)
409 version-conflict merge prompt — t2/l2; (3) "drafts ready, refresh" banner — t1/l1; (4)
"N unsaved" reminder — t2/l2/l3/t5; (5) context-pack chip — t1/l2/a4; (6) "AI not
configured" empty state — l1; (7) mode gating + preview toggle — l1 (translate-only menu
items) plus the Mode button on every screen; (8) "x of y" counters — pervasive (t1, t2,
l3, t5, a2); (9) "org switch = full reload" — account-menu notes on every screen plus
a3-team.html's explicit modal copy. **9/9 OK.**

---

## Audit 3 — Endpoint reverse pass

Walking 00b's flat table (110 rows), excluding AUTH and INFRA rows per the brief's
instruction. Every row tagged with a UI-facing bundle (A–K) was checked against the
aggregated handle list from Audit 1.

**Endpoints confirmed present as a handle somewhere: ~55 of ~96 UI-facing rows** (110
total minus 8 AUTH rows minus the `/api/health` INFRA-ish row, though health *is* shown
on a4-observe.html so it's counted OK). The absences, with justification where one
exists:

| Endpoint | Bundle | Justified? |
|---|---|---|
| `GET /api/alerts/me`, `POST /api/alerts/:id/dismiss` | K | **Unjustified MISS** — App.tsx's system-alerts stack is a real, always-mounted cross-cutting surface; no screen renders it or explains its absence. |
| `GET /api/books/:book/lint` | B/K | Unjustified MISS (see Audit 2) |
| `GET /api/pending-imports` | B | Unjustified MISS — no screen surfaces the shared pending-AI-import review queue at all; 00-code-inventory itself only has an `[INFERRED]` call site for it, so this may double as an already-orphaned route, but it's still a real endpoint with zero representation. |
| `GET /api/orgs/search` | A | Unjustified MISS, low severity (see Audit 2) |
| `GET /api/l10n/overrides`, `PUT /api/l10n/overrides/:lang` | Unmapped/C | Reasonably justified — never assigned to any screen in 02-architecture.md's screen table (see Audit 2) |
| `POST /api/templates/sync` | I | Weakly justified — [INFERRED] with no confirmed real-app UI call site either (see Audit 2) |
| `GET /api/twl-suggestions/...`, `GET /api/twl-filters/:book` | D | Unjustified MISS — tied to the whole-bundle TWL-editing gap (Audit 2, Bundle F.4) |
| `POST /api/rows/:kind` (create) | E/F | Unjustified MISS — no screen creates a new tn/tq/twl row (no "+" insert, no TwlSuggestions Add) |
| `DELETE /api/rows/:kind/:id` | E/F | Unjustified MISS — no hard-delete control shown anywhere (QuestionCard/WordsTable delete) |
| `POST /api/rows/tn/:id/restore` | E/F | Unjustified MISS (see Audit 2) |
| `GET /api/catalogs` | E/F | Unjustified MISS, low severity — support-ref/tW-link autocomplete not modeled as interactive anywhere |
| `GET /api/lexicon/:strong`, `GET /api/lexicon` | E/F/K | Unjustified MISS, low severity (see K.4 above) |
| `POST /api/project-config/lanes/:lane/validate`, `GET .../affected-books`, `POST .../replacements`, `GET .../replacements/:jobId`, `.../retry-book`, `.../waive-book`, `.../activate`, `.../cancel`, `.../back-out` (9 routes) | G (Scripture-lane admin) | Unjustified MISS — the "lane-replacement full job polling" gap (see Audit 2, Bundle A.7) |
| `GET /api/articles/:resource`, `GET /api/articles/:resource/unit` | J | Justified — passive list/unit-load reads, same systemic pattern as every other book/chapter/template/prefs list-load across all 12 screens (none of the 12 wire a plain data-fetch to a `data-handle`; only actions do) |
| `POST /api/articles/:resource/add` | J | Unjustified MISS (see Audit 2) |
| `GET /api/templates`, `GET /api/project-config`, `GET /api/exports`, `GET /api/exports/resources`, `GET /api/translation-memory/prefs`, `GET /api/translation-memory/terms/count`, `GET /api/translation-memory/export-status` | C/I | Justified — same passive-load pattern (several of these are at least named in on-screen caption text, see Audit 2's NEAR-MISS rows) |
| `GET /api/verses/.../:bibleVersion`, `GET /api/rows/:kind/:id`, `GET /api/chapters/:book/:chapter`\* related passive GETs | G/E/F | Justified — passive page-load reads, consistent with the rest of the set (\*`GET /api/chapters/:book/:chapter` *is* used once, as an explicit "Chapter board" button handle in t3-scripture.html, so it's actually OK not just justified) |
| `GET /api/workspaces/pool`, `POST /api/workspaces/pool`, `POST /api/workspaces/pool/claim` | A | OK — present on a4-observe.html |

**Systemic pattern, stated once rather than per-row:** none of the 12 screens wire a
plain "load this list/page" GET to a `data-handle` — only user-triggered actions (button
clicks, explicit Refresh, history opens) get one. This is a consistent, reasonable
simplification across the whole set, not a per-screen inconsistency, and I've treated
every such passive GET as justified above rather than listing it as a defect.

---

## Verdict

**Audit 1 (handle validity):** 61 distinct real handles checked, **0 INVENTED**, 2
NEAR-MISS (hardcoded `ULT`/`UST` literals instead of `:bibleVersion`, 5 occurrences total
across t3/t4), 1 methodological note (a JS-templated handle that a naive grep
misreports but which resolves correctly at runtime). Every If-Match/X-Source-Generation
header requirement is met everywhere it applies — 0 missing-header defects. This audit
is clean: the "never invented, always copied from the registry" rule held completely.

**Audit 2 (action coverage):** the large majority of A–K actions are covered, several
bundles (D, H, I, J, most of K) essentially completely. Confirmed **2 DELIBERATE**
omissions with direct in-file evidence (QA rules; the Workflow-stages future card) plus
one confirmed-accurate real-gap note (article history), one genuine redesign decision
with a cited source (columns/book-mode collapse), and the NoteCard-sparkles claim
verified true. Against that: **~20 MISS-severity gaps**, the two largest being (a) TWL
editing (WordsTable, QuoteBuilderPopper's actual interaction, TwlSuggestions) has **no**
screen at all, only a read-only display, and (b) the scripture-lane replacement job
lifecycle (8 of 9 endpoints) is essentially unbuilt beyond one demo button. Most of the
remainder are single, low-severity secondary actions (Restore, Undo-for-notes, Add-article,
Remove-override, book-lint, version-mismatch nudge, lexicon hover, Find/Replace,
Export-USFM). All 9 required states from 02-architecture.md are demonstrated somewhere.

**Audit 3 (endpoint reverse pass):** roughly 55 of ~96 UI-facing endpoints have a call
site; the rest split cleanly into "justified passive-load absence" (the majority) and a
smaller set of genuinely unjustified MISSes that map 1:1 onto Audit 2's findings (TWL
create/delete/restore/suggestions, lane-replacement admin, book-lint, pending-imports,
alerts, org-search, article-add).

**Bottom line:** no fabrication risk (Audit 1 is clean), but "nothing left out" cannot
be claimed — the honest count is 0 invented handles, ~4 confirmed-with-evidence
deliberate omissions, and roughly 20 real, unacknowledged gaps of varying severity, the
two headline ones being the TWL-editing surface and the scripture-lane-replacement job
flow. Four of the six omissions the brief described as "recorded as deliberate" have no
recorded justification I could find anywhere in this repository.
