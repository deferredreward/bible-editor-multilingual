// Chapter-scoped export merge: splice a chapter-range TSV render into the
// existing master whole-book TSV, keeping every row outside the range
// byte-for-byte in its original order. Mirrors unfoldingWord/bp-assistant's
// `mergeChapterIntoBook` (its translate pipeline) — this is the API-side
// port used by the "export MRK 13-14 tn" admin flow (exportWorkflow.ts
// exportOne), which merges instead of replacing the whole file the way a
// full-book export does.
//
// Pure string module: no D1, no fetch, no Workflow knowledge. Line-oriented
// like bp-assistant — cells are split on "\t" and NEVER unquoted/re-escaped;
// a row is just its raw tab-joined line, moved around wholesale.

export interface ChapterRange {
  start: number; // inclusive, integer >= 1
  end: number; // inclusive, integer >= start
}

export interface ChapterMergeResult {
  content: string; // merged whole-book TSV, LF line endings, one trailing newline
  masterRowsInRange: number; // data rows master had in [start,end] before merge
  masterRowsTotal: number; // data rows master had in total (0 when master is null — bootstrap)
  renderedRows: number; // data rows in `rendered`
}

// "13:4" -> 13, "13:intro" -> 13, "front:intro" -> null, garbage -> null.
// A Reference's chapter segment is everything before the first ":"; anything
// that isn't a plain run of digits (notably "front") doesn't resolve to a
// chapter number and is therefore never "in range".
export function chapterOfReference(ref: string): number | null {
  if (!ref) return null;
  const colon = ref.indexOf(":");
  const chapterText = colon < 0 ? ref : ref.slice(0, colon);
  if (!/^\d+$/.test(chapterText)) return null;
  return parseInt(chapterText, 10);
}

export function formatChapterRange(range: ChapterRange): string {
  return range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
}

// Inverse of formatChapterRange. Returns null on anything that doesn't parse
// to a valid ascending (or single) integer range.
export function parseChapterRangeLabel(s: string): ChapterRange | null {
  const m = /^(\d+)(?:-(\d+))?$/.exec(s.trim());
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = m[2] != null ? parseInt(m[2], 10) : start;
  if (start < 1 || end < start) return null;
  return { start, end };
}

function isInRange(refRaw: string, range: ChapterRange): boolean {
  const ch = chapterOfReference(refRaw.trim());
  return ch != null && ch >= range.start && ch <= range.end;
}

