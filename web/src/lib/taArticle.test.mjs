// Tests for the web translationAcademy (tA) article helpers
// (web/src/lib/taArticle.ts), mirroring api/src/articlePopulate.ts parseTaRef.
// Run from web/:
//   node --experimental-strip-types --no-warnings --test src/lib/taArticle.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { parseTaRef, taShort, taArticleDcsUrl } from "./taArticle.ts";

test("bare slug defaults manual to translate", () => {
  assert.deepEqual(parseTaRef("figs-metaphor"), { manual: "translate", slug: "figs-metaphor" });
});

test("bare manual/slug", () => {
  assert.deepEqual(parseTaRef("translate/figs-aside"), { manual: "translate", slug: "figs-aside" });
});

test("rc:// with man segment", () => {
  assert.deepEqual(parseTaRef("rc://en/ta/man/translate/figs-metaphor"), {
    manual: "translate",
    slug: "figs-metaphor",
  });
});

test("rc:// missing man segment", () => {
  assert.deepEqual(parseTaRef("rc://*/ta/translate/figs-metaphor"), {
    manual: "translate",
    slug: "figs-metaphor",
  });
});

test("unknown manual → null", () => {
  assert.equal(parseTaRef("bogus/figs-metaphor"), null);
});

test("bad slug chars → null", () => {
  assert.equal(parseTaRef("translate/../etc"), null);
  assert.equal(parseTaRef("translate/Figs_Metaphor!"), null);
});

test("3+ segments → null", () => {
  assert.equal(parseTaRef("rc://en/ta/man/translate/figs-metaphor/extra"), null);
});

test("null/empty → null", () => {
  assert.equal(parseTaRef(null), null);
  assert.equal(parseTaRef(undefined), null);
  assert.equal(parseTaRef(""), null);
  assert.equal(parseTaRef("   "), null);
});

test("taShort round-trips a parseable ref, passes through an unparseable one", () => {
  assert.equal(taShort("rc://en/ta/man/translate/figs-metaphor"), "translate/figs-metaphor");
  assert.equal(taShort("bogus/figs-metaphor"), "bogus/figs-metaphor");
  assert.equal(taShort(null), "");
});

test("taArticleDcsUrl is empty for an unparseable ref", () => {
  assert.equal(taArticleDcsUrl("bogus/figs-metaphor"), "");
  assert.equal(taArticleDcsUrl(null), "");
});

test("taArticleDcsUrl builds the expected Gitea page for a parseable ref", () => {
  assert.equal(
    taArticleDcsUrl("translate/figs-metaphor"),
    "https://git.door43.org/unfoldingWord/en_ta/src/branch/master/translate/figs-metaphor/01.md",
  );
});
