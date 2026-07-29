# stoic-bardeen-7eb2ea — unsaved note-template drafts

Applies the PR #132 drafts-store treatment to `TemplateWorkspace.tsx`, which had
the same silent data-loss bug and no dirty tracking at all.

## Verified in a browser (dev worker :8792 + vite :5292, this worktree)
Bug reproduced BEFORE the fix (typing lost via Back arrow and via switching
template), then after the fix: Back arrow, template switch, full page reload,
and the SyncStatusBar "1 unsaved" jump all preserve the text; Save clears the
draft, disarms the rail marker, and empties the store.

## Notes for a reviewer
- The templates view renders **no TopBar** (see `App.tsx` ~line 536 — unlike the
  articles view). So the "TopBar More menu" exit named in the original report is
  not reachable from this screen; the Back arrow is the exit. Persistence is
  store-based, so any unmount is covered regardless.
- `Unapprove` is now gated on `dirty`, matching the article fix: the validate
  response carries the pre-existing `target_md`, so running it with unsaved
  typing would overwrite it via `applyServerUnit`.
- `TemplateHistoryDialog`'s `onUseVersion` also persists now — pulling an old
  version into the box is unsaved typing like any other.

## Local verification setup (if it needs redoing)
Both local dev DBs were migrated (`bible_editor_dev` AND
`bible_editor_mltest_dev` — which one you land in depends on the resolved
workspace) and seeded with two template_units (`tmpl-alpha`, `tmpl-beta`); the
seed SQL lives in the session scratchpad, not the repo.

Gotcha worth remembering: probing the drafts IndexedDB from the console with a
bare `indexedDB.open('bible-editor-drafts')` **creates the DB at v1 with no
object store**, which then blocks the app's own `openDB(name, 1)` upgrade and
makes drafts silently non-functional. A later `deleteDatabase` against the app's
live connection wedges every subsequent open. Both cost real debugging time
here. Probe with the store already created, or just verify behaviourally.

The dev session cookie lapses quickly; re-mint mid-session with
`fetch('/api/auth/dev',{method:'POST',...})` when a PATCH starts 401ing.
