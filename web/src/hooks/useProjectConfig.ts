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

// Persist the editor/translator mode override (admin only) and publish the
// updated config through the shared cache so every mode-dependent component
// (TopBar articles, Preferences memory, translation UI) re-renders at once.
export async function setProjectMode(
  mode: "authoring" | "translation",
): Promise<ProjectConfig> {
  const res = await api.patchProjectMode(mode);
  publish({ config: res.config, presets: cache?.presets ?? [] });
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

// True when translation-mode UI should be shown. Now driven by the explicit,
// admin-toggleable `mode` (materialized server-side), decoupled from the
// data source: an admin can run an org that HAS a translationSource in
// authoring mode, or vice versa.
export function isTranslationProject(cfg: ProjectConfig | null): boolean {
  if (!cfg) return false;
  // `mode` is the source of truth. Fall back to the legacy translationSource
  // derivation ONLY for a pre-mode cached config whose `mode` field is missing,
  // so first paint before the fetch converges still matches the old behavior
  // (English root → non-translation) rather than flickering.
  if (cfg.mode === "authoring" || cfg.mode === "translation") {
    return cfg.mode === "translation";
  }
  return cfg.translationSource != null;
}
