# Flexible Layouts — handoff (read this first)

Branch: `claude/bem-flexible-layouts-3d4b0a` (pushed to origin). All work below is committed.
Design decisions (full history, 6 rounds): `~/.claude/plans/take-a-look-at-toasty-hippo.md`.
Target UX (runtime-verified mockup, open in a browser): `docs/mockups/flexible-layouts.html`.

## Where this stands (honest)

**Shipped = the FOUNDATION/skeleton.** It rearranges the *existing* monolithic components; it does not yet deliver the flexible substance the mockup promised.

Commits (newest first): always-show switcher fix; Phase 5 save/manage user layouts; Phase 4 server-shipped defaults + client fallback; Phase 3 layout-driven WorkspaceLayout + `react-resizable-panels` + switcher; Phase 2 WorkspaceLayout extraction; Phase 1 recursive schema/store/registry; Phase 0 mockup.

- **web/src/lib/**: `layoutSpec.ts` (recursive `LayoutNode = SplitNode | PanelRegion` + `PanelInstance`/`PanelConfig`, `LayoutSpec{v:2}`, strict validator, `normalizeSizes`), `builtinLayouts.ts` (4 built-ins: classic / translate-notes / bp-review-nested / translate-words + `getBuiltinLayouts(cfg)`), `layoutStore.ts` (`be:layouts.v2` + `LayoutOverride` + `mergeOverride`), `panelRegistry.ts` (10 panel types + `validateLayoutAgainstRegistry`).
- **WorkspaceLayout.tsx**: renders a `LayoutSpec`. `builtin:classic` uses a special-cased flexbox+divider path (byte-identical to today). Other layouts render the recursive tree via `react-resizable-panels` v4 (`Group`/`Panel`/`Separator`, `orientation`, `onLayoutChanged`).
- **Shell.tsx**: resolves the active layout (`useWorkflowLayouts()` + user layouts), `renderRegion(region)` maps a region to ONE component — scripture→`ScriptureColumn`, notes/words/questions→`ResourceColumn` with `visibleTabs`, everything else→a labeled placeholder. `selectLayout` syncs mode/versions (Classic uses `be:*` keys; others use overrides). Switcher wired in both the data branch and (now) the no-data branch.
- **ResourceColumn.tsx**: optional `visibleTabs`/`initialTab`. **TopBar.tsx**: `LayoutSwitcher` (ViewQuilt icon). **api/src/workflowLayouts.ts**: `builtinLayoutsFor(config)` served on `GET /api/project-config`; client validates + falls back to bundled. **LayoutMenu.tsx**: save/manage dialogs.

Verified: `npm run typecheck` clean, `npm run build` succeeds, web tests 15/15, api tests 96. NOT verified by a live click-through (see dev-env gotcha).

## The GAP (user feedback after seeing it live) — this is the remaining work

1. **Can't move panels.** Drag-between-regions / reorder / region hide, and the **Flexible · Columns / Nested** layouts (mockup-only, never added as builtins), don't exist. The renderer maps a region to ONE component, so it can't host multi-panel regions.
2. **No side-by-side note translation.** "Translate Notes" re-hosts the normal notes column; the source-note | target-note paired UI (mockup) was never built into `NoteCard`. Source-notes data exists via `useSourceNotes` (translation projects).
3. **Scripture panes are the dense existing `ScriptureColumn`** — not the simple review-oriented panes the layouts promised.

## The plan (user chose: FOUNDATION FIRST, then all three)

**Foundation** — decompose the monolithic columns into clean, standalone, individually-placeable panel components (a notes panel, words panel, questions panel, scripture panel, original-language panel) with clean props, so a `PanelRegion` can hold one-or-many and `renderRegion` renders `region.panels` as separate panels. This is the base for all three below. `PanelInstance.type` already enumerates them (`scripture|original|notes|words|questions|taArticle|twArticle|articleList|alignment|search`).

Then, on top of the foundation:
1. **Movable panels + Flexible builtins** — drag/reorder/hide layer in WorkspaceLayout (mockup has a working reference impl), persist to `LayoutOverride`; add Flexible · Columns + Nested to `builtinLayouts.ts` + `api/src/workflowLayouts.ts`.
2. **Side-by-side source→target notes** — a paired note component using `useSourceNotes`, honoring `PanelConfig.pairAxis` (horizontal default; vertical option).
3. **Simpler scripture panes** — a lightweight read/review scripture panel, distinct from the full editor column.

**Hard invariant throughout:** `builtin:classic` must stay byte-identical to today's Shell.

## Region hide / restore — built, and why it is built this way

Round 6 asked for "regions can be turned off and back on", distinct from panel
minimize. It is now in, Flexible-only. In plain terms: **each section has a small
✕ that closes the whole section, with everything inside it. A thin strip appears
at the edge of the workspace with one button per closed section, and the Layouts
menu lists them by name — either one brings the section back exactly as it was.**

Four decisions worth knowing before touching this:

- **Hiding is a render-time FILTER, never a tree edit.** `LayoutOverride.hidden`
  (region id → true) is consulted only by `WorkspaceLayout.renderNode`; the
  persisted tree keeps the closed region and all its panels. This is what makes
  "panels are never orphaned" structural rather than careful: `normalizeTree`
  deletes a region only when it has **no** panels, and a closed one still has all
  of its, so no engine operation can destroy it. Verified live: emptying a closed
  region's sibling collapses the split *around* the closed region and its three
  panels come back intact.
- **Filter AFTER computing the child path, never before.** `collectSizeKeys`
  mirrors `renderNode`'s `${path}.${i}` scheme, so re-indexing the surviving
  children would repoint every nested `split:<path>` size key — closing a region
  would resize unrelated splits and `pruneSizes` would delete live keys.
- **Every write resolves both sides.** `resolveHidden` returns `{}` for an
  unsatisfiable set (all regions closed) so the workspace can never go blank —
  but that made the stored value and the rendered value diverge, and a write built
  on the raw stored value stayed unsatisfiable, so the ✕ became a permanent no-op.
  Writes now resolve the base first and persist the resolved value, which heals
  the bad state on the next click. **This bug was found by clicking, not by the
  113 unit tests** — it is now pinned in `layoutTree.test.mjs`.
- **An emptied region is still deleted outright — hide/restore did NOT change
  that.** Round 6 floated "emptied regions may auto-close with a reopen
  affordance". Rejected: a restore entry is keyed by a region id that must still
  exist in the tree, and an auto-closed emptied region has no panels to bring
  back, so reopening it would hand the user an empty box. The recovery gesture for
  an emptied band already exists — the perimeter/outer drop (see `OuterDropTarget`).
  Hide/restore serves the case that actually needed it: closing a section you
  intend to get back **with its contents**.

Both restore paths ship on purpose: the in-flow edge strip is the discoverable
one (and is a flex sibling, not an overlay — an overlaid strip could swallow the
drag grips, which is exactly how the perimeter bands shipped a bug), and the
Layouts menu names each closed section in full for when the strip is missed.

## Dev / verify gotchas (important — cost hours last session)

- ~~**node_modules is REAL in this worktree.** Do NOT run `scripts/worktree-init.ps1`.~~ **Stale (2026-07-28):** `worktree-init.ps1` no longer junctions anything — it runs a real cache-fast `npm install`, so it is now the correct first step in a fresh worktree and `react-resizable-panels` installs normally. Same for the `--persist-to "C:/…"` workaround below: the repo lives at `C:\GH\BEM\repo` precisely so the default in-worktree `.wrangler/state` fits `MAX_PATH`. Verified this session: migrate + seed + `wrangler dev` all worked with no `--persist-to`, and the seeded OBA chapter WAS visible to `wrangler dev`.
- **wrangler local-D1 persistence mismatch on this machine:** `wrangler d1 execute --local` and `wrangler dev` resolve the local SQLite file differently (worsened by the `Documents`/XDG path, which also throws `SQLITE_CANTOPEN` on `d1 migrations apply`). Seeding a book via `import-book.mjs` + `d1 execute` did NOT become visible to `wrangler dev`. To verify live, use a **properly-onboarded project** (real config + lanes), e.g. the user's normal dev environment — don't burn time re-seeding a throwaway D1. A raw `import-book.mjs` also does NOT create `project_config` / `scripture_lane_state`; the chapter read (`api/src/chapters.ts`) filters verses by each lane's `active_generation`, so no lanes → empty chapter → app sits in the no-data view.
- Background servers from last session may still be up: wrangler `:8787`, vite `:5174` (its D1 is empty — the seed didn't align). Ports `5173`/`5176` are the user's own servers — do not disturb.

## First move for the next session
Read `STATE.md` + this file + skim the mockup, then build the panel-decomposition foundation as its own reviewable PR (start with extracting a standalone notes panel + wiring `renderRegion` to render `region.panels` individually), keeping Classic byte-identical. Commit per step; the user reviews at each stage.
