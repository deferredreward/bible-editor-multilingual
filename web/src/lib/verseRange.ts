// Helpers for verses that span multiple Bible verses (USFM `\v 6-9`).
//
// One D1 row covers the whole range: `verse=6, verse_end=9`. PR 1 preserves
// this through import/export. PR 2 makes the UI render the range as one card
// and resolve "verse 7" inside a UST 6-9 block to the canonical row at v=6.
//
// The hook layer (useChapter) exposes both shapes:
//   - versesByVersion: raw, keyed by verse_start (the wire shape)
//   - versesIndexByVersion: pre-expanded — verses 7,8,9 in a 6-9 range all map
//     to the same DTO reference, so lookups by any integer in the range work
//
// All renderers and the AlignmentPanel go through this module rather than
// reading `verses[bv][n]` directly.

import type { VerseDto } from "../sync/api";
// Explicit `.ts` — these modules are run directly by the node --strip-types
// test runner, where extensionless specifiers don't resolve.
import { extractPlainText } from "./usfm.ts";

export type VerseSpan = readonly [start: number, end: number];

export function verseSpan(dto: VerseDto): VerseSpan {
  const end = dto.verse_end ?? dto.verse;
  return [dto.verse, end];
}

export function isRangeRow(dto: VerseDto): boolean {
  return dto.verse_end != null && dto.verse_end > dto.verse;
}

// "7" for singletons (and verse 0 "front" — caller decides how to render that),
// "6-9" for range rows.
export function formatVerseLabel(dto: VerseDto): string {
  if (isRangeRow(dto)) return `${dto.verse}-${dto.verse_end}`;
  return String(dto.verse);
}

// Expand a per-version map keyed by verse_start into one keyed by every
// integer verse covered. Range rows contribute multiple keys; all keys for
// the same range point at the same DTO reference. Singletons contribute one
// key. Non-overlapping ranges across versions are fine — this only operates
// on a single version's slice.
export function buildVerseIndex(
  byVerseStart: Record<number, VerseDto> | undefined,
): Record<number, VerseDto> {
  if (!byVerseStart) return {};
  const out: Record<number, VerseDto> = {};
  for (const key of Object.keys(byVerseStart)) {
    const dto = byVerseStart[Number(key)];
    if (!dto) continue;
    const [start, end] = verseSpan(dto);
    for (let v = start; v <= end; v++) {
      // First-writer-wins on overlap. PR 1 import doesn't produce overlaps
      // (extractor only emits one row per source key), so this only matters
      // if a future writer inserts an overlapping singleton.
      if (out[v] == null) out[v] = dto;
    }
  }
  return out;
}

// The same-chapter verse numbers a note/question `ref_raw` covers. Unlike
// scripture rows (which carry `verse_end`), tn/tq rows store only a leading
// `verse` integer plus the raw reference string, so a bridge like "1:2-3" — or
// a discontinuous list like "1:2,4" — lives only in `ref_raw`. The leading
// `verse` is authoritative and always included (rows.ts re-derives it from
// ref_raw on save). Contiguous ranges expand to every verse; comma segments are
// unioned; "intro"/"front", cross-chapter ("3:2"), and malformed segments are
// skipped. Returns a sorted, unique list — `[verse]` for the common singleton.
const NOTE_SPAN_CAP = 400;

export function noteCoveredVerses(row: { verse: number; ref_raw?: string | null }): number[] {
  const covered = new Set<number>([row.verse]);
  const ref = row.ref_raw;
  if (ref) {
    const colon = ref.indexOf(":");
    const versePart = colon >= 0 ? ref.slice(colon + 1) : ref;
    for (const rawSeg of versePart.split(",")) {
      const seg = rawSeg.trim();
      // Skip empty, "intro"/"front" (no digit), and cross-chapter ("3:2")
      // segments — locks/WS/caches are all keyed to a single chapter.
      if (!seg || seg.includes(":") || !/\d/.test(seg)) continue;
      const dash = seg.indexOf("-");
      if (dash < 0) {
        const n = parseInt(seg, 10);
        if (Number.isFinite(n)) covered.add(n);
        continue;
      }
      const a = parseInt(seg.slice(0, dash), 10);
      const b = parseInt(seg.slice(dash + 1), 10);
      if (!Number.isFinite(a)) continue;
      if (!Number.isFinite(b) || b < a) {
        covered.add(a);
        continue;
      }
      // Bound expansion so a malformed free-text ref (e.g. "1:1-1000000000"
      // typed into the TQ reference field) can't build a huge Set and hang the
      // render/checkoff pass. NOTE_SPAN_CAP sits well above the largest real
      // chapter (~176 verses).
      const end = Math.min(b, a + NOTE_SPAN_CAP);
      for (let v = a; v <= end; v++) covered.add(v);
    }
  }
  return [...covered].sort((x, y) => x - y);
}

