// i18n: nothing user-facing lives here — it is pure model code. Every string
// below is an id/key, never rendered.
//
// Source-position bookkeeping shared by the t4 Align screen's tap-to-pair view.
//
// These helpers are a faithful port of the private ones inside
// web/src/components/AlignmentPanel.tsx (buildSourceIndexMap /
// resolveSourcePos / groupPositionKey / displayGroups / groupsForCard). They
// are NOT re-derived logic: the drag canvas (AlignmentPanel) and the tap view
// must agree on which state groups a single visible card owns, or the two
// modes would disagree about what "clear this card" or "combine these two"
// means on the very same verse. Copied rather than imported because the
// originals are module-private in a 2300-line component; keep them in step if
// that file changes.
//
// Nothing here mutates or builds verse JSON. Every alignment edit goes through
// the tested primitives in web/src/lib/alignment.ts.

import {
  mergeAdjacentSameSource,
  mergeSamePositionGroups,
  sourceKey,
  stripCompoundOverlaps,
  type AlignmentGroup,
  type AlignmentState,
  type SourceWord,
} from "../../lib/alignment";
import { suggestKey, type StreamWord } from "../../lib/alignmentSuggest";
import { nfc } from "../../lib/hebrew";
import type { VerseDto } from "../../sync/api";

/**
 * Walk-position index for the source (UHB/UGNT) verse: `t:<nfc text>|<occ>`
 * and `s:<strong>|<occ>` both map to the token's 0-based position.
 */
export function buildSourceIndexMap(sourceVerse: VerseDto | null): Map<string, number> {
  const map = new Map<string, number>();
  if (!sourceVerse?.content) return map;
  const verseObjects = (sourceVerse.content as { verseObjects?: unknown[] }).verseObjects;
  if (!Array.isArray(verseObjects)) return map;
  let idx = 0;
  const textCount = new Map<string, number>();
  const strongCount = new Map<string, number>();
  const walk = (nodes: unknown[]) => {
    for (const n of nodes ?? []) {
      const o = n as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "word" && o["tag"] === "w") {
        const text = nfc(String(o["text"] ?? ""));
        const strong = String(o["strong"] ?? "");
        const tOcc = (textCount.get(text) ?? 0) + 1;
        const sOcc = (strongCount.get(strong) ?? 0) + 1;
        textCount.set(text, tOcc);
        strongCount.set(strong, sOcc);
        const textKey = `t:${text}|${tOcc}`;
        const strongKey = `s:${strong}|${sOcc}`;
        if (!map.has(textKey)) map.set(textKey, idx);
        if (!map.has(strongKey)) map.set(strongKey, idx);
        idx++;
      } else if (
        o["type"] === "milestone" ||
        // \d (Psalm superscription) is type:"section" but its content IS
        // alignable verse body — descend it, matching AlignmentPanel.
        (o["type"] === "section" && o["tag"] === "d")
      ) {
        walk((o["children"] as unknown[] | undefined) ?? []);
      }
    }
  };
  walk(verseObjects);
  return map;
}

/**
 * Position of a group's source word in the source verse. NFC content +
 * occurrence first, then content first-instance, then strong + occurrence,
 * then strong first-instance. -1 when nothing matches.
 */
export function resolveSourcePos(s: SourceWord, indexMap: Map<string, number>): number {
  const c = nfc(s.content ?? "");
  return (
    indexMap.get(`t:${c}|${s.occurrence}`) ??
    indexMap.get(`t:${c}|1`) ??
    indexMap.get(`s:${s.strong}|${s.occurrence}`) ??
    indexMap.get(`s:${s.strong}|1`) ??
    -1
  );
}

/** Stable position-sequence identity, or null when any source word is unresolved. */
export function groupPositionKey(
  g: AlignmentGroup,
  indexMap: Map<string, number>,
): string | null {
  if (g.source.length === 0) return null;
  const positions = g.source.map((s) => resolveSourcePos(s, indexMap));
  return positions.some((p) => p < 0) ? null : positions.join(".");
}

/**
 * The cards actually rendered: state groups sorted into source order, with
 * compound overlaps stripped and same-source / same-position duplicates fused.
 * One card can therefore stand for several state groups — see cardStateGroups.
 */
export function orderDisplayGroups(
  state: AlignmentState | null,
  indexMap: Map<string, number>,
): AlignmentGroup[] {
  if (!state) return [];
  const sortKey = (g: AlignmentGroup) => {
    if (g.source.length === 0) return Number.MAX_SAFE_INTEGER;
    const pos = resolveSourcePos(g.source[0], indexMap);
    return pos >= 0 ? pos : Number.MAX_SAFE_INTEGER;
  };
  const sorted = [...state.groups].sort((a, b) => sortKey(a) - sortKey(b));
  const stripped = stripCompoundOverlaps(sorted);
  const merged = mergeAdjacentSameSource(stripped);
  return mergeSamePositionGroups(merged, (g) => groupPositionKey(g, indexMap));
}

/**
 * Every state-group id a display card collapsed — by source identity OR source
 * position, the same resolution AlignmentPanel's clear/merge handlers use. The
 * carried id leads the list.
 */
export function cardStateGroups(
  state: AlignmentState | null,
  cardId: string,
  indexMap: Map<string, number>,
): string[] {
  if (!state) return [cardId];
  const target = state.groups.find((g) => g.id === cardId);
  if (!target) return [cardId];
  const key = sourceKey(target);
  const posKey = groupPositionKey(target, indexMap);
  return [
    cardId,
    ...state.groups
      .filter(
        (g) =>
          g.id !== cardId &&
          (sourceKey(g) === key ||
            (posKey !== null && groupPositionKey(g, indexMap) === posKey)),
      )
      .map((g) => g.id),
  ];
}

/**
 * Strong's numbers (for the lexicon) and "<strong>~<morphClass>" keys (for
 * /api/align/suggest) covering both the parsed groups and every token in the
 * source verse. Mirrors AlignmentPanel's `allStrongs`.
 */
export function collectStrongKeys(
  state: AlignmentState | null,
  sourceVerse: VerseDto | null,
): { strongs: string[]; keys: string[] } {
  const strongs = new Set<string>();
  const keys = new Set<string>();
  const add = (strong: string, morph: string | undefined) => {
    if (!strong) return;
    strongs.add(strong);
    keys.add(suggestKey(strong, morph));
  };
  if (state) {
    for (const g of state.groups) for (const s of g.source) add(s.strong, s.morph);
  }
  const sourceObjects = (sourceVerse?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  if (Array.isArray(sourceObjects)) {
    const walk = (nodes: unknown[]) => {
      for (const n of nodes ?? []) {
        const o = n as Record<string, unknown> | null;
        if (!o) continue;
        if (o["type"] === "word" && o["tag"] === "w") {
          add(String(o["strong"] ?? ""), o["morph"] as string | undefined);
        } else if (o["type"] === "milestone") {
          walk((o["children"] as unknown[] | undefined) ?? []);
        }
      }
    };
    walk(sourceObjects);
  }
  return { strongs: [...strongs], keys: [...keys] };
}

/** Document-order target tokens with their aligned flag — computeGhosts' input. */
export function streamWordsOf(state: AlignmentState | null): StreamWord[] {
  if (!state) return [];
  return state.stream.flatMap((it) =>
    it.kind === "word"
      ? [{ id: it.word.id, text: it.word.text, aligned: it.alignedTo !== null }]
      : [],
  );
}
