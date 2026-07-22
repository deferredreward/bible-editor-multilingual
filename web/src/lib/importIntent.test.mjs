// Tests for the pure IMPORT-surface decision logic (web/src/lib/importIntent.ts).
// The load-bearing claim is SAFETY: an already-imported book must never be
// routed to the destructive POST /import.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings --test src/lib/importIntent.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultIntent,
  importActionFor,
  repullDefaultRange,
  classifyAiTranslateResult,
  mainPaneState,
} from "./importIntent.ts";

test("defaultIntent: not-imported book defaults to translate", () => {
  assert.equal(defaultIntent(false), "translate");
});

test("defaultIntent: imported book defaults to load", () => {
  assert.equal(defaultIntent(true), "load");
});

test("routing: not-imported + translate → destructive import from upstream source", () => {
  assert.deepEqual(importActionFor(false, "translate"), {
    kind: "import",
    translateFromSource: true,
  });
});

test("routing: not-imported + load → destructive import from own repo", () => {
  assert.deepEqual(importActionFor(false, "load"), {
    kind: "import",
    translateFromSource: false,
  });
});

test("SAFETY: imported + load never hits destructive import — routes to editor", () => {
  assert.deepEqual(importActionFor(true, "load"), { kind: "open" });
});

test("SAFETY: imported + translate never hits destructive import — routes to editor", () => {
  assert.deepEqual(importActionFor(true, "translate"), { kind: "open" });
});

test("SAFETY invariant: importActionFor never returns kind:import for an imported book", () => {
  for (const intent of ["translate", "load"]) {
    const action = importActionFor(true, intent);
    assert.notEqual(
      action.kind,
      "import",
      `imported book with intent=${intent} must not be destructively imported`,
    );
  }
});

// ── repullDefaultRange: the re-pull default must span the WHOLE book ──

test("repullDefaultRange: empty chapter list falls back to '1'", () => {
  assert.equal(repullDefaultRange([]), "1");
});

test("repullDefaultRange: single chapter → that chapter, no range", () => {
  assert.equal(repullDefaultRange([7]), "7");
});

test("repullDefaultRange: multi-chapter book → whole-book range (not just ch 1)", () => {
  assert.equal(repullDefaultRange([1, 2, 3, 4, 5]), "1-5");
});

test("repullDefaultRange: unsorted input spans min..max", () => {
  assert.equal(repullDefaultRange([3, 1, 2, 50, 10]), "1-50");
});

// ── classifyAiTranslateResult: failures must not read as success ──

test("classifyAiTranslate: nothing started or already-running → failed", () => {
  assert.equal(classifyAiTranslateResult({ started: 0, skipped: 0, failed: 0 }), "failed");
  assert.equal(classifyAiTranslateResult({ started: 0, skipped: 0, failed: 5 }), "failed");
});

test("classifyAiTranslate: some started but some failed → partial (warning, not success)", () => {
  assert.equal(classifyAiTranslateResult({ started: 3, skipped: 0, failed: 2 }), "partial");
  assert.equal(classifyAiTranslateResult({ started: 0, skipped: 2, failed: 1 }), "partial");
});

test("classifyAiTranslate: clean run (no failures) → success", () => {
  assert.equal(classifyAiTranslateResult({ started: 5, skipped: 0, failed: 0 }), "success");
  assert.equal(classifyAiTranslateResult({ started: 3, skipped: 2, failed: 0 }), "success");
});

// ── mainPaneState: don't render the pane before imported-status is known ──

test("mainPaneState: no book selected → empty (regardless of load state)", () => {
  assert.equal(mainPaneState(false, false), "empty");
  assert.equal(mainPaneState(false, true), "empty");
});

test("mainPaneState: book selected but books not loaded → loading (gate the pane)", () => {
  assert.equal(mainPaneState(true, false), "loading");
});

test("mainPaneState: book selected and books loaded → ready", () => {
  assert.equal(mainPaneState(true, true), "ready");
});
