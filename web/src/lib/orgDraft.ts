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
//   override → pull from a DIFFERENT repo, optionally in a DIFFERENT org,
//   blank    → no upstream source for this resource (omitted entirely).
// An `override` with an `org` (from a pasted Door43 URL) points the resource at
// that org+repo; without `org` it stays in the default upstream org (a pragmatic
// slice of #84 — full multi-org search UI still deferred).
export type ResourceSourceMode = "upstream" | "override" | "blank";

export interface ResourceSource {
  mode: ResourceSourceMode;
  /** Present only when mode === "override": the alternate repo. */
  repo?: string;
  /**
   * Present only when mode === "override" AND the override points at a DIFFERENT
   * org than the default upstream (parsed from a pasted URL). Absent = same
   * upstream org, which emits a bare repo string for backward-compat.
   */
  org?: string;
}

/** A per-resource source value: bare repo (default org) or an { org, repo } ref. */
export type SourceRefValue = string | { org: string; repo: string };

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
  repos: Partial<Record<ResourceKey, SourceRefValue>>;
}

// Assemble the translationSource object from the per-resource selection:
//   upstream → upstreamRepos[key]      (bare string; skipped if blank/missing),
//   override → the override repo       (bare string when same upstream org, or
//              { org, repo } when the override names a DIFFERENT org; skipped if
//              the repo is blank),
//   blank    → omitted.
// Emits null when EVERY resource resolves to nothing (all blank) — matching the
// legacy `translationSourceOn === false` case.
//
// BACKWARD-COMPAT: all-upstream (or override-without-a-distinct-org) emits ONLY
// bare repo strings, so the materialized config is byte-for-byte what the
// pre-#84 model produced.
export function buildTranslationSource(params: {
  upstreamOrg: string;
  languageCode: string;
  upstreamRepos: Record<ResourceKey, string>;
  resourceSource: ResourceSourceMap;
}): TranslationSource | null {
  const { upstreamOrg, languageCode, upstreamRepos, resourceSource } = params;
  const repos: Partial<Record<ResourceKey, SourceRefValue>> = {};
  for (const key of RESOURCE_KEYS) {
    const sel = resourceSource[key] ?? { mode: "upstream" };
    if (sel.mode === "upstream") {
      const repo = (upstreamRepos[key] ?? "").trim();
      if (repo !== "") repos[key] = repo;
    } else if (sel.mode === "override") {
      const repo = (sel.repo ?? "").trim();
      if (repo === "") continue;
      const org = (sel.org ?? "").trim();
      // A distinct override org emits an { org, repo } ref; otherwise a bare
      // string (same upstream org) keeps the legacy shape.
      repos[key] = org !== "" && org !== upstreamOrg ? { org, repo } : repo;
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
