// params.ts: the editor-shaped resolveParams. The bot's resolveParams cases
// that did not depend on the Zulip command grammar or translate-targets.json
// (translate-select / translate-tq / translate-article tests) are ported here
// with the synthetic-route inputs expressed as a job options object.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/params.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveParams, langName, RTL_LANGS } from "./params.ts";

const oba1 = (extra = {}) => ({ book: "OBA", startChapter: 1, endChapter: 1, targetLang: "ar", provider: "claude", model: "claude-sonnet-5", ...extra });

test("resolveParams: whole chapter → range mode with tN defaults", () => {
  const p = resolveParams(oba1());
  assert.equal(p.resourceType, "tn");
  assert.equal(p.family, "tsv");
  assert.equal(p.skill, "translate-tn");
  assert.equal(p.mergeMode, "range");
  assert.equal(p.verseStart, null);
  assert.equal(p.startChapter, 1);
  assert.equal(p.endChapter, 1);
  assert.deepEqual(p.passThroughColumns, ["Reference", "ID", "Tags", "SupportReference", "Quote", "Occurrence"]);
  assert.deepEqual(p.translateColumns, ["Note"]);
  assert.equal(p.sourceRef, "unfoldingWord/en_tn@master");
  assert.equal(p.sourceLiteralRef, "unfoldingWord/en_ult@master");
  assert.equal(p.sourceSimplifiedRef, "unfoldingWord/en_ust@master");
  assert.equal(p.sourceLang, "en");
  assert.equal(p.sourceLangName, "English");
  assert.equal(p.targetLangName, "Arabic");
  assert.equal(p.direction, "rtl");
  assert.equal(p.thinking, "medium");
  assert.equal(p.provider, "claude");
  assert.equal(p.model, "claude-sonnet-5");
  assert.equal(p.contextRefExplicit, false);
});

test("resolveParams: endChapter defaults to startChapter; book is upper-cased", () => {
  const p = resolveParams({ book: "oba", startChapter: 2, targetLang: "id" });
  assert.equal(p.book, "OBA");
  assert.equal(p.endChapter, 2);
  assert.equal(p.direction, "ltr");
});

test("resolveParams: single verse and verse range → by-id mode", () => {
  const one = resolveParams(oba1({ verseStart: 5 }));
  assert.equal(one.mergeMode, "by-id");
  assert.equal(one.verseStart, 5);
  assert.equal(one.verseEnd, null); // selectRows treats null end as start (bot parity)
  const range = resolveParams(oba1({ verseStart: 5, verseEnd: 7, targetLang: "es-419" }));
  assert.equal(range.mergeMode, "by-id");
  assert.equal(range.verseEnd, 7);
  assert.equal(range.targetLang, "es-419");
  assert.equal(range.targetLangName, "Latin American Spanish");
});

test("resolveParams: rowIds → by-id mode; an empty list is chapter-wide", () => {
  const p = resolveParams(oba1({ rowIds: ["xm1w", "k9wc"] }));
  assert.equal(p.mergeMode, "by-id");
  assert.deepEqual(p.rowIds, ["xm1w", "k9wc"]);
  assert.equal(resolveParams(oba1({ rowIds: [] })).rowIds, null);
});

