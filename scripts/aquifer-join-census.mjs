// Phase-0 validation (throwaway diagnostic, not part of the runtime).
//
// For a given Aquifer language edition, join every book it covers to the current
// unfoldingWord/en_tn and report how cleanly each Aquifer note maps to an en_tn
// row. QUOTE-PRIMARY: the embedded original-language quote (Greek ltr / Hebrew
// rtl span, NFC) is language-independent and exact; the per-verse ordinal (#N) is
// NOT reliable across editions (Hindi reorders/repeats it). Repeated quotes at a
// ref are resolved by group order to the en_tn Occurrence. Also reports the
// hybrid ceiling (quote-match OR ordinal-in-range).
//
// Run:  node scripts/aquifer-join-census.mjs arb   (or hin, ...)
// Output: scripts/out/aquifer-census-<aqLang>.json  (+ a table on stdout)
//
// NOTE: Aquifer files use CANONICAL book numbers (40=MAT … 66=REV); en_tn is
// fetched by book CODE (tn_<CODE>.tsv), so the number only drives the Aquifer URL.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const aqLang = (process.argv[2] || "arb").toLowerCase();

const AQ_NUM = {
  GEN: "01", EXO: "02", LEV: "03", NUM: "04", DEU: "05", JOS: "06", JDG: "07",
  RUT: "08", "1SA": "09", "2SA": "10", "1KI": "11", "2KI": "12", "1CH": "13",
  "2CH": "14", EZR: "15", NEH: "16", EST: "17", JOB: "18", PSA: "19", PRO: "20",
  ECC: "21", SNG: "22", ISA: "23", JER: "24", LAM: "25", EZK: "26", DAN: "27",
  HOS: "28", JOL: "29", AMO: "30", OBA: "31", JON: "32", MIC: "33", NAM: "34",
  HAB: "35", ZEP: "36", HAG: "37", ZEC: "38", MAL: "39", MAT: "40", MRK: "41",
  LUK: "42", JHN: "43", ACT: "44", ROM: "45", "1CO": "46", "2CO": "47",
  GAL: "48", EPH: "49", PHP: "50", COL: "51", "1TH": "52", "2TH": "53",
  "1TI": "54", "2TI": "55", TIT: "56", PHM: "57", HEB: "58", JAS: "59",
  "1PE": "60", "2PE": "61", "1JN": "62", "2JN": "63", "3JN": "64", JUD: "65",
  REV: "66",
};

const nfc = (s) => (s || "").normalize("NFC").trim();
const DIGIT_MAP = {};
for (let i = 0; i < 10; i++) {
  DIGIT_MAP[String.fromCharCode(0x0660 + i)] = String(i);
  DIGIT_MAP[String.fromCharCode(0x0966 + i)] = String(i);
}
const normDigits = (s) => s.replace(/[٠-٩०-९]/g, (d) => DIGIT_MAP[d] ?? d);
function ordinalOf(title) {
  const m = /#\s*([0-9٠-٩०-९]+)|([0-9٠-٩०-९]+)\s*#/.exec(title || "");
  return m ? parseInt(normDigits(m[1] ?? m[2]), 10) : null;
}
function embeddedQuote(html) {
  const m = /direction:\s*(?:ltr|rtl)[^>]*>([\s\S]*?)<\/span>/.exec(html || "");
  return m ? nfc(m[1].replace(/<[^>]+>/g, "")) : "";
}
async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "aquifer-census" } });
  if (!res.ok) return null;
  return await res.text();
}
function parseTsv(raw) {
  const lines = raw.replace(/^﻿/, "").split(/\r?\n/);
  const header = lines[0].split("\t");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cells = lines[i].split("\t");
    if (cells.length < 7) continue;
    const r = {};
    header.forEach((h, j) => (r[h] = cells[j] ?? ""));
    rows.push(r);
  }
  return rows;
}

