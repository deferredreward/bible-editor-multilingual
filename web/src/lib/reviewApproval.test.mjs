import test from "node:test";
import assert from "node:assert/strict";
import { isApprovableRow } from "./reviewApproval.ts";

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
