# cranky-burnell-03e290 — unsaved tW/tA article drafts

**PR:** https://github.com/deferredreward/bible-editor-multilingual/pull/132 (open)

Fixes silent loss of unsaved tW/tA article drafts (found by Codex review of #131,
deferred there). Approach chosen by Benjamin: keep server saves explicit, protect
the text by **persisting to the IndexedDB drafts store** — the convention the
verse/row/note editors already use — not by confirm dialogs.

## Review status: complete
Claude pass found 2 real defects (un-approve wiping the draft; an undismissable
"unsaved" chip) -- both fixed in 064acd1 and re-verified in a browser. Codex pass
returned APPROVE with no blocking findings. Details in the PR thread.

## Follow-ups
- Not exercised: a multi-part tA article (title/sub-title/body). Same code path as
  the tW body part that was verified, but unclicked.
- Deferred deliberately: there is still no per-draft discard for ordinary (non-failed,
  non-quarantined) drafts, so a draft stranded on an article that vanishes from the
  workspace would nag with no way to clear it. Pre-existing class (row drafts have it
  too); worth its own change if it ever bites.
- No automated test added — the drafts store has no test harness. If one is ever
  built, the regression to pin is: type → unmount → remount → text survives.

## Local verification setup (if it needs redoing)
Dev DB in this worktree's `.wrangler/state` has two seeded tW articles
(`kt/grace`, `kt/faith`); seed SQL was written to the session scratchpad, not the
repo. Both `bible_editor_dev` AND `bible_editor_mltest_dev` were migrated+seeded --
which DB you land in depends on the workspace the session resolves to (`bsoj` vs
`mltest`), and a fresh browser profile resolved to `mltest` whose DB had no
migrations, giving "no such table" 500s and an "only available for gateway-language
projects" screen. Migrate both. Servers were run as `wrangler dev --port 8791` + `vite --port 5291` with
`VITE_API_PROXY=http://127.0.0.1:8791`. Note that background servers started by a
**subagent** die when that agent finishes — start them from the main session.
