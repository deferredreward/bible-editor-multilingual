// Tests for the locale-aware display formatters (web/src/lib/formatDate.ts).
//
// Run from web/:
//   node --experimental-strip-types --no-warnings --test src/lib/formatDate.test.mjs
//
// These drive the REAL i18next singleton (the same instance src/i18n/index.ts
// initializes) so the "language switch takes effect immediately" claim is
// tested end to end rather than through a stub. Expected strings are compared
// against a direct `toLocale*` call with the same locale tag instead of a
// hard-coded ICU rendering — that keeps the suite stable across ICU/CLDR
// versions and machine time zones while still proving the LOCALE is applied.

import assert from "node:assert";
import i18n from "i18next";
import {
  activeLocale,
  formatDate,
  formatDateTime,
  formatEpochSecondsDateTime,
  formatNumber,
  formatTime,
} from "./formatDate.ts";

let pass = 0;
function check(name, got, want) {
  assert.strictEqual(got, want, `${name}: expected "${want}", got "${got}"`);
  pass++;
  console.log(`  ok: ${name}`);
}
function checkNot(name, got, unwanted) {
  assert.notStrictEqual(got, unwanted, `${name}: expected something other than "${got}"`);
  pass++;
  console.log(`  ok: ${name}`);
}
function checkTrue(name, cond, msg) {
  assert.ok(cond, `${name}: ${msg}`);
  pass++;
  console.log(`  ok: ${name}`);
}

// A fixed instant: 2025-01-01T00:00:00Z. Every assertion compares two
// renderings of THIS instant, so the machine's time zone can't skew results.
const MS = Date.UTC(2025, 0, 1, 0, 0, 0);
const SEC = MS / 1000;
const ISO = new Date(MS).toISOString();
const DATE_OBJ = new Date(MS);

// ── before init: the singleton has no language, so we fall back to en ────────
check("pre-init locale falls back to en", activeLocale(), "en-u-nu-latn");

await i18n.init({
  lng: "en",
  fallbackLng: "en",
  resources: {
    en: { translation: {} },
    ar: { translation: {} },
    bn: { translation: {} },
    fa: { translation: {} },
  },
});

// ── locale resolution ───────────────────────────────────────────────────────
check("en resolves with the digit extension", activeLocale(), "en-u-nu-latn");

await i18n.changeLanguage("ar");
check("ar resolves with the digit extension", activeLocale(), "ar-u-nu-latn");

// ── a language switch changes the output (re-resolved per call) ─────────────
await i18n.changeLanguage("en");
const enDateTime = formatDateTime(MS);
check("en date-time matches the en locale", enDateTime, DATE_OBJ.toLocaleString("en-u-nu-latn"));

await i18n.changeLanguage("ar");
const arDateTime = formatDateTime(MS);
check("ar date-time matches the ar locale", arDateTime, DATE_OBJ.toLocaleString("ar-u-nu-latn"));
checkNot("switching to ar changed the rendering", arDateTime, enDateTime);

// Switching back must restore the earlier output — proof the language is
// re-read on every call and not captured in a module-level constant.
await i18n.changeLanguage("en");
check("switching back to en restores the en rendering", formatDateTime(MS), enDateTime);

// The same holds for the date-only and time-only variants.
await i18n.changeLanguage("ar");
check("ar date-only follows the UI language", formatDate(MS), DATE_OBJ.toLocaleDateString("ar-u-nu-latn"));
check("ar time-only follows the UI language", formatTime(MS), DATE_OBJ.toLocaleTimeString("ar-u-nu-latn"));
await i18n.changeLanguage("en");
checkNot("en date-only differs from ar", formatDate(MS), DATE_OBJ.toLocaleDateString("ar-u-nu-latn"));

// ── input forms: epoch ms, ISO string, Date object all agree ────────────────
check("epoch ms and ISO string agree", formatDateTime(ISO), formatDateTime(MS));
check("epoch ms and Date object agree", formatDateTime(DATE_OBJ), formatDateTime(MS));
check("epoch SECONDS helper matches ms", formatEpochSecondsDateTime(SEC), formatDateTime(MS));
check("date-only accepts an ISO string", formatDate(ISO), formatDate(DATE_OBJ));
check("time-only accepts an ISO string", formatTime(ISO), formatTime(DATE_OBJ));

