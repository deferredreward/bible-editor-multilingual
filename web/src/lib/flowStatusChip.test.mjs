import test from "node:test";
import assert from "node:assert/strict";
import { resolveFlowChipStatus, flowChipKind } from "./flowStatusChip.ts";

// Every input defaults to false; each case overrides only what it exercises, so
// a row reads as the pure-precedence table it claims to be.
const base = {
  isCurrent: false,
  hasLiveDiff: false,
  draftPresent: false,
  approved: false,
  skipped: false,
  pending: false,
  aquifer: false,
  aiDrafted: false,
};
const resolve = (over) => resolveFlowChipStatus({ ...base, ...over });

test("empty / untouched row is a plain draft", () => {
  assert.equal(resolve({}), "draft");
});

test("precedence order, each winning over everything below it", () => {
  // The current row's live diff wins over every saved verdict (#342).
  assert.equal(
    resolve({ isCurrent: true, hasLiveDiff: true, approved: true, skipped: true, pending: true }),
    "editing",
  );
  // A persisted draft on a NON-current row wins over approved/pending too.
  assert.equal(
    resolve({ isCurrent: false, draftPresent: true, approved: true, pending: true, aquifer: true }),
    "unsaved",
  );
  // Below the unsaved tier: approved > skipped > pending > aquifer > aiDraft > draft.
  assert.equal(resolve({ approved: true, skipped: true, pending: true, aquifer: true, aiDrafted: true }), "approved");
  assert.equal(resolve({ skipped: true, pending: true, aquifer: true, aiDrafted: true }), "skipped");
  assert.equal(resolve({ pending: true, aquifer: true, aiDrafted: true }), "pending");
  assert.equal(resolve({ aquifer: true, aiDrafted: true }), "aquifer");
  assert.equal(resolve({ aiDrafted: true }), "aiDraft");
});

test("current-row-with-diff beats an approved verdict", () => {
  // This is the #342 case that the chip exists to protect.
  assert.equal(resolve({ isCurrent: true, hasLiveDiff: true, approved: true }), "editing");
  // ...but a current row with NO live diff falls through to its saved verdict.
  assert.equal(resolve({ isCurrent: true, hasLiveDiff: false, approved: true }), "approved");
});

test("the open row is judged by its live diff, not its persisted draft", () => {
  // A persisted draft on the CURRENT row does not by itself force "unsaved" —
  // it's hydrated into the editor, so hasLiveDiff is the signal. Without a live
  // diff the current row shows its saved verdict.
  assert.equal(resolve({ isCurrent: true, draftPresent: true, hasLiveDiff: false, approved: true }), "approved");
  assert.equal(resolve({ isCurrent: true, draftPresent: true, hasLiveDiff: true, approved: true }), "editing");
});

test("non-current drafted rows read Unsaved even when the chapter is approved", () => {
  // The list/done-list case: every drafted row that isn't the open one shows
  // Unsaved, so an approved chapter doesn't bury a drafted row as "Approved".
  assert.equal(resolve({ isCurrent: false, draftPresent: true, approved: true }), "unsaved");
  // A non-current row with no draft keeps its saved verdict.
  assert.equal(resolve({ isCurrent: false, draftPresent: false, approved: true }), "approved");
});

test("tq phone done-list: the current row holding a persisted draft is not mislabeled Approved (#348 part 2)", () => {
  // The bug: the phone done-list excluded the current id from the Unsaved branch
  // AND passed dirty=false, so the cursor row's persisted draft (surfaced as a
  // live diff, hasLiveDiff) read "Approved" while every other drafted row read
  // "Unsaved". Routed through the resolver with the current row's real diff, it
  // now resolves to editing.
  assert.equal(resolve({ isCurrent: true, hasLiveDiff: true, approved: true }), "editing");
});

test("scripture-lane laneChip (#366): a dirty current lane beats the verse's approved verdict", () => {
  // TranslateScriptureScreen.laneChip renders the OPEN verse's two lanes, so
  // both lanes feed isCurrent:true; laneDirty is the live-diff signal and
  // draftPresent stays false (a restored draft is already marked dirty on
  // hydration). The scripture screen has no aquifer/aiDraft/skip verdicts and
  // no non-current "unsaved" tier — it uses editing / approved / pending / draft.
  const lane = (over) =>
    resolve({ isCurrent: true, draftPresent: false, aquifer: false, aiDrafted: false, skipped: false, ...over });

  // The #366 bug: an approved verse whose current lane holds unsaved text must
  // read Edited (editing), not Approved.
  assert.equal(lane({ hasLiveDiff: true, approved: true }), "editing");
  // Human-touched (updated_by set) but not dirty, in an approved verse: the
  // approved verdict still shows (approved > pending). This preserves today's
  // "Approved" for a saved-and-approved lane.
  assert.equal(lane({ hasLiveDiff: false, pending: true, approved: true }), "approved");
  // Approved verse, untouched lane, no live diff → Approved.
  assert.equal(lane({ hasLiveDiff: false, approved: true }), "approved");
  // Not approved, human-touched save → pending (scripture labels it "Edited").
  assert.equal(lane({ hasLiveDiff: false, pending: true }), "pending");
  // Not approved, untouched import → draft (scripture labels it "Imported").
  assert.equal(lane({ hasLiveDiff: false }), "draft");
});

test("flowChipKind maps status → chip color", () => {
  assert.equal(flowChipKind("editing"), "edited");
  assert.equal(flowChipKind("unsaved"), "edited");
  assert.equal(flowChipKind("pending"), "edited");
  assert.equal(flowChipKind("approved"), "approved");
  assert.equal(flowChipKind("skipped"), "skip");
  assert.equal(flowChipKind("aquifer"), "aquifer");
  assert.equal(flowChipKind("aiDraft"), "draft");
  assert.equal(flowChipKind("draft"), "draft");
});
