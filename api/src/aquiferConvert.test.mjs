// Unit tests for the Aquifer -> en_tn converter (aquiferConvert.ts).
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/aquiferConvert.test.mjs
//
// Fixtures are compact but use REAL Aquifer markup shapes: a leading ltr/rtl
// original-language quote span, a bold gloss, prose, and a trailing "(See: <TA>)"
// resourceReference paragraph.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convertAquiferBook,
  ordinalOf,
  embeddedQuote,
  aquiferRef,
  htmlToMarkdown,
  nfc,
} from "./aquiferConvert.ts";

const en = (Reference, ID, SupportReference, Quote, Occurrence, Note) => ({
  Reference, ID, Tags: "", SupportReference, Quote, Occurrence, Note,
});
const aq = (title, index_reference, start, content, end) => ({
  content_id: `c-${title}`,
  title,
  index_reference,
  content,
  associations: { passage: [{ start_ref_usfm: start, end_ref_usfm: end ?? start }] },
});
const noteHtml = (quote, dir, gloss, prose) =>
  `<p><strong><span style='direction: ${dir};'>${quote}</span></strong></p>` +
  `<p><strong>&quot;</strong><span><strong>${gloss}</strong></span><strong>&quot;</strong></p>` +
  `<p>${prose}</p>` +
  `<p>See: <span data-bnType="resourceReference" data-resourceId="26687" data-resourceType="UWTranslationManual">Assumed Knowledge</span></p>`;

test("ordinalOf handles #N, N# (RTL flip) and Arabic-indic/Devanagari digits", () => {
  assert.equal(ordinalOf("3 John 1:1 (#1)"), 1);
  assert.equal(ordinalOf("تيطس 1:1 (1#)"), 1);
  assert.equal(ordinalOf("راعوث ١:١ (#٢)"), 2);
  assert.equal(ordinalOf("यहूदा 1:1 (#३)"), 3);
  assert.equal(ordinalOf("Ruth - Introduction"), null);
});

test("embeddedQuote pulls the first ltr(Greek)/rtl(Hebrew) span, NFC-trimmed", () => {
  assert.equal(embeddedQuote("<p><span style='direction: ltr;'>ὁ πρεσβύτερος</span></p>"), "ὁ πρεσβύτερος");
  assert.equal(embeddedQuote("<span style='direction: rtl;'>בִּ⁠ימֵי֙</span>"), nfc("בִּ⁠ימֵי֙"));
  assert.equal(embeddedQuote("<p>no span here</p>"), "");
});

test("aquiferRef maps book intro, chapter intro, verse, and range", () => {
  assert.deepEqual(aquiferRef({ index_reference: "08000000", associations: { passage: [{ start_ref_usfm: "RUT 0:1" }] } }), { ref: "front:intro", isIntro: true });
  assert.deepEqual(aquiferRef({ index_reference: "08Ruth000", associations: { passage: [{ start_ref_usfm: "RUT 2:1" }] } }), { ref: "2:intro", isIntro: true });
  assert.deepEqual(aquiferRef({ index_reference: "08001001", associations: { passage: [{ start_ref_usfm: "RUT 1:1" }] } }), { ref: "1:1", isIntro: false });
  assert.deepEqual(aquiferRef({ index_reference: "08001002", associations: { passage: [{ start_ref_usfm: "RUT 1:2", end_ref_usfm: "RUT 1:8" }] } }), { ref: "1:2-8", isIntro: false });
  assert.deepEqual(aquiferRef({ index_reference: "64001006-64001007", associations: { passage: [{ start_ref_usfm: "3JN 1:6", end_ref_usfm: "3JN 1:7" }] } }), { ref: "1:6-7", isIntro: false });
});

test("htmlToMarkdown strips leading quote + trailing See-link, keeps prose", () => {
  const md = htmlToMarkdown(noteHtml("ὁ πρεσβύτερος", "ltr", "the elder", "John assumes Gaius knows who he is."));
  assert.ok(!md.includes("πρεσβύτερος"), "orig-language quote paragraph removed");
  assert.ok(!md.includes("resourceReference") && !md.includes("Assumed Knowledge"), "trailing See:TA removed");
  assert.ok(md.includes("John assumes Gaius knows who he is."), "prose kept");
});

test("htmlToMarkdown keeps headings/lists for intros", () => {
  const md = htmlToMarkdown("<h1>Introduction to Ruth</h1><h2>Part 1</h2><ol><li>Outline point</li></ol>", { isIntro: true });
  assert.ok(md.includes("# Introduction to Ruth"));
  assert.ok(md.includes("## Part 1"));
  assert.ok(md.includes("- Outline point"));
});