// A leading UTF-8 BOM (U+FEFF), when the file was saved/fetched with one, is
// invisible in any editor but would otherwise land on the header line's first
// cell — breaking the header-match check (F6) and (were it ever a Reference
// cell) chapter parsing. Strip it before splitting; never touches anything
// else in the text.
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Normalize CRLF -> LF, split on "\n", drop the trailing empty element (a
// well-formed TSV ends with exactly one newline), then drop any other blank
// lines. Never touches cell content.
function splitDataLines(text: string): string[] {
  const lines = stripBom(text).replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.filter((l) => l.length > 0);
}

// Range-local shrink policy. The whole-book guard (exportTsvShrinkRefused)
// always passes a loss of <=25 rows regardless of the book's size — fine for
// a 700-row book, but a 20-row chapter rendered down to 1 row loses 19, well
// under that floor, and would sail through. Refuse when more than half of
// the range's rows would vanish, or when the whole-book policy would refuse
// (large ranges, same >25-lost-and->5% shape) — whichever threshold is
// stricter for the range at hand.
export function chapterShrinkRefused(rendered: number, existing: number): boolean {
  if (existing <= 0) return false; // nothing in the range to protect
  const lost = existing - rendered;
  if (lost <= 0) return false; // no shrink (incl. growth) — fine
  return lost / existing >= 0.5 || (lost > 25 && lost / existing > 0.05);
}

// F2 (strict): out-of-range rows on `masterText` that are absent from
// `mergedText`'s full ID set. Used when the merge's base was read from the
// export BRANCH rather than master — the branch may itself be behind or
// sparse relative to master (an out-of-band edit landed on master, or an
// earlier conflict-recovery rebuilt the branch incompletely), and the
// range-local shrink guard (chapterShrinkRefused) never looks outside
// [start,end], so it can't catch that. Only OUT-OF-RANGE rows are compared —
// an in-range master row disappearing is expected (that IS the edit); this
// function never counts one. Returns every master out-of-range row's ID
// (column 2) not found anywhere in the merged file; empty = clean.
export function missingOutOfRangeIds(
  masterText: string,
  mergedText: string,
  range: ChapterRange,
): string[] {
  const masterBody = splitDataLines(masterText).slice(1); // drop header
  const mergedBody = splitDataLines(mergedText).slice(1);
  const mergedIds = new Set<string>();
  for (const line of mergedBody) {
    mergedIds.add(line.split("\t")[1] ?? "");
  }
  const missing: string[] = [];
  for (const line of masterBody) {
    const cells = line.split("\t");
    const ref = (cells[0] ?? "").trim();
    if (isInRange(ref, range)) continue; // in-range rows are expected to differ
    const id = cells[1] ?? "";
    if (!mergedIds.has(id)) missing.push(id);
  }
  return missing;
}

export function mergeTsvChapterRange(
  masterText: string | null,
  rendered: string,
  range: ChapterRange,
): ChapterMergeResult {
  const renderedLines = splitDataLines(rendered);
  const renderedHeader = renderedLines[0] ?? "";
  const renderedBody = renderedLines.slice(1);

  // Every rendered row must fall inside the requested range — a violation
  // means the SQL feeding the render is wrong, and we must not push it.
  for (const line of renderedBody) {
    const ref = line.split("\t")[0] ?? "";
    if (!isInRange(ref, range)) {
      throw new Error(`rendered_row_out_of_range:${ref}`);
    }
  }

  let header: string;
  let mergedBody: string[];
  let masterRowsInRange = 0;
  let masterRowsTotal = 0;

  if (masterText == null) {
    // Bootstrap: no master file yet — nothing to merge against.
    header = renderedHeader;
    mergedBody = renderedBody;
  } else {
    const masterLines = splitDataLines(masterText);
    const masterHeader = masterLines[0] ?? "";
    const masterBody = masterLines.slice(1);

    if (masterHeader !== renderedHeader) {
      throw new Error("header_mismatch");
    }
    header = masterHeader;
    masterRowsTotal = masterBody.length;

    const kept: string[] = [];
    let insertAt = -1; // position (within `kept`) of the first removed in-range row
    let fallbackAt = -1; // position (within `kept`) of the first row past the range
    for (const line of masterBody) {
      const ref = line.split("\t")[0] ?? "";
      if (isInRange(ref, range)) {
        masterRowsInRange++;
        if (insertAt === -1) insertAt = kept.length;
        continue;
      }
      if (fallbackAt === -1) {
        const ch = chapterOfReference(ref.trim());
        if (ch != null && ch > range.end) fallbackAt = kept.length;
      }
      kept.push(line);
    }
    const at = insertAt !== -1 ? insertAt : fallbackAt !== -1 ? fallbackAt : kept.length;
    mergedBody = [...kept.slice(0, at), ...renderedBody, ...kept.slice(at)];
  }

  // Post-merge assertion: no rendered row's ID (column index 1) may collide
  // with another rendered row or with a kept master row. Only collisions OUR
  // rows introduce are refused — a duplicate that already exists among
  // master's out-of-range rows is not this export's to fix (a whole-book
  // export doesn't check it either), and refusing on it would block a
  // legitimate chapter push over unrelated pre-existing junk.
  const renderedIds = new Set<string>();
  for (const line of renderedBody) {
    const id = line.split("\t")[1] ?? "";
    if (renderedIds.has(id)) throw new Error(`duplicate_id:${id}`);
    renderedIds.add(id);
  }
  for (const line of mergedBody) {
    if (renderedBody.includes(line)) continue; // one of ours (all in range, so never also a kept master row)
    const id = line.split("\t")[1] ?? "";
    if (renderedIds.has(id)) throw new Error(`duplicate_id:${id}`);
  }

  return {
    content: [header, ...mergedBody].join("\n") + "\n",
    masterRowsInRange,
    masterRowsTotal,
    renderedRows: renderedBody.length,
  };
}
