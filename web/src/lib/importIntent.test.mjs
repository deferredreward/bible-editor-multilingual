// Tests for the pure IMPORT-surface decision logic (web/src/lib/importIntent.ts).
// The load-bearing claim is SAFETY: an already-imported book must never be
// routed to the destructive POST /import.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings --test src/lib/importIntent.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { defaultIntent, importActionFor } from "./importIntent.ts";

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
