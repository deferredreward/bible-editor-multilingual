#!/usr/bin/env node
/**
 * Extract the keys a locale is missing, together with their English source
 * text, as a flat JSON map ready to hand to a translator (human or AI).
 *
 * Usage: node scripts/i18n-extract-missing.mjs <locale> [outFile]
 *
 * Emits the *actual* en.json keys to translate — including every CLDR plural
 * variant the target language requires, not just the base key. A base key that
 * is plural in en expands to one entry per category the target needs (Arabic
 * needs all six), each seeded with the nearest en variant so the translator
 * sees real source text rather than a bare key.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(HERE, "..", "web", "src", "i18n", "locales");
const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"];
const PLURAL_RE = new RegExp(`_(${PLURAL_SUFFIXES.join("|")})$`);

function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

function basesOf(flat, knownPluralBases) {
  const keys = [...flat.keys()];
  let pluralBases = knownPluralBases;
  if (!pluralBases) {
    const bySuffix = new Map();
    for (const k of keys) {
      const m = k.match(PLURAL_RE);
      if (!m) continue;
      const b = k.slice(0, -(m[1].length + 1));
      if (!bySuffix.has(b)) bySuffix.set(b, new Set());
      bySuffix.get(b).add(m[1]);
    }
    // Must match check-i18n.mjs / i18n-apply.mjs: a real en plural family ships
    // both `_one` and `_other`.
    pluralBases = new Set([...bySuffix].filter(([, s]) => s.has("one") && s.has("other")).map(([b]) => b));
  }
  const bases = new Set();
  const cats = new Map();
  for (const k of keys) {
    const m = k.match(PLURAL_RE);
    if (m) {
      const b = k.slice(0, -(m[1].length + 1));
      if (pluralBases.has(b)) {
        bases.add(b);
        if (!cats.has(b)) cats.set(b, new Set());
        cats.get(b).add(m[1]);
        continue;
      }
    }
    bases.add(k);
  }
  return { bases, pluralBases, cats };
}

const locale = process.argv[2];
if (!locale) {
  console.error("usage: node scripts/i18n-extract-missing.mjs <locale> [outFile]");
  process.exit(2);
}
// Default OUTSIDE the repo. The previous default wrote into web/src/i18n/,
// which is shipped source and isn't gitignored — easy to commit by accident.
const outFile = process.argv[3] || join(tmpdir(), `${locale}.missing.json`);

const enFlat = flatten(JSON.parse(readFileSync(join(LOCALES_DIR, "en.json"), "utf8")));
const en = basesOf(enFlat);
const locFlat = flatten(JSON.parse(readFileSync(join(LOCALES_DIR, `${locale}.json`), "utf8")));
const sameAsEnglishOk = new Set(
  JSON.parse(readFileSync(join(LOCALES_DIR, "..", "coverage.json"), "utf8")).sameAsEnglish ?? [],
);
const loc = basesOf(locFlat, en.pluralBases);

let requiredCats;
try {
  requiredCats = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
} catch {
  requiredCats = ["one", "other"];
}

/**
 * Does the locale still need work on this exact key?
 *
 * Missing entirely — or present but still holding the English text. The second
 * case matters: this script SEEDS plural categories with English, so a category
 * it emitted once is "present" forever after. Without this, a seeded-but-
 * untranslated `_few` was flagged by check-i18n yet never handed back to a
 * translator — the loop could not fix what the checker demanded.
 */
function needsWork(key, enText) {
  // Keys whose English form is correct in every language (brands, codes,
  // symbols) must not be handed to a translator as work.
  if (sameAsEnglishOk.has(key)) return false;
  const cur = locFlat.get(key);
  if (cur === undefined) return true;
  if (typeof cur !== "string" || !cur.trim()) return true;
  return enText !== undefined && cur.trim() === String(enText).trim();
}

const out = {};
for (const base of [...en.bases].sort()) {
  const isPlural = en.pluralBases.has(base);
  if (!isPlural) {
    const enText = enFlat.get(base);
    if (!needsWork(base, enText)) continue;
    out[base] = enText;
    continue;
  }
  // Plural base: emit each required category that is missing OR still English.
  const seed =
    enFlat.get(`${base}_other`) ??
    enFlat.get(`${base}_one`) ??
    enFlat.get([...PLURAL_SUFFIXES].map((s) => `${base}_${s}`).find((k) => enFlat.has(k)));
  for (const cat of requiredCats) {
    const key = `${base}_${cat}`;
    const enText = enFlat.get(key) ?? seed;
    if (!needsWork(key, enText)) continue;
    out[key] = enText;
  }
}

writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`${locale}: ${Object.keys(out).length} keys to translate -> ${outFile}`);
console.log(`plural categories required for ${locale}: ${requiredCats.join("/")}`);
