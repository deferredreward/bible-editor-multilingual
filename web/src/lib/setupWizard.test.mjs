// Tests for the pure Setup-wizard helpers (web/src/lib/setupWizard.ts): step
// gating after Apply, import-error → replacement-step routing, the source-URL
// verify state machine's error classification, and the lane upstream-choice
// mapping.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings --test src/lib/setupWizard.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import {
  SETUP_STEPS,
  lanesNeedingReplacement,
  stepAfterApply,
  importErrorLane,
  verifyErrorKind,
  laneChoiceFromMode,
  toggleResourceChecked,
  door43RepoUrl,
} from "./setupWizard.ts";

test("stepAfterApply skips to import when no lane is quarantined", () => {
  assert.equal(stepAfterApply(null), SETUP_STEPS.importBook);
  assert.equal(stepAfterApply({}), SETUP_STEPS.importBook);
  assert.equal(
    stepAfterApply({ lit: { replacementRequired: false }, sim: { replacementRequired: false } }),
    SETUP_STEPS.importBook,
  );
});

test("stepAfterApply enters the replacement step when any lane is quarantined", () => {
  assert.equal(stepAfterApply({ lit: { replacementRequired: true } }), SETUP_STEPS.replacement);
  assert.equal(stepAfterApply({ sim: { replacementRequired: true } }), SETUP_STEPS.replacement);
});

test("lanesNeedingReplacement returns quarantined lanes in lit,sim order", () => {
  assert.deepEqual(lanesNeedingReplacement(null), []);
  assert.deepEqual(
    lanesNeedingReplacement({ lit: { replacementRequired: true }, sim: { replacementRequired: true } }),
    ["lit", "sim"],
  );
  assert.deepEqual(lanesNeedingReplacement({ sim: { replacementRequired: true } }), ["sim"]);
});

test("importErrorLane routes the wrapped lane-freeze message (in body.message)", () => {
  // The route wraps the thrown Error as import_failed with the lane in message.
  assert.equal(
    importErrorLane({ error: "import_failed", message: "lit_lane_replacement_required" }),
    "lit",
  );
  assert.equal(
    importErrorLane({ error: "import_failed", message: "sim_lane_replacement_required" }),
    "sim",
  );
});

test("importErrorLane also matches a bare error code, and ignores unrelated errors", () => {
  assert.equal(importErrorLane({ error: "lit_lane_replacement_required" }), "lit");
  assert.equal(importErrorLane({ error: "unknown_book" }), null);
  assert.equal(importErrorLane({ error: "import_failed", message: "network boom" }), null);
  assert.equal(importErrorLane(null), null);
  assert.equal(importErrorLane(undefined), null);
});

test("verifyErrorKind never turns a transient 503 into 'not_found'", () => {
  assert.equal(verifyErrorKind(400), "invalid");
  assert.equal(verifyErrorKind(404), "not_found");
  assert.equal(verifyErrorKind(503), "unreachable");
  assert.equal(verifyErrorKind(500), "unreachable");
  assert.equal(verifyErrorKind(undefined), "unreachable");
});

test("laneChoiceFromMode maps resourceSource mode to the lane control value", () => {
  assert.equal(laneChoiceFromMode("upstream"), "unfoldingWord");
  assert.equal(laneChoiceFromMode("override"), "url");
  assert.equal(laneChoiceFromMode("blank"), "none");
});

test("toggleResourceChecked: checked pulls upstream, unchecked defaults to blank", () => {
  assert.deepEqual(toggleResourceChecked(true), { mode: "upstream" });
  assert.deepEqual(toggleResourceChecked(false), { mode: "blank" });
});

test("door43RepoUrl builds the canonical repo web URL", () => {
  assert.equal(door43RepoUrl("BibleAquifer", "ar_tn"), "https://git.door43.org/BibleAquifer/ar_tn");
});