test("quote-primary: unique Greek quote match inherits en columns, no flag (language-independent)", () => {
  const enRows = [
    en("front:intro", "kwv9", "", "", "0", "# Intro"),
    en("1:1", "w99t", "rc://*/ta/man/translate/figs-explicit", "ὁ πρεσβύτερος", "1", "The elder..."),
  ];
  const items = [
    aq("3 यूहन्ना - परिचय", "64000000", "3JN 0:1", "<h1>परिचय</h1>"),
    aq("3 यूहन्ना 1:1 (#1)", "64001001", "3JN 1:1", noteHtml("ὁ πρεσβύτερος", "ltr", "प्राचीन", "यूहन्ना मानता है...")),
  ];
  const { notes, report } = convertAquiferBook(items, enRows);
  const r = notes.find((n) => n.enId === "w99t");
  assert.equal(r.joinMethod, "quote");
  assert.equal(r.reviewReason, null);
  assert.equal(r.supportReference, "rc://*/ta/man/translate/figs-explicit");
  assert.equal(r.quote, "ὁ πρεσβύτερος");
  assert.equal(r.occurrence, 1);
  assert.ok(r.note.includes("यूहन्ना मानता है"));
  assert.equal(report.matchedQuote, 1);
  assert.equal(report.matchedIntro, 1);
});

test("ordinal fallback flags for review when the quote does not match en", () => {
  const enRows = [
    en("1:1", "aaaa", "rc://*/ta/man/translate/figs-x", "מֵ⁠אֹ֥הֶל מוֹעֵ֖ד", "1", "from the tent"),
  ];
  const items = [
    aq("Leviticus 1:1 (#1)", "03001001", "LEV 1:1", noteHtml("לֵ⁠אמֹֽר׃ דַּבֵּ֞ר", "rtl", "saying", "Address the sons of Israel.")),
  ];
  const { notes, report } = convertAquiferBook(items, enRows);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].joinMethod, "ordinal");
  assert.ok(notes[0].reviewReason && notes[0].reviewReason.length > 0, "flagged for review");
  assert.equal(notes[0].enId, "aaaa");
  assert.equal(report.matchedOrdinal, 1);
  assert.equal(report.flagged, 1);
});

test("repeated quote at a ref: notes zip in order to the en Occurrences", () => {
  const enRows = [
    en("1:5", "id-a", "", "λόγος", "1", "n1"),
    en("1:5", "id-b", "", "λόγος", "2", "n2"),
  ];
  const items = [
    aq("Book 1:5 (#1)", "40001005", "X 1:5", noteHtml("λόγος", "ltr", "word", "first occurrence prose")),
    aq("Book 1:5 (#2)", "40001005", "X 1:5", noteHtml("λόγος", "ltr", "word", "second occurrence prose")),
  ];
  const { notes } = convertAquiferBook(items, enRows);
  assert.equal(notes[0].occurrence, 1);
  assert.ok(notes[0].note.includes("first occurrence"));
  assert.equal(notes[1].occurrence, 2);
  assert.ok(notes[1].note.includes("second occurrence"));
});

test("unmatched Aquifer note (no en_tn row) is returned minted + flagged with extracted quote", () => {
  const enRows = [en("2:1", "other", "", "χάρις", "1", "grace")];
  const items = [
    aq("Book 1:1 (#1)", "40001001", "X 1:1", noteHtml("ἀρχή", "ltr", "beginning", "unmatched prose")),
  ];
  const { notes, report } = convertAquiferBook(items, enRows);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].joinMethod, "unmatched");
  assert.equal(notes[0].enId, null);
  assert.equal(notes[0].quote, "ἀρχή");
  assert.ok(notes[0].reviewReason, "flagged");
  assert.ok(notes[0].note.includes("unmatched prose"));
  assert.equal(report.unmatched, 1);
  assert.equal(report.flagged, 1);
});

test("intro note attaches to front:intro / N:intro rows without a flag", () => {
  const enRows = [
    en("front:intro", "i0", "", "", "0", "# en book intro"),
    en("1:intro", "i1", "", "", "0", "# en ch1 intro"),
  ];
  const items = [
    aq("Ruth - Introduction", "08000000", "RUT 0:1", "<h1>Introduction to Ruth</h1>"),
    aq("Ruth intro - chapter 1", "08Ruth000", "RUT 1:1", "<h2>Chapter 1 notes</h2>"),
  ];
  const { notes, report } = convertAquiferBook(items, enRows);
  assert.equal(notes.find((n) => n.enId === "i0").joinMethod, "intro");
  assert.equal(notes.find((n) => n.enId === "i1").joinMethod, "intro");
  assert.equal(notes.find((n) => n.enId === "i1").reviewReason, null);
  assert.equal(report.matchedIntro, 2);
  assert.equal(report.flagged, 0);
});
