// tsvCodec.ts — generic strict TSV codec for the translate runner.
//
// Ported verbatim from bp-assistant src/lib/tsv-resource.js + tn-tsv.js (issue
// #445). Do NOT swap in importParsers.ts parseTsv: the strict codec's exact
// byte round-trip (parse → serialize reproduces the input) is the invariant
// the pass-through checks and the replay test depend on.
//
// Format facts (verified against unfoldingWord en_tn tn_OBA.tsv and en_tq
// tq_OBA.tsv, 2026-07-13):
// - Header is the exact tab-joined column list; one physical line per row.
// - Newlines inside a free-text column are the literal two chars "\n"
//   (backslash + n), never a real newline; fields never contain real tabs.
//   So a naive line/tab split is exact, not approximate.
//
// The row-object shape is `{ [column]: value }`. The chapter/verse ref helpers
// operate only on the shared `Reference` column, so they are resource-agnostic.

import { TN_COLUMNS } from "./resourceTypes.ts";

export type TsvRow = Record<string, string>;

export type TsvCodec = {
  COLUMNS: readonly string[];
  HEADER: string;
  parse: (text: string) => TsvRow[];
  serialize: (rows: readonly TsvRow[]) => string;
};

/**
 * Build a strict parse/serialize pair for a fixed column schema.
 * `columns[0]` should be the Reference-style key; the header is
 * `columns.join('\t')`.
 */
export function makeTsvCodec(columns: readonly string[]): TsvCodec {
  if (!Array.isArray(columns) || columns.length < 2) {
    throw new Error("makeTsvCodec requires a column list");
  }
  const HEADER = columns.join("\t");
  const n = columns.length;

  function parse(text: string): TsvRow[] {
    const lines = String(text).replace(/\r\n/g, "\n").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop(); // trailing newline
    if (!lines.length) throw new Error("empty TSV");
    if (lines[0] !== HEADER) {
      throw new Error(`bad TSV header: expected "${HEADER}", got "${lines[0].slice(0, 160)}"`);
    }
    const rows: TsvRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === "") continue; // tolerate stray blank lines between rows
      const cells = lines[i].split("\t");
      if (cells.length !== n) {
        throw new Error(`row ${i + 1}: expected ${n} columns, got ${cells.length}`);
      }
      const row: TsvRow = {};
      columns.forEach((c, j) => {
        row[c] = cells[j];
      });
      rows.push(row);
    }
    return rows;
  }

  function serialize(rows: readonly TsvRow[]): string {
    const out = [HEADER];
    for (const row of rows) {
      out.push(columns.map((c) => row[c] ?? "").join("\t"));
    }
    return out.join("\n") + "\n";
  }

  return { COLUMNS: columns, HEADER, parse, serialize };
}

/**
 * Chapter key of a row's Reference: 'front', or the integer chapter.
 * References look like "front:intro", "1:1", "1:intro", "12:3-4".
 */
export function refChapter(reference: string): "front" | number | null {
  const head = String(reference).split(":")[0];
  if (head === "front") return "front";
  const num = Number(head);
  return Number.isInteger(num) ? num : null;
}

/**
 * Verse range of a row's Reference, or null for intro/front rows.
 * "1:1" → {start:1,end:1}; "1:5-7" → {start:5,end:7}; "1:intro"/"front:intro" → null.
 */
export function refVerseRange(reference: string): { start: number; end: number } | null {
  const parts = String(reference).split(":");
  if (parts.length < 2) return null;
  const m = /^(\d+)(?:\s*[-–—]\s*(\d+))?/.exec(parts[1]);
  if (!m) return null;
  const start = Number(m[1]);
  return { start, end: m[2] ? Number(m[2]) : start };
}

/**
 * Select the rows belonging to a chapter range. Book-front matter
 * (front:intro) belongs to the range only when it starts at chapter 1 —
 * translating "OBA 1" means the whole translation unit including the intro,
 * while "PSA 40-42" must not touch the book intro.
 */
export function sliceChapterRows<T extends TsvRow>(rows: readonly T[], startChapter: number, endChapter: number): T[] {
  return rows.filter((r) => {
    const ch = refChapter(r.Reference);
    if (ch === "front") return startChapter === 1;
    return typeof ch === "number" && ch >= startChapter && ch <= endChapter;
  });
}

// ---------------------------------------------------------------------------
// tN convenience codec (bp-assistant tn-tsv.js). Same generic codec bound to
// the 7-column translationNotes schema; kept so the tN default paths in
// checks.ts / core.ts read like the bot's.
// ---------------------------------------------------------------------------

export const tnCodec: TsvCodec = makeTsvCodec(TN_COLUMNS);
export const TN_HEADER = tnCodec.HEADER;

/**
 * Parse a tN TSV string. Throws on structural corruption (wrong header,
 * wrong column count) — corrupt input must never be silently repaired.
 */
export const parseTnTsv = tnCodec.parse;

/** Serialize rows back to canonical tN TSV (header + LF line endings + trailing newline). */
export const serializeTnTsv = tnCodec.serialize;
