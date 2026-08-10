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
 * provides BOTH `_one` and `_other` — exactly the two categories CLDR defines
 * for English. Locales collapse their suffixed keys against en's plural-base
 * set, never their own — so a locale that ships only `_other` (id/th) still
 * satisfies the base, and ordinary keys that merely end in plural words (e.g.
 * "step_one" beside "step_two") are never misread as one plural base.
 *
 * Also runs a code -> en ORPHAN scan: every `ns.key` literal referenced in the
 * web/src TS/TSX (whether via t("...") or a const map) must exist in en.json,
 * because neither tsc nor the locale check catches a key typo — i18next just
 * renders the raw string. Dynamic keys (t(`ns.${x}`)) can't be resolved
 * statically and are skipped.
 *
 * ── TIERING (why this can gate CI without demanding 13 translations) ────────
 * Most locales are machine-drafted and incomplete, and translating a new UI
 * string into all 13 languages is not a reasonable ask of every PR. So
 * web/src/i18n/coverage.json splits locales into two tiers:
 *
 *   gated    — must be complete, and its VALUES are checked, not just its keys.
 *              Fails on: a missing key or plural category; a value that isn't a
 *              non-empty string (null/number/array/""/"   " all used to pass as
 *              "present" and render nothing); a value still equal to English
 *              (compared trimmed — a trailing space used to defeat it); and a
 *              translation that drops an interpolation placeholder. Plural
 *              variants en doesn't carry (Arabic _zero/_two/_few/_many) are
 *              value-checked against en's _other, because i18n-extract-missing
 *              seeds those categories WITH English text — so an untranslated
 *              extract->apply round trip would otherwise pass silently.
 *              Keys whose English form is correct in that language — symbols,
 *              brand names, resource codes — are allow-listed in coverage.json.
 *              These are the languages we actually ship to a client.
 *   baseline — every other locale. coverage.json records what it currently HAS
 *              translated; losing any of that FAILS. Adding a new en string
 *              does NOT fail these locales — it just widens a backlog we
 *              already accept and will fill before that language is presented.
 *
 * So a PR that adds a UI string owes English + every gated locale, and nothing
 * else. The 12 backlog locales are a one-way ratchet: they can only improve or
 * hold, never lose ground, but they never block a feature either.
 *
 * STALE keys and code orphans fail for every locale in both tiers — both are
 * cheap to fix and are genuine rot rather than untranslated work.
 *
 * Run:  node scripts/check-i18n.mjs
 *       node scripts/check-i18n.mjs --update-baseline   (after translating, or
 *            after deliberately accepting a new gap in a baseline locale)
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const I18N_DIR = join(HERE, "..", "web", "src", "i18n");
const LOCALES_DIR = join(I18N_DIR, "locales");
const COVERAGE_FILE = join(I18N_DIR, "coverage.json");
const WEB_SRC_DIR = join(HERE, "..", "web", "src");
const SOURCE = "en.json";

const UPDATE_BASELINE = process.argv.includes("--update-baseline");

const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"];
const PLURAL_RE = new RegExp(`_(${PLURAL_SUFFIXES.join("|")})$`);
// Matches {{name}} and i18next format specs {{name, number}} / {{name, datetime}}.
// Only the variable NAME is compared, so adding or changing a format spec is not
// mistaken for dropping the placeholder.
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*(?:,[^}]*)?\}\}/g;

/** en plural families missing `_one` or `_other` — reported, never fatal. */
const enPluralWarnings = [];

/**
 * Is a locale value the same text as English, ignoring surrounding whitespace?
 *
 * Byte-equality alone was trivially defeated: a single trailing space on an
 * otherwise-English value passed the "not still English" check.
 */
function sameText(a, b) {
  return typeof a === "string" && typeof b === "string" && a.trim() === b.trim();
}

/**
 * Interpolation variable names in a string, as a multiset (name -> count).
 *
 * Counted, not de-duplicated: "A {{x}} B {{x}}" translated to "أ {{x}}" really
 * has dropped an interpolation, and a set comparison cannot see that.
 */
function placeholders(s) {
  const out = new Map();
  for (const m of String(s).matchAll(PLACEHOLDER_RE)) {
    out.set(m[1], (out.get(m[1]) ?? 0) + 1);
  }
  return out;
}

