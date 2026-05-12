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
