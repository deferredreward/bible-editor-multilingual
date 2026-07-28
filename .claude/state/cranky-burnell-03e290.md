# cranky-burnell-03e290 — unsaved tW/tA article drafts

**PR:** https://github.com/deferredreward/bible-editor-multilingual/pull/132 (open)

Fixes silent loss of unsaved tW/tA article drafts (found by Codex review of #131,
deferred there). Approach chosen by Benjamin: keep server saves explicit, protect
the text by **persisting to the IndexedDB drafts store** — the convention the
verse/row/note editors already use — not by confirm dialogs.

## In flight / follow-ups
- Independent review agent was dispatched on the diff; findings not yet folded in
  at the time this file was written. Check the PR thread before merging.
- Not exercised: a multi-part tA article (title/sub-title/body). Same code path as
  the tW body part that was verified, but unclicked.
- No automated test added — the drafts store has no test harness. If one is ever
  built, the regression to pin is: type → unmount → remount → text survives.

## Local verification setup (if it needs redoing)
Dev DB in this worktree's `.wrangler/state` has two seeded tW articles
(`kt/grace`, `kt/faith`); seed SQL was written to the session scratchpad, not the
repo. Servers were run as `wrangler dev --port 8791` + `vite --port 5291` with
`VITE_API_PROXY=http://127.0.0.1:8791`. Note that background servers started by a
**subagent** die when that agent finishes — start them from the main session.
