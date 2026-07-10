// Per-project source configuration — the multilingual replacement for the
// hardcoded unfoldingWord/en_* mapping that used to live in dcsSources.ts
// (and its duplicate in export.ts RESOURCE_TARGETS).
//
// Design decisions, in order of load-bearing-ness:
//
// 1. `bible_version` labels stay ROLE-CODED. The verses PK, the export
//    machinery, the pending_imports classifier, and the web's enabled-version
//    defaults all key on the literal strings "ULT" | "UST" | "UHB" | "UGNT".
//    Those stay, reinterpreted as roles: ULT = the project's *literal* pane,
//    UST = the *simplified* pane, UHB/UGNT = the originals. A GL project maps
//    the roles to its own repos (ar_glt → role ULT) and the UI renders
//    display labels from this config. This means ZERO data migration and the
//    export/reimport data-loss guards keep operating on the same keys.
//
// 2. One D1 database = one project. The config is a single row (id=1) in
//    project_config; the tenancy model for more languages is more databases
//    (FEASIBILITY §4 Option A), not more rows.
//
// 3. Switching a live database to a different org/preset is an admin action
//    with consequences: the book_resource_syncs watermarks recorded under the
//    old org no longer describe the new source. writeProjectConfig therefore
//    stamps source_org on new watermarks and storedResourceSha treats an
//    org-mismatched watermark as absent (see bookReimport.ts) — the reimport
//    then treats the book as never-synced rather than trusting a stale SHA.
//
// 4. Presets are code, overrides are data. The four GL presets below were
//    verified against live Door43 org listings on 2026-07-10. es-419 and ru
//    orgs currently hold legacy per-book repos (ULB1_gen-style / tStudio
//    exports), so their presets point at the STANDARD repo names the
//    publisher will create ({lang}_glt, ...) — flagged `reposVerified:false`.

import type { Env } from "./index";

export type ResourceKey = "lit" | "sim" | "tn" | "tq" | "twl";

export interface GlBiblePane {
  /** DCS repo under the project org, e.g. "ar_avd" */
  repo: string;
  /** bible_version label for the verses store, e.g. "AVD" (must be unique per project) */
  version: string;
  /** Display title (native) */
  title: string;
}

export interface ProjectConfig {
  /** Preset id this config was derived from */
  preset: string;
  /** DCS org the editable resources are imported from / exported to */
  org: string;
  /** Export target org; defaults to `org` (env DCS_EXPORT_OWNER still wins for back-compat) */
  exportOrg: string;
  /** IETF-ish language code used in repo names and RC manifests, e.g. "en", "ar", "es-419" */
  languageCode: string;
  /** English name of the language */
  languageName: string;
  /** Native name, for UI display */
  languageTitle: string;
  direction: "ltr" | "rtl";
  /** Repo name per editable resource role */
  repos: Record<ResourceKey, string>;
  /** Display labels for the role-coded lit/sim panes (bible_version stays ULT/UST) */
  litLabel: string;
  simLabel: string;
  /** Additional read-only GL Bible panes (imported on demand; verses keyed by their `version`) */
  glBibles: GlBiblePane[];
  /**
   * Source-language project this GL translates FROM (null for the English
   * root project, which is authored, not translated). When set, translation
   * mode is available: English rows import read-only from here and the
   * `translate` pipeline targets this project's language.
   */
  translationSource: {
    org: string;
    languageCode: string;
    repos: Record<ResourceKey, string>;
  } | null;
  /** True when the org's repos were confirmed to exist on Door43 (2026-07-10 survey) */
  reposVerified: boolean;
}

const EN_REPOS: Record<ResourceKey, string> = {
  lit: "en_ult", sim: "en_ust", tn: "en_tn", tq: "en_tq", twl: "en_twl",
};

const UW_SOURCE = { org: "unfoldingWord", languageCode: "en", repos: EN_REPOS };

