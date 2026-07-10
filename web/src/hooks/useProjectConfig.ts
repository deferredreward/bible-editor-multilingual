import { useEffect, useState } from "react";
import { api, type ProjectConfig } from "../sync/api";

// The active per-project source config (org/language/direction/labels +
// translationSource). Mirrors useNoteTemplates: one shared fetch, a
// localStorage cache so an F5 while offline still has the config, and
// stale-while-revalidate on mount. Config changes are rare admin actions, so a
// cached value is almost always current; the background refresh converges after
// a PUT. Returns null until the first fetch resolves (no cached value yet).
const STORAGE_KEY = "bible-editor.project-config.v1";

function readPersisted(): ProjectConfig | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as ProjectConfig;
  } catch {
    return null;
  }
}

function writePersisted(cfg: ProjectConfig) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* quota or private mode — soft fail */
  }
}

let cache: ProjectConfig | null = readPersisted();
let inflight: Promise<ProjectConfig> | null = null;
const subscribers = new Set<(c: ProjectConfig) => void>();

function load(): Promise<ProjectConfig> {
  if (inflight) return inflight;
  inflight = api
    .getProjectConfig()
    .then((res) => {
      cache = res.config;
      inflight = null;
      writePersisted(res.config);
      for (const s of subscribers) s(res.config);
      return res.config;
    })
    .catch((err) => {
      inflight = null;
      throw err;
    });
  return inflight;
}

export function useProjectConfig(): ProjectConfig | null {
  const [val, setVal] = useState<ProjectConfig | null>(() => cache);
  useEffect(() => {
    let mounted = true;
    load()
      .then((c) => {
        if (mounted) setVal(c);
      })
      .catch(() => {
        /* keep cached value */
      });
    subscribers.add(setVal);
    return () => {
      mounted = false;
      subscribers.delete(setVal);
    };
  }, []);
  return val;
}

// True when translation-mode UI should be shown: the active project translates
// FROM a source language (English root project → translationSource === null →
// false, so its UX is byte-for-byte unchanged).
export function isTranslationProject(cfg: ProjectConfig | null): boolean {
  return !!cfg && cfg.translationSource !== null;
}