test("resolveParams: unknown lang derives {lang}_gl / {lang}_tn / glt / gst / translation-context; options override", () => {
  const xx = resolveParams({ book: "OBA", startChapter: 1, targetLang: "xyz" });
  assert.equal(xx.targetOrg, "xyz_gl");
  assert.equal(xx.repoName, "xyz_tn");
  assert.equal(xx.targetLiteralRef, "xyz_gl/xyz_glt@master");
  assert.equal(xx.targetSimplifiedRef, "xyz_gl/xyz_gst@master");
  assert.equal(xx.contextRef, "xyz_gl/translation-context@master");
  assert.equal(xx.targetLangName, "xyz");
  assert.equal(xx.direction, "ltr");

  const ov = resolveParams(oba1({
    targetOrg: "other_org", repoName: "other_tn", sourceRef: "BSOJ/ar_tn@master",
    literalRef: "BSOJ/ar_avd@master", simplifiedRef: "BSOJ/ar_nav@master",
    contextRef: "BSOJ/translation-context@abc", direction: "ltr", sourceLang: "ru", jobId: "job-9",
  }));
  assert.equal(ov.targetOrg, "other_org");
  assert.equal(ov.repoName, "other_tn");
  assert.equal(ov.sourceRef, "BSOJ/ar_tn@master");
  assert.equal(ov.targetLiteralRef, "BSOJ/ar_avd@master");
  assert.equal(ov.targetSimplifiedRef, "BSOJ/ar_nav@master");
  assert.equal(ov.contextRef, "BSOJ/translation-context@abc");
  assert.equal(ov.contextRefExplicit, true);
  assert.equal(ov.direction, "ltr"); // explicit direction beats the RTL derivation
  assert.equal(ov.sourceLangName, "Russian");
  assert.equal(ov.jobId, "job-9");
});

test("resolveParams: tq → tq resource, ar_tq repo, translate-tq skill, en_tq source", () => {
  const p = resolveParams(oba1({ resourceType: "tq" }));
  assert.equal(p.resourceType, "tq");
  assert.equal(p.family, "tsv");
  assert.equal(p.skill, "translate-tq");
  assert.equal(p.repoName, "ar_tq");
  assert.equal(p.book, "OBA");
  assert.equal(p.startChapter, 1);
  assert.deepEqual(p.translateColumns, ["Question", "Response"]);
  // pilot default: TQ sources from unfoldingWord/en_tq (source language English)
  assert.equal(p.sourceRef, "unfoldingWord/en_tq@master");
  assert.equal(p.sourceLang, "en");
});

test("resolveParams: article resource carries resourceType + articleId, no tsv scope", () => {
  const p = resolveParams({ resourceType: "tw", targetLang: "ar", articleId: "kt/god", sourceLang: "en" });
  assert.equal(p.resourceType, "tw");
  assert.equal(p.family, "article");
  assert.equal(p.skill, "translate-article");
  assert.equal(p.articleId, "kt/god");
  assert.equal(p.articleUrl, null);
  assert.equal(p.repoName, "ar_tw");
  assert.equal(p.sourceRef, "unfoldingWord/en_tw@master");
  assert.equal(p.book, null);
  assert.equal(p.mergeMode, "range");
  assert.equal(p.passThroughColumns, undefined);
  const url = "https://git.door43.org/unfoldingWord/en_ta/src/branch/master/translate/figs-aside";
  const ta = resolveParams({ resourceType: "ta", targetLang: "ar", articleUrl: url });
  assert.equal(ta.articleUrl, url);
  assert.equal(ta.articleId, null);
  assert.equal(ta.repoName, "ar_ta");
  assert.equal(ta.sourceRef, "unfoldingWord/en_ta@master");
});

test("resolveParams: validation errors name what is missing", () => {
  assert.throws(() => resolveParams({ startChapter: 1, targetLang: "ar" }), /book and startChapter are required for tn/);
  assert.throws(() => resolveParams({ book: "OBA", targetLang: "ar" }), /book and startChapter are required/);
  assert.throws(() => resolveParams({ book: "OBA", startChapter: 1, targetLang: "" }), /targetLang is required/);
  assert.throws(() => resolveParams({ resourceType: "tw", targetLang: "ar" }), /articleId or articleUrl is required/);
  assert.throws(() => resolveParams({ resourceType: "xx", targetLang: "ar" }), /unknown resourceType/);
});

test("langName / RTL_LANGS", () => {
  assert.equal(langName("ar"), "Arabic");
  assert.equal(langName("zz"), "zz");
  assert.equal(langName("constructor"), "constructor");
  assert.ok(RTL_LANGS.has("he") && RTL_LANGS.has("fa") && !RTL_LANGS.has("es"));
});
