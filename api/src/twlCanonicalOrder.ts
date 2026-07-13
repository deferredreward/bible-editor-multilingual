// Canonical TWL ordering: sequence translationWord links by the position of the
// Hebrew/Greek word they point at in the aligned ULT verse. A pure leaf module
// (no D1 / Workflow deps) so it's unit-testable under the strip-types runner,
// like sortOrder.ts. The nightly export (export.ts buildTwlTsv) and the reimport
// canonicalization post-pass (bookReimport.ts) BOTH order rows through the shared
// `orderTwlRows` helper here, so the two agree exactly on canonical order.

import type { TwlRow, VerseRow } from "./types";
import { parseVerseContentJson } from "./contentJson.ts";
import { sortRowsByReference } from "./tsvFormat.ts";

// Sequence TWLs by position of Hebrew word in aligned ULT.
export function normalizeWordText(s: string | null | undefined): string {
  if (s == null) return "";
  return s.normalize("NFC").toLowerCase().trim().replace(/[\s\p{P}\p{S}]+/gu, " ");
}

// A `\zaln` alignment milestone we are currently inside. `occurrence` is the
// source-instance number of this exact word in the verse (1-based, reading
// order); `recorded` guards so we key it to the FIRST English word under it.
interface AlignmentFrame {
  content: string;
  occurrence: number;
  recorded: boolean;
}

export function buildUltSequenceMap(verse: VerseRow | null | undefined): Map<string, number> {
  const sequenceMap = new Map<string, number>();
  if (!verse) return sequenceMap;

  const parsed = parseVerseContentJson(verse);
  const verseObjects = parsed && typeof parsed === "object"
    ? (parsed as { verseObjects?: unknown[] }).verseObjects
    : null;

  if (!Array.isArray(verseObjects)) return sequenceMap;

  let englishIndex = 0;
  // Per-normalized-content source-instance counter: how many `\zaln` milestones
  // of this word we've entered so far. This is the OCCURRENCE a TWL row keys on
  // (which source instance), NOT the number of English words the alignment fans
  // out to — so a word aligned to several English words still owns one slot.
  const occurrenceCount = new Map<string, number>();
  const stack: AlignmentFrame[] = [];

  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;

      // Start of an alignment milestone. usfm-js nests alignment via `children`
      // (real ULT data carries NO milestoneEnd nodes), so scope the frame to the
      // children walk: push, recurse, pop. A milestone with no children is
      // sibling-structured — leave it on the stack for a milestoneEnd below.
      if (o["type"] === "milestone" && o["tag"] === "zaln" && typeof o["content"] === "string") {
        const content = normalizeWordText(o["content"] as string);
        const occurrence = (occurrenceCount.get(content) ?? 0) + 1;
        occurrenceCount.set(content, occurrence);
        stack.push({ content, occurrence, recorded: false });
        const children = o["children"];
        if (Array.isArray(children)) {
          walk(children);
          stack.pop();
        }
        continue;
      }

      // End of a sibling-structured alignment milestone.
      if (o["type"] === "milestoneEnd" && o["tag"] === "zaln") {
        if (stack.length > 0) stack.pop();
        continue;
      }

      // English word. Key EVERY enclosing milestone (all nesting levels) to its
      // FIRST English index — so a TWL link on an OUTER word of a nested
      // alignment resolves (ZEC 3:1 "high priest" = הַכֹּהֵן wrapping הַגָּדוֹל)
      // and each source instance owns exactly one position.
      if (o["type"] === "word" && o["tag"] === "w") {
        for (const frame of stack) {
          if (!frame.recorded) {
            sequenceMap.set(`${frame.content}#${frame.occurrence}`, englishIndex);
            frame.recorded = true;
          }
        }
        englishIndex++;
        continue;
      }

      const children = o["children"];
      if (Array.isArray(children)) walk(children);
    }
  };

  walk(verseObjects);

  return sequenceMap;
}

export function twlSortPosition(
  row: TwlRow,
  sequenceMap: Map<string, number>,
): number | null {
  const key =
    `${normalizeWordText(row.orig_words)}#${row.occurrence}`;
  return sequenceMap.get(key) ?? null;
}

