// Pure (React-free) helpers behind the shared Setup/Preferences org draft.
// Kept in a plain .ts module (no JSX) so the node --strip-types web test
// runner can import and unit-test the override-building logic directly, and so
// the single decision — "an unchecked upstream resource may be left blank OR
// pointed at a different repo within the same upstream org" — lives in exactly
// one place the hook wraps with React state.

export type ResourceKey = "lit" | "sim" | "tn" | "tq" | "twl" | "tw" | "ta";

export const RESOURCE_KEYS: ResourceKey[] = ["lit", "sim", "tn", "tq", "twl", "tw", "ta"];

// unfoldingWord's English gateway repos — the default upstream a non-English
// org translates FROM. Mirrors api/src/projectConfig.ts EN_REPOS / UW_SOURCE so
// the legacy "translationSource on" path reproduces UW_SOURCE byte-for-byte.
export const UW_UPSTREAM_ORG = "unfoldingWord";
export const UW_UPSTREAM_LANG = "en";
export const UW_UPSTREAM_REPOS: Record<ResourceKey, string> = {
  lit: "en_ult",
  sim: "en_ust",
  tn: "en_tn",
  tq: "en_tq",
  twl: "en_twl",
  tw: "en_tw",
  ta: "en_ta",
};

// Per-resource upstream selection (owner decision baked into this PR):
//   upstream → pull from the upstream org at its default/inferred repo,
//   override → pull from the upstream org at a DIFFERENT repo name,
//   blank    → no upstream source for this resource (omitted entirely).
// A different upstream ORG per resource is intentionally OUT of scope (#84).
export type ResourceSourceMode = "upstream" | "override" | "blank";

export interface ResourceSource {
  mode: ResourceSourceMode;
  /** Present only when mode === "override": the alternate repo (same upstream org). */
  repo?: string;
}

export type ResourceSourceMap = Record<ResourceKey, ResourceSource>;

export function defaultResourceSources(): ResourceSourceMap {
  return {
    lit: { mode: "upstream" },
    sim: { mode: "upstream" },
    tn: { mode: "upstream" },
    tq: { mode: "upstream" },
    twl: { mode: "upstream" },
    tw: { mode: "upstream" },
    ta: { mode: "upstream" },
  };
}

// Set every resource to a single mode — backs the legacy `translationSourceOn`
// boolean (on = all upstream, off = all blank).
export function allResourceSources(mode: "upstream" | "blank"): ResourceSourceMap {
  return {
    lit: { mode },
    sim: { mode },
    tn: { mode },
    tq: { mode },
    twl: { mode },
    tw: { mode },
    ta: { mode },
  };
}

export interface TranslationSource {
  org: string;
  languageCode: string;
  repos: Partial<Record<ResourceKey, string>>;
}

// Assemble the translationSource object from the per-resource selection:
//   upstream → upstreamRepos[key] (skipped if blank/missing),
//   override → the override repo (skipped if blank),
//   blank    → omitted.
// Emits null when EVERY resource resolves to nothing (all blank) — matching the
// legacy `translationSourceOn === false` case.
export function buildTranslationSource(params: {
  upstreamOrg: string;
  languageCode: string;
  upstreamRepos: Record<ResourceKey, string>;
  resourceSource: ResourceSourceMap;
}): TranslationSource | null {
  const { upstreamOrg, languageCode, upstreamRepos, resourceSource } = params;
  const repos: Partial<Record<ResourceKey, string>> = {};
  for (const key of RESOURCE_KEYS) {
    const sel = resourceSource[key] ?? { mode: "upstream" };
    if (sel.mode === "upstream") {
      const repo = (upstreamRepos[key] ?? "").trim();
      if (repo !== "") repos[key] = repo;
    } else if (sel.mode === "override") {
      const repo = (sel.repo ?? "").trim();
      if (repo !== "") repos[key] = repo;
    }
    // blank → omit
  }
  if (Object.keys(repos).length === 0) return null;
  return { org: upstreamOrg, languageCode, repos };
}

// The legacy boolean the existing wizard/Preferences toggle drives. On = the
// translationSource will be non-null (at least one resource is sourced);
// Off = every resource is blank (translationSource === null).
export function translationSourceOnFor(resourceSource: ResourceSourceMap): boolean {
  return RESOURCE_KEYS.some((k) => (resourceSource[k]?.mode ?? "upstream") !== "blank");
}
