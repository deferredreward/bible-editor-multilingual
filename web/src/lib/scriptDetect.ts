// Single source of truth for "does this string contain Hebrew / Greek
// script" — one char is enough. Kept dependency-free so modules that are
// unit-tested under node --experimental-strip-types (tnQuickRequest) can
// import it without dragging in browser-only import chains.
//
// HEBREW: the Hebrew Unicode block U+0590-05FF.
// GREEK: Greek and Coptic U+0370-03FF plus Greek Extended U+1F00-1FFF —
// covers UGNT text (e.g. βλέπεις), whose precomposed forms always include
// base Greek letters.
export const HEBREW = /[֐-׿]/;
export const GREEK = /[Ͱ-Ͽἀ-῿]/;