// True when a note/question row covers any verse in the inclusive display
// window [rangeStart, rangeEnd]. Reduces to `verse in [start,end]` for singletons.
export function noteOverlapsRange(
  row: { verse: number; ref_raw?: string | null },
  rangeStart: number,
  rangeEnd: number,
): boolean {
  return noteCoveredVerses(row).some((v) => v >= rangeStart && v <= rangeEnd);
}

// True when this integer verse is the *start* of a range (or a singleton).
// Renderers use this to avoid double-rendering verses 7,8,9 under a UST 6-9
// block: only the cell at v=6 paints the card; subsequent verses skip.
export function isFirstOfRange(dto: VerseDto, v: number): boolean {
  return v === dto.verse;
}

// Size of the range in integer verses. 1 for singletons. 4 for "6-9".
export function rangeSize(dto: VerseDto): number {
  const [start, end] = verseSpan(dto);
  return end - start + 1;
}

// Concatenate per-verse source rows (UHB/UGNT) into a single synthetic DTO
// covering [start, end]. Used by AlignmentPanel when the target is a UST 6-9
// block — the source side joins verses 6,7,8,9 of UHB into one combined
// verseObjects array so the aligner sees a flat token stream.
//
// Punctuation between verses is preserved via a `\v` boundary marker — usfm-js
// emits these naturally but we'd be combining post-parse, so we just splice
// them together verbatim with a separator text node. The aligner doesn't
// care about verse boundaries inside the combined source.
export function concatSourceRange(
  sourceByVerseStart: Record<number, VerseDto> | undefined,
  start: number,
  end: number,
): VerseDto | null {
  if (!sourceByVerseStart) return null;
  const first = sourceByVerseStart[start];
  if (!first) return null;
  if (start === end) return first;

  const combined: unknown[] = [];
  let lastVerseSeen: VerseDto | null = null;
  for (let v = start; v <= end; v++) {
    const row = sourceByVerseStart[v];
    if (!row) continue;
    lastVerseSeen = row;
    const content = row.content as { verseObjects?: unknown[] } | null;
    if (!content || !Array.isArray(content.verseObjects)) continue;
    if (combined.length > 0) {
      // Light separator so consecutive sources don't run together visually.
      combined.push({ type: "text", text: " " });
    }
    combined.push(...content.verseObjects);
  }
  if (combined.length === 0 || !lastVerseSeen) return null;

  // Return a synthetic DTO; never persisted, never PATCHed. Carries the
  // span so the AlignmentPanel title can show "UHB 6-9".
  return {
    ...first,
    verse_end: end,
    plain_text: null,
    content: { verseObjects: combined },
  };
}

