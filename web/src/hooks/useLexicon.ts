// Module-level lexicon cache: each unique Strong's key is fetched at most
// once per page load. Components subscribe via useLexicon, which batches
// requested strongs into a single GET /api/lexicon?strongs=... call.

import { useEffect, useState } from "react";

export interface LexiconEntry {
  strong: string;
  resource: "uhal" | "ugl";
  lemma: string | null;
  part_of_speech: string | null;
  gloss: string | null;
  definition: string | null;
}

const cache = new Map<string, LexiconEntry | null>();
const inFlight = new Set<string>();
const subscribers = new Set<() => void>();

// Reduce 'b:H2320', 'H2148a', etc. to the keys the API can resolve. Returns
// the exact form and an alpha-stripped fallback ('H2148a' → ['H2148a','H2148']).
export function normalizeStrong(raw: string): string[] {
  if (!raw) return [];
  const m = raw.match(/[HG]\d+[a-z]?/i);
  if (!m) return [];
  const exact = m[0].toUpperCase().replace(/^([HG])0+/, "$1");
  const base = exact.replace(/[A-Z]$/, "");
  return exact === base ? [exact] : [exact, base];
}

async function ensure(rawStrongs: string[]) {
  const want: string[] = [];
  for (const s of rawStrongs) {
    const keys = normalizeStrong(s);
    for (const k of keys) {
      if (!cache.has(k) && !inFlight.has(k)) want.push(k);
    }
  }
  if (want.length === 0) return;
  for (const k of want) inFlight.add(k);
  try {
    const url = `/api/lexicon?strongs=${encodeURIComponent(want.join(","))}`;
    const res = await fetch(url);
    const data = (await res.json()) as { entries?: LexiconEntry[] };
    const byStrong = new Map((data.entries ?? []).map((e) => [e.strong, e]));
    for (const k of want) cache.set(k, byStrong.get(k) ?? null);
  } catch {
    for (const k of want) cache.set(k, null);
  } finally {
    for (const k of want) inFlight.delete(k);
    for (const fn of subscribers) fn();
  }
}

// Subscribe to lexicon updates for the given raw Strong's. Returns a map
// keyed by the *input* raw form so callers can look up by what they have.
export function useLexicon(rawStrongs: string[]): Map<string, LexiconEntry | null> {
  const [, force] = useState(0);
  const joined = rawStrongs.join(",");
  useEffect(() => {
    void ensure(rawStrongs);
    const fn = () => force((t) => t + 1);
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
    // joined captures the set of strongs; rawStrongs identity is irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  const out = new Map<string, LexiconEntry | null>();
  for (const raw of rawStrongs) {
    const keys = normalizeStrong(raw);
    let hit: LexiconEntry | null = null;
    for (const k of keys) {
      const v = cache.get(k);
      if (v) {
        hit = v;
        break;
      }
    }
    out.set(raw, hit);
  }
  return out;
}