/** Names present in `a` more often than in `b`, as "{{name}}" labels. */
function placeholderDiff(a, b) {
  const out = [];
  for (const [name, n] of placeholders(a)) {
    const other = placeholders(b).get(name) ?? 0;
    if (n > other) out.push(`{{${name}}}${n > 1 ? ` x${n - other}` : ""}`);
  }
  return out.sort();
}

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
    // A real en plural family ships BOTH `_one` and `_other` — those are exactly
    // the two categories CLDR defines for English. Requiring both (rather than
    // "any 2 suffixes") stops two ordinary keys that happen to end in plural
    // words from being misread as one plural base: `setup.step_one` +
    // `setup.step_two` is a plausible wizard naming, and under the old rule it
    // invented a `setup.step` plural base and demanded `_few`/`_many`/... of
    // every gated locale — an unfixable false failure.
    pluralBases = new Set();
    for (const [base, suffixes] of bySuffixBase) {
      if (suffixes.has("one") && suffixes.has("other")) pluralBases.add(base);
    }
    // A partial family is an en authoring bug: i18next asks Intl.PluralRules for
    // a category, and if en never defined `_other` there is nothing to fall back
    // to. Warn rather than fail — the key may just be named unluckily.
    for (const [base, suffixes] of bySuffixBase) {
      if (pluralBases.has(base)) continue;
      if (suffixes.has("one") !== suffixes.has("other")) {
        enPluralWarnings.push(`${base} [has ${[...suffixes].sort().join(", ")}]`);
      }
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
  const path = join(LOCALES_DIR, file);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`✗ ${file} — cannot be read: ${e.message}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    // A raw JSON.parse stack trace in CI is a poor error for a trailing comma.
    console.error(`✗ ${file} — is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}

/** Render a coverage id for humans: `a.b` stays, `a.b#few` becomes `a.b [few]`. */
function fmtGap(id) {
  const i = id.indexOf("#");
  return i === -1 ? id : `${id.slice(0, i)} [${id.slice(i + 1)}]`;
}

let coverage;
try {
  coverage = JSON.parse(readFileSync(COVERAGE_FILE, "utf8"));
} catch (e) {
  console.error(`✗ coverage.json — cannot be read or parsed: ${e.message}`);
  process.exit(1);
}
const gated = new Set(coverage.gated ?? []);
const baseline = coverage.baseline ?? {};
const sameAsEnglishOk = new Set(coverage.sameAsEnglish ?? []);

const enFlat = flatten(load(SOURCE));
const en = analyze(enFlat);

const localeFiles = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith(".json") && f !== SOURCE)
  .sort();

// A gated locale that has no file on disk would otherwise be skipped entirely —
// the loop below iterates files, not the gated list — silently disabling the
// whole gate. A typo in `gated` (or a deleted locale) must be loud.
const missingGated = [...gated].filter((c) => !localeFiles.includes(`${c}.json`) && c !== "en");
if (missingGated.length) {
  console.error(`✗ coverage.json lists gated locale(s) with no file: ${missingGated.join(", ")}`);
  console.error(`  → fix the code in "gated", or restore ${missingGated.map((c) => `${c}.json`).join(", ")}.`);
  process.exit(1);
}

let failed = false;
// `hardFailed` excludes baseline-tier regressions, which --update-baseline is
// meant to forgive. A gated failure, a stale key, or a code orphan is never
// forgiven by rewriting the baseline.
let hardFailed = false;
const nextBaseline = {};
console.log(`i18n check — source ${SOURCE} (${en.bases.size} base keys, ${en.pluralBases.size} plural)`);
console.log(`gated locales (must be complete): ${[...gated].sort().join(", ") || "(none)"}\n`);

