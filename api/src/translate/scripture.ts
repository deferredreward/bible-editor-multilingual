// scripture.ts — fetch source/target Bible text for the verses a row set
// covers, for injection into translate batch context packs.
//
// Ported from bp-assistant src/lib/scripture-verses.js plus the two USFM
// helpers it used from api-runner/verse-data.js (extractChapterVerse,
// stripMarkup) — issue #445. BOOK_NUMBERS comes from dcsSources.ts, which the
// editor already maintains for its own DCS fetches, instead of a fourth copy.
//
// Fetches the four USFM books (source ULT/UST, target literal/simplified) and
// builds per-verse plain-text maps keyed "chapter:verse". A repo or book that
// does not exist (a clean 404) degrades to "absent" — a target Bible that has
// not been started yet must never fail the run. A TRANSPORT failure (5xx,
// network, truncated read) is NOT absence: swallowing it would persist a
// context-free pack that every batch of the run is then billed against, so it
// propagates and the context step retries.

import { BOOK_NUMBERS } from "../dcsSources.ts";
import { fetchResourceFile, type ScripturePack, type ScriptureVersion } from "./core.ts";
import { refChapter, refVerseRange, type TsvRow } from "./tsvCodec.ts";
import type { FetchLike } from "./contextPack.ts";

const MAX_ROW_VERSE_SPAN = 10;

export type VerseRef = { chapter: number; verse: number };

