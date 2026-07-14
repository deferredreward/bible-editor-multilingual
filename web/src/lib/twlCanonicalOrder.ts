// VERBATIM MIRROR of api/src/twlCanonicalOrder.ts — keep the shared functions
// (normalizeWordText, buildUltSequenceMap, twlSortPosition) byte-identical with
// the server so the nightly export, the reimport canonicalization post-pass, and
// this live client all agree on canonical TWL order. The ONLY intentional
// difference: the web verse `content` is ALREADY a parsed object, so
// buildUltSequenceMap here takes `verseObjects` directly instead of a VerseRow +
// parseVerseContentJson. Precedent for an api↔web verbatim mirror:
// web/src/lib/usfmFormat.ts.
//
// Canonical order = sequence TWL links by the position of the Hebrew/Greek word
// they point at in the aligned ULT verse.

// Sequence TWLs by position of Hebrew word in aligned ULT.
export function normalizeWordText(s: string | null | undefined): string {
  if (s == null) return "";
  return s.normalize("NFC").toLowerCase().trim().replace(/[\s\p{P}\p{S}]+/gu, " ");
}

// A `\zaln` alignment milestone we are currently inside. `occurrence` is the
// source-instance number of this word in the verse (1-based, reading order);
// `recorded` guards so we key it to the FIRST English word under it.
interface AlignmentFrame {
  content: string;
  occurrence: number;
  recorded: boolean;
}

export function buildUltSequenceMap(
  verseObjects: unknown[] | null | undefined,
): Map<string, number> {
  const sequenceMap = new Map<string, number>();
  if (!Array.isArray(verseObjects)) return sequenceMap;

  let englishIndex = 0;
  // Per-content source-instance counter — the OCCURRENCE a TWL row keys on
  // (which source instance), NOT the number of English words it fans out to.
  const occurrenceCount = new Map<string, number>();
  const stack: AlignmentFrame[] = [];

  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;

      // Start of an alignment milestone. usfm-js nests alignment via `children`
      // (real ULT data carries NO milestoneEnd nodes), so scope the frame to the
      // children walk: push, recurse, pop. A childless milestone is
      // sibling-structured — left for a milestoneEnd below.
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
  row: { orig_words: string | null; occurrence: number | null },
  sequenceMap: Map<string, number>,
): number | null {
  const key = `${normalizeWordText(row.orig_words)}#${row.occurrence}`;
  return sequenceMap.get(key) ?? null;
}

// Return a NEW array of a verse's TWL rows in canonical order: ULT word position
// asc; a row with a resolved position before one without; then stored sort_order
// (null → +Infinity); then original index (stable). Mirrors the per-verse
// comparator in api/src/twlCanonicalOrder.ts `orderTwlRows`. Does not mutate the
// input. Callers pass the ULT verse's verseObjects (or null when unavailable, in
// which case every row is "unresolved" and order falls back to sort_order).
export function canonicalTwlOrder<
  T extends { orig_words: string | null; occurrence: number | null; sort_order: number | null },
>(rows: T[], verseObjects: unknown[] | null | undefined): T[] {
  const sequenceMap = buildUltSequenceMap(verseObjects);
  return rows
    .map((row, originalIndex) => ({ row, originalIndex }))
    .sort((a, b) => {
      const aPos = twlSortPosition(a.row, sequenceMap);
      const bPos = twlSortPosition(b.row, sequenceMap);
      if (aPos != null && bPos != null && aPos !== bPos) return aPos - bPos;
      if (aPos != null && bPos == null) return -1;
      if (aPos == null && bPos != null) return 1;
      const aSort = a.row.sort_order ?? Number.POSITIVE_INFINITY;
      const bSort = b.row.sort_order ?? Number.POSITIVE_INFINITY;
      if (aSort !== bSort) return aSort - bSort;
      return a.originalIndex - b.originalIndex;
    })
    .map((x) => x.row);
}
