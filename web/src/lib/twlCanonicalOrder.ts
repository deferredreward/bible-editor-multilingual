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

export function buildUltSequenceMap(
  verseObjects: unknown[] | null | undefined,
): Map<string, number> {
  const sequenceMap = new Map<string, number>();
  if (!Array.isArray(verseObjects)) return sequenceMap;

  let englishIndex = 0;
  const occurrenceMap = new Map<string, number>();
  const alignmentStack: Array<{ content: string }> = [];

  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;

      // Beginning of an alignment milestone
      if (o["type"] === "milestone" && o["tag"] === "zaln" && typeof o["content"] === "string") {
        alignmentStack.push({ content: normalizeWordText(o["content"] as string) });
      }

      // English word. Record it against EVERY alignment milestone currently on
      // the stack, not just the innermost — otherwise a TWL link pointing at an
      // OUTER word of a NESTED alignment never gets a position and sinks to the
      // end. Real case: ZEC 3:1 "high priest" = הַכֹּהֵן wrapping הַגָּדוֹל; the
      // English words sit under the inner הַגָּדוֹל, so only it used to get keys
      // and the הַכֹּהֵן link resolved to null. Additive: the innermost word's
      // per-\w occurrence counter is unchanged (always in the loop, incremented
      // once per \w as before), so existing keys keep their positions; outer
      // words gain the keys they lacked, mapped to the first English index in
      // their span.
      if (o["type"] === "word" && o["tag"] === "w") {
        for (const entry of alignmentStack) {
          const occurrence = (occurrenceMap.get(entry.content) ?? 0) + 1;
          occurrenceMap.set(entry.content, occurrence);
          sequenceMap.set(`${entry.content}#${occurrence}`, englishIndex);
        }
        englishIndex++;
      }

      const children = o["children"];
      if (Array.isArray(children)) walk(children);

      // End of an alignment milestone
      if (o["type"] === "milestoneEnd" && o["tag"] === "zaln") {
        alignmentStack.pop();
      }
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
