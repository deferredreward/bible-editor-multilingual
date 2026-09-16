// Deterministic core of the translate runner: batching, pack rendering,
// whole-book chapter merge, and the in-memory batch artifacts/validation.
// Ported from bp-assistant test/translate-core.test.js minus the
// translate-suggestions / context-write cases (not ported: bot-only context
// write-back) and with readBatchOutput reshaped to validateBatchOutput (text
// in, no file). Context-pack parsing/loading cases live in contextPack.test.mjs.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/core.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTnTsv, serializeTnTsv } from "./tsvCodec.ts";
import * as core from "./core.ts";
import { loadContextPack } from "./contextPack.ts";
import { fixture, fakeRawFetch, fixturePackFiles } from "./fixtures.mjs";

const rows = () => parseTnTsv(fixture("tn_OBA.tsv"));
const REF = "BSOJ/translation-context@master";
const loadFixturePack = () => loadContextPack(REF, { fetchImpl: fakeRawFetch(fixturePackFiles()) });

test("buildBatches respects row and char caps and loses no rows", () => {
  const all = rows();
  const batches = core.buildBatches(all);
  assert.equal(batches.flat().length, all.length);
  for (const b of batches) {
    assert.ok(b.length <= core.BATCH_MAX_ROWS);
    const chars = b.reduce((s, r) => s + (r.Note || "").length, 0);
    assert.ok(chars <= core.BATCH_MAX_NOTE_CHARS || b.length === 1,
      `batch of ${b.length} rows exceeds char cap (${chars})`);
  }
  assert.deepEqual(batches.flat().map((r) => r.ID), all.map((r) => r.ID));
});

test("buildBatches splits on the char cap before the row cap", () => {
  const big = "x".repeat(4000);
  const all = [1, 2, 3].map((i) => ({ Reference: `1:${i}`, ID: `r${i}`, Note: big }));
  assert.deepEqual(core.buildBatches(all).map((b) => b.length), [1, 1, 1]);
  assert.deepEqual(core.buildBatches(all, { maxNoteChars: 8000 }).map((b) => b.length), [2, 1]);
});

test("slugFromSupportReference extracts the tA slug", () => {
  assert.equal(core.slugFromSupportReference("rc://*/ta/man/translate/figs-metaphor"), "figs-metaphor");
  assert.equal(core.slugFromSupportReference(""), null);
  assert.equal(core.slugFromSupportReference(null), null);
});

test("selectExamples prefers slug matches, then recency, capped", () => {
  const ex = (rowId, slug, at) => ({ rowId, supportReference: slug ? `rc://*/ta/man/translate/${slug}` : null, source: rowId, target: rowId, validated_at: at, _seq: at });
  const examples = [ex("old-general", null, 1), ex("new-general", null, 9), ex("idiom", "figs-idiom", 5), ex("metaphor", "figs-metaphor", 2)];
  const picked = core.selectExamples(examples, ["figs-metaphor"]);
  assert.deepEqual(picked.map((e) => e.rowId), ["metaphor", "new-general", "idiom", "old-general"]);
  assert.equal(core.selectExamples(examples, [], 2).length, 2);
});

test("fetchResourceFile builds the DCS raw URL (branch vs commit) and maps 404 to null", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return url.endsWith("tn_OBA.tsv") ? { status: 200, ok: true, text: async () => "body" } : { status: 404, ok: false, text: async () => "" };
  };
  assert.equal(await core.fetchResourceFile("unfoldingWord/en_tn@master", "tn_OBA.tsv", { fetchImpl }), "body");
  assert.equal(urls[0], "https://git.door43.org/unfoldingWord/en_tn/raw/branch/master/tn_OBA.tsv");
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(await core.fetchResourceFile(`unfoldingWord/en_tn@${sha}`, "nope.tsv", { fetchImpl }), null);
  assert.equal(urls[1], `https://git.door43.org/unfoldingWord/en_tn/raw/commit/${sha}/nope.tsv`);
  await assert.rejects(core.fetchResourceFile("not-a-ref", "x", { fetchImpl }), /sourceRef must be "org\/repo@ref"/);
  const boom = async () => ({ status: 503, ok: false, text: async () => "" });
  await assert.rejects(core.fetchResourceFile("a/b@c", "x", { fetchImpl: boom }), /HTTP 503/);
});