// ── null / invalid input never leaks "Invalid Date" or "NaN" ────────────────
check("null date → empty string", formatDateTime(null), "");
check("undefined date → empty string", formatDateTime(undefined), "");
check("empty string date → empty string", formatDateTime(""), "");
check("whitespace string date → empty string", formatDateTime("   "), "");
check("unparseable string date → empty string", formatDateTime("not a date"), "");
check("NaN date → empty string", formatDateTime(Number.NaN), "");
check("Infinity date → empty string", formatDateTime(Number.POSITIVE_INFINITY), "");
check("Invalid Date object → empty string", formatDateTime(new Date("nope")), "");
check("null date-only → empty string", formatDate(null), "");
check("null time-only → empty string", formatTime(null), "");
check("null epoch-seconds → empty string", formatEpochSecondsDateTime(null), "");
check("undefined epoch-seconds → empty string", formatEpochSecondsDateTime(undefined), "");
// Epoch 0 is a real instant, not "missing" — it must still format.
checkTrue("epoch ms 0 still formats", formatDateTime(0).length > 0, "expected a rendering for 1970-01-01");

// ── options are passed through untouched (call sites keep their shape) ──────
check(
  "dateStyle option is forwarded",
  formatDate(MS, { dateStyle: "medium" }),
  DATE_OBJ.toLocaleDateString("en-u-nu-latn", { dateStyle: "medium" }),
);
check(
  "timeStyle option is forwarded",
  formatTime(MS, { timeStyle: "short" }),
  DATE_OBJ.toLocaleTimeString("en-u-nu-latn", { timeStyle: "short" }),
);

// ── numbers ─────────────────────────────────────────────────────────────────
check("en number grouping", formatNumber(1234567), (1234567).toLocaleString("en-u-nu-latn"));
check("numeric string is coerced", formatNumber("1234567"), formatNumber(1234567));
check("zero formats (not treated as missing)", formatNumber(0), "0");
check("null number → empty string", formatNumber(null), "");
check("undefined number → empty string", formatNumber(undefined), "");
check("NaN number → empty string", formatNumber(Number.NaN), "");
check("non-numeric string → empty string", formatNumber("abc"), "");
check("Infinity number → empty string", formatNumber(Number.POSITIVE_INFINITY), "");
check(
  "number options are forwarded",
  formatNumber(0.5, { style: "percent" }),
  (0.5).toLocaleString("en-u-nu-latn", { style: "percent" }),
);

// hi groups differently from en (lakh/crore: 12,34,567) — proof the UI
// language reaches Intl for numbers too, not just for dates.
await i18n.changeLanguage("hi");
check("hi number follows the UI language", formatNumber(1234567), (1234567).toLocaleString("hi-u-nu-latn"));
checkNot("hi number grouping differs from en", formatNumber(1234567), (1234567).toLocaleString("en-u-nu-latn"));

// ── the digit-system decision: LOCALE_EXTENSION forces Western digits ───────
// Eastern Arabic-Indic (٠-٩), Extended Arabic-Indic/Persian (۰-۹), Bengali
// (০-৯), Devanagari (०-९) — none of these may appear while the constant is
// "-u-nu-latn", because these values render beside Latin-digit verse refs.
const NON_LATIN_DIGITS = /[٠-٩۰-۹০-৯०-९]/;
for (const lang of ["ar", "bn", "fa", "hi"]) {
  await i18n.changeLanguage(lang);
  checkTrue(
    `${lang} numbers use Western digits`,
    !NON_LATIN_DIGITS.test(formatNumber(1234567)),
    `got "${formatNumber(1234567)}"`,
  );
  checkTrue(
    `${lang} timestamps use Western digits`,
    !NON_LATIN_DIGITS.test(formatDateTime(MS)),
    `got "${formatDateTime(MS)}"`,
  );
}

await i18n.changeLanguage("en");

console.log(`\nformatDate: all ${pass} assertions passed.`);
