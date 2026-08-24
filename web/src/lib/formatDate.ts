// Locale-aware display formatting for timestamps and numbers.
//
// WHY THIS EXISTS: ~17 call sites used to call `new Date(x).toLocaleString()`
// with no locale argument. With no argument the runtime uses the BROWSER's
// locale, so a user who picked Arabic in the UI switcher still saw English
// dates. Every one of those sites now routes through this module, which
// resolves the ACTIVE UI language at call time and passes it explicitly.
//
// DISPLAY ONLY. Nothing here parses, sorts, stores, or transmits a date — the
// helpers take whatever the call site already had and return a string for the
// screen. Never feed a formatted string back into a Date, a sort comparator,
// or an API payload.
//
// WHY `i18next` AND NOT `../i18n`: this reads the same i18next singleton that
// `src/i18n/index.ts` initializes (i18next's default export IS the instance),
// but importing the package directly keeps this module free of the locale JSON
// imports, so the node --experimental-strip-types test runner can load it and
// drive a real `changeLanguage()`. If the singleton has not been initialized
// yet (a formatter called before `src/i18n` is imported), `i18n.language` is
// undefined and we fall back to `en`.
//
// The language is re-read on EVERY call — never cached in a module constant —
// so switching the UI language repaints dates with no reload. Components pick
// the new output up on their next render; the ones that show dates already
// subscribe via `useTranslation()`.
import i18n from "i18next";

/**
 * Unicode locale extension appended to the active UI language for every
 * formatter here. THIS IS THE ONE KNOB for the digit-system decision.
 *
 * `-u-nu-latn` forces Western digits (0123) instead of each locale's CLDR
 * default numbering system. Rationale: these timestamps sit inline next to
 * verse references ("Genesis 1:1"), chapter/verse numbers, and app version
 * strings, all of which are built from raw JS numbers in template literals and
 * are therefore always Western digits. Letting `bn` render ১২৩, `fa` render
 * ۱۲۳, or a region-specific Arabic locale render ١٢٣ puts two numbering
 * systems side by side in the same line of chrome. Note that bare `ar` already
 * resolves to `latn` in current CLDR — this extension mainly normalizes
 * `bn`/`fa`/`ur`/`hi` and any region-tagged Arabic (`ar-EG` → `arab`).
 *
 * To adopt each locale's native digits instead, set this to `""`. To also pin
 * the calendar (see the `fa`/`th` note below), set it to
 * `"-u-nu-latn-ca-gregory"`. Nothing else in the codebase needs to change.
 *
 * Deliberately NOT pinned here: the calendar system. `fa` formats in the
 * Persian (Jalali) calendar and `th` in the Buddhist era — those are the
 * locale-correct renderings, and overriding them would change the date VALUE a
 * user reads, which is out of scope for a locale fix.
 */
const LOCALE_EXTENSION = "-u-nu-latn";

/** Used when the i18next singleton has no language yet (pre-init). */
const FALLBACK_LANGUAGE = "en";

/** Everything the existing call sites actually hand us. */
export type DateLike = Date | string | number | null | undefined;

/** What every helper returns for null/undefined/unparseable input. */
const EMPTY = "";

/**
 * The BCP-47 tag handed to `Intl`, resolved fresh from the i18next singleton.
 * Exported mainly so tests (and any future `Intl.*` construction) can assert
 * the same resolution rule.
 */
export function activeLocale(): string {
  const lang = typeof i18n?.language === "string" ? i18n.language.trim() : "";
  const base = lang || FALLBACK_LANGUAGE;
  // Don't double up if the language already carries a -u- extension.
  return base.includes("-u-") ? base : base + LOCALE_EXTENSION;
}

/**
 * Coerce a call site's value into a valid Date, or null.
 *
 * Accepts Date objects, ISO strings (and anything else `new Date(string)`
 * understands), and epoch MILLISECONDS as a number. Epoch SECONDS are not
 * auto-detected — call sites that store seconds already multiply by 1000, and
 * guessing would silently reinterpret 1970-era values.
 */
function toDate(value: DateLike): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// A malformed language tag makes Intl throw RangeError. That must never take a
// screen down over a date, so every formatter retries bare (browser default)
// and finally falls back to the empty string.
function safeFormat(run: (locale: string) => string, bare: () => string): string {
  try {
    return run(activeLocale());
  } catch {
    try {
      return bare();
    } catch {
      return EMPTY;
    }
  }
}

/**
 * Date + time, matching the default shape of `Date#toLocaleString()`.
 * Pass `options` only where the call site already passed some.
 */
export function formatDateTime(value: DateLike, options?: Intl.DateTimeFormatOptions): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  return safeFormat(
    (locale) => d.toLocaleString(locale, options),
    () => d.toLocaleString(undefined, options),
  );
}

/** Date only, matching the default shape of `Date#toLocaleDateString()`. */
export function formatDate(value: DateLike, options?: Intl.DateTimeFormatOptions): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  return safeFormat(
    (locale) => d.toLocaleDateString(locale, options),
    () => d.toLocaleDateString(undefined, options),
  );
}

/** Time only, matching the default shape of `Date#toLocaleTimeString()`. */
export function formatTime(value: DateLike, options?: Intl.DateTimeFormatOptions): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  return safeFormat(
    (locale) => d.toLocaleTimeString(locale, options),
    () => d.toLocaleTimeString(undefined, options),
  );
}

/**
 * Grouped number, matching the default shape of `Number#toLocaleString()`.
 * Non-finite input (NaN/Infinity/null) returns the empty string rather than
 * the literal "NaN".
 */
export function formatNumber(
  value: number | string | null | undefined,
  options?: Intl.NumberFormatOptions,
): string {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (n == null || typeof n !== "number" || !Number.isFinite(n)) return EMPTY;
  return safeFormat(
    (locale) => n.toLocaleString(locale, options),
    () => n.toLocaleString(undefined, options),
  );
}

/**
 * Convenience for the many call sites that store unix epoch SECONDS (D1's
 * `unixepoch()`), so `* 1000` stops being copy-pasted at each one.
 */
export function formatEpochSecondsDateTime(
  epochSeconds: number | null | undefined,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (epochSeconds == null || !Number.isFinite(epochSeconds)) return EMPTY;
  return formatDateTime(epochSeconds * 1000, options);
}
