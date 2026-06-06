import type { VerseRow } from "./types";

export interface VerseContentJsonContext {
  book: string;
  chapter: number;
  verse: number;
  verseEnd: number | null;
  bibleVersion: string;
  version: number;
}

type VerseContentJsonRow = Pick<
  VerseRow,
  "book" | "chapter" | "verse" | "verse_end" | "bible_version" | "version" | "content_json"
>;

export class CorruptContentJsonError extends Error {
  readonly context: VerseContentJsonContext;
  readonly causeValue: unknown;

  constructor(context: VerseContentJsonContext, causeValue: unknown) {
    super(
      `corrupt_content_json: ${context.book} ${context.chapter}:${context.verse} ${context.bibleVersion} v${context.version}`,
    );
    this.name = "CorruptContentJsonError";
    this.context = context;
    this.causeValue = causeValue;
  }
}

function verseContentJsonContext(row: VerseContentJsonRow): VerseContentJsonContext {
  return {
    book: row.book,
    chapter: row.chapter,
    verse: row.verse,
    verseEnd: row.verse_end,
    bibleVersion: row.bible_version,
    version: row.version,
  };
}

export function parseVerseContentJson(row: VerseContentJsonRow): unknown {
  try {
    return JSON.parse(row.content_json);
  } catch (err) {
    throw new CorruptContentJsonError(verseContentJsonContext(row), err);
  }
}

export function corruptContentJsonBody(error: CorruptContentJsonError) {
  return {
    error: "corrupt_content_json" as const,
    ...error.context,
  };
}

export function logCorruptContentJson(error: CorruptContentJsonError): void {
  const cause =
    error.causeValue instanceof Error
      ? `${error.causeValue.name}: ${error.causeValue.message}`
      : String(error.causeValue);
  console.error("corrupt_content_json", { ...error.context, cause });
}