for (const file of localeFiles) {
  const code = file.replace(/\.json$/, "");
  const loc = analyze(flatten(load(file)), en.pluralBases);
  const isGated = gated.has(code);

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
    for (const c of requiredCats.filter((c) => !present.has(c))) pluralGaps.push(`${base}#${c}`);
  }

  // A "coverage id" is a base key the locale resolves, or `base#category` for
  // each required plural category it supplies. Uniform ids let one baseline
  // list cover both kinds.
  const gaps = [...missing, ...pluralGaps].sort();
  const missingSet = new Set(missing);
  const gapSet = new Set(gaps);
  const covered = [];
  for (const k of en.bases) {
    if (missingSet.has(k)) continue;
    if (!en.pluralBases.has(k)) {
      covered.push(k);
      continue;
    }
    for (const c of requiredCats) if (!gapSet.has(`${k}#${c}`)) covered.push(`${k}#${c}`);
  }
  covered.sort();
  nextBaseline[code] = covered;

  if (isGated) {
    // Tier 1: no tolerance. Every gap is a failure — and, uniquely for gated
    // locales, so is a value left byte-identical to English. Key presence alone
    // is a weak signal: copying en.json and shipping it would otherwise report
    // "complete" while rendering an entirely English UI. Values that are
    // legitimately identical (symbols, brand names, resource identifiers) are
    // listed in coverage.json's sameAsEnglish allow-list.
    const locFlatRaw = flatten(load(file));
    const untranslated = [];
    const badValues = [];
    const placeholderLoss = [];
    for (const [k, v] of locFlatRaw) {
      // Every value in a gated locale must be usable text. A null, a number, an
      // array, an empty string or a whitespace-only string all used to satisfy
      // "the key is present" and render as nothing (or as a bare number) in the
      // UI while CI reported the locale complete.
      if (typeof v !== "string" || !v.trim()) {
        badValues.push(`${k} = ${JSON.stringify(v)}`);
        continue;
      }

      // The English text to compare against. For a plural variant en does not
      // carry (Arabic's _zero/_two/_few/_many), fall back to en's _other/_one
      // for that base — otherwise those categories were never value-checked at
      // all, and i18n-extract-missing.mjs seeds them WITH English source text,
      // so an untranslated extract→apply round trip passed the gate silently.
      let enText = enFlat.get(k);
      if (enText === undefined) {
        const m = k.match(PLURAL_RE);
        const base = m ? k.slice(0, -(m[1].length + 1)) : null;
        if (base && en.pluralBases.has(base)) {
          enText = enFlat.get(`${base}_other`) ?? enFlat.get(`${base}_one`);
        }
      }
      if (enText === undefined) continue; // stale key; reported separately

      if (!sameAsEnglishOk.has(k) && sameText(enText, v)) {
        untranslated.push(k);
        continue;
      }

      // A translation that drops {{count}} or {{book}} renders a sentence with a
      // hole in it; one that INVENTS a placeholder renders a literal "{{bogus}}"
      // because i18next has nothing to substitute. Both are checked.
      //
      // Arabic legitimately omits {{count}} in _zero/_one/_two, where the wording
      // carries the number ("مسودة معزولة واحدة"). That exemption is limited to
      // genuine plural variants — an ordinary key that merely ends in "_one"
      // (see the plural-family rule above) must keep its placeholders.
      const pm = k.match(PLURAL_RE);
      const pluralBase = pm ? k.slice(0, -(pm[1].length + 1)) : null;
      const isPluralVariant = !!pluralBase && en.pluralBases.has(pluralBase);
      const smallCountForm = isPluralVariant && /^(zero|one|two)$/.test(pm[1]);

      const dropped = placeholderDiff(enText, v).filter(
        (p) => !(smallCountForm && p === "{{count}}"),
      );
      if (dropped.length) placeholderLoss.push(`${k} — missing ${dropped.join(", ")}`);

      const added = placeholderDiff(v, enText);
      if (added.length) placeholderLoss.push(`${k} — unresolvable ${added.join(", ")} (not in ${SOURCE})`);
    }
    untranslated.sort();
    badValues.sort();
    placeholderLoss.sort();

    const ok =
      !gaps.length && !stale.length && !untranslated.length && !badValues.length && !placeholderLoss.length;
    if (ok) {
      console.log(`✓ ${code} — GATED, complete (plural cats: ${requiredCats.join("/")})`);
      continue;
    }
    failed = true;
    hardFailed = true;
    console.log(`✗ ${code} — GATED and INCOMPLETE`);
    if (badValues.length) {
      console.log(`   UNUSABLE VALUES — must be a non-empty string (${badValues.length}):`);
      for (const b of badValues) console.log(`     - ${b}`);
    }
    if (untranslated.length) {
      console.log(`   UNTRANSLATED — value identical to English (${untranslated.length}):`);
      for (const k of untranslated) console.log(`     - ${k} = ${JSON.stringify(locFlatRaw.get(k))}`);
      console.log(`   → translate these, or add the key to "sameAsEnglish" in coverage.json`);
      console.log(`     if the English form is correct in this language (symbol, brand, code).`);
    }
    if (placeholderLoss.length) {
      console.log(`   PLACEHOLDER LOSS — interpolation dropped (${placeholderLoss.length}):`);
      for (const p of placeholderLoss) console.log(`     - ${p}`);
    }
    if (missing.length) {
      console.log(`   MISSING (${missing.length}):`);
      for (const k of missing) console.log(`     - ${k}`);
    }
    if (pluralGaps.length) {
      console.log(`   PLURAL categories missing (needs ${requiredCats.join("/")}):`);
      for (const g of pluralGaps) console.log(`     - ${fmtGap(g)}`);
    }
  } else {
    // Tier 2: a ratchet. Everything the baseline says is translated must still
    // be translated. New English strings are NOT demanded of this locale.
    const promised = new Set(baseline[code] ?? []);
    const coveredSet = new Set(covered);
    const lost = [...promised].filter((g) => !coveredSet.has(g)).sort();
    const gained = covered.filter((g) => !promised.has(g));

    if (lost.length) {
      failed = true;
      console.log(`✗ ${code} — LOST ${lost.length} key(s) this locale previously had:`);
      for (const g of lost) console.log(`     - ${fmtGap(g)}`);
      console.log(`   → restore these. If the en key was deliberately renamed or removed,`);
      console.log(`     delete it from every locale too, then run --update-baseline.`);
    } else {
      // "present", not "translated" — for a baseline locale this counts keys
      // that resolve, and says nothing about whether the value is in the target
      // language. Many are still English. Only gated locales are value-checked.
      // Count BASES for display, not coverage ids — ids include one entry per
      // required plural category, which made the ratio exceed 100%.
      const presentBases = en.bases.size - missing.length;
      const note = gained.length ? `, +${gained.length} newly filled — run --update-baseline` : "";
      console.log(`· ${code} — ${presentBases}/${en.bases.size} keys present, ${gaps.length} known gap(s)${note}`);
    }
  }

  if (stale.length) {
    failed = true;
    hardFailed = true;
    console.log(`✗ ${code} — STALE, not in ${SOURCE} (${stale.length}) — delete these:`);
    for (const k of stale) console.log(`     - ${k}`);
  }
}
console.log("");

