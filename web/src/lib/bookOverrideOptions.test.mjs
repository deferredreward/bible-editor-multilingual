// Tests for the pure Source-overrides picker logic (web/src/lib/bookOverrideOptions.ts).
// The load-bearing claim (issue #282): the overrides picker must offer books that
// have NOT been imported yet, flagged as such — because the backend accepts
// overrides pre-import and range overrides take effect on the next full import.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings --test src/lib/bookOverrideOptions.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { bookOverrideOptions, defaultOverrideBook } from "./bookOverrideOptions.ts";

const ALL = ["GEN", "EXO", "MRK", "REV"];

test("bookOverrideOptions: offers every canonical book, imported ones flagged", () => {
  const opts = bookOverrideOptions(ALL, ["MRK"]);
  assert.deepEqual(opts, [
    { code: "GEN", imported: false },
    { code: "EXO", imported: false },
    { code: "MRK", imported: true },
    { code: "REV", imported: false },
  ]);
});

test("bookOverrideOptions: preserves canonical order regardless of imported set", () => {
  const opts = bookOverrideOptions(ALL, ["REV", "GEN"]);
  assert.deepEqual(opts.map((o) => o.code), ["GEN", "EXO", "MRK", "REV"]);
  assert.deepEqual(
    opts.filter((o) => o.imported).map((o) => o.code),
    ["GEN", "REV"],
  );
});

test("bookOverrideOptions: none imported → all flagged unimported (the #282 dead-end case)", () => {
  const opts = bookOverrideOptions(ALL, []);
  assert.ok(opts.every((o) => !o.imported));
  assert.equal(opts.length, ALL.length);
});

test("defaultOverrideBook: keeps a valid current selection", () => {
  assert.equal(defaultOverrideBook("MRK", ALL, ["GEN"]), "MRK");
});

test("defaultOverrideBook: drops a current selection that isn't a canonical code", () => {
  assert.equal(defaultOverrideBook("XYZ", ALL, ["EXO"]), "EXO");
});

test("defaultOverrideBook: no current → first imported book", () => {
  assert.equal(defaultOverrideBook(null, ALL, ["MRK", "REV"]), "MRK");
});

test("defaultOverrideBook: no current, nothing imported → first canonical book (never empty)", () => {
  assert.equal(defaultOverrideBook(null, ALL, []), "GEN");
});

test("defaultOverrideBook: empty canonical list → null", () => {
  assert.equal(defaultOverrideBook(null, [], []), null);
});
