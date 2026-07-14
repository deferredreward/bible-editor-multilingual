import { useEffect, useState } from "react";
import {
  api,
  type ProjectConfig,
  type ProjectConfigResponse,
  type ProjectPreset,
} from "../sync/api";

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

const persisted = readPersisted();
let cache: ProjectConfigResponse | null = persisted
  ? { config: persisted, presets: [] }
  : null;
let inflight: Promise<ProjectConfigResponse> | null = null;
const subscribers = new Set<(c: ProjectConfigResponse) => void>();

function publish(next: ProjectConfigResponse): ProjectConfigResponse {
  cache = next;
  writePersisted(next.config);
  for (const s of subscribers) s(next);
  return next;
}

function load(): Promise<ProjectConfigResponse> {
  if (inflight) return inflight;
  inflight = api
    .getProjectConfig()
    .then((res) => {
      inflight = null;
      return publish(res);
    })
    .catch((err) => {
      inflight = null;
      throw err;
    });
  return inflight;
}

export function useProjectConfig(): ProjectConfig | null {
  const [val, setVal] = useState<ProjectConfig | null>(() => cache?.config ?? null);
  useEffect(() => {
    let mounted = true;
    load()
      .then((res) => {
        if (mounted) setVal(res.config);
      })
      .catch(() => {
        /* keep cached value */
      });
    const subscriber = (res: ProjectConfigResponse) => setVal(res.config);
    subscribers.add(subscriber);
    return () => {
      mounted = false;
      subscribers.delete(subscriber);
    };
  }, []);
  return val;
}

export function useProjectPresets(): ProjectPreset[] {
  const [val, setVal] = useState<ProjectPreset[]>(() => cache?.presets ?? []);
  useEffect(() => {
    let mounted = true;
    load()
      .then((res) => {
        if (mounted) setVal(res.presets);
      })
      .catch(() => {
        /* keep cached value */
      });
    const subscriber = (res: ProjectConfigResponse) => setVal(res.presets);
    subscribers.add(subscriber);
    return () => {
      mounted = false;
      subscribers.delete(subscriber);
    };
  }, []);
  return val;
}

// Project mode is global server state, not a local UI preference. Publish the
// PUT response through the same shared cache used by every mode-dependent
// component so TopBar, Articles, and translation review UI update immediately.
export async function selectProjectPreset(preset: string): Promise<ProjectConfig> {
  const res = await api.putProjectConfig(preset);
  publish({
    config: res.config,
    presets: cache?.presets ?? [],
  });
  return res.config;
}

// True when translation-mode UI should be shown: the active project translates
// FROM a source language (English root project → translationSource === null →
// false, so its UX is byte-for-byte unchanged).
export function isTranslationProject(cfg: ProjectConfig | null): boolean {
  // Loose `!= null` (not `!== null`) so a cached/older-schema config whose
  // `translationSource` is UNDEFINED (missing field) reads as non-translation
  // — otherwise `undefined !== null` is true and the English root project would
  // wrongly enable translation-mode UI on first paint until the fetch converges.
  return !!cfg && cfg.translationSource != null;
}
