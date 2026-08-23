# Book lifecycle: from a book-page-owned flow (scoping proposal)

> **Status: SCOPING PROPOSAL for review — not a finalized design.** Per issue
> [#290](https://github.com/deferredreward/bible-editor-multilingual/issues/290),
> this document scopes a direction and a PR-sized breakdown. It does *not*
> prescribe the final UX, and no code is changed by this doc. Each PR below is
> its own review; the design can move between here and those PRs.

## Problem

Bringing a **mixed-source** book from nothing to published-on-Door43 currently
takes **seven screen-stops**. Benjamin walked this flow for the **2026-08-24
BSOJ demo** and flagged it as far too complicated. Three of the seven stops are
*accidental complexity* — plumbing artifacts, not translation work:

1. A **second trip to Admin > Setup** exists only to *remove* the per-chapter
   source-override rows, because the exporter treats **source provenance as
   publish-permission** (#236). Deleting override rows is being used as a
   "publish" button.
2. The **first Setup trip** is book-scoped config living two screens away from
   the import it configures. #282 fixed the book picker; the *placement* is
   still wrong.
3. **Publish lives on an org-wide admin screen** (Admin > Workflow) instead of
   on the book, even though a book-scoped export already exists (#287).

The **success check** for the eventual implementation: an admin can take a
mixed-source book from not-imported to a Door43 PR while visiting only the
**book page**, the **editor**, and the **review queue** — three stops.

---

## Current flow (7 stops)

Each stop names the screen and the file(s)/route(s) behind it. Stops marked
**[ACCIDENTAL]** are the three the redesign removes.

| # | Stop | Screen | Behind it |
|---|------|--------|-----------|
| 1 | **[ACCIDENTAL]** Set per-chapter source overrides | Admin > Setup | `web/src/components/flows/AdminSetupScreen.tsx` hosts `web/src/components/BookSourceOverridesPanel.tsx`; writes `book_source_overrides` via `api/src/bookSource.ts` (INSERT at `bookSource.ts:234`). #282 widened the picker to the full canon. |
| 2 | Import the book | Books | `web/src/components/flows/BooksScreen.tsx` (a2-import) → `api.importBook(book, …)` (`BooksScreen.tsx:388`); server import in `api/src/bookImport.ts`. `translateFromSource` sets the whole-book provenance marker. |
| 3 | AI-translate the drafted rows | editor | Translate screens (`TranslateNotesScreen.tsx` / `TranslateQuestionsScreen.tsx`, etc.); AI proxy `/api/tn-quick` + `/api/pipelines/*`. |
| 4 | Approve / edit rows | review queue | Review screens (`ReviewRail.tsx`, `ReviewQuestionsGrid.tsx`); rows become non-pristine (`updated_by` set) via `PATCH /api/rows/...`. |
| 5 | **[ACCIDENTAL]** Return to Setup to **remove** the override rows so export stops holding the notes out | Admin > Setup (again) | Same `BookSourceOverridesPanel.tsx`; DELETE at `bookSource.ts:251`/`:264`. This exists **only** because export hold-out is keyed on provenance — see #236 below. |
| 6 | **[ACCIDENTAL]** Run a scoped export | Admin > Workflow | `web/src/components/flows/AdminWorkflowScreen.tsx` "Run export now" → `api.exportsRun({ book })` → `POST /api/exports/run` (`api/src/exports.ts:37`, `book` param at `exports.ts:23`, #287). Org-wide screen, not the book. |
| 7 | Merge the Door43 PR by hand | Door43 (DCS) | `api/src/exportWorkflow.ts` renders D1 → USFM/TSV and opens a per-`(book,resource)` contributor-branch PR (`buildExportBranch`, `api/src/export.ts:58`); a human merges on DCS. |

### Why stop 5 exists (the mechanism to remove)

The exporter builds a **held-out set** of `"BOOK:resource"` keys and *skips*
those pairs (`api/src/exportWorkflow.ts:353-376`, the held-out `continue`). The
set is assembled at `exportWorkflow.ts:268-289` from two sources:

- **Whole-book provenance marker** — `book_imports.tn_source` / `tq_source` /
  `ult_source` / `ust_source` / `twl_source`, via `heldOutNoteResources(r)` in
  `api/src/dcsSources.ts`.
- **Per-chapter range overrides** — `book_source_overrides`, via
  `listRangeHeldOutKeys(env, cfg)` in `api/src/bookSource.ts:479`, which resolves
  each range through `heldOutChapters` / `heldOutChaptersFromRanges`
  (`bookSource.ts:442`).

Because a *partial* book carries **no** whole-book marker (its base is the org's
own repo), the range table is the only thing stopping its cross-sourced chapters
from rendering over master. So today the **only** way to make an
approved-but-cross-sourced book publish is to *delete the override rows* — that
is stop 5, provenance-as-publish-permission in action.

---

## Proposed flow (3 stops) — the book page owns the lifecycle

The natural home is the **book package hub** at `#/package/{book}`
(`web/src/components/flows/PackageHubScreen.tsx`) — where a translator already
lands after picking a book and where every work screen's "Back to {book}
package" chevron points.

| # | Stop | What the book page does |
|---|------|-------------------------|
| 1 | **Bring in this book** (book card / package hub) | An inline "bring in this book" action asks, per resource and per chapter-range, *where each comes from* — own repos (default), the **unfoldingWord preset** (#289 / PR #291), Aquifer, or another URL — then imports. This folds today's stops 1+2 into one: the source config lives *on* the import it configures, writing `book_source_overrides` and calling `api.importBook` in one flow instead of a Setup trip two screens away. |
| 2 | Draft + review | editor + review queue (unchanged: stops 3+4 above). Rows are drafted, AI-translated, and approved/edited here. |
| 3 | **Publish this book** (book page) | A "Publish this book" button runs the **book-scoped export** (#287's plumbing: `api.exportsRun({ book })` → `POST /api/exports/run`) and links to the resulting **Door43 PR**. No Setup return, no org-wide Workflow trip. |

The removed stops (old 5 and old 6) collapse because **publish-permission is
re-keyed** (below) and **publish moves onto the book**.

---

## The durable #236 fix

Today provenance does **two** jobs: (a) it is the **reimport guard** (a
cross-sourced/AI row must not be clobbered by a pristine reimport from master),
and (b) it is the **export publish-permission** (a cross-sourced resource is
held out of export). Job (b) is the bug — it forces stop 5.

**Fix:** key publish-permission on **review state**, not import provenance.

- **Publish** what has been **approved/edited** — rows that are non-pristine
  (`updated_by` set) or have passed review. An approved cross-sourced row is
  *finished translation work*, so it should export; its origin is irrelevant to
  whether it is publishable.
- **Provenance stays** as **metadata** and as the **reimport guard** only. The
  hold-out that `heldOutNoteResources` / `listRangeHeldOutKeys` drives today
  moves from "block export" to "don't reimport-clobber" — which the reimport
  path already does independently via its pristine predicate
  (`api/src/bookReimport.ts`, `isPristineTsv` / the UPDATE-WHERE-pristine batch,
  `skipped_edited` counting).
- **This deletes the remove-overrides step outright.** With export gated on
  review state, there is nothing to un-configure before publishing, so old stop
  5 disappears.

Note the documented limitation this also lets us address: the current hold-out
is a **whole-resource** skip (`exportWorkflow.ts:264-266`), so a partial book's
*owned* chapters don't publish either. Keying on review state at row/range
granularity is the path to publishing the approved chapters without a separate
merge-export follow-up.

---

## Guards that must survive

The reliability rails that keep a stale or partial D1 from clobbering master
are **orthogonal** to the provenance-as-publish-permission change and **must be
preserved**:

| Guard | What it protects | Where it lives |
|-------|------------------|----------------|
| **Shrink guard** | Rejects any render that would mass-delete rows/files vs. master (the `twl_PSA`-clobber signature). | `api/src/exportWorkflow.ts` (TSV guard `:1911-1941`, alignment backstop `:1149-1164`, article backstop `:1424-1443`); `contextShrinkRefused` in `api/src/contextExportLib.ts`; `shrinkRefused` / `exportTsvShrinkRefused` in `api/src/export.ts`. |
| **Freshness gate** | Refuses to commit a render when D1 is stale vs. master (`masterSha` vs. the `book_resource_syncs` watermark) — a failed pre-export sync skips, never reverts. | `api/src/exportWorkflow.ts:1084-1102` (checked in `exportOne`; referenced at `:313`). |
| **Pristine-row sync** | Pre-export DCS→D1 sync updates only *pristine* rows (out-of-band master edits) and never overwrites translator-edited rows; batched under Cloudflare's ~1000-subrequest cap. | `api/src/exportWorkflow.ts:292-328` (`runChunkedReimport`); `api/src/bookReimport.ts` (pristine predicate, `skipped_edited`). |
| **Contributor-branch policy** | Export commits land on a per-`(book,resource)` branch named for the book's human contributors and open a PR for human merge — never a direct push to master. | `buildExportBranch` (`api/src/export.ts:58`), `contributorsFor` + branch build (`api/src/exportWorkflow.ts:1043-1045`, `:1670`). The legacy `live-snapshot` branch is dormant (`exportWorkflow.ts:58-61`). |
| **Provenance-as-reimport-guard** | A cross-sourced/AI/edited row must not be reverted by a pristine reimport from master. **This use of provenance is retained** — it is distinct from provenance-as-publish-permission, which #236 removes. | `api/src/bookReimport.ts` (pristine predicate); provenance markers in `book_imports` + `book_source_overrides`. |

The held-out **observability** shape (a skipped `StepResult` + snapshot with
`held_out:<resource>`, `exportWorkflow.ts:353-374`, #236) should be repurposed,
not deleted: after the fix it reports "held for review" rather than "held for
provenance" so admins still see *why* a pair didn't publish.

---

## PR-sized breakdown (ordered, independently shippable)

1. **Re-key export publish-permission on review state (#236 durable fix).**
   Replace the provenance-derived held-out set in `exportWorkflow.ts:268-289`
   with a review-state predicate (approved/edited rows publish; pristine
   cross-sourced rows don't). Keep the shrink/freshness/pristine guards
   untouched. Keep provenance as the reimport guard. Repurpose the `held_out`
   snapshot reason to "held for review". *Ships value alone: deletes the need
   for stop 5 even before any UI moves.*
2. **Move source config onto import ("bring in this book" inline).** Fold
   `BookSourceOverridesPanel` config into the import flow on
   `BooksScreen.tsx` / `PackageHubScreen.tsx` so source-per-resource/chapter-range
   is chosen *at* import. Retire the standalone Setup panel (or leave it as an
   advanced/edit path). Collapses old stops 1+2.
3. **Wire the unfoldingWord preset (#289 / PR #291) into the inline picker** as a
   one-click source option, alongside own-repos / Aquifer / other-URL.
4. **Add a "Publish this book" button on the book page** calling
   `api.exportsRun({ book })` (#287 plumbing) and surfacing run status. Collapses
   old stop 6 onto the book.
5. **Link the resulting Door43 PR from the book page** (from the export
   snapshot's `pr_number`, already stored — `exports.ts:88-93`), so the admin
   reaches the merge from the book page rather than hunting on DCS.
6. **(Optional, follow-up) Row/range-granular publish** — publish a partial
   book's approved *owned* chapters, removing the whole-resource-skip limitation
   noted at `exportWorkflow.ts:264-266`.

PRs 1 and 4/5 are the load-bearing ones for the success check; PRs 2/3 are the
UX consolidation; PR 6 is the stretch that fully generalizes partial books.

---

## Cross-references

- **#236** — provenance-as-publish-permission is the bug that forces stop 5;
  this doc's durable fix (PR 1) re-keys publish on review state and demotes
  provenance to metadata + reimport guard.
- **#282** — fixed the source-overrides book picker to offer the full canon;
  the *placement* of that config (a Setup trip) is what this doc moves onto the
  book page (PR 2).
- **#287** — added the book-scoped export ("Run export now" with a scope
  picker); this doc reuses that plumbing (`exportsRun({ book })`) behind a
  "Publish this book" button on the book page (PR 4).
- **#289 / PR #291** — the unfoldingWord source preset; this doc wires it into
  the inline "bring in this book" picker as a one-click source (PR 3).
- **#104** — per-book/per-chapter source overrides (`book_source_overrides`,
  Tier 2 ranges); the mechanism whose config placement PR 2 relocates and whose
  hold-out semantics PR 1 changes from publish-block to reimport-guard.
