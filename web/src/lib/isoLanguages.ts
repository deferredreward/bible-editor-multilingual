// Compact curated ISO-language table for the Setup flow: code → { name,
// direction }. Covers the common gateway/target languages (the UI_LANGUAGES
// set the chrome ships with, the GL presets in api/src/projectConfig.ts, and
// the Arabic variants BSOJ-style orgs use), enough to pre-seed a new project's
// resource language without a network round-trip.
//
// SINGLE SOURCE OF TRUTH for RTL on the web side: directionForLang() below
// mirrors the RTL base-language set in api/src/orgInference.ts (RTL_LANGS) so
// the client and server never disagree about a language's direction. Every
// entry in LANGUAGES derives its `direction` from directionForLang(), so the
// two can't drift.

export type Direction = "ltr" | "rtl";

// RTL base languages. Mirrors api/src/orgInference.ts RTL_LANGS, widened with a
// few common script-level variants (Arabic macrolanguage variants, Dari,
// Sorani Kurdish, Sindhi, Uyghur, Yiddish) so a coded variant still resolves
// RTL by its base subtag.
const RTL_BASES = new Set<string>([
  // core (parity with orgInference.ts)
  "ar", "he", "fa", "ur", "ps", "syr", "dv",
  // widened
  "iw", "yi", "ckb", "sd", "ug", "prs", "pnb", "apc", "acm", "ary", "arz", "arb",
]);

// The base subtag of an IETF-ish code ("es-419" → "es", "ar_avd" → "ar").
export function baseSubtag(code: string): string {
  return code.split(/[-_]/)[0].toLowerCase();
}

// Centralized RTL decision — the one place the web side computes direction from
// a language code. Unknown codes default to "ltr".
export function directionForLang(code: string): Direction {
  return RTL_BASES.has(baseSubtag(code)) ? "rtl" : "ltr";
}

export interface IsoLanguage {
  /** English display name. */
  name: string;
  direction: Direction;
}

// Curated code → name map. `direction` on each entry is filled from
// directionForLang() by `entry()` so it can never contradict the RTL set.
function entry(code: string, name: string): [string, IsoLanguage] {
  return [code, { name, direction: directionForLang(code) }];
}

export const LANGUAGES: Record<string, IsoLanguage> = Object.fromEntries([
  // UI_LANGUAGES set (web/src/i18n/index.ts)
  entry("en", "English"),
  entry("ar", "Arabic"),
  entry("es", "Spanish"),
  entry("fr", "French"),
  entry("hi", "Hindi"),
  entry("id", "Indonesian"),
  entry("pt", "Portuguese"),
  entry("ru", "Russian"),
  entry("sw", "Swahili"),
  entry("ne", "Nepali"),
  entry("bn", "Bengali"),
  entry("ur", "Urdu"),
  entry("fa", "Persian"),
  entry("th", "Thai"),
  // GL presets (api/src/projectConfig.ts)
  entry("es-419", "Latin American Spanish"),
  // Arabic variants (BSOJ-style orgs: ar_avd / ar_nav, plus macrolanguage codes)
  entry("apc", "Levantine Arabic"),
  entry("acm", "Mesopotamian Arabic"),
  entry("ary", "Moroccan Arabic"),
  entry("arz", "Egyptian Arabic"),
  entry("arb", "Standard Arabic"),
  // Other common gateway / target languages
  entry("he", "Hebrew"),
  entry("ps", "Pashto"),
  entry("prs", "Dari"),
  entry("ckb", "Central Kurdish"),
  entry("sd", "Sindhi"),
  entry("ug", "Uyghur"),
  entry("am", "Amharic"),
  entry("zh", "Chinese"),
  entry("ta", "Tamil"),
  entry("te", "Telugu"),
  entry("ml", "Malayalam"),
  entry("mr", "Marathi"),
  entry("gu", "Gujarati"),
  entry("pa", "Punjabi"),
  entry("my", "Burmese"),
  entry("vi", "Vietnamese"),
  entry("tl", "Tagalog"),
  entry("ha", "Hausa"),
  entry("yo", "Yoruba"),
  entry("am-et", "Amharic"),
  entry("tr", "Turkish"),
  entry("de", "German"),
  entry("nl", "Dutch"),
  entry("it", "Italian"),
]);

// Look a code up in the curated table. Tries the exact code first, then the
// base subtag ("es-419" falls back to "es"). Returns null when unknown.
export function lookupLanguage(code: string): IsoLanguage | null {
  if (!code) return null;
  const exact = LANGUAGES[code] ?? LANGUAGES[code.toLowerCase()];
  if (exact) return exact;
  const base = baseSubtag(code);
  return LANGUAGES[base] ?? null;
}

export interface ResolvedResourceLanguage {
  languageCode: string;
  languageName: string;
  direction: Direction;
}

// Pre-seed a project's RESOURCE language for the Setup flow. Priority:
//   1. the inferred-config proposal (org's own tN manifest), when it carries a
//      languageCode — its languageName/direction win, with direction derived
//      from the code when the proposal omitted it;
//   2. otherwise the current UI language (i18n.language) — name from the
//      curated table, direction from directionForLang().
// Always returns concrete values so it can be stored straight into the
// languageCode/languageName/direction override keys.
export function resolveResourceLanguage(
  proposal:
    | { languageCode?: string | null; languageName?: string | null; direction?: Direction | null }
    | null
    | undefined,
  uiLangCode: string,
): ResolvedResourceLanguage {
  const inferredCode = proposal?.languageCode?.trim();
  if (inferredCode) {
    const known = lookupLanguage(inferredCode);
    return {
      languageCode: inferredCode,
      languageName: proposal?.languageName?.trim() || known?.name || inferredCode,
      direction: proposal?.direction ?? known?.direction ?? directionForLang(inferredCode),
    };
  }
  const ui = (uiLangCode || "en").trim() || "en";
  const known = lookupLanguage(ui);
  return {
    languageCode: ui,
    languageName: known?.name || ui,
    direction: known?.direction ?? directionForLang(ui),
  };
}