test("renderBatchPack injects preferred/forbidden terms, register, active templates", async () => {
  const pack = await loadFixturePack();
  const batchRows = rows().filter((r) => /figs-metaphor|figs-idiom/.test(r.SupportReference)).slice(0, 4);
  assert.ok(batchRows.length >= 2);
  const rendered = core.renderBatchPack({
    batchRows, pack, targetLang: "ar", targetLangName: "Arabic", direction: "rtl",
  });
  assert.match(rendered.markdown, /قالب الاستعارة/);
  assert.match(rendered.markdown, /"Yahweh" → "يهوه"/);
  assert.match(rendered.markdown, /HARD CONSTRAINTS \(preferred/);
  assert.match(rendered.markdown, /FORBIDDEN/);
  assert.match(rendered.markdown, /do not translate/);
  assert.match(rendered.markdown, /\*\*formal\*\* register/);
  assert.ok(!/candidates \(prefer these/.test(rendered.markdown));
  assert.ok(rendered.slugs.includes("figs-metaphor"));
  assert.ok(rendered.templateFallbacks.includes("figs-idiom"));
  assert.match(rendered.markdown, /No Arabic template exists yet for/);
  // tombstoned a1 gone; c1 metaphor example present
  assert.match(rendered.markdown, /src C/);
  assert.ok(!/src A/.test(rendered.markdown));
  assert.match(rendered.markdown, /^# Translation context — Arabic \(ar, right-to-left\)/);
});

test("renderTerminologySections covers every status vocabulary bucket", () => {
  const parts = core.renderTerminologySections([
    { source: "a", target: "أ", status: "preferred", comment: "c" },
    { source: "b", target: "ب", status: "admitted" },
    { source: "c", target: "ج", status: "deprecated" },
    { source: "d", target: "د", status: "forbidden", replacement: "ذ" },
    { source: "e", target: "", status: "do_not_translate" },
  ]);
  assert.equal(parts.length, 5);
  assert.match(parts[0], /"a" → "أ" \(c\)/);
  assert.match(parts[2], /never "د"; use "ذ" instead/);
  assert.match(parts[3], /do not use "ج" for "c"/);
  assert.match(parts[4], /leave "e" untranslated/);
});

test("mergeChapterIntoBook: fresh book equals serialized new rows", () => {
  const all = rows();
  const merged = core.mergeChapterIntoBook(null, all, { startChapter: 1, endChapter: 1 });
  assert.equal(merged, serializeTnTsv(all));
});

test("mergeChapterIntoBook replaces only the range, preserving other chapters", () => {
  const all = rows().slice(0, 20);
  const ch1 = all.slice(0, 10);
  const ch2 = all.slice(10).map((r, i) => ({ ...r, Reference: `2:${i + 1}` }));
  const bookText = serializeTnTsv([...ch1, ...ch2]);

  const newCh2 = ch2.map((r) => ({ ...r, Note: "ترجمة جديدة" }));
  const merged = core.mergeChapterIntoBook(bookText, newCh2, { startChapter: 2, endChapter: 2 });
  const mergedRows = parseTnTsv(merged);
  assert.deepEqual(mergedRows.slice(0, 10), ch1);
  assert.deepEqual(mergedRows.slice(10).map((r) => r.Note), newCh2.map(() => "ترجمة جديدة"));

  const newCh1 = ch1.map((r) => ({ ...r, Note: "الفصل الأول" }));
  const merged1 = core.mergeChapterIntoBook(bookText, newCh1, { startChapter: 1, endChapter: 1 });
  const merged1Rows = parseTnTsv(merged1);
  assert.deepEqual(merged1Rows.slice(0, 10).map((r) => r.Note), newCh1.map(() => "الفصل الأول"));
  assert.deepEqual(merged1Rows.slice(10), ch2);
});

test("mergeChapterIntoBook keeps front matter ahead of a middle-chapter replacement", () => {
  const front = { Reference: "front:intro", ID: "fr01", Tags: "", SupportReference: "", Quote: "", Occurrence: "0", Note: "intro" };
  const mk = (ref, id) => ({ Reference: ref, ID: id, Tags: "", SupportReference: "", Quote: "", Occurrence: "1", Note: "n" });
  const bookText = serializeTnTsv([front, mk("1:1", "a1"), mk("2:1", "b1"), mk("3:1", "c1")]);
  const merged = parseTnTsv(core.mergeChapterIntoBook(bookText, [{ ...mk("2:1", "b1"), Note: "new" }], { startChapter: 2, endChapter: 2 }));
  assert.deepEqual(merged.map((r) => [r.ID, r.Note]), [["fr01", "intro"], ["a1", "n"], ["b1", "new"], ["c1", "n"]]);
});

test("tsvResource builds the per-run descriptor from the registry", () => {
  const tn = core.tsvResource("tn");
  assert.equal(tn.resourceType, "tn");
  assert.equal(tn.file("oba"), "tn_OBA.tsv");
  assert.equal(tn.codec.HEADER, "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote");
  assert.deepEqual(tn.checkOpts, { passThroughColumns: tn.passThroughColumns, translateColumns: ["Note"] });
  assert.equal(tn.sizeOf({ Note: "abcd" }), 4);
  assert.throws(() => core.tsvResource("tw"), /not a TSV resource/);
});

test("buildBatchArtifacts mirrors the bot's writeBatchFiles contents under logical names", () => {
  const resource = core.tsvResource("tn");
  const batch = rows().slice(0, 3);
  const art = core.buildBatchArtifacts(2, {
    batchRows: batch, packMarkdown: "# pack\n", targetLang: "ar", targetLangName: "Arabic",
    direction: "rtl", book: "OBA", resource,
  });
  assert.equal(art.nn, "03");
  assert.deepEqual(art.names, { batchFile: "batch-03.tsv", packFile: "batch-03-pack.md", taskFile: "batch-03-task.json", outputFile: "batch-03-out.tsv" });
  assert.equal(art.sourceTsv, serializeTnTsv(batch));
  assert.equal(art.packMarkdown, "# pack\n");
  const task = JSON.parse(art.taskJson);
  assert.deepEqual(task, {
    task: "translate-tsv-batch",
    resourceType: "tn",
    passThroughColumns: ["Reference", "ID", "Tags", "SupportReference", "Quote", "Occurrence"],
    translateColumns: ["Note"],
    book: "OBA",
    targetLang: "ar",
    targetLangName: "Arabic",
    sourceLangName: "English",
    direction: "rtl",
    rowCount: 3,
    batchFile: "batch-03.tsv",
    packFile: "batch-03-pack.md",
    outputFile: "batch-03-out.tsv",
  });
  assert.ok(art.taskJson.includes("\n  \"task\""), "2-space pretty JSON like the bot");
  // Without a resource the tN defaults apply and passThroughColumns is omitted (JSON drops undefined).
  const bare = JSON.parse(core.buildBatchArtifacts(0, { batchRows: batch, packMarkdown: "", targetLang: "ar", targetLangName: "Arabic", direction: "rtl", book: "OBA" }).taskJson);
  assert.equal(bare.resourceType, "tn");
  assert.ok(!("passThroughColumns" in bare));
  assert.deepEqual(bare.translateColumns, ["Note"]);
});

test("validateBatchOutput surfaces check results and throws on missing/unparseable output", () => {
  const batch = rows().slice(1, 4);
  const out = batch.map((r) => ({ ...r, Note: "ترجمة" }));
  const { rows: parsed, checks } = core.validateBatchOutput(serializeTnTsv(out), batch);
  assert.equal(parsed.length, 3);
  assert.ok(checks);
  assert.ok(checks.ok, JSON.stringify(checks.errors));
  assert.throws(() => core.validateBatchOutput(null, batch), /no output/);
  assert.throws(() => core.validateBatchOutput("not a tsv", batch), /bad TSV header/);
  // A dropped row is a check failure, not an exception.
  const short = core.validateBatchOutput(serializeTnTsv(out.slice(0, 2)), batch);
  assert.ok(!short.checks.ok);
  assert.ok(short.checks.errors.some((e) => e.check === "missing-row"));
});

test("validateBatchOutput byte-preserves pass-through columns from source", () => {
  const batch = rows().slice(1, 4);
  // Simulate the model round-trip mangling the Quote: Note localized, and the
  // Hebrew Quote returned byte-different from source (a normalization drift or
  // any other re-emission). Healing must restore the source bytes verbatim.
  const out = batch.map((r) => ({ ...r, Note: "ترجمة", Quote: r.Quote + "ּ" }));
  const { rows: parsed } = core.validateBatchOutput(serializeTnTsv(out), batch);
  // Healed: each output Quote is byte-identical to its source row again.
  for (const p of parsed) {
    const src = batch.find((r) => r.ID === p.ID);
    assert.equal(p.Quote, src.Quote, `Quote must be restored verbatim for ${p.ID}`);
  }
});

test("buildTranslateReport carries the bot's shape with the editor's generatedBy", () => {
  const checks = { ok: true, errors: [], warnings: [{ check: "whitespace", severity: "warning", rowId: "a", message: "m" }] };
  const report = core.buildTranslateReport({
    book: "OBA", startChapter: 1, endChapter: 1, targetLang: "ar", sourceRef: "unfoldingWord/en_tn@master",
    contextRef: "BSOJ/translation-context@master", contextSha: "abc",
    batches: [{ nn: "01", rowCount: 15, attempts: 1, templateFallbacks: [], slugs: ["figs-metaphor"] }],
    checks, jobId: "job-1", generatedAt: "2026-09-15T00:00:00.000Z",
    llm: { provider: "claude", model: "claude-sonnet-5", inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001, calls: 1 },
  });
  assert.equal(report.version, 1);
  assert.equal(report.generatedBy, "bible-editor/translate");
  assert.equal(report.rowCount, 15);
  assert.deepEqual(report.batches, [{ batch: "01", rowCount: 15, attempts: 1, templateFallbacks: [], slugs: ["figs-metaphor"], path: undefined }]);
  assert.deepEqual(report.checks, { ok: true, errorCount: 0, warningCount: 1, errors: [], warnings: checks.warnings });
  assert.deepEqual(report.selection, { mergeMode: "range", verseStart: null, verseEnd: null, rowIds: null });
  assert.deepEqual(report.scope, { book: "OBA", startChapter: 1, endChapter: 1, articleId: null });
  assert.equal(report.llm.calls, 1);
  assert.equal(report.sourceLang, "en");
  const noLlm = core.buildTranslateReport({ targetLang: "ar", sourceRef: "x", contextRef: "y", checks, generatedBy: "bp-assistant/translate" });
  assert.ok(!("llm" in noLlm));
  assert.equal(noLlm.generatedBy, "bp-assistant/translate");
});

test("fetchResourceFile rejects a short read against the declared Content-Length", async () => {
  const res = (body, contentLength) => ({
    status: 200,
    ok: true,
    text: async () => body,
    headers: contentLength === undefined ? null : { get: (k) => (k.toLowerCase() === "content-length" ? contentLength : null) },
  });
  const ref = "unfoldingWord/en_tn@master";
  const whole = "Reference\tID\n1:1\ta1\n";
  const bytes = String(new TextEncoder().encode(whole).length);

  // Complete body → returned as-is.
  assert.equal(await core.fetchResourceFile(ref, "tn_OBA.tsv", { fetchImpl: async () => res(whole, bytes) }), whole);
  // No declared length (the HAB blind spot) → unverifiable here, still returned.
  assert.equal(await core.fetchResourceFile(ref, "tn_OBA.tsv", { fetchImpl: async () => res(whole, undefined) }), whole);
  // A longer-than-declared body is not a truncation (transfer encodings).
  assert.equal(await core.fetchResourceFile(ref, "tn_OBA.tsv", { fetchImpl: async () => res(whole, "3") }), whole);
  // Non-numeric header → ignored rather than fatal.
  assert.equal(await core.fetchResourceFile(ref, "tn_OBA.tsv", { fetchImpl: async () => res(whole, "chunked") }), whole);

  // Short body vs declared length → the twl_PSA data-loss signature. Never content.
  await assert.rejects(
    () => core.fetchResourceFile(ref, "tn_OBA.tsv", { fetchImpl: async () => res("Reference\tID\n", "99999") }),
    /truncated body \(13 of 99999 declared bytes\)/,
  );
  // Byte length, not char length: multi-byte content must not read as short.
  const arabic = "Reference\tID\tNote\n1:1\ta1\tترجمة\n";
  const arabicBytes = String(new TextEncoder().encode(arabic).length);
  assert.equal(await core.fetchResourceFile(ref, "tn_OBA.tsv", { fetchImpl: async () => res(arabic, arabicBytes) }), arabic);

  // 404 is still absence, not truncation.
  assert.equal(await core.fetchResourceFile(ref, "tn_OBA.tsv", { fetchImpl: async () => ({ status: 404, ok: false, headers: null, text: async () => "" }) }), null);
});
