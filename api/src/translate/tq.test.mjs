// TQ (translationQuestions) checks + core: pass-through discipline over the
// TQ column set, chapter merge / by-id update via the tq codec.
// Ported from bp-assistant test/translate-tq.test.js minus the Zulip
// resolveParams case (its editor-shaped equivalent is in params.test.mjs).
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/tq.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTsvCodec } from "./tsvCodec.ts";
import { getTsvResourceType } from "./resourceTypes.ts";
import { runChecks } from "./checks.ts";
import * as core from "./core.ts";
import { fixture } from "./fixtures.mjs";

const TQ = getTsvResourceType("tq");
const codec = makeTsvCodec(TQ.columns);
const CHECK_OPTS = { passThroughColumns: TQ.passThroughColumns, translateColumns: TQ.translateColumns };
const load = () => codec.parse(fixture("tq_OBA.tsv"));

// "translate" Question+Response with a marker that preserves rc:// links + digits.
function fakeTr(text) {
  if (!text) return text;
  const digits = [...new Set(text.match(/\d+/g) || [])];
  const rc = (text.match(/rc:\/\/[^\s\])]+/g) || []);
  return "ترجمة " + digits.join(" ") + " " + rc.join(" ") + " منتهى";
}

test("perfect TQ translation (Question+Response) passes all error checks", () => {
  const src = load();
  const tgt = src.map((r) => ({ ...r, Question: fakeTr(r.Question), Response: fakeTr(r.Response) }));
  const res = runChecks(src, tgt, CHECK_OPTS);
  assert.deepEqual(res.errors, [], JSON.stringify(res.errors.slice(0, 5), null, 2));
  assert.ok(res.ok);
});

test("touching a pass-through column (Quote/Reference/Occurrence) blocks", () => {
  const src = load().slice(0, 3);
  const tgt = src.map((r) => ({ ...r, Question: fakeTr(r.Question), Response: fakeTr(r.Response) }));
  tgt[0].Reference = "9:9";
  tgt[1].Quote = "tampered";
  tgt[2].Occurrence = "3";
  const res = runChecks(src, tgt, CHECK_OPTS);
  const checks = res.errors.map((e) => e.check);
  assert.ok(checks.includes("passthrough-reference"), checks.join(","));
  assert.ok(checks.includes("passthrough-quote"));
  assert.ok(checks.includes("passthrough-occurrence"));
});

test("empty Response blocks with a column-qualified check id; identical is a warning", () => {
  const src = load().slice(0, 2);
  const tgt = [
    { ...src[0], Question: fakeTr(src[0].Question), Response: "" }, // empty response
    { ...src[1] }, // untranslated (identical)
  ];
  const res = runChecks(src, tgt, CHECK_OPTS);
  assert.ok(res.errors.some((e) => e.check === "empty-translation-response" && e.rowId === src[0].ID));
  assert.ok(res.warnings.some((w) => w.check === "identical-to-source-question" && w.column === "Question"));
});

test("a dropped rc:// link in a translate column blocks (per-column)", () => {
  const src = [{ Reference: "1:1", ID: "ab12", Tags: "", Quote: "", Occurrence: "0",
    Question: "See [[rc://*/ta/man/translate/figs-metaphor]]?", Response: "yes" }];
  const tgt = [{ ...src[0], Question: "بدون رابط؟", Response: "نعم" }];
  const res = runChecks(src, tgt, CHECK_OPTS);
  assert.ok(res.errors.some((e) => e.check === "rc-links-question"));
});

test("buildBatches weighs Question+Response, loses no rows, preserves order", () => {
  const all = load();
  const sizeOf = (r) => TQ.translateColumns.reduce((s, c) => s + (r[c] || "").length, 0);
  const batches = core.buildBatches(all, { sizeOf });
  assert.equal(batches.flat().length, all.length);
  assert.deepEqual(batches.flat().map((r) => r.ID), all.map((r) => r.ID));
  // tsvResource() bakes the same weight function.
  const resource = core.tsvResource("tq");
  assert.deepEqual(core.buildBatches(all, { sizeOf: resource.sizeOf }), batches);
});

test("mergeChapterIntoBook with the tq codec replaces the range only", () => {
  const all = load().slice(0, 8);
  const ch1 = all.slice(0, 4);
  const ch2 = all.slice(4).map((r, i) => ({ ...r, Reference: `2:${i + 1}` }));
  const bookText = codec.serialize([...ch1, ...ch2]);
  const newCh2 = ch2.map((r) => ({ ...r, Question: "س", Response: "ج" }));
  const merged = core.mergeChapterIntoBook(bookText, newCh2, {
    startChapter: 2, endChapter: 2, parse: codec.parse, serialize: codec.serialize,
  });
  const rows = codec.parse(merged);
  assert.deepEqual(rows.slice(0, 4), ch1); // ch1 untouched
  assert.deepEqual(rows.slice(4).map((r) => r.Question), newCh2.map(() => "س"));
});

test("updateRowsById with the tq codec updates only targeted rows", () => {
  const all = load();
  const bookText = codec.serialize(all);
  const target = all[2];
  const updated = [{ ...target, Question: "محدث", Response: "محدث" }];
  const merged = core.updateRowsById(bookText, updated, { parse: codec.parse, serialize: codec.serialize });
  const rows = codec.parse(merged);
  const changed = rows.filter((r, i) => JSON.stringify(r) !== JSON.stringify(all[i]));
  assert.equal(changed.length, 1);
  assert.equal(changed[0].ID, target.ID);
  assert.equal(changed[0].Quote, target.Quote); // pass-through preserved
});

test("validateBatchOutput with the tq resource copies back every tq pass-through column", () => {
  const resource = core.tsvResource("tq");
  const batch = load().slice(0, 3);
  const out = batch.map((r) => ({ ...r, Question: "س", Response: "ج", Quote: r.Quote + "x", Tags: "tampered" }));
  const { rows, checks } = core.validateBatchOutput(codec.serialize(out), batch, { parse: resource.codec.parse, checkOpts: resource.checkOpts });
  assert.ok(checks.ok, JSON.stringify(checks.errors));
  for (const p of rows) {
    const src = batch.find((r) => r.ID === p.ID);
    assert.equal(p.Quote, src.Quote);
    assert.equal(p.Tags, src.Tags);
    assert.equal(p.Question, "س");
  }
});
