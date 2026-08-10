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
    pluralBases = new Set([...bySuffix].filter(([, s]) => s.size >= 2).map(([b]) => b));
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
const outFile = process.argv[3] || join(LOCALES_DIR, `..`, `${locale}.missing.json`);

const enFlat = flatten(JSON.parse(readFileSync(join(LOCALES_DIR, "en.json"), "utf8")));
const en = basesOf(enFlat);
const locFlat = flatten(JSON.parse(readFileSync(join(LOCALES_DIR, `${locale}.json`), "utf8")));
const loc = basesOf(locFlat, en.pluralBases);

let requiredCats;
try {
  requiredCats = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
} catch {
  requiredCats = ["one", "other"];
}

const out = {};
for (const base of [...en.bases].sort()) {
  const isPlural = en.pluralBases.has(base);
  if (!isPlural) {
    if (loc.bases.has(base)) continue;
    out[base] = enFlat.get(base);
    continue;
  }
  // Plural base: emit each required category the locale is missing.
  const present = loc.cats.get(base) ?? new Set();
  const seed =
    enFlat.get(`${base}_other`) ??
    enFlat.get(`${base}_one`) ??
    enFlat.get([...PLURAL_SUFFIXES].map((s) => `${base}_${s}`).find((k) => enFlat.has(k)));
  for (const cat of requiredCats) {
    if (present.has(cat)) continue;
    out[`${base}_${cat}`] = enFlat.get(`${base}_${cat}`) ?? seed;
  }
}

writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`${locale}: ${Object.keys(out).length} keys to translate -> ${outFile}`);
console.log(`plural categories required for ${locale}: ${requiredCats.join("/")}`);