/** Ordered, de-duplicated list of {chapter, verse} covered by a row set. */
export function collectVerseRefs(rows: readonly Pick<TsvRow, "Reference">[]): VerseRef[] {
  const refs: VerseRef[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const chapter = refChapter(row.Reference);
    if (chapter === "front" || typeof chapter !== "number") continue;
    const range = refVerseRange(row.Reference);
    if (!range) continue;
    const end = Math.min(range.end, range.start + MAX_ROW_VERSE_SPAN - 1);
    for (let verse = range.start; verse <= end; verse++) {
      const key = `${chapter}:${verse}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ chapter, verse });
    }
  }
  // No global verse cap: buildScripturePack is called once with the full row
  // set, so every verse any batch covers must be present in byRef — truncating
  // here would silently strip scripture from later batches (the per-row span
  // cap above already bounds any single pathological range).
  return refs;
}

/** Parse "org/repo@ref" and return just the repo (or the raw string if unparseable). */
function repoOf(ref: string | null | undefined): string | null | undefined {
  const m = /^([^/@\s]+)\/([^/@\s]+)@(.+)$/.exec(String(ref || "").trim());
  return m ? m[2] : ref;
}

/** Fetch USFM for a ref; returns null if the ref is falsy, 404s, or the fetch throws. */
async function fetchUsfm(ref: string | null | undefined, book: string, { fetchImpl }: { fetchImpl?: FetchLike } = {}): Promise<string | null> {
  if (!ref) return null;
  return await fetchResourceFile(ref, `${BOOK_NUMBERS[book.toUpperCase()]}-${book.toUpperCase()}.usfm`, { fetchImpl });
}

// --- USFM helpers (bp-assistant api-runner/verse-data.js:118-141, 180-197) ---

/** Slice the raw USFM of one verse out of a whole book; null when absent. */
export function extractChapterVerse(usfm: string, chapter: number, verse: number): string | null {
  const chapterRe = new RegExp(`\\\\c ${chapter}(?:\\D|$)`);
  const chapterMatch = chapterRe.exec(usfm);
  if (!chapterMatch) return null;
  const chapterStart = chapterMatch.index;

  const nextChapterRe = new RegExp(`\\\\c ${chapter + 1}(?:\\D|$)`);
  const nextChapterMatch = nextChapterRe.exec(usfm.slice(chapterStart + 1));
  const chapterContent = nextChapterMatch
    ? usfm.slice(chapterStart, chapterStart + 1 + nextChapterMatch.index)
    : usfm.slice(chapterStart);

  const verseRe = new RegExp(`\\\\v ${verse}(?:\\D|$)`);
  const verseMatch = verseRe.exec(chapterContent);
  if (!verseMatch) return null;
  const contentStart = verseMatch.index + verseMatch[0].length;

  const nextVerseIdx = chapterContent.slice(contentStart).search(/\\v \d/);
  const verseContent = nextVerseIdx !== -1
    ? chapterContent.slice(contentStart, contentStart + nextVerseIdx)
    : chapterContent.slice(contentStart);

  return verseContent.trim();
}

/** Plain text of a verse: the \w words when aligned, else markers stripped. */
export function stripMarkup(verseUsfm: string): string {
  const wordPattern = /\\w ([^|\\]+?)(?:\|[^\\]*)?\\w\*/g;
  const words: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = wordPattern.exec(verseUsfm)) !== null) {
    words.push(match[1].trim());
  }
  if (words.length > 0) return words.join(" ");

  return verseUsfm
    .replace(/\\[a-z-]+\*?\s*/g, "")
    .replace(/\|[^\s\\]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build {chapter:verse -> text} for the given refs from one USFM book. */
function buildByRef(usfm: string, refs: readonly VerseRef[]): Record<string, string> {
  const byRef: Record<string, string> = {};
  for (const { chapter, verse } of refs) {
    const raw = extractChapterVerse(usfm, chapter, verse);
    const text = stripMarkup(raw || "");
    if (text) byRef[`${chapter}:${verse}`] = text;
  }
  return byRef;
}

export type ScripturePackInput = {
  book: string;
  rows: readonly Pick<TsvRow, "Reference">[];
  sourceLiteralRef?: string | null;
  sourceSimplifiedRef?: string | null;
  targetLiteralRef?: string | null;
  targetSimplifiedRef?: string | null;
};

/**
 * Fetch source (ULT/UST) and target (literal/simplified) scripture text for
 * the verses a row set covers. Never throws — target (and source, degraded)
 * fetch failures just mark that version absent.
 */
export async function buildScripturePack(
  { book, rows, sourceLiteralRef, sourceSimplifiedRef, targetLiteralRef, targetSimplifiedRef }: ScripturePackInput,
  { fetchImpl }: { fetchImpl?: FetchLike } = {},
): Promise<ScripturePack> {
  const refs = collectVerseRefs(rows);

  // allSettled, not all: the four fetches run concurrently and a transport
  // failure now propagates (see the header note). Promise.all would reject on
  // the first one and leave the siblings' rejections unhandled.
  const settled = await Promise.allSettled([
    fetchUsfm(sourceLiteralRef, book, { fetchImpl }),
    fetchUsfm(sourceSimplifiedRef, book, { fetchImpl }),
    fetchUsfm(targetLiteralRef, book, { fetchImpl }),
    fetchUsfm(targetSimplifiedRef, book, { fetchImpl }),
  ]);
  const rejected = settled.find((s) => s.status === "rejected");
  if (rejected) throw (rejected as PromiseRejectedResult).reason;
  const [sourceLiteralUsfm, sourceSimplifiedUsfm, targetLiteralUsfm, targetSimplifiedUsfm] =
    settled.map((s) => (s as PromiseFulfilledResult<string | null>).value);

  const versions: ScriptureVersion[] = [];
  if (sourceLiteralUsfm) {
    versions.push({ role: "source-literal", label: "Source literal (ULT)", byRef: buildByRef(sourceLiteralUsfm, refs) });
  }
  if (sourceSimplifiedUsfm) {
    versions.push({ role: "source-simplified", label: "Source simplified (UST)", byRef: buildByRef(sourceSimplifiedUsfm, refs) });
  }
  const targetLiteralFound = !!targetLiteralUsfm;
  if (targetLiteralUsfm) {
    versions.push({
      role: "target-literal",
      label: `Target literal (${repoOf(targetLiteralRef)})`,
      byRef: buildByRef(targetLiteralUsfm, refs),
    });
  }
  const targetSimplifiedFound = !!targetSimplifiedUsfm;
  if (targetSimplifiedUsfm) {
    versions.push({
      role: "target-simplified",
      label: `Target simplified (${repoOf(targetSimplifiedRef)})`,
      byRef: buildByRef(targetSimplifiedUsfm, refs),
    });
  }

  return { versions, targetLiteralFound, targetSimplifiedFound };
}
