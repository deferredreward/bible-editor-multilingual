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

## Dev / verify gotchas (important — cost hours last session)

- **node_modules is REAL in this worktree** (un-junctioned to install `react-resizable-panels@4.12.2`). Do NOT run `scripts/worktree-init.ps1` or re-junction, or the dep vanishes.
- **wrangler local-D1 persistence mismatch on this machine:** `wrangler d1 execute --local` and `wrangler dev` resolve the local SQLite file differently (worsened by the `Documents`/XDG path, which also throws `SQLITE_CANTOPEN` on `d1 migrations apply`). Seeding a book via `import-book.mjs` + `d1 execute` did NOT become visible to `wrangler dev`. To verify live, use a **properly-onboarded project** (real config + lanes), e.g. the user's normal dev environment — don't burn time re-seeding a throwaway D1. A raw `import-book.mjs` also does NOT create `project_config` / `scripture_lane_state`; the chapter read (`api/src/chapters.ts`) filters verses by each lane's `active_generation`, so no lanes → empty chapter → app sits in the no-data view.
- Background servers from last session may still be up: wrangler `:8787`, vite `:5174` (its D1 is empty — the seed didn't align). Ports `5173`/`5176` are the user's own servers — do not disturb.

## First move for the next session
Read `STATE.md` + this file + skim the mockup, then build the panel-decomposition foundation as its own reviewable PR (start with extracting a standalone notes panel + wiring `renderRegion` to render `region.panels` individually), keeping Classic byte-identical. Commit per step; the user reviews at each stage.