export const PRESETS: Record<string, ProjectConfig> = {
  // The default — byte-for-byte the behavior the hardcoded mapping had.
  "en-unfoldingword": {
    preset: "en-unfoldingword",
    org: "unfoldingWord",
    exportOrg: "unfoldingWord",
    languageCode: "en",
    languageName: "English",
    languageTitle: "English",
    direction: "ltr",
    repos: EN_REPOS,
    litLabel: "ULT",
    simLabel: "UST",
    glBibles: [],
    translationSource: null,
    reposVerified: true,
  },
  // Verified live 2026-07-10: BSOJ has ar_glt, ar_gst, ar_tn, ar_tq, ar_twl,
  // ar_tw, ar_ta plus Bibles ar_avd (Van Dyke), ar_nav, ar_arst.
  "ar-bsoj": {
    preset: "ar-bsoj",
    org: "BSOJ",
    exportOrg: "BSOJ",
    languageCode: "ar",
    languageName: "Arabic",
    languageTitle: "العربية",
    direction: "rtl",
    repos: { lit: "ar_glt", sim: "ar_gst", tn: "ar_tn", tq: "ar_tq", twl: "ar_twl" },
    litLabel: "GLT",
    simLabel: "GST",
    glBibles: [
      { repo: "ar_avd", version: "AVD", title: "فانديك" },
      { repo: "ar_nav", version: "NAV", title: "الترجمة العربية المبسطة" },
    ],
    translationSource: UW_SOURCE,
    reposVerified: true,
  },
  // Verified live 2026-07-10: id_gl has the full standard set.
  "id-gl": {
    preset: "id-gl",
    org: "id_gl",
    exportOrg: "id_gl",
    languageCode: "id",
    languageName: "Indonesian",
    languageTitle: "Bahasa Indonesia",
    direction: "ltr",
    repos: { lit: "id_glt", sim: "id_gst", tn: "id_tn", tq: "id_tq", twl: "id_twl" },
    litLabel: "GLT",
    simLabel: "GST",
    glBibles: [],
    translationSource: UW_SOURCE,
    reposVerified: true,
  },
  // es-419_gl currently holds legacy per-book ULB repos (ULB1_gen …) and
  // partial tN/tQ — no standard {lang}_* repos yet (survey 2026-07-10).
  // This preset names the repos the publisher would create.
  "es-419-gl": {
    preset: "es-419-gl",
    org: "es-419_gl",
    exportOrg: "es-419_gl",
    languageCode: "es-419",
    languageName: "Latin American Spanish",
    languageTitle: "Español latinoamericano",
    direction: "ltr",
    repos: {
      lit: "es-419_glt", sim: "es-419_gst",
      tn: "es-419_tn", tq: "es-419_tq", twl: "es-419_twl",
    },
    litLabel: "GLT",
    simLabel: "GST",
    glBibles: [],
    translationSource: UW_SOURCE,
    reposVerified: false,
  },
  // ru_gl holds tStudio-era per-book exports + ru_ta (survey 2026-07-10);
  // standard repos would be created by the publisher.
  "ru-gl": {
    preset: "ru-gl",
    org: "ru_gl",
    exportOrg: "ru_gl",
    languageCode: "ru",
    languageName: "Russian",
    languageTitle: "Русский",
    direction: "ltr",
    repos: { lit: "ru_glt", sim: "ru_gst", tn: "ru_tn", tq: "ru_tq", twl: "ru_twl" },
    litLabel: "GLT",
    simLabel: "GST",
    glBibles: [],
    translationSource: UW_SOURCE,
    reposVerified: false,
  },
};

export const DEFAULT_PRESET = "en-unfoldingword";

// Per-isolate cache. Config changes are rare admin actions; a 60s TTL keeps
// every request path from paying a D1 read while still converging quickly
// after a PUT (which also clears the cache in-isolate).
let cached: { cfg: ProjectConfig; at: number } | null = null;
const CACHE_TTL_MS = 60_000;

export function clearProjectConfigCache(): void {
  cached = null;
}

interface ConfigRow {
  preset: string;
  overrides_json: string | null;
}

// Merge stored overrides over the preset. Only known top-level keys are
// honored; unknown keys are dropped (forward-compat: an old worker reading a
// newer overrides blob must not crash).
function materialize(preset: string, overridesJson: string | null): ProjectConfig {
  const base = PRESETS[preset] ?? PRESETS[DEFAULT_PRESET];
  if (!overridesJson) return base;
  try {
    const o = JSON.parse(overridesJson) as Partial<ProjectConfig>;
    return {
      ...base,
      ...(o.org ? { org: o.org } : {}),
      ...(o.exportOrg ? { exportOrg: o.exportOrg } : {}),
      ...(o.languageCode ? { languageCode: o.languageCode } : {}),
      ...(o.languageName ? { languageName: o.languageName } : {}),
      ...(o.languageTitle ? { languageTitle: o.languageTitle } : {}),
      ...(o.direction === "ltr" || o.direction === "rtl" ? { direction: o.direction } : {}),
      ...(o.repos ? { repos: { ...base.repos, ...o.repos } } : {}),
      ...(o.litLabel ? { litLabel: o.litLabel } : {}),
      ...(o.simLabel ? { simLabel: o.simLabel } : {}),
      ...(Array.isArray(o.glBibles) ? { glBibles: o.glBibles } : {}),
      preset: base.preset,
    };
  } catch {
    return base;
  }
}

export async function getProjectConfig(env: Env): Promise<ProjectConfig> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.cfg;
  let cfg: ProjectConfig;
  try {
    const row = await env.DB
      .prepare("SELECT preset, overrides_json FROM project_config WHERE id = 1")
      .first<ConfigRow>();
    cfg = row ? materialize(row.preset, row.overrides_json) : PRESETS[DEFAULT_PRESET];
  } catch {
    // Table missing (migration not yet applied) or transient D1 error →
    // default preset preserves the pre-refactor behavior exactly.
    cfg = PRESETS[DEFAULT_PRESET];
  }
  cached = { cfg, at: now };
  return cfg;
}

export async function writeProjectConfig(
  env: Env,
  preset: string,
  overrides: Partial<ProjectConfig> | null,
): Promise<ProjectConfig> {
  if (!PRESETS[preset]) throw new Error(`unknown preset: ${preset}`);
  const overridesJson = overrides ? JSON.stringify(overrides) : null;
  await env.DB
    .prepare(
      `INSERT INTO project_config (id, preset, overrides_json, updated_at)
       VALUES (1, ?, ?, unixepoch())
       ON CONFLICT(id) DO UPDATE SET preset = excluded.preset,
         overrides_json = excluded.overrides_json, updated_at = excluded.updated_at`,
    )
    .bind(preset, overridesJson)
    .run();
  clearProjectConfigCache();
  return materialize(preset, overridesJson);
}

// The repo name for a role under this project (what dcsResourceFile consumes).
export function repoFor(cfg: ProjectConfig, key: ResourceKey): string {
  return cfg.repos[key];
}
