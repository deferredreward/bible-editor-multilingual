import type { BookSummary } from "../sync/api";

/**
 * GET /api/books/:book groups rows by chapter, and book front matter lands in
 * chapter 0: `refParts` in api/src/importParsers.ts maps a 'front:intro' tn ref
 * to chapter 0, so every book imported with book-intro notes gets a chapter-0
 * entry (verified against GET /api/chapters/ZEC: ids 0-14 for a 14-chapter
 * book). Counting that entry as a chapter reported OBA — a one-chapter book —
 * as "2 chapter(s) loaded", and fed chapter 0 into chapter navigation, the
 * re-pull default range, and whole-book AI translate.
 *
 * Anything that counts, lists, or navigates chapters goes through these.
 * Row totals (notes/questions) are deliberately NOT filtered here — intro notes
 * are real notes; only screens that can't open chapter 0 exclude them.
 */
export function realChapters(summary: BookSummary | null | undefined): BookSummary["chapters"] {
  return (summary?.chapters ?? []).filter((c) => c.chapter >= 1);
}

/** Real chapter numbers, ascending. */
export function realChapterNumbers(summary: BookSummary | null | undefined): number[] {
  return realChapters(summary)
    .map((c) => c.chapter)
    .sort((a, b) => a - b);
}
