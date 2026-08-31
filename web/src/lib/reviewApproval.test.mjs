import test from "node:test";
import assert from "node:assert/strict";
import { isApprovableRow, liveRowCount, liveRows, reviewStats } from "./reviewApproval.ts";

test("ai_draft and edited rows are approvable", () => {
  assert.equal(isApprovableRow({ translation_state: "ai_draft" }), true);
  assert.equal(isApprovableRow({ translation_state: "edited" }), true);
});

test("pristine (null / undefined translation_state) rows are NOT approvable", () => {
  // These are the rows the server refuses to validate (translation_state IS NULL),
  // so including them made Approve-All 404 and halt on the first one (#238).
  assert.equal(isApprovableRow({ translation_state: null }), false);
  assert.equal(isApprovableRow({ translation_state: undefined }), false);
  assert.equal(isApprovableRow({}), false);
});

test("already-validated rows are NOT approvable (nothing to do)", () => {
  assert.equal(isApprovableRow({ translation_state: "validated" }), false);
});

test("trashed rows are never approvable, whatever their draft state", () => {
  // Validating a thrown-away note would promote it into the nightly few-shot set.
  assert.equal(
    isApprovableRow({ translation_state: "ai_draft", trashed_at: "2026-01-01T00:00:00Z" }),
    false,
  );
  assert.equal(
    isApprovableRow({ translation_state: "edited", trashed_at: "2026-01-01T00:00:00Z" }),
    false,
  );
});

test("a null trashed_at does not disqualify a drafted row", () => {
  assert.equal(isApprovableRow({ translation_state: "edited", trashed_at: null }), true);
});

// ── The one denominator (#238) ───────────────────────────────────────────────
//
// The reported OBA spread was 153 / 152 / 148 / 147 for a chapter holding 153
// non-deleted notes: 1 trashed, 4 validated, and 1 pristine (never drafted).
// This fixture reproduces that shape in miniature so the numbers are checkable
// by hand: 6 rows = 1 trashed + 2 validated + 2 drafted + 1 pristine.
const OBA_SHAPE = [
  { id: "a", translation_state: "validated" },
  { id: "b", translation_state: "validated" },
  { id: "c", translation_state: "ai_draft" },
  { id: "d", translation_state: "edited" },
  { id: "e", translation_state: null }, // imported, never drafted — not approvable
  { id: "f", translation_state: "ai_draft", trashed_at: 1785800000 },
];

test("reviewStats counts LIVE rows only — trashed is the axis that split 153 from 152", () => {
  const s = reviewStats(OBA_SHAPE);
  assert.equal(s.total, 5, "the trashed row is not part of the denominator");
  assert.equal(s.trashed, 1, "…but it is reported, so a surface can label it");
  assert.equal(s.validated, 2);
});

test("reviewStats.draftIds is exactly the approvable set — no pristine, no trashed", () => {
  const s = reviewStats(OBA_SHAPE);
  // The 148-vs-147 half of #238: the pristine row ("e") the server refuses to
  // validate must not be counted by the button, and the trashed drafted row
  // ("f") must not be either.
  assert.deepEqual(s.draftIds, ["c", "d"]);
});

test("reviewStats([]) is the zeroed shape a switched-off surface renders", () => {
  assert.deepEqual(reviewStats([]), { total: 0, validated: 0, draftIds: [], trashed: 0 });
});

test("tQ rows have no trashed_at at all, so the same helper is a no-op on that axis", () => {
  const s = reviewStats([
    { id: "q1", translation_state: "validated" },
    { id: "q2", translation_state: "edited" },
  ]);
  assert.equal(s.total, 2);
  assert.equal(s.trashed, 0);
  assert.deepEqual(s.draftIds, ["q2"]);
});

test("liveRowCount splits a displayed list into what counts and what is trashed", () => {
  assert.deepEqual(liveRowCount(OBA_SHAPE), { live: 5, trashed: 1 });
  assert.deepEqual(liveRowCount([]), { live: 0, trashed: 0 });
});

test("liveRows drops trashed rows and tolerates a missing chapter payload", () => {
  assert.deepEqual(
    liveRows(OBA_SHAPE).map((r) => r.id),
    ["a", "b", "c", "d", "e"],
  );
  assert.deepEqual(liveRows(undefined), []);
  assert.deepEqual(liveRows(null), []);
});

test("the badge denominator and the meter denominator are the same number", () => {
  // This equality IS the fix: classic showed "Notes 153" beside a "4 / 152"
  // meter because the badge used a raw array length and the meter used the
  // trashed-filtered count. Both now come from the same rule.
  assert.equal(liveRowCount(OBA_SHAPE).live, reviewStats(OBA_SHAPE).total);
});
