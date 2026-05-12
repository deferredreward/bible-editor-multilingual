import { useEffect, useState } from "react";
import { api, type Catalogs } from "../sync/api";

// Single in-module cache so every NoteCard/WordsTable shares the same fetch.
let cache: Catalogs | null = null;
let inflight: Promise<Catalogs> | null = null;
const subscribers = new Set<(c: Catalogs) => void>();

function load(): Promise<Catalogs> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = api.getCatalogs().then((c) => {
    cache = c;
    inflight = null;
    for (const s of subscribers) s(c);
    return c;
  });
  return inflight;
}

export function useCatalogs(): Catalogs {
  const [val, setVal] = useState<Catalogs>(
    () => cache ?? { supportReferences: [], twLinks: [] },
  );
  useEffect(() => {
    let mounted = true;
    void load().then((c) => {
      if (mounted) setVal(c);
    });
    subscribers.add(setVal);
    return () => {
      mounted = false;
      subscribers.delete(setVal);
    };
  }, []);
  return val;
}
