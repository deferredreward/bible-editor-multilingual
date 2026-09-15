// REPLAY INVARIANT (issue #445, design §E): the bot's recorded OBA→Arabic dry
// run (translate-pipeline/dry-run-ar-OBA, 2026-07-10, 153 rows in 11 batches)
// replayed through the ported pure functions with no LLM. Each recorded
// batch-NN-out.tsv is fed to validateBatchOutput as if it were the model reply
// for batch-NN.tsv; the merged book must be byte-identical to the recorded
// tn_OBA.tsv. This is the proof that the port produces the same bytes the bot
// did, so a step-6 live dry run only has to compare model output.
//
// Also pinned: the batch boundaries reproduce from the English source fixture
// (the bot ran unfoldingWord/en_tn@master unpinned on 2026-07-10, which is the
// same snapshot as test-fixtures/translate/tn_OBA.tsv), and the recorded
// report's per-batch slugs come out of renderBatchPack unchanged.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/replay.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTnTsv, sliceChapterRows } from "./tsvCodec.ts";
import { runChecks } from "./checks.ts";
import * as core from "./core.ts";
import { fixture } from "./fixtures.mjs";

const DRY = "dry-run-ar-OBA/";
const BATCH_COUNT = 11;
const nnOf = (i) => String(i).padStart(2, "0");

const resource = core.tsvResource("tn");
const sourceRows = sliceChapterRows(parseTnTsv(fixture("tn_OBA.tsv")), 1, 1);
const report = JSON.parse(fixture(`${DRY}translate-report.json`));

/** Recorded batch inputs/outputs, in order. */
function recordedBatches() {
  const out = [];
  for (let i = 1; i <= BATCH_COUNT; i++) {
    const nn = nnOf(i);
    out.push({
      nn,
      sourceText: fixture(`${DRY}work/batch-${nn}.tsv`),
      outputText: fixture(`${DRY}work/batch-${nn}-out.tsv`),
    });
  }
  return out;
}

test("the recorded run is the fixture we think it is", () => {
  assert.equal(report.rowCount, 153);
  assert.equal(report.batches.length, BATCH_COUNT);
  assert.equal(report.sourceRef, "unfoldingWord/en_tn@master");
  assert.equal(report.book, "OBA");
  assert.equal(sourceRows.length, 153, "English source fixture slices to the recorded row count");
});

test("batch boundaries reproduce from the English source fixture (15 rows / 7000 chars)", () => {
  const batches = core.buildBatches(sourceRows, { sizeOf: resource.sizeOf });
  assert.equal(batches.length, BATCH_COUNT);
  assert.deepEqual(batches.map((b) => b.length), report.batches.map((b) => b.rowCount));
  const recorded = recordedBatches();
  for (let i = 0; i < BATCH_COUNT; i++) {
    const rows = resource.codec.parse(recorded[i].sourceText);
    assert.deepEqual(batches[i], rows, `batch ${recorded[i].nn} rows == recorded batch-${recorded[i].nn}.tsv`);
    // and the codec re-emits the recorded batch file byte-for-byte
    assert.equal(core.buildBatchArtifacts(i, {
      batchRows: batches[i], packMarkdown: "", targetLang: "ar", targetLangName: "Arabic", direction: "rtl", book: "OBA", resource,
    }).sourceTsv, recorded[i].sourceText, `batch-${recorded[i].nn}.tsv serializes byte-identically`);
  }
});

test("every recorded model reply validates: checks.ok and pass-through columns byte-identical", () => {
  const passThrough = ["Reference", "ID", "Tags", "SupportReference", "Quote", "Occurrence"];
  for (const { nn, sourceText, outputText } of recordedBatches()) {
    const batchRows = resource.codec.parse(sourceText);
    const { rows, checks } = core.validateBatchOutput(outputText, batchRows, { parse: resource.codec.parse, checkOpts: resource.checkOpts });
    assert.ok(checks.ok, `batch ${nn}: ${JSON.stringify(checks.errors.slice(0, 3))}`);
    assert.equal(rows.length, batchRows.length, `batch ${nn} row count`);
    assert.deepEqual(rows.map((r) => r.ID), batchRows.map((r) => r.ID), `batch ${nn} row order`);
    // Strongest form: the model's raw reply already had the pass-through cells
    // byte-identical, so the copy-back is a no-op on this run — and the
    // validated rows carry the source bytes either way.
    const raw = resource.codec.parse(outputText);
    for (let i = 0; i < batchRows.length; i++) {
      for (const col of passThrough) {
        assert.equal(raw[i][col], batchRows[i][col], `batch ${nn} row ${batchRows[i].ID} raw ${col}`);
        assert.equal(rows[i][col], batchRows[i][col], `batch ${nn} row ${batchRows[i].ID} validated ${col}`);
      }
      assert.notEqual(rows[i].Note, batchRows[i].Note, `batch ${nn} row ${batchRows[i].ID} Note was translated`);
    }
  }
});

test("merging all 11 validated batches reproduces the recorded tn_OBA.tsv byte-for-byte", () => {
  const targetRows = [];
  for (const { sourceText, outputText } of recordedBatches()) {
    const batchRows = resource.codec.parse(sourceText);
    targetRows.push(...core.validateBatchOutput(outputText, batchRows, { parse: resource.codec.parse, checkOpts: resource.checkOpts }).rows);
  }
  // Whole-range validation, as translateChapters does before merging.
  const whole = runChecks(sourceRows, targetRows, resource.checkOpts);
  assert.ok(whole.ok, JSON.stringify(whole.errors.slice(0, 3)));
  assert.equal(whole.errors.length, report.checks.errorCount);
  assert.equal(whole.warnings.length, report.checks.warningCount);

  // The bot merged into a fresh book (no existing ar_tn OBA at the time).
  const merged = core.mergeChapterIntoBook(null, targetRows, {
    startChapter: 1, endChapter: 1, parse: resource.codec.parse, serialize: resource.codec.serialize,
  });
  const expected = fixture(`${DRY}tn_OBA.tsv`);
  assert.equal(merged.length, expected.length, "merged book length");
  assert.equal(merged, expected, "merged book is byte-identical to the recorded tn_OBA.tsv");

  // The by-id path is idempotent against the recorded book: re-applying any
  // batch's rows over the recorded book changes nothing.
  const mid = recordedBatches()[4];
  const midRows = core.validateBatchOutput(mid.outputText, resource.codec.parse(mid.sourceText), { parse: resource.codec.parse, checkOpts: resource.checkOpts }).rows;
  assert.equal(core.updateRowsById(expected, midRows, { parse: resource.codec.parse, serialize: resource.codec.serialize }), expected);
});

test("renderBatchPack derives the same per-batch slugs the recorded report lists", () => {
  const batches = core.buildBatches(sourceRows, { sizeOf: resource.sizeOf });
  const pack = { templates: new Map(), terms: [], examples: [] };
  for (let i = 0; i < BATCH_COUNT; i++) {
    const rendered = core.renderBatchPack({ batchRows: batches[i], pack, targetLang: "ar", targetLangName: "Arabic", direction: "rtl" });
    assert.deepEqual(rendered.slugs, report.batches[i].slugs, `batch ${nnOf(i + 1)} slugs`);
  }
});
