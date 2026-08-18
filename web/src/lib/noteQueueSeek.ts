// Deep-link seek arithmetic shared by TranslateNotesScreen's queue-build
// effect (initial seed) and its verse-change effect (re-seek on a
// same-chapter deep link — issue #201). Pulled into its own module because
// TranslateNotesScreen.tsx is JSX and the strip-types test runner can't
// import it directly (see replace.test.mjs and friends: every unit-tested
// module here is a plain .ts file for the same reason).
//
// Land on the first entry whose verse is at or after `target`. A verse past
// the last note's verse has no >= match (-1); clamp to the last entry
// instead of falling back to index 0, which would jump to the top of the
// chapter instead of near where the user asked to look. `verses` must
// already be sorted ascending (the queue always is). Null only for an empty
// queue.
export function seekIndex(verses: number[], target: number): number | null {
  if (verses.length === 0) return null;
  const idx = verses.findIndex((v) => v >= target);
  return idx < 0 ? verses.length - 1 : idx;
}
