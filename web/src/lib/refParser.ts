// Parse a user-typed chapter reference like "PSA 130", "PSA 130-135",
// "130", or "130-135" into a normalized scope. Used by the AI pipeline
// dialog so translators can extend a single-chapter run to a contiguous
// range (the client then fans out N single-chapter requests).
//
// - Book defaults to `currentBook` when omitted.
// - Book is normalized to uppercase.
// - Single-chapter input ("PSA 130") → endChapter equals startChapter.
// - Cross-book ranges ("GEN 50-EXO 2") are out of scope.
//
// `error` is DISPLAY ONLY — ImportFromDoor43Dialog and PipelineMenu render it
// as helperText and branch on `ok`, never on the text. Translated per call
// (never at module load) so a UI-language switch repaints it.

import i18n from "../i18n";

export interface ChapterRange {
  book: string;
  startChapter: number;
  endChapter: number;
}

export type ParseResult =
  | { ok: true; range: ChapterRange }
  | { ok: false; error: string };

const PATTERN = /^([A-Za-z0-9]{3})?\s*(\d+)(?:\s*-\s*(\d+))?$/;

export function parseChapterRange(input: string, currentBook: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: i18n.t("messages.chapterRef.enterChapter") };
  const m = PATTERN.exec(trimmed);
  if (!m) return { ok: false, error: i18n.t("messages.chapterRef.format") };
  const book = (m[1] ?? currentBook).toUpperCase();
  const startChapter = Number.parseInt(m[2], 10);
  const endChapter = m[3] !== undefined ? Number.parseInt(m[3], 10) : startChapter;
  if (!Number.isFinite(startChapter) || startChapter < 1) {
    return { ok: false, error: i18n.t("messages.chapterRef.mustBePositive") };
  }
  if (!Number.isFinite(endChapter) || endChapter < startChapter) {
    return { ok: false, error: i18n.t("messages.chapterRef.endBeforeStart") };
  }
  return { ok: true, range: { book, startChapter, endChapter } };
}