async function censusBook(code) {
  const num = AQ_NUM[code];
  const aqRaw = await fetchText(`https://raw.githubusercontent.com/BibleAquifer/UWTranslationNotes/main/${aqLang}/json/${num}.content.json`);
  if (aqRaw === null) return null;
  let items;
  try { items = JSON.parse(aqRaw); } catch { return { code, error: "json_parse" }; }
  const enRaw = await fetchText(`https://git.door43.org/unfoldingWord/en_tn/raw/branch/master/tn_${code}.tsv`);
  if (enRaw === null) return { code, error: "no_en_tn" };
  const en = parseTsv(enRaw);

  const enGroups = new Map();
  const enByRefCount = new Map();
  const enEmptyByRef = new Map();
  for (const r of en) {
    enByRefCount.set(r.Reference, (enByRefCount.get(r.Reference) || 0) + 1);
    const q = nfc(r.Quote);
    if (q) enGroups.set(`${r.Reference}\t${q}`, (enGroups.get(`${r.Reference}\t${q}`) || 0) + 1);
    else enEmptyByRef.set(r.Reference, (enEmptyByRef.get(r.Reference) || 0) + 1);
  }
  const aqGroups = new Map();
  const aqVerse = [];
  for (const it of items) {
    const usfm = it.associations?.passage?.[0]?.start_ref_usfm || "";
    if (!usfm.includes(" ")) continue;
    const ref = usfm.split(" ", 2)[1];
    const q = embeddedQuote(it.content);
    aqVerse.push({ ref, q, ord: ordinalOf(it.title) });
    if (q) aqGroups.set(`${ref}\t${q}`, (aqGroups.get(`${ref}\t${q}`) || 0) + 1);
  }

  let unique = 0, multiResolvable = 0, multiUnbalanced = 0, noMatch = 0, noQuote = 0;
  let quoteHit = 0, ordinalHit = 0, hybridHit = 0;
  for (const { ref, q, ord } of aqVerse) {
    const key = `${ref}\t${q}`;
    const enc = q ? (enGroups.get(key) || 0) : 0;
    const aqc = q ? (aqGroups.get(key) || 0) : 0;
    const quoteMatched = q && enc > 0 && (enc === 1 ? aqc === 1 || aqc === enc : aqc === enc);
    if (!q) { if ((enEmptyByRef.get(ref) || 0) > 0) noQuote++; else noMatch++; }
    else if (enc === 0) noMatch++;
    else if (enc === 1 && aqc === 1) unique++;
    else if (aqc === enc) multiResolvable++;
    else multiUnbalanced++;
    const ordInRange = ord != null && ord >= 1 && ord <= (enByRefCount.get(ref) || 0);
    if (quoteMatched) quoteHit++;
    if (ordInRange) ordinalHit++;
    if (quoteMatched || ordInRange) hybridHit++;
  }
  const total = unique + multiResolvable + multiUnbalanced + noMatch + noQuote;
  return {
    code, aqItems: items.length, enRows: en.length,
    unique, multiResolvable, multiUnbalanced, noMatch, noQuote, total,
    matchable: unique + multiResolvable, quoteHit, ordinalHit, hybridHit,
  };
}

const results = [];
let covered = 0;
const agg = { unique: 0, multiResolvable: 0, multiUnbalanced: 0, noMatch: 0, noQuote: 0, total: 0, matchable: 0, quoteHit: 0, ordinalHit: 0, hybridHit: 0 };

console.log(`Aquifer join census — language "${aqLang}" vs unfoldingWord/en_tn\n`);
console.log("BK    aqN    enN  quote%  ord%  hybrid%");
for (const code of Object.keys(AQ_NUM)) {
  const r = await censusBook(code);
  if (r === null) continue;
  covered++;
  results.push(r);
  if (r.error) { console.log(`${code.padEnd(4)} ERROR: ${r.error}`); continue; }
  for (const k of Object.keys(agg)) agg[k] += r[k];
  const pct = (n) => String(r.total ? +(100 * n / r.total).toFixed(1) : 0).padStart(6);
  console.log(`${code.padEnd(4)} ${String(r.aqItems).padStart(5)} ${String(r.enRows).padStart(5)} ${pct(r.quoteHit)} ${pct(r.ordinalHit)} ${pct(r.hybridHit)}`);
}
const p = (n) => (agg.total ? +(100 * n / agg.total).toFixed(2) : 0);
console.log(
  `\nCovered books: ${covered}/66   HYBRID matchable: ${agg.hybridHit}/${agg.total} (${p(agg.hybridHit)}%)\n` +
  `  quote-only: ${p(agg.quoteHit)}%   ordinal-only: ${p(agg.ordinalHit)}%\n` +
  `  quote detail — unique ${agg.unique}, multiResolvable ${agg.multiResolvable}, unbalanced ${agg.multiUnbalanced}, noMatch ${agg.noMatch}, noQuote ${agg.noQuote}`,
);

const outDir = resolve(repoRoot, "scripts/out");
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `aquifer-census-${aqLang}.json`);
writeFileSync(outPath, JSON.stringify({ aqLang, covered, aggregate: { ...agg, hybridPct: p(agg.hybridHit), quotePct: p(agg.quoteHit), ordinalPct: p(agg.ordinalHit) }, books: results }, null, 2));
console.log(`\nWrote ${outPath}`);