// A baseline entry for a locale file that no longer exists is dead weight and
// would silently mask a deleted locale. Report it; don't fail on it.
const localeCodes = new Set(localeFiles.map((f) => f.replace(/\.json$/, "")));
const orphanBaselines = Object.keys(baseline).filter((c) => !localeCodes.has(c));
if (orphanBaselines.length) {
  console.log(`! coverage.json has baseline entries for missing locales: ${orphanBaselines.join(", ")}`);
  console.log(`  → run --update-baseline to drop them.\n`);
}

// en authoring smells: a plural family with `_one` but no `_other` (or vice
// versa) can't be resolved for every count. Not fatal — the key may simply be
// named unluckily — but worth surfacing once.
if (enPluralWarnings.length) {
  console.log(`! ${SOURCE} has ${enPluralWarnings.length} incomplete plural family(ies):`);
  for (const w of enPluralWarnings) console.log(`     - ${w}`);
  console.log(`  → a real plural needs both _one and _other in ${SOURCE}; otherwise rename the key.\n`);
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
  hardFailed = true;
  console.log(`✗ code — ${orphans.size} ORPHAN key(s) referenced but not in ${SOURCE}:`);
  for (const [key, where] of [...orphans].sort()) {
    console.log(`     - ${key}  (${where})`);
  }
  console.log("");
}

if (UPDATE_BASELINE) {
  // Gated locales are never baselined — their target is zero gaps.
  for (const code of Object.keys(nextBaseline)) {
    if (gated.has(code)) delete nextBaseline[code];
  }
  coverage.baseline = nextBaseline;
  writeFileSync(COVERAGE_FILE, JSON.stringify(coverage, null, 2) + "\n", "utf8");
  const total = Object.values(nextBaseline).reduce((n, a) => n + a.length, 0);
  console.log(
    `baseline updated — ${total} protected keys recorded across ${Object.keys(nextBaseline).length} locales.`,
  );
  // Rewriting the baseline forgives baseline-tier regressions — that is the
  // point of the flag. It does NOT forgive a broken gated locale, a stale key,
  // or a code orphan, so those must still set a non-zero exit.
  if (hardFailed) {
    console.error("\ni18n check FAILED — baseline rewritten, but real failures remain (see above).");
    process.exit(1);
  }
  process.exit(0);
}

if (failed) {
  console.error("\ni18n check FAILED — see above.");
  process.exit(1);
}
console.log("All gated locales complete; no regressions, stale keys, or orphan code keys.");
