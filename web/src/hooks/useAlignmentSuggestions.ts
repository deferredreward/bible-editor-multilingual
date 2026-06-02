// Fetches non-AI alignment suggestions for the current verse's source words.
// Each key is a per-word "<strong>~<morphClass>" composite (suggestKey); the
// backend (/api/align/suggest) ranks candidate target surfaces from the
// precomputed alignment memory (strong-only counts interpolated with
// morphology-conditioned counts), with a lexicon gloss/definition fallback.
// Intentionally dumb: one fetch per (bible, key-set), cached module-wide; the
// component does the word-bank intersection so unsaved edits never round-trip.

import { useEffect, useState } from "react";
import type { AlignCandidate, AlignPhrase, AlignSuggestion } from "../lib/alignmentSuggest";

// Re-exported for existing importers; the canonical definitions live with the
// scoring logic in ../lib/alignmentSuggest (shared with the eval harness).
export type { AlignCandidate, AlignPhrase, AlignSuggestion };

type SuggestionMap = Record<string, AlignSuggestion>; // keyed by the "<strong>~<morph>" key sent

// Module-level cache so flipping between verses / re-renders doesn't refetch.
const cache = new Map<string, SuggestionMap>();
const EMPTY: SuggestionMap = {};

export function useAlignmentSuggestions(
  bibleVersion: string,
  rawKeys: string[],
): SuggestionMap {
  const bible = (bibleVersion || "ult").toLowerCase();
  const unique = [...new Set(rawKeys)].filter(Boolean).sort();
  const key = `${bible}::${unique.join(";")}`;
  const [, force] = useState(0);

  useEffect(() => {
    if (unique.length === 0 || cache.has(key)) return;
    let cancelled = false;
    const url = `/api/align/suggest?bible=${encodeURIComponent(bible)}&keys=${encodeURIComponent(unique.join(";"))}`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : { suggestions: {} }))
      .then((data: { suggestions?: SuggestionMap }) => {
        if (cancelled) return;
        cache.set(key, data.suggestions ?? {});
        force((t) => t + 1);
      })
      .catch(() => {
        // Network failure: cache empty so we don't hammer, but a later verse
        // (different key) can still try.
        if (!cancelled) {
          cache.set(key, {});
          force((t) => t + 1);
        }
      });
    return () => {
      cancelled = true;
    };
    // key encodes bible + the sorted composite-key set; rawKeys identity is moot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return cache.get(key) ?? EMPTY;
}
