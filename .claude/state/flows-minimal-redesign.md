# flows-minimal-redesign — Titus-artifact design calibration

Delete when the redesign PR merges. Branch stacks on
claude/flows-fidelity-verse-overview-c51f2c (PR #157).

**Design source of truth:** Benjamin's published Claude artifacts (list via the
Artifact tool): "Translation Notes — Titus 1", "Translate Questions — Titus 1",
"Minimalist UI concepts", plus Scripture/Words/Team/Setup/Workflow/Progress and
the book-package verse preview. The docs/flows/ui mockups are SUPERSEDED for
design (their wiring findings remain valid). Locked decisions: translation-
primary; no authoring chrome (no preserve/hint/TCM/SH/reorder/ids); notes
"Not needed" = tn soft-trash relabeled; questions are never dropped (two verbs:
Redo · Approve); nav = book-package hub + back-chevrons (FlowNav pill bar dies);
admin = desk-rail; one-screen-first calibration workflow.

**Built + Benjamin-approved:** #/notes/{book}/{chapter} (TranslateNotesScreen);
#/questions/{book}/{chapter} (approved 2026-08-07 with one change: Redo hidden,
Approve is the one verb — 60cea3d; per-question redo returns only if users ask,
wired to the async translate pipeline). Notes keeps "Not needed"; bulk
per-language note-kind exclusion is issue #158 (parked).
**Built 2026-08-07 fan-out, awaiting his markup:** #/words/{book}
(TranslateWordsScreen — Approve/Save/async Redo real, "Needs work" hidden: no
such article state), #/scripture/{book}/{ch} (TranslateScriptureScreen —
smartEditVerse-safe saves, Redraft hidden: async pipeline only),
#/package/{book} (PackageHubScreen — synthesized, no dedicated artifact; counts
from BookSummary only, chapter-0 front matter excluded). Routes: 1–2-segment
#/scripture and 2-segment #/words now open the new screens; 3-segment forms
still open the old flows screens. FlowNav still renders on old screens only;
retire it when book-open affordances point at #/package/{book}.
**2026-08-10 responsive pass (committed, tip b2148b9):** every redesign screen
now has the words-pattern md+/desktop master-detail (900px gate, 1180px desk);
phone unchanged. New TranslateAlignScreen at
#/alignment/{book}/{ch}[/{v}[/dual]] wraps AlignmentPanel / AlignTapView /
SideBySideAligner with their exact save paths; hub gained an Alignment surface;
scripture desktop gained per-lane Align + Align both. Local dev DB has tw
kt/prophet + ta translate/figs-metaphor populated (POST /api/articles/:res/add)
so words detail/editing is testable; prophet carries an Arabic smoke-test draft.
**Verified in browser (wide only):** all five wide layouts + key interactions
(row selection drives cursor, dual dialog opens from route and from Align both,
words edit PATCH 200). NOT verifiable headless: the phone↔wide breakpoint FLIP
(hidden pane never fires matchMedia change events; useMediaQuery freezes at
first paint) — Benjamin's real-browser resize is the validator. Cosmetics:
notes intro-row previews show raw markdown marks.

**Local dev environment gotchas (this worktree):**
- bsoj lane state in LOCAL D1 was aligned to the preset's desired configs
  (AVD/ar_avd, NAV/ar_nav) so the project-config healer stops re-quarantining
  ULT/UST; lanes show English stand-in text under AVD/NAV labels.
- After ANY wrangler d1 CLI write, RESTART the wrangler dev process — a running
  isolate serves stale lane state to the app while fresh curl probes look fine
  (cost hours; same family as the stale-workerd lesson).
- Servers: wrangler :8891, vite :5181 (bound 127.0.0.1). Boot may flash a stale
  "session expired" banner (pre-existing dev-mint race) — dismiss once.

**2026-08-10 markup round + admin wave (tip f524180):** notes list previews
target text (never Hebrew/Greek, markdown stripped); words/articles sorted by
book frequency desc; prev/next at top+bottom on all queue screens; swipe paging
(useSwipeNav) on notes/questions/scripture — deliberately NOT alignment (drag
collision, recorded); action bars data-no-swipe. Admin desk shipped:
#/admin/{progress|workflow|team|setup} in AdminDesk rail chrome, Today-tier
sections wired real, Phase-2 mockup panels omitted + recorded in headers.
Entry points: BooksScreen Open → #/package/{book}; hub topbar has admin-only
desk link. MERGE DECISION (Benjamin 2026-08-10): classic mode STAYS for power
users; this redesign replaces flexible/flows mode entirely at merge.
**Verified in browser:** notes previews, frequency sort (yahweh 131 first),
all four admin screens with real data, books→hub entry. NOT verified: swipe on
real touch hardware; OBA shows all-zero counts on the progress board (check
whether OBA content actually imported in this dev workspace or summary quirk).
**Known cosmetics:** FlowStatusChip inside Typography p logs a
validateDOMNesting warning (notes list rows).

**2026-08-15 mobile markup round (tip 9bbffec, after merging origin/main
post-#157/#152):** dir="auto" verse snippets (scripture+align lists — RTL-declared
lane + LTR stand-in text used to show verse tails); tap-mode toggle pill contained,
label "Tap mode"; AlignTapView bounded in a bordered scroll box (save bar sticky
inside); topbar Scripture button on alignment (label ≥560px, icon below); per-lane
Align + Align both now on phone; Redo buttons use AutoAwesomeIcon; phone focus mode
on notes/questions/words (editor open → topbar/action bar/pager/filters hide until
Done); editor focus via preventScroll + centered scrollIntoView (no autoFocus);
words "both" source column 38% at 0.78rem.
**Verified in browser (devtools MCP, 501px + 1280px, fresh load per width):** all
eight items, focus-mode round-trips, words Save → article_units row in local D1,
dual dialog, hub/books/admin sweep, zero console errors. NOT verified: real
keyboard/touch feel of the scroll fix and focus mode (needs Benjamin's device);
swipe on hardware; RTL wide layouts under Arabic UI.
**Known cosmetics:** English UI strings inside RTL-directed containers render with
leading punctuation (e.g. ".All target words are aligned" in the tap-view pool).

**2026-08-15 PR #165 + review rounds (tips 19e46b3, 4a539c2):** PR open, CI
green, dev worker serves 4a539c2. Two independent Claude reviews ran per the
pre-merge protocol (commit-scoped, then full-PR-diff): headline finds were the
questions QaPair component-in-component (remounted per keystroke — likely the
original "lose my spot" bug; hoisted to module scope, browser-verified), the
align tap-draft flush writing cross-verse corrupted drafts on fast verse nav
(fixed with tapEditKeyRef provenance; the old rehydration guard also raced
IndexedDB and skipped same-mount rehydrate — round-trip now browser-verified),
phone save-bar unpinning in the bounded tap box, and width-split scroll policy.
Deferred to issues: #163 RTL UI-string punctuation, #164 scripture focus mode,
#166 /api/exports wrapper, #167 pre-existing drafts stash race. Codex pass on
the PR is the remaining protocol step (running at handoff if not concluded).

**Next:** old flows screens retirement plan (FlowNav dies when the last old
screen is replaced); real-device pass on focus mode + swipe.