export interface TwlOrdering {
  // rows in DCS reference order (the stable order the TSV body is rendered in,
  // with per-verse buckets re-sequenced into canonical order).
  referenceOrdered: TwlRow[];
  // row id → its 0-based canonical index WITHIN its verse bucket.
  versePositions: Map<string, number>;
  // sort_order diffs: for every verse where any row's computed (i+1)*100 differs
  // from its stored sort_order, one entry per differing row. This is the exact
  // set of D1 updates the export applies and the reimport post-pass adopts.
  sortOrderUpdates: Array<{ id: string; sort_order: number }>;
}

// Shared per-verse ordering. Groups rows by chapter:verse (after
// sortRowsByReference), finds the matching ULT verse, builds its sequence map,
// and sorts each bucket by (ULT position asc; resolved-position before null;
// stored sort_order nulls-last; original index). Then diffs each verse's
// computed (i+1)*100 positions against stored sort_order. Kept byte-identical to
// the logic that used to live inline in export.ts buildTwlTsv.
export function orderTwlRows(rows: TwlRow[], ultVerses: VerseRow[]): TwlOrdering {
  const referenceOrdered = sortRowsByReference(rows);

  const versePositions = new Map<string, number>();
  const verseRows = new Map<string, Array<{ row: TwlRow; originalIndex: number }>>();

  // Group rows by verse
  for (const [originalIndex, row] of referenceOrdered.entries()) {
    const key = `${row.chapter}:${row.verse}`;
    const bucket = verseRows.get(key) ?? [];
    bucket.push({ row, originalIndex });
    verseRows.set(key, bucket);
  }

  // Compute the desired order within each verse
  for (const bucket of verseRows.values()) {
    const verse =
      ultVerses.find(
        (v) =>
          v.bible_version === "ULT" &&
          v.chapter === bucket[0].row.chapter &&
          v.verse === bucket[0].row.verse,
      ) ?? null;

    const sequenceMap = buildUltSequenceMap(verse);

    bucket.sort((a, b) => {
      const aPos = twlSortPosition(a.row, sequenceMap);
      const bPos = twlSortPosition(b.row, sequenceMap);

      if (aPos != null && bPos != null && aPos !== bPos) {
        return aPos - bPos;
      }

      if (aPos != null && bPos == null) return -1;
      if (aPos == null && bPos != null) return 1;

      if (
        (a.row.sort_order ?? Number.POSITIVE_INFINITY) !==
        (b.row.sort_order ?? Number.POSITIVE_INFINITY)
      ) {
        return (
          (a.row.sort_order ?? Number.POSITIVE_INFINITY) -
          (b.row.sort_order ?? Number.POSITIVE_INFINITY)
        );
      }

      return a.originalIndex - b.originalIndex;
    });

    bucket.forEach(({ row }, index) => {
      versePositions.set(row.id, index);
    });
  }

  // Track sort_order updates: only rows in verses where reordering happened
  const sortOrderUpdates: Array<{ id: string; sort_order: number }> = [];
  for (const bucket of verseRows.values()) {
    // Check if this verse's rows were reordered from their stored sort_order
    let verseReordered = false;
    for (let i = 0; i < bucket.length; i++) {
      const computedPos = (i + 1) * 100;
      const storedPos = bucket[i].row.sort_order ?? Number.POSITIVE_INFINITY;
      if (computedPos !== storedPos) {
        verseReordered = true;
        break;
      }
    }

    // If reordered, record updates for all rows in this verse that differ
    if (verseReordered) {
      for (let i = 0; i < bucket.length; i++) {
        const row = bucket[i].row;
        const computedPos = (i + 1) * 100;
        const storedPos = row.sort_order ?? Number.POSITIVE_INFINITY;
        if (computedPos !== storedPos) {
          sortOrderUpdates.push({ id: row.id, sort_order: computedPos });
        }
      }
    }
  }

  return { referenceOrdered, versePositions, sortOrderUpdates };
}

// Pure canonical-order diff for the reimport post-pass: given the book's live
// twl rows and its ULT verses, return the sort_order updates that would bring D1
// into canonical (ULT-position) order. Identical semantics to the export's
// sortOrderUpdates — same code path (orderTwlRows).
export function computeTwlSortOrderUpdates(
  rows: TwlRow[],
  ultVerses: VerseRow[],
): Array<{ id: string; sort_order: number }> {
  return orderTwlRows(rows, ultVerses).sortOrderUpdates;
}
