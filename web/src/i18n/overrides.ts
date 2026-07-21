// Runtime UI-string overrides (Localization tab; migration 0052).
//
// UI strings ship as static per-language JSON (./locales/*.json) bundled at
// build time. This module layers server-stored overrides on top at runtime via
// i18next's addResourceBundle deep-merge, so an admin's edit is live for them
// immediately and for everyone else on next load. react-i18next re-renders on
// these store changes because index.ts sets `react.bindI18nStore`.

import i18n from "./index";
import en from "./locales/en.json";
import { api, ApiError, type L10nBag } from "../sync/api";

const NS = "translation";

/** Deep-merge server override bags over the bundled base, per language. */
export function applyOverrides(overrides: Record<string, L10nBag>): void {
  for (const [lang, bag] of Object.entries(overrides)) {
    if (bag && typeof bag === "object" && Object.keys(bag).length > 0) {
      i18n.addResourceBundle(lang, NS, bag, /* deep */ true, /* overwrite */ true);
    }
  }
}

/** The live merged bundle for a language (base + applied overrides) — the
 *  drop-in locale file the Export button downloads. */
export function mergedLocale(lang: string): unknown {
  return i18n.getResourceBundle(lang, NS) ?? {};
}

export interface StringRow {
  /** Top-level namespace (common, topbar, preferences, …) — used for grouping. */
  ns: string;
  /** Full dot path (e.g. "preferences.section.brief"). */
  path: string;
  /** The English source text (canonical). */
  english: string;
}

/** Flatten en.json into leaf rows, preserving file order and grouping key. */
export function flattenEn(): StringRow[] {
  const rows: StringRow[] = [];
  const walk = (node: unknown, prefix: string, ns: string) => {
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${k}` : k;
        walk(v, path, prefix ? ns : k);
      }
    } else if (typeof node === "string") {
      rows.push({ ns, path: prefix, english: node });
    }
  };
  walk(en, "", "");
  return rows;
}

/** Read the raw value stored for a key in one language, WITHOUT English
 *  fallback — undefined means the locale is missing that key (a drift gap). */
export function currentValue(lang: string, path: string): string | undefined {
  const v = i18n.getResource(lang, NS, path);
  return typeof v === "string" ? v : undefined;
}

/** Build a nested {ns:{key:"text"}} bag from a flat map of path → text. */
export function bagFromFlat(flat: Record<string, string>): L10nBag {
  const bag: L10nBag = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split(".");
    let node = bag;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
      node = node[key] as L10nBag;
    }
    node[parts[parts.length - 1]] = value;
  }
  return bag;
}

/** Flatten a nested bag back to path → text (inverse of bagFromFlat) — used to
 *  seed the editor's draft from a fetched override bag. */
export function flatFromBag(bag: L10nBag, prefix = ""): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(bag)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") flat[path] = v;
    else if (v && typeof v === "object") Object.assign(flat, flatFromBag(v, path));
  }
  return flat;
}

export type SaveOverrideOutcome =
  | { ok: true; version: number }
  | { ok: false; kind: "conflict" | "forbidden" | "error" };

/** Merge `patch` into `storedFlat`, PUT the result under CAS (`baseVersion`),
 *  and apply it live on success. Shared by PreferencesWorkspace's Localization
 *  tab and LocalizationInspector's inspect-to-edit popup — both hit the same
 *  save/CAS/error-classification contract, and letting them diverge means a
 *  future change to that contract (a new error code, a different merge
 *  strategy) silently applies to only one of them. Callers still own their
 *  own post-save/error UI state (which fields to clear, which local cache to
 *  refresh) — this only does the network call + merge + error mapping. */
export async function saveOverridePatch(
  lang: string,
  baseVersion: number,
  storedFlat: Record<string, string>,
  patch: Record<string, string>,
): Promise<SaveOverrideOutcome> {
  const mergedFlat = { ...storedFlat, ...patch };
  const bag = bagFromFlat(mergedFlat);
  try {
    const { version } = await api.putL10nOverrides(lang, baseVersion, bag);
    applyOverrides({ [lang]: bag });
    return { ok: true, version };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return { ok: false, kind: "conflict" };
    if (e instanceof ApiError && e.status === 403) return { ok: false, kind: "forbidden" };
    return { ok: false, kind: "error" };
  }
}

/** i18next interpolation tokens ({{book}}, {{count}}, …) present in a string. */
export function placeholdersOf(str: string): string[] {
  return (str.match(/\{\{[^}]+\}\}/g) ?? []).map((s) => s.trim());
}
