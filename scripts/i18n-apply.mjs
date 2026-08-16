#!/usr/bin/env node
/**
 * Merge flat translation maps into a locale JSON, and prune stale keys.
 *
 * Usage:
 *   node scripts/i18n-apply.mjs <locale> <flat.json> [<flat.json> ...]
 *   node scripts/i18n-apply.mjs <locale> <flat.json> --overwrite
 *   node scripts/i18n-apply.mjs <locale> --prune-stale
 *
 * Merging inserts each dotted key into the locale's nested tree, creating
 * intermediate objects as needed. Existing values are never overwritten — a
 * key already present in the locale is reported and skipped, so re-running is
 * safe and a translator can't silently clobber reviewed text.
 *
 * --overwrite additionally replaces values that are still in the SOURCE
 * language: either identical to en.json, or stale English left behind after
 * the en wording changed. Genuine translations are still never replaced. Use
 * this to fill a locale whose keys all exist but whose values were copied from
 * English.
 *
 * --prune-stale removes keys the locale has that en.json does not, using the
 * same plural-collapsing rules as check-i18n.mjs (a locale plural variant is
 * kept iff its base is a plural base in en).
 *
 * Key order follows en.json: after any change the locale tree is rebuilt in
 * en's order so diffs stay reviewable and locales stay comparable.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(HERE, "..", "web", "src", "i18n", "locales");
const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"];
const PLURAL_RE = new RegExp(`_(${PLURAL_SUFFIXES.join("|")})$`);

/**
 * Flatten to dotted keys, recording each key's REAL path segments.
 *
 * en.json contains object keys that literally contain a dot — e.g. `register`
 * (a string) sits beside `"register.default"` in the same object. Both flatten
 * to a dotted key, but only one is a nested path. Splitting the dotted key on
 * "." to rebuild would turn `register.default` into a nested object and silently
 * destroy the sibling `register` string. So carry the segments along.
 */
function flatten(obj, prefixPath = [], out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const path = [...prefixPath, k];
    const key = path.join(".");
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, path, out);
    else out.set(key, { value: v, path });
  }
  return out;
}

/** Rebuild a nested tree from entries carrying their own path segments. */
function nest(entries) {
  const root = {};
  for (const [key, { value, path }] of entries) {
    let node = root;
    for (let i = 0; i < path.length - 1; i++) {
      if (typeof node[path[i]] !== "object" || node[path[i]] === null) node[path[i]] = {};
      node = node[path[i]];
    }
    if (typeof node[path[path.length - 1]] === "object" && node[path[path.length - 1]] !== null) {
      throw new Error(`path collision writing ${key} — a nested object already occupies it`);
    }
    node[path[path.length - 1]] = value;
  }
  return root;
}

/**
 * Path to use for a key being ADDED to a locale: mirror en's structure exactly,
 * so a literal-dotted en key stays literal-dotted in the locale.
 */
function pathFor(key, enFlat, pluralBases) {
  if (enFlat.has(key)) return enFlat.get(key).path;
  // Plural variant en doesn't carry (e.g. Arabic _two): borrow the base's path
  // and swap the final segment's suffix.
  const m = key.match(PLURAL_RE);
  if (m) {
    const base = key.slice(0, -(m[1].length + 1));
    if (pluralBases.has(base)) {
      for (const suffix of PLURAL_SUFFIXES) {
        const sibling = `${base}_${suffix}`;
        if (!enFlat.has(sibling)) continue;
        const p = [...enFlat.get(sibling).path];
        p[p.length - 1] = p[p.length - 1].replace(PLURAL_RE, `_${m[1]}`);
        return p;
      }
    }
  }
  return key.split(".");
}

/**
 * Does the string contain a letter outside the Latin script?
 *
 * Used to tell a real translation from source text left behind. Punctuation and
 * symbols are ignored — an em dash or arrow in otherwise-English text must not
 * read as "translated". Only meaningful for non-Latin-script targets.
 */
function hasNonLatinLetter(s) {
  return typeof s === "string" && /\p{L}/u.test(s) && /[^\p{Script=Latin}\P{L}]/u.test(s);
}

/**
 * Plural bases of en: a base carrying BOTH `_one` and `_other`, the two
 * categories CLDR defines for English. Must stay identical to the rule in
 * check-i18n.mjs — if the two scripts disagree about what is plural, this one
 * writes files the checker then rejects.
 */
function enPluralBases(enFlat) {
  const bySuffix = new Map();
  for (const k of enFlat.keys()) {
    const m = k.match(PLURAL_RE);
    if (!m) continue;
    const b = k.slice(0, -(m[1].length + 1));
    if (!bySuffix.has(b)) bySuffix.set(b, new Set());
    bySuffix.get(b).add(m[1]);
  }
  return new Set([...bySuffix].filter(([, s]) => s.has("one") && s.has("other")).map(([b]) => b));
}

const locale = process.argv[2];
const rest = process.argv.slice(3);
if (!locale || !rest.length) {
  console.error("usage: node scripts/i18n-apply.mjs <locale> <flat.json>... | --prune-stale");
  process.exit(2);
}

const localePath = join(LOCALES_DIR, `${locale}.json`);
const enFlat = flatten(JSON.parse(readFileSync(join(LOCALES_DIR, "en.json"), "utf8")));
const pluralBases = enPluralBases(enFlat);
const locFlat = flatten(JSON.parse(readFileSync(localePath, "utf8")));

const coverage = JSON.parse(readFileSync(join(LOCALES_DIR, "..", "coverage.json"), "utf8"));
const sameAsEnglishOk = new Set(coverage.sameAsEnglish ?? []);

