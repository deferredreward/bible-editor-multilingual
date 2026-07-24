// Tests for the ISO-language module (web/src/lib/isoLanguages.ts) — the curated
// code→{name,direction} table + RTL source-of-truth + resource-language
// pre-seed helper.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings --test src/lib/isoLanguages.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import {
  directionForLang,
  baseSubtag,
  lookupLanguage,
  resolveResourceLanguage,
  RTL_BASE_CODES,
} from "./isoLanguages.ts";

// Locks the COMPLETE RTL base set (not just the 7-code core). RTL_BASE_CODES is
// hand-maintained parity with api/src/orgInference.ts RTL_LANGS (the api/web
// build boundary prevents sharing one module) — if either side diverges, update
// BOTH and this assertion. The first 7 MUST equal orgInference's RTL_LANGS.
test("RTL_BASE_CODES: full set is locked (core 7 = orgInference RTL_LANGS, then widened variants)", () => {
  assert.deepEqual(
    [...RTL_BASE_CODES],
    [
      // core — MUST match api/src/orgInference.ts RTL_LANGS exactly
      "ar", "he", "fa", "ur", "ps", "syr", "dv",
      // widened variants
      "iw", "yi", "ckb", "sd", "ug", "prs", "pnb", "apc", "acm", "ary", "arz", "arb",
    ],
    "RTL_BASE_CODES drifted — reconcile with orgInference.ts RTL_LANGS",
  );
  // Every locked code actually resolves rtl through the public accessor.
  for (const code of RTL_BASE_CODES) {
    assert.equal(directionForLang(code), "rtl", `${code} resolves rtl`);
  }
});

test("directionForLang: RTL core set (parity with orgInference RTL_LANGS)", () => {
  for (const code of ["ar", "he", "fa", "ur", "ps", "syr", "dv"]) {
    assert.equal(directionForLang(code), "rtl", `${code} is rtl`);
  }
});

test("directionForLang: LTR for common gateway languages", () => {
  for (const code of ["en", "es", "fr", "hi", "id", "pt", "ru", "sw", "th"]) {
    assert.equal(directionForLang(code), "ltr", `${code} is ltr`);
  }
});

test("directionForLang: Arabic variants resolve rtl by base subtag", () => {
  for (const code of ["apc", "acm", "ary", "arz", "arb", "ar_avd", "ar-x-custom"]) {
    assert.equal(directionForLang(code), "rtl", `${code} is rtl`);
  }
});

test("directionForLang: unknown code defaults to ltr", () => {
  assert.equal(directionForLang("zz"), "ltr");
  assert.equal(directionForLang(""), "ltr");
});

test("baseSubtag strips region/script/private subtags", () => {
  assert.equal(baseSubtag("es-419"), "es");
  assert.equal(baseSubtag("ar_avd"), "ar");
  assert.equal(baseSubtag("EN"), "en");
});

test("lookupLanguage: exact hit returns name + direction", () => {
  assert.deepEqual(lookupLanguage("ar"), { name: "Arabic", direction: "rtl" });
  assert.deepEqual(lookupLanguage("en"), { name: "English", direction: "ltr" });
});

test("lookupLanguage: es-419 exact entry wins", () => {
  assert.equal(lookupLanguage("es-419").name, "Latin American Spanish");
});

test("lookupLanguage: falls back to base subtag when the full code is unknown", () => {
  // ar_avd not an entry; base 'ar' is
  assert.deepEqual(lookupLanguage("ar_avd"), { name: "Arabic", direction: "rtl" });
});

test("lookupLanguage: unknown code returns null", () => {
  assert.equal(lookupLanguage("zz"), null);
  assert.equal(lookupLanguage(""), null);
});

test("resolveResourceLanguage: inferred proposal wins, direction from code when omitted", () => {
  const r = resolveResourceLanguage(
    { languageCode: "ar", languageName: "العربية", direction: null },
    "en",
  );
  assert.equal(r.languageCode, "ar");
  assert.equal(r.languageName, "العربية");
  assert.equal(r.direction, "rtl");
});

test("resolveResourceLanguage: proposal direction is honored when present", () => {
  const r = resolveResourceLanguage(
    { languageCode: "xyz", languageName: "Custom", direction: "rtl" },
    "en",
  );
  assert.equal(r.direction, "rtl");
});

test("resolveResourceLanguage: falls back to the UI language when no inference", () => {
  const r = resolveResourceLanguage(null, "fa");
  assert.equal(r.languageCode, "fa");
  assert.equal(r.languageName, "Persian");
  assert.equal(r.direction, "rtl");
});

test("resolveResourceLanguage: fallback derives name from the curated table", () => {
  const r = resolveResourceLanguage({ languageCode: null }, "id");
  assert.equal(r.languageCode, "id");
  assert.equal(r.languageName, "Indonesian");
  assert.equal(r.direction, "ltr");
});

test("resolveResourceLanguage: unknown UI language still returns concrete values", () => {
  const r = resolveResourceLanguage(null, "zz");
  assert.equal(r.languageCode, "zz");
  assert.equal(r.languageName, "zz");
  assert.equal(r.direction, "ltr");
});
