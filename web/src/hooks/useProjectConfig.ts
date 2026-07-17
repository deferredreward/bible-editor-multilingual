import { useEffect, useState } from "react";
import {
  api,
  type ProjectConfig,
  type ProjectConfigResponse,
  type ProjectPreset,
} from "../sync/api";
import { getBuiltinLayouts } from "../lib/builtinLayouts";
import { validateLayoutSpec, type LayoutSpec } from "../lib/layoutSpec";
import { validateLayoutAgainstRegistry } from "../lib/panelRegistry";

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

// Resolve the workspace layout list for a config-response: prefer the
// server-shipped `layouts` (each validated structurally, then against the panel
// registry, dropping any invalid/drifted spec) when present and non-empty;
// otherwise fall back to the client's bundled built-ins. This gives offline
// resilience (the localStorage cache stores only `config`, so its responses
// have no `layouts` and fall through) and drift safety (a bad server spec is
// dropped, never fatal — worst case the whole set falls back to bundled).
function resolveWorkflowLayouts(res: ProjectConfigResponse): LayoutSpec[] {
  const cfg = res.config;
  if (Array.isArray(res.layouts) && res.layouts.length > 0) {
    const valid: LayoutSpec[] = [];
    for (const raw of res.layouts) {
      const structural = validateLayoutSpec(raw);
      if (!structural) continue;
      const available = validateLayoutAgainstRegistry(structural, cfg);
      if (available) valid.push(available);
    }
    if (valid.length > 0) return valid;
  }
  return getBuiltinLayouts(cfg);
}

// The workspace layouts the switcher offers: server-shipped defaults when
// available, otherwise the bundled built-ins. Same subscribe-to-shared-cache
// pattern as useProjectPresets.
export function useWorkflowLayouts(): LayoutSpec[] {
  const [val, setVal] = useState<LayoutSpec[]>(() =>
    cache ? resolveWorkflowLayouts(cache) : getBuiltinLayouts(null),
  );
  useEffect(() => {
    let mounted = true;
    load()
      .then((res) => {
        if (mounted) setVal(resolveWorkflowLayouts(res));
      })
      .catch(() => {
        /* keep cached value */
      });
    const subscriber = (res: ProjectConfigResponse) => setVal(resolveWorkflowLayouts(res));
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

// PR B: apply a custom-gl draft (or any explicit override set) — always sends
// `overrides` explicitly, unlike selectProjectPreset above.
export async function applyProjectOverrides(
  preset: string,
  overrides: Record<string, unknown> | null,
): Promise<ProjectConfig> {
  const res = await api.putProjectConfigWithOverrides(preset, overrides);
  publish({ config: res.config, presets: cache?.presets ?? [] });
  return res.config;
}

// Publish an externally-obtained config update (e.g. from a lane PATCH
// response) through the shared cache so every subscriber re-renders.
export function updateProjectConfig(cfg: ProjectConfig): void {
  publish({
    config: cfg,
    presets: cache?.presets ?? [],
  });
}

// Force a fresh fetch from the server and publish. Useful after lane mutations
// where the server returns partial state and we want the full picture.
export async function refreshProjectConfig(): Promise<ProjectConfig> {
  inflight = null; // clear any stale in-flight
  const res = await api.getProjectConfig();
  publish(res);
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