/** Does en.json define this key, directly or as a CLDR variant of a plural base? */
function isKnownKey(k) {
  if (enFlat.has(k)) return true;
  const m = k.match(PLURAL_RE);
  return !!m && pluralBases.has(k.slice(0, -(m[1].length + 1)));
}

const OVERWRITE = rest.includes("--overwrite");
const inputFiles = rest.filter((a) => !a.startsWith("--"));

let added = 0;
let skipped = 0;
let pruned = 0;
let replaced = 0;

if (rest.includes("--prune-stale") && inputFiles.length) {
  // Pruning ignores input files; silently discarding a translation batch would
  // look like the merge simply didn't take.
  console.error(`refusing to run: --prune-stale ignores input files (${inputFiles.join(", ")}).`);
  console.error(`run the merge and the prune as two separate commands.`);
  process.exit(2);
}

if (rest.includes("--prune-stale")) {
  // A locale key is valid iff en has it verbatim, or it is a CLDR variant of an
  // en plural base (locales legitimately carry categories en does not, e.g.
  // Arabic _two / _few / _many).
  for (const k of [...locFlat.keys()]) {
    if (enFlat.has(k)) continue;
    const m = k.match(PLURAL_RE);
    if (m && pluralBases.has(k.slice(0, -(m[1].length + 1)))) continue;
    locFlat.delete(k);
    pruned++;
    console.log(`  prune ${k}`);
  }
} else {
  for (const file of inputFiles) {
    const map = JSON.parse(readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(map)) {
      if (typeof v !== "string" || !v.trim()) {
        console.warn(`  ! ${k}: non-string/empty value, skipped`);
        skipped++;
        continue;
      }
      // A key en.json doesn't define can only become a STALE key that fails CI
      // later, far from the typo that caused it. Reject it here instead.
      if (!isKnownKey(k)) {
        console.warn(`  ! ${k}: not a key in en.json, skipped (typo?)`);
        skipped++;
        continue;
      }
      if (locFlat.has(k)) {
        if (!OVERWRITE) {
          console.warn(`  = ${k}: already present, kept existing`);
          skipped++;
          continue;
        }
        // --overwrite is for replacing values left in the SOURCE language; it
        // must never silently discard real translated text. A value is treated
        // as untranslated when it is identical to en.json, or when it is pure
        // ASCII while the incoming translation is not (the stale-English case:
        // an old en wording left behind after the source was reworded).
        // NB: the ASCII test only discriminates for non-Latin-script targets.
        // For a Latin-script locale (es/fr/pt) only the exact-match arm applies,
        // so a real translation is still never clobbered.
        // Allow-listed keys are *meant* to stay in English (brands, codes,
        // symbols). They look exactly like untranslated text to the heuristic
        // below, so --overwrite would silently replace them and the gate — which
        // only checks "differs from en" — would never notice.
        if (sameAsEnglishOk.has(k)) {
          console.warn(`  = ${k}: allow-listed as same-as-English, not overwritten`);
          skipped++;
          continue;
        }
        const existing = locFlat.get(k).value;
        // An unusable value (null, number, array, empty or whitespace-only) is
        // not a translation and check-i18n rejects it — so --overwrite must be
        // able to repair it. Without this arm the only fix was hand-editing.
        const unusable = typeof existing !== "string" || !existing.trim();
        const sameAsEn = enFlat.has(k) && existing === enFlat.get(k).value;
        const staleSourceText =
          typeof existing === "string" && !hasNonLatinLetter(existing) && hasNonLatinLetter(v);
        if (!unusable && !sameAsEn && !staleSourceText) {
          console.warn(`  ! ${k}: already translated, NOT overwritten`);
          skipped++;
          continue;
        }
        locFlat.set(k, { value: v, path: locFlat.get(k).path });
        replaced++;
        continue;
      }
      locFlat.set(k, { value: v, path: pathFor(k, enFlat, pluralBases) });
      added++;
    }
  }
}

// Reorder only when we ADDED keys — a new key has no natural home, so we place
// it where en puts it. A prune-only run keeps the file's existing order so the
// diff is exactly the deleted lines and stays reviewable.
const ordered = new Map();
if (!added) {
  for (const [k, v] of locFlat) ordered.set(k, v);
}
for (const enKey of added ? enFlat.keys() : []) {
  if (locFlat.has(enKey)) ordered.set(enKey, locFlat.get(enKey));
  const m = enKey.match(PLURAL_RE);
  if (!m) continue;
  const base = m ? enKey.slice(0, -(m[1].length + 1)) : enKey;
  if (!pluralBases.has(base)) continue;
  for (const suffix of PLURAL_SUFFIXES) {
    const variant = `${base}_${suffix}`;
    if (locFlat.has(variant) && !ordered.has(variant)) ordered.set(variant, locFlat.get(variant));
  }
}
for (const [k, v] of locFlat) if (!ordered.has(k)) ordered.set(k, v);

const tree = nest(ordered);
// Round-trip guard: re-flattening the tree we are about to write must reproduce
// exactly the keys and values we intended. This is what catches a path
// collision silently eating a sibling key (see flatten()'s note on `register`).
const roundTrip = flatten(tree);
for (const [k, { value }] of ordered) {
  if (!roundTrip.has(k)) throw new Error(`round-trip lost key ${k} — refusing to write`);
  if (roundTrip.get(k).value !== value) throw new Error(`round-trip changed value of ${k} — refusing to write`);
}
if (roundTrip.size !== ordered.size) {
  throw new Error(`round-trip size mismatch ${ordered.size} -> ${roundTrip.size} — refusing to write`);
}

writeFileSync(localePath, JSON.stringify(tree, null, 2) + "\n", "utf8");
console.log(
  `${locale}: +${added} added, ${replaced} replaced, ${skipped} skipped, ${pruned} pruned -> ${ordered.size} keys`,
);
