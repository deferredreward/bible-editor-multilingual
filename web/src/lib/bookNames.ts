// USFM 3-letter codes (uppercase) with English names and common aliases.
// Used by the TopBar book picker (typeahead) and the reference parser.
//
// `code` is the stable USFM/DCS identifier — it drives file names, import/
// export paths, and API routes, and must never be swapped for a translated
// display string. `name` here is the English fallback used to seed the
// alias map (so typing "Genesis" still resolves even before i18n loads) and
// as a last-resort display value; the actual localized display name/abbr
// comes from the `books.<CODE>.name` / `books.<CODE>.abbr` i18next keys (see
// i18n/locales/en.json) via bookName()/bookAbbr() below, which route through
// i18next (including any runtime overrides from the Localization tab).

import i18n from "../i18n";

export interface BookInfo {
  code: string;
  name: string;
  aliases: string[];
}

export const BOOKS: BookInfo[] = [
  { code: "GEN", name: "Genesis",        aliases: ["gen", "ge", "gn"] },
  { code: "EXO", name: "Exodus",         aliases: ["exo", "ex", "exod"] },
  { code: "LEV", name: "Leviticus",      aliases: ["lev", "lv"] },
  { code: "NUM", name: "Numbers",        aliases: ["num", "nm", "nb"] },
  { code: "DEU", name: "Deuteronomy",    aliases: ["deu", "dt", "deut"] },
  { code: "JOS", name: "Joshua",         aliases: ["jos", "josh", "jsh"] },
  { code: "JDG", name: "Judges",         aliases: ["jdg", "judg", "jg"] },
  { code: "RUT", name: "Ruth",           aliases: ["rut", "ru", "rth"] },
  { code: "1SA", name: "1 Samuel",       aliases: ["1sa", "1sam", "1s", "1 sam", "1 samuel", "i sam", "i samuel"] },
  { code: "2SA", name: "2 Samuel",       aliases: ["2sa", "2sam", "2s", "2 sam", "2 samuel", "ii sam", "ii samuel"] },
  { code: "1KI", name: "1 Kings",        aliases: ["1ki", "1kgs", "1k", "1 ki", "1 kings", "i kings"] },
  { code: "2KI", name: "2 Kings",        aliases: ["2ki", "2kgs", "2k", "2 ki", "2 kings", "ii kings"] },
  { code: "1CH", name: "1 Chronicles",   aliases: ["1ch", "1chr", "1 ch", "1 chr", "1 chronicles", "i chronicles"] },
  { code: "2CH", name: "2 Chronicles",   aliases: ["2ch", "2chr", "2 ch", "2 chr", "2 chronicles", "ii chronicles"] },
  { code: "EZR", name: "Ezra",           aliases: ["ezr", "ezra"] },
  { code: "NEH", name: "Nehemiah",       aliases: ["neh", "ne"] },
  { code: "EST", name: "Esther",         aliases: ["est", "es", "esth"] },
  { code: "JOB", name: "Job",            aliases: ["job", "jb"] },
  { code: "PSA", name: "Psalms",         aliases: ["psa", "ps", "psalm", "psalms", "pslm", "psm"] },
  { code: "PRO", name: "Proverbs",       aliases: ["pro", "pr", "prov", "prv"] },
  { code: "ECC", name: "Ecclesiastes",   aliases: ["ecc", "ec", "eccl", "qoh"] },
  { code: "SNG", name: "Song of Songs",  aliases: ["sng", "sg", "song", "ss", "sos", "songs", "canticles", "cant"] },
  { code: "ISA", name: "Isaiah",         aliases: ["isa", "is"] },
  { code: "JER", name: "Jeremiah",       aliases: ["jer", "je", "jr"] },
  { code: "LAM", name: "Lamentations",   aliases: ["lam", "la"] },
  { code: "EZK", name: "Ezekiel",        aliases: ["ezk", "eze", "ezek", "ek"] },
  { code: "DAN", name: "Daniel",         aliases: ["dan", "da", "dn"] },
  { code: "HOS", name: "Hosea",          aliases: ["hos", "ho"] },
  { code: "JOL", name: "Joel",           aliases: ["jol", "joel", "jl"] },
  { code: "AMO", name: "Amos",           aliases: ["amo", "am", "amos"] },
  { code: "OBA", name: "Obadiah",        aliases: ["oba", "ob", "obad"] },
  { code: "JON", name: "Jonah",          aliases: ["jon", "jnh"] },
  { code: "MIC", name: "Micah",          aliases: ["mic", "mc"] },
  { code: "NAM", name: "Nahum",          aliases: ["nam", "na", "nah"] },
  { code: "HAB", name: "Habakkuk",       aliases: ["hab", "hb"] },
  { code: "ZEP", name: "Zephaniah",      aliases: ["zep", "zp", "zeph"] },
  { code: "HAG", name: "Haggai",         aliases: ["hag", "hg"] },
  { code: "ZEC", name: "Zechariah",      aliases: ["zec", "zc", "zech"] },
  { code: "MAL", name: "Malachi",        aliases: ["mal", "ml"] },
  { code: "MAT", name: "Matthew",        aliases: ["mat", "mt", "matt"] },
  { code: "MRK", name: "Mark",           aliases: ["mrk", "mk", "mar", "mr"] },
  { code: "LUK", name: "Luke",           aliases: ["luk", "lk", "lu"] },
  { code: "JHN", name: "John",           aliases: ["jhn", "jn", "joh", "john"] },
  { code: "ACT", name: "Acts",           aliases: ["act", "ac", "acts"] },
  { code: "ROM", name: "Romans",         aliases: ["rom", "ro", "rm"] },
  { code: "1CO", name: "1 Corinthians",  aliases: ["1co", "1cor", "1 co", "1 cor", "1 corinthians", "i corinthians"] },
  { code: "2CO", name: "2 Corinthians",  aliases: ["2co", "2cor", "2 co", "2 cor", "2 corinthians", "ii corinthians"] },
  { code: "GAL", name: "Galatians",      aliases: ["gal", "ga"] },
  { code: "EPH", name: "Ephesians",      aliases: ["eph", "ephes"] },
  { code: "PHP", name: "Philippians",    aliases: ["php", "phil", "phlp"] },
  { code: "COL", name: "Colossians",     aliases: ["col", "cl"] },
  { code: "1TH", name: "1 Thessalonians",aliases: ["1th", "1thess", "1 th", "1 thess", "i thessalonians"] },
  { code: "2TH", name: "2 Thessalonians",aliases: ["2th", "2thess", "2 th", "2 thess", "ii thessalonians"] },
  { code: "1TI", name: "1 Timothy",      aliases: ["1ti", "1tim", "1 ti", "1 tim", "i timothy"] },
  { code: "2TI", name: "2 Timothy",      aliases: ["2ti", "2tim", "2 ti", "2 tim", "ii timothy"] },
  { code: "TIT", name: "Titus",          aliases: ["tit", "ti"] },
  { code: "PHM", name: "Philemon",       aliases: ["phm", "phlm", "phile"] },
  { code: "HEB", name: "Hebrews",        aliases: ["heb", "he"] },
  { code: "JAS", name: "James",          aliases: ["jas", "jm", "james"] },
  { code: "1PE", name: "1 Peter",        aliases: ["1pe", "1pet", "1 pe", "1 pet", "i peter"] },
  { code: "2PE", name: "2 Peter",        aliases: ["2pe", "2pet", "2 pe", "2 pet", "ii peter"] },
  { code: "1JN", name: "1 John",         aliases: ["1jn", "1joh", "1 jn", "1 john", "i john"] },
  { code: "2JN", name: "2 John",         aliases: ["2jn", "2joh", "2 jn", "2 john", "ii john"] },
  { code: "3JN", name: "3 John",         aliases: ["3jn", "3joh", "3 jn", "3 john", "iii john"] },
  { code: "JUD", name: "Jude",           aliases: ["jud", "jude"] },
  { code: "REV", name: "Revelation",     aliases: ["rev", "re", "the revelation", "apocalypse", "apoc"] },
];