// The verse tree of a scripture row, or null when the row carries none. The
// same `content.verseObjects` cast is hand-rolled in a dozen components; this
// export is where they should converge. AlignScreen's copy is retired (#351),
// and ReviewQueue + tnQuickRequest are retired here (#388); the rest
// (ScriptureScreen, TranslateAlignScreen, VerseScreen, WordsScreen) are still
// local, so a change here does NOT yet reach every call site.
export function verseObjectsOf(dto: VerseDto | null | undefined): unknown[] | null {
  const vo = (dto?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  return Array.isArray(vo) ? vo : null;
}

// Marker between two verses inside a lane that renders several verses as one
// run of text. Without it a discontinuous ref like "13:26,28" reads as one
// continuous sentence with verse 27 silently elided, and a wide range
// concatenates with nothing to say where each verse begins (#351). Subtle on
// purpose — a broken bar plus the number of the verse that follows, which is
// what a printed Bible interleaves. `verse` is the first verse of the text
// that follows the marker.
export function verseBoundaryText(verse: number): string {
  return ` ¦${verse} `;
}

// One verse's slice of a scripture lane, paired with the original-language
// verse the highlighter should anchor against. `verse` is the leading verse of
// the lane row this slice renders (the row's own start, so a USFM bridge row
// reports the verse its text actually begins at).
export interface CoveredLaneSlice {
  verse: number;
  verseObjects: unknown[] | null;
  plainText: string | null;
  sourceVerseObjects: unknown[] | null;
}

// Slice one scripture lane (ULT / UST) across every verse a note covers, given
// per-verse *expanded* indexes (`buildVerseIndex`) for the lane and for the
// original language, plus the covered verse list from `noteCoveredVerses(row)`.
// A note whose `ref_raw` bridges verses (e.g. MRK "13:26-27") must show the
// whole range's text — otherwise wording the alternate-translation draft refers
// to, present only in a later verse, is invisible (issue #341).
//
// The slices stay SEPARATE rather than being concatenated into one tree: a
// highlight key is `${text}|${occurrence}` and occurrence numbers are counted
// per verse, so one combined tree puts two distinct tokens under one key and
// both get marked (#344 review). Callers highlight each slice on its own and
// join the resulting segments (`flowLaneSegmentsAcross`). `plainText` is the
// whole lane's joined text, which is what the lane renders unhighlighted.
//
// Dedupes by DTO identity so a scripture row that is itself a USFM bridge
// (`verse_end`, which buildVerseIndex maps under every integer it spans) yields
// one slice, carrying the source verses of every covered verse it spans.
// Reduces to a single slice for the common singleton note. Unlike
// concatSourceRange this takes an explicit verse list, so a discontinuous ref
// ("2,4") covers only its listed verses.
export function coveredLaneSlices(
  laneIndex: Record<number, VerseDto>,
  sourceIndex: Record<number, VerseDto> | undefined,
  coveredVerses: number[],
): { slices: CoveredLaneSlice[]; plainText: string | null } {
  const sliceOf = new Map<VerseDto, CoveredLaneSlice>();
  const slices: CoveredLaneSlice[] = [];
  const seenSource = new Set<VerseDto>();
  for (const v of coveredVerses) {
    const laneDto = laneIndex[v];
    if (!laneDto) continue;
    let slice = sliceOf.get(laneDto);
    if (!slice) {
      const vo = verseObjectsOf(laneDto);
      const verseObjects = vo && vo.length > 0 ? vo : null;
      // `plainText` must cover exactly the verses the tree renders. A row whose
      // `plain_text` column is empty but whose tree carries tokens used to
      // contribute to the rendered slice yet vanish from the joined string —
      // silently partial for any lane that renders the string (tq) or falls
      // back to it (#351). Extract from the tree instead, the same walk
      // flowHighlight mirrors, so both paths show the same verses.
      const stored = typeof laneDto.plain_text === "string" ? laneDto.plain_text : "";
      const plain = stored || (verseObjects ? extractPlainText(verseObjects) : "");
      slice = {
        verse: laneDto.verse,
        verseObjects,
        plainText: plain ? plain : null,
        sourceVerseObjects: null,
      };
      sliceOf.set(laneDto, slice);
      slices.push(slice);
    }
    const sourceDto = sourceIndex?.[v];
    if (!sourceDto || seenSource.has(sourceDto)) continue;
    seenSource.add(sourceDto);
    const sourceVo = verseObjectsOf(sourceDto);
    if (!sourceVo || sourceVo.length === 0) continue;
    if (slice.sourceVerseObjects) {
      // Only reachable when the lane row is a USFM bridge spanning several
      // source verses; a light separator keeps them from running together.
      slice.sourceVerseObjects = [
        ...slice.sourceVerseObjects,
        { type: "text", text: " " },
        ...sourceVo,
      ];
    } else {
      slice.sourceVerseObjects = sourceVo;
    }
  }
  // Join with a verse marker rather than a bare space so a multi-verse lane
  // says where each verse starts (#351). A single slice gets no marker, so a
  // singleton note's lane text is its `plain_text` verbatim — except where that
  // column is empty and the tree is not, which is the one case the derivation
  // above deliberately changes on the singleton path too (empty box before,
  // the verse's text now).
  let plainText: string | null = null;
  for (const slice of slices) {
    if (!slice.plainText) continue;
    plainText =
      plainText === null
        ? slice.plainText
        : plainText + verseBoundaryText(slice.verse) + slice.plainText;
  }
  return { slices, plainText };
}

// The reference label for a note/question row: `ref_raw` when it names exactly
// what the lanes show, else the leading-verse form. `ref_raw` is the only place
// a note's range lives (tn_rows/tq_rows have no verse_end), so a bridged note
// reads "13:26-27". But `noteCoveredVerses` deliberately drops cross-chapter
// segments, so "13:26-14:2" covers verse 26 alone — printing that ref verbatim
// would advertise a range the lanes don't render, and a label must name what is
// on screen (house rule, VerseScreen.tsx). When the covered list collapsed to
// the single leading verse but ref_raw still carries range/comma syntax, fall
// back to `${chapter}:${verse}`.
//
// The same rule applies to the CHAPTER part. `ref_raw` is free-typed (the tq
// Reference field, QuestionsTable.tsx) and the API rewrites `verse` only when
// the retyped chapter matches the row's own (rows.ts), so "2:3" can sit on a
// chapter-1 row. `noteCoveredVerses` ignores the chapter part entirely, so the
// lanes still render chapter 1 — printing "2:3" over them names a chapter that
// is not on screen (#351 review).
export function noteRefLabel(row: {
  chapter: number;
  verse: number;
  ref_raw?: string | null;
}): string {
  const plain = `${row.chapter}:${row.verse}`;
  const ref = row.ref_raw;
  if (!ref) return plain;
  const colon = ref.indexOf(":");
  if (colon >= 0) {
    const refChapter = parseInt(ref.slice(0, colon), 10);
    if (Number.isFinite(refChapter) && refChapter !== row.chapter) return plain;
  }
  const versePart = ref.slice(colon + 1);
  if (/[-,]/.test(versePart) && noteCoveredVerses(row).length === 1) return plain;
  return ref;
}
