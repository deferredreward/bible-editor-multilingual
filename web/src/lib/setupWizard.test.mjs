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
  verifyErrorKind,
  laneChoiceFromMode,
  toggleResourceChecked,
  door43RepoUrl,
  laneUrlChoiceSelection,
  clearedOverrideSelection,
  upstreamLanguageOf,
  jobActionable,
  replacementSpinnerVisible,
  describeBookError,
} from "./setupWizard.ts";

test("stepAfterApply goes straight to done when no lane is quarantined", () => {
  assert.equal(stepAfterApply(null), SETUP_STEPS.done);
  assert.equal(stepAfterApply({}), SETUP_STEPS.done);
  assert.equal(
    stepAfterApply({ lit: { replacementRequired: false }, sim: { replacementRequired: false } }),
    SETUP_STEPS.done,
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

test("laneUrlChoiceSelection makes the choice read as 'url' without committing a repo", () => {
  const sel = laneUrlChoiceSelection();
  assert.equal(laneChoiceFromMode(sel.mode), "url");
  assert.equal(sel.repo, undefined); // nothing committed until a URL verifies
});

test("clearedOverrideSelection resets to upstream when checked, blank when not", () => {
  assert.deepEqual(clearedOverrideSelection(true), { mode: "upstream" });
  assert.deepEqual(clearedOverrideSelection(false), { mode: "blank" });
});

test("upstreamLanguageOf uses the inferred code, falling back to 'en'", () => {
  assert.equal(upstreamLanguageOf("ar"), "ar");
  assert.equal(upstreamLanguageOf("  es-419 "), "es-419");
  assert.equal(upstreamLanguageOf(""), "en");
  assert.equal(upstreamLanguageOf(null), "en");
  assert.equal(upstreamLanguageOf(undefined), "en");
});

test("jobActionable is true only when a book needs retry/waive", () => {
  assert.equal(jobActionable([{ status: "pending" }, { status: "artifact_ok" }]), false);
  assert.equal(jobActionable([{ status: "retryable_error" }]), true);
  assert.equal(jobActionable([{ status: "artifact_ok" }, { status: "failed" }]), true);
  assert.equal(jobActionable([]), false);
});

test("replacementSpinnerVisible hides once ready or once a book needs action", () => {
  // Genuinely staging → spin.
  assert.equal(replacementSpinnerVisible("staging", [{ status: "pending" }]), true);
  // Ready (awaiting Activate) → no spin.
  assert.equal(replacementSpinnerVisible("ready", [{ status: "artifact_ok" }]), false);
  // Stuck on a retryable book → no spin (action required panel shows instead).
  assert.equal(replacementSpinnerVisible("staging", [{ status: "retryable_error" }]), false);
});

test("describeBookError maps sha_unavailable to a not-found location", () => {
  const src = { owner: "BibleAquifer", repo: "ar_avd", ref: "master" };
  assert.deepEqual(describeBookError(JSON.stringify({ error: "sha_unavailable" }), src), {
    kind: "not_found",
    location: "BibleAquifer/ar_avd@master",
  });
  // Bare (non-JSON) string form.
  assert.deepEqual(describeBookError("sha_unavailable", src), {
    kind: "not_found",
    location: "BibleAquifer/ar_avd@master",
  });
  // No ref → omit the @ref suffix.
  assert.deepEqual(describeBookError("sha_unavailable", { owner: "o", repo: "r" }), {
    kind: "not_found",
    location: "o/r",
  });
  // Other errors pass through as detail; empty → null.
  assert.deepEqual(describeBookError(JSON.stringify({ error: "boom" }), src), {
    kind: "other",
    detail: "boom",
  });
  assert.equal(describeBookError(null, src), null);
  assert.equal(describeBookError("", src), null);
});
