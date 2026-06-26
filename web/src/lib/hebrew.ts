// Hebrew text normalization for comparison/lookup.
//
// UHB stores combining marks in the traditional Tanakh order
// (consonant-DAGESH-vowel — e.g. `כ ּ ִ`, where DAGESH has CCC 21 and HIRIQ
// has CCC 18). Most usfm-js outputs — and many other Hebrew sources — emit
// Unicode-canonical NFC order (lower-CCC first → HIRIQ before DAGESH). The
// two encodings are visually identical and identical to a translator, but
// they fail strict byte equality. Anywhere we compare or key on Hebrew
// strings — milestone `x-content` vs UHB `\w text`, TWL `orig_words` vs
// milestone content, TN/TQ `quote` vs UHB \w token text — we must normalize
// first or lookups silently miss and the UI mis-highlights, mis-orders, or
// synthesizes phantom placeholders.
//
// Use `nfc()` on EVERY Hebrew source-text key or compare. Display strings
// can stay raw — the user sees identical glyphs either way. Note that
// Greek is unaffected by this specific ordering issue but NFC is a no-op
// on already-canonical strings, so it's safe to apply uniformly.
export function nfc(s: string): string {
  return s.normalize("NFC");
}

// Consonant-only fold for TWL deny-list matching. NFC, then drop pointing
// (combining marks), the maqaf (U+05BE), the word-joiner (U+2060 / U+200D),
// and inter-word whitespace — collapsing a quote to its bare consonant string.
//
// The two filter tables (twl_unlinked_words, twl_deleted_rows) store
// vowel-stripped Hebrew that keeps the U+2060 prefix-joiner and spaces. But a
// quote freshly resolved in the browser comes back from buildQuoteFromSelection
// with maqaf/space separators (never U+2060), so `ל⁠בן` in the table would
// arrive as `ל בן` and miss. Folding both sides to consonants makes the compare
// separator- and pointing-insensitive. Equality stays full-string (`בן` never
// matches `לבן`); the only cost is that two different multi-word quotes whose
// consonants concatenate identically would collide — acceptable for a deny-list.
export function twlFilterKey(s: string): string {
  return s.normalize("NFC").replace(/[\p{Mn}־⁠‍\s]/gu, "");
}
