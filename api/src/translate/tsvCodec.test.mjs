// Registry + generic TSV codec (ported from bp-assistant
// test/translate-resource-types.test.js and the refVerseRange case of
// test/translate-select.test.js): round-trip tn and tq fixtures byte-identically,
// and confirm the registry column schemas match the real published files.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/tsvCodec.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTsvCodec, parseTnTsv, serializeTnTsv, refVerseRange, refChapter, normalizeSourceRows } from "./tsvCodec.ts";
import { RESOURCE_TYPES, getResourceType, getTsvResourceType, isTsvResource, isArticleResource } from "./resourceTypes.ts";
import { fixture } from "./fixtures.mjs";

test("registry families are classified correctly", () => {
  assert.ok(isTsvResource("tn") && isTsvResource("tq"));
  assert.ok(isArticleResource("tw") && isArticleResource("ta"));
  assert.ok(!isTsvResource("tw") && !isArticleResource("tn"));
  assert.throws(() => getResourceType("xx"), /unknown resourceType/);
  assert.throws(() => getTsvResourceType("tw"), /not a TSV resource/);
  // Prototype keys are not resource types.
  assert.ok(!isTsvResource("constructor") && !isArticleResource("__proto__"));
});

test("tn codec (via generic makeTsvCodec) matches the tN convenience codec exactly", () => {
  const raw = fixture("tn_OBA.tsv").replace(/\r\n/g, "\n");
  const codec = makeTsvCodec(RESOURCE_TYPES.tn.columns);
  const rows = codec.parse(raw);
  assert.deepEqual(rows, parseTnTsv(raw)); // same parse
  assert.equal(codec.serialize(rows), serializeTnTsv(rows)); // same serialize
  assert.equal(codec.serialize(rows), raw.endsWith("\n") ? raw : raw + "\n");
});

test("tq codec round-trips the real tq_OBA.tsv byte-identically", () => {
  const raw = fixture("tq_OBA.tsv").replace(/\r\n/g, "\n");
  const codec = makeTsvCodec(RESOURCE_TYPES.tq.columns);
  const rows = codec.parse(raw);
  assert.ok(rows.length > 5);
  // header is exactly the published TQ column order
  assert.equal(codec.HEADER, "Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse");
  assert.equal(codec.serialize(rows), raw.endsWith("\n") ? raw : raw + "\n");
  // pass-through vs translate column sets are disjoint and cover all columns
  const rt = RESOURCE_TYPES.tq;
  assert.deepEqual([...rt.passThroughColumns, ...rt.translateColumns].sort(), [...rt.columns].sort());
});

test("tq parser rejects a row with the wrong column count", () => {
  const codec = makeTsvCodec(RESOURCE_TYPES.tq.columns);
  const bad = codec.HEADER + "\n1:1\tab12\t\t\t0\tonly six columns here\n";
  assert.throws(() => codec.parse(bad), /expected 7 columns/);
});

test("parser rejects a wrong header and an empty document", () => {
  const codec = makeTsvCodec(RESOURCE_TYPES.tn.columns);
  assert.throws(() => codec.parse("Reference\tID\n1:1\tab12\n"), /bad TSV header/);
  assert.throws(() => codec.parse(""), /empty TSV/);
  assert.throws(() => makeTsvCodec(["Only"]), /requires a column list/);
});

test("CRLF input parses like LF and blank lines between rows are tolerated", () => {
  const codec = makeTsvCodec(RESOURCE_TYPES.tq.columns);
  const text = codec.HEADER + "\r\n1:1\tab12\t\t\t0\tQ?\tA.\r\n\r\n1:2\tcd34\t\t\t0\tQ2?\tA2.\r\n";
  const rows = codec.parse(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].Question, "Q2?");
});

test("refVerseRange parses verse and range, null for intro; refChapter handles front", () => {
  assert.deepEqual(refVerseRange("1:1"), { start: 1, end: 1 });
  assert.deepEqual(refVerseRange("1:5-7"), { start: 5, end: 7 });
  assert.deepEqual(refVerseRange("12:3–4"), { start: 3, end: 4 }); // en dash
  assert.equal(refVerseRange("front:intro"), null);
  assert.equal(refVerseRange("1:intro"), null);
  assert.equal(refChapter("front:intro"), "front");
  assert.equal(refChapter("12:3"), 12);
  assert.equal(refChapter("x:1"), null);
});

// ---------------------------------------------------------------------------
// Source normalization (#472)
// ---------------------------------------------------------------------------

test("normalizeSourceRows fills an empty Occurrence with 0 and leaves everything else alone", () => {
  const intro = { Reference: "6:intro", ID: "tfbm", Tags: "", SupportReference: "", Quote: "", Occurrence: "", Note: "# Intro" };
  const real = { Reference: "6:1", ID: "ab12", Tags: "", SupportReference: "", Quote: "word", Occurrence: "1", Note: "n" };
  const negative = { ...real, ID: "cd34", Occurrence: "-1" };
  const [a, b, c] = normalizeSourceRows([intro, real, negative]);

  assert.equal(a.Occurrence, "0", "the intro row is what occurrence-int used to reject");
  assert.equal(a.Note, "# Intro", "no other column is touched");
  assert.equal(b.Occurrence, "1");
  assert.equal(c.Occurrence, "-1", "-1 is a legal Occurrence and must survive");

  assert.equal(intro.Occurrence, "", "the input row is not mutated");
  assert.equal(b, real, "a row needing no change is returned by identity, not copied");
});

test("normalizeSourceRows ignores a resource with no Occurrence column", () => {
  const row = { Reference: "1:1", ID: "ab12", Note: "n" };
  const [out] = normalizeSourceRows([row]);
  assert.equal(out, row, "identity — nothing to normalize");
  assert.ok(!("Occurrence" in out), "a column the resource does not have is never invented");
  assert.deepEqual(normalizeSourceRows([]), []);
});
