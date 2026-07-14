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
 * en.json is the single authority on what is plural: a base is plural iff en
 * provides >=2 distinct CLDR suffixes for it (en always ships _one + _other for
 * a real plural). Locales collapse their suffixed keys against en's plural-base
 * set, never their own — so a locale that ships only `_other` (id/th) still
 * satisfies the base, and a lone key that merely ends in a plural word (e.g. a
 * future "phase_one") is never misread as a plural.
 *
 * Also runs a code -> en ORPHAN scan: every `ns.key` literal referenced in the
 * web/src TS/TSX (whether via t("...") or a const map) must exist in en.json,
 * because neither tsc nor the locale check catches a key typo — i18next just
 * renders the raw string. Dynamic keys (t(`ns.${x}`)) can't be resolved
 * statically and are skipped.
 *
 * Exits non-zero if any locale is incomplete (missing base, missing plural
 * category, or stale key) or any code orphan is found.
 *
 * Run: node scripts/check-i18n.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(HERE, "..", "web", "src", "i18n", "locales");
const WEB_SRC_DIR = join(HERE, "..", "web", "src");
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
 * Reduce a flat key map to its "base" keys (plural variants collapsed).
 *
 * `knownPluralBases` is the authority on which bases are plural. Pass it for
 * locales (always en's set). Omit it for en itself, where plural bases are
 * derived as those with >=2 distinct CLDR suffixes.
 */
function analyze(flat, knownPluralBases) {
  const keys = [...flat.keys()];

  let pluralBases;
  if (knownPluralBases) {
    pluralBases = knownPluralBases;
  } else {
    const bySuffixBase = new Map(); // base -> Set(suffix)
    for (const k of keys) {
      const m = k.match(PLURAL_RE);
      if (!m) continue;
      const base = k.slice(0, -(m[1].length + 1));
      if (!bySuffixBase.has(base)) bySuffixBase.set(base, new Set());
      bySuffixBase.get(base).add(m[1]);
    }
    pluralBases = new Set();
    for (const [base, suffixes] of bySuffixBase) {
      if (suffixes.size >= 2) pluralBases.add(base);
    }
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

const enFlat = flatten(load(SOURCE));
const en = analyze(enFlat);

const localeFiles = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith(".json") && f !== SOURCE)
  .sort();

let failed = false;
console.log(`i18n check — source ${SOURCE} (${en.bases.size} base keys, ${en.pluralBases.size} plural)\n`);

for (const file of localeFiles) {
  const code = file.replace(/\.json$/, "");
  const loc = analyze(flatten(load(file)), en.pluralBases);

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

// ── code -> en orphan scan ────────────────────────────────────────────────
// Every static key passed to t("...") in the web/src TS/TSX must exist in
// en.json. A typo renders the raw key at runtime; tsc doesn't catch it and the
// locale check above only compares JSON files. Scoped to t("...") call sites
// (near-zero false positives — bare member access like `words.length` is not a
// t() call). Dynamic keys (t(`ns.${x}`)) don't match and are skipped; keys
// held in a const and passed indirectly aren't covered.
const T_CALL_RE = /\bt\(\s*["'`]([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)["'`]/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "locales" || entry === "node_modules") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\./.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

const orphans = new Map(); // key -> first file it appears in
for (const filePath of walk(WEB_SRC_DIR)) {
  const src = readFileSync(filePath, "utf8");
  for (const m of src.matchAll(T_CALL_RE)) {
    const key = m[1];
    // Plural-aware: a code ref to the base (or any variant) is satisfied by the
    // en base. Strip a trailing plural suffix before checking.
    const pm = key.match(PLURAL_RE);
    const base = pm ? key.slice(0, -(pm[1].length + 1)) : key;
    if (en.bases.has(base) || en.bases.has(key)) continue;
    if (!orphans.has(key)) orphans.set(key, filePath.slice(WEB_SRC_DIR.length + 1));
  }
}

if (orphans.size) {
  failed = true;
  console.log(`✗ code — ${orphans.size} ORPHAN key(s) referenced but not in ${SOURCE}:`);
  for (const [key, where] of [...orphans].sort()) {
    console.log(`     - ${key}  (${where})`);
  }
  console.log("");
}

if (failed) {
  console.error("\ni18n check FAILED — locales incomplete or code references an unknown key.");
  process.exit(1);
}
console.log("\nAll locales complete; no orphan code keys.");
