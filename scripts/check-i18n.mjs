#!/usr/bin/env node
/**
 * i18n completeness checker.
 *
 * For every locale JSON in web/src/i18n/locales (except the en.json source of
 * truth), reports:
 *   - MISSING  — base keys present in en.json but absent from the locale.
 *   - PLURALS  — plural base keys whose locale is missing a CLDR plural
 *                category that i18next (via Intl.PluralRules) will actually
 *                request for that language.
 *   - STALE    — keys in the locale that don't exist in en.json.
 *
 * Plural-aware: i18next resolves a base key `foo` through suffixed variants
 * `foo_one` / `foo_other` and the CLDR categories `foo_zero` / `foo_two` /
 * `foo_few` / `foo_many`. Any of those satisfies the base key `foo`.
 *
 * Exits non-zero if any locale is incomplete (missing base, missing plural
 * category, or stale key).
 *
 * Run: node scripts/check-i18n.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(HERE, "..", "web", "src", "i18n", "locales");
const SOURCE = "en.json";

const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"];
const PLURAL_RE = new RegExp(`_(${PLURAL_SUFFIXES.join("|")})$`);

/** Flatten a nested translation object to a map of dotted-key -> string. */
function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

/**
 * From a flat key map, work out the set of "base" keys (plural variants
 * collapsed) and the set of plural base keys. A key is treated as a plural
 * variant only when a sibling with the same base but a *different* plural
 * suffix also exists — so a lone key that happens to end in a plural word
 * (there are none today, but be safe) is not misread as a plural.
 */
function analyze(flat) {
  const keys = [...flat.keys()];
  const bySuffixBase = new Map(); // base -> Set(suffix)
  for (const k of keys) {
    const m = k.match(PLURAL_RE);
    if (!m) continue;
    const base = k.slice(0, -(m[1].length + 1));
    if (!bySuffixBase.has(base)) bySuffixBase.set(base, new Set());
    bySuffixBase.get(base).add(m[1]);
  }
  const pluralBases = new Set();
  for (const [base, suffixes] of bySuffixBase) {
    if (suffixes.size >= 2 || !flat.has(base)) pluralBases.add(base);
  }
  const bases = new Set();
  const pluralCats = new Map(); // pluralBase -> Set(present categories)
  for (const k of keys) {
    const m = k.match(PLURAL_RE);
    if (m) {
      const base = k.slice(0, -(m[1].length + 1));
      if (pluralBases.has(base)) {
        bases.add(base);
        if (!pluralCats.has(base)) pluralCats.set(base, new Set());
        pluralCats.get(base).add(m[1]);
        continue;
      }
    }
    bases.add(k);
  }
  return { bases, pluralBases, pluralCats };
}

function load(file) {
  return JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8"));
}

const en = analyze(flatten(load(SOURCE)));

const localeFiles = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith(".json") && f !== SOURCE)
  .sort();

let failed = false;
console.log(`i18n check — source ${SOURCE} (${en.bases.size} base keys, ${en.pluralBases.size} plural)\n`);

for (const file of localeFiles) {
  const code = file.replace(/\.json$/, "");
  const loc = analyze(flatten(load(file)));

  const missing = [...en.bases].filter((k) => !loc.bases.has(k)).sort();
  const stale = [...loc.bases].filter((k) => !en.bases.has(k)).sort();

  // Which plural categories will i18next actually request for this language?
  let requiredCats;
  try {
    requiredCats = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
  } catch {
    requiredCats = ["one", "other"];
  }
  const pluralGaps = [];
  for (const base of en.pluralBases) {
    if (missing.includes(base)) continue; // already reported as fully missing
    const present = loc.pluralCats.get(base) ?? new Set();
    const gaps = requiredCats.filter((c) => !present.has(c));
    if (gaps.length) pluralGaps.push(`${base} [${gaps.join(", ")}]`);
  }

  const ok = !missing.length && !stale.length && !pluralGaps.length;
  if (ok) {
    console.log(`✓ ${code} — complete (plural cats: ${requiredCats.join("/")})`);
    continue;
  }
  failed = true;
  console.log(`✗ ${code} — INCOMPLETE`);
  if (missing.length) {
    console.log(`   MISSING (${missing.length}):`);
    for (const k of missing) console.log(`     - ${k}`);
  }
  if (pluralGaps.length) {
    console.log(`   PLURAL categories missing (needs ${requiredCats.join("/")}):`);
    for (const g of pluralGaps) console.log(`     - ${g}`);
  }
  if (stale.length) {
    console.log(`   STALE — not in ${SOURCE} (${stale.length}):`);
    for (const k of stale) console.log(`     - ${k}`);
  }
  console.log("");
}

if (failed) {
  console.error("\ni18n check FAILED — some locales are incomplete.");
  process.exit(1);
}
console.log("\nAll locales complete.");