const ALIAS_MAP: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const b of BOOKS) {
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
    m[norm(b.code)] = b.code;
    m[norm(b.name)] = b.code;
    for (const a of b.aliases) m[norm(a)] = b.code;
  }
  return m;
})();

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/** Resolves free-text input (code, English alias, or the *current* locale's
 *  translated name/abbr) to a stable book code. `ALIAS_MAP` only covers the
 *  bundled English names/aliases, so a translated `books.<CODE>.name`/`.abbr`
 *  (from a non-English locale or a runtime Localization override) is checked
 *  as a fallback — otherwise pasting exactly what the UI displays wouldn't
 *  resolve once a locale supplies a translated name. */
export function resolveBook(input: string): string | null {
  const key = norm(input);
  const direct = ALIAS_MAP[key];
  if (direct) return direct;
  for (const b of BOOKS) {
    if (norm(bookName(b.code)) === key) return b.code;
    if (norm(bookAbbr(b.code)) === key) return b.code;
  }
  return null;
}

/** Localized display name for a book code (e.g. "Zechariah"). Falls back to
 *  the bundled English name, then to the raw code, if a translation is
 *  missing. `code` itself is untouched — only the label shown to users. */
export function bookName(code: string): string {
  const upper = code.toUpperCase();
  const fallback = BOOKS.find((b) => b.code === upper)?.name ?? code;
  return i18n.t(`books.${upper}.name`, { defaultValue: fallback });
}

/** Localized short abbreviation for a book code (e.g. "Zech"). Falls back to
 *  the localized full name, then the raw code, if no abbreviation is set. */
export function bookAbbr(code: string): string {
  const upper = code.toUpperCase();
  const fallback = bookName(code);
  return i18n.t(`books.${upper}.abbr`, { defaultValue: fallback });
}
