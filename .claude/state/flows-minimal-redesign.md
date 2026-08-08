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
**Verified in browser (this dev DB):** hub counts real; scripture lanes
faithfully mirror old screen (AVD/NAV text-read-only, empty targets); words
list real but ALL articles unpopulated here, so the words detail/edit view has
never been exercised — populate one tw source (Articles workspace) to test it.

**Local dev environment gotchas (this worktree):**
- bsoj lane state in LOCAL D1 was aligned to the preset's desired configs
  (AVD/ar_avd, NAV/ar_nav) so the project-config healer stops re-quarantining
  ULT/UST; lanes show English stand-in text under AVD/NAV labels.
- After ANY wrangler d1 CLI write, RESTART the wrangler dev process — a running
  isolate serves stale lane state to the app while fresh curl probes look fine
  (cost hours; same family as the stale-workerd lesson).
- Servers: wrangler :8891, vite :5181 (bound 127.0.0.1). Boot may flash a stale
  "session expired" banner (pre-existing dev-mint race) — dismiss once.

**Next:** Words/Articles screen, Scripture screen, package hub (replaces
FlowNav), admin desk screens — after Benjamin's questions-screen markup.
Options offered, undecided: wire tq Redo to the per-row translate pipeline job.
