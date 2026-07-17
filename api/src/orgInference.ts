// Manifest inference (PR B): given a Door43 org name, list its repos, fetch
// each candidate's manifest.yaml, and infer a draft ProjectConfig proposal —
// never applied automatically. The admin reviews/completes the draft and
// applies it explicitly via PUT /api/project-config (custom-gl preset).
//
// Design points:
//  - translationSource is NEVER inferred from language equality. An English
//    org (e.g. BibleEditorMLTest) still translates FROM UW_SOURCE. The
//    proposal only carries a *suggestion* (UW_SOURCE); the admin picks
//    explicitly at apply time.
//  - lit/sim candidates are only trusted when their OWN manifest verifies a
//    Bible-ish dublin_core.subject ("Aligned Bible" / "Bible"). An identifier
//    that doesn't match the explicit {lit:[ult,glt], sim:[ust,gst]} table
//    (e.g. avd, nav) is reported as an ambiguous candidate, never auto-picked.
//  - Multiple `*_tn` repos are ambiguous — no order-based tiebreak.

import type { Env } from "./index";
import { load as yamlLoad, JSON_SCHEMA } from "js-yaml";
import { fetchTextWithStatus, type FetchTextResult } from "./dcsSources.ts";
import type { ResourceKey } from "./projectConfig.ts";

// ── Gitea org repo listing ───────────────────────────────────────────────────

export interface OrgRepo {
  name: string;
}

export type ListOrgReposResult =
  | { ok: true; repos: OrgRepo[] }
  | { ok: false; error: "org_not_found" | "dcs_forbidden" | "dcs_unreachable" };

const PAGE_LIMIT = 50;
const MAX_PAGES = 20; // 1000 repos — generous ceiling against a runaway org

export async function listOrgRepos(
  env: Env,
  org: string,
  deps?: { fetch?: typeof fetch },
): Promise<ListOrgReposResult> {
  const doFetch = deps?.fetch ?? fetch;
  const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
  const all: OrgRepo[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${base}/api/v1/orgs/${encodeURIComponent(org)}/repos?limit=${PAGE_LIMIT}&page=${page}`;
    let r: Response;
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (env.DCS_SERVICE_TOKEN) headers.Authorization = `token ${env.DCS_SERVICE_TOKEN}`;
      r = await doFetch(url, { headers });
      // A scoped service token (e.g. write-only) can be rejected on read
      // endpoints where anonymous access would succeed — public orgs must not
      // be blocked by the token, so retry the page unauthenticated.
      if ((r.status === 401 || r.status === 403) && headers.Authorization) {
        r = await doFetch(url, { headers: { Accept: "application/json" } });
      }
    } catch {
      return { ok: false, error: "dcs_unreachable" };
    }
    if (r.status === 404) {
      // 404 on page 1 = org doesn't exist. 404 on a later page (some Gitea
      // versions) just means "past the end" — treat as end-of-list, not
      // org-not-found, UNLESS it's page 1 with zero repos collected so far.
      if (page === 1) return { ok: false, error: "org_not_found" };
      break;
    }
    if (r.status === 403) return { ok: false, error: "dcs_forbidden" };
    if (!r.ok) return { ok: false, error: "dcs_unreachable" };
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      return { ok: false, error: "dcs_unreachable" };
    }
    if (!Array.isArray(body)) return { ok: false, error: "dcs_unreachable" };
    const names = body
      .map((x) => (x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string"
        ? (x as { name: string }).name
        : null))
      .filter((n): n is string => n != null);
    all.push(...names.map((name) => ({ name })));
    if (body.length < PAGE_LIMIT) break; // last page
  }
  return { ok: true, repos: all };
}

// ── Manifest parsing ─────────────────────────────────────────────────────────

export interface ManifestFacts {
  language: string | null;
  languageTitle: string | null;
  languageDirection: "ltr" | "rtl" | null;
  relation: string[];
  identifier: string | null;
  subject: string | null;
}

// Strip a `?v=<ref>` suffix some RC manifests append to relation entries
// (e.g. "en/ult?v=86" -> "en/ult").
function stripVersionSuffix(s: string): string {
  return s.replace(/\?v=[^/]*$/i, "");
}

export function parseManifestFacts(yamlText: string): ManifestFacts | null {
  let doc: unknown;
  try {
    doc = yamlLoad(yamlText, { schema: JSON_SCHEMA });
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const dc = (doc as Record<string, unknown>).dublin_core;
  if (!dc || typeof dc !== "object") return null;
  const d = dc as Record<string, unknown>;

  let language: string | null = null;
  let languageTitle: string | null = null;
  let languageDirection: "ltr" | "rtl" | null = null;
  const langField = d.language;
  if (typeof langField === "string") language = langField;
  else if (langField && typeof langField === "object") {
    const lf = langField as Record<string, unknown>;
    if (typeof lf.identifier === "string") language = lf.identifier;
    if (typeof lf.title === "string" && lf.title.trim() !== "") languageTitle = lf.title;
    if (lf.direction === "ltr" || lf.direction === "rtl") languageDirection = lf.direction;
  }

  let relation: string[] = [];
  if (Array.isArray(d.relation)) {
    relation = d.relation
      .filter((x): x is string => typeof x === "string")
      .map(stripVersionSuffix);
  }

  const identifier = typeof d.identifier === "string" ? d.identifier : null;
  const subject = typeof d.subject === "string" ? d.subject : null;

  return { language, languageTitle, languageDirection, relation, identifier, subject };
}

function isBibleSubject(subject: string | null): boolean {
  if (!subject) return false;
  return /\bbible\b/i.test(subject);
}

// ── Repo-list inference ──────────────────────────────────────────────────────

export type LaneRole = "lit" | "sim";

// Explicit identifier table: only these dublin_core.identifier values are
// auto-assigned to a lane role. Anything else (avd, nav, ulb, …) is reported
// as an ambiguous candidate — never guessed.
const LANE_IDENTIFIERS: Record<LaneRole, string[]> = {
  lit: ["ult", "glt"],
  sim: ["ust", "gst"],
};

const TN_REPO_RE = /^([a-z0-9-]+)_tn$/;

export interface RepoManifestInfo {
  repoName: string;
  facts: ManifestFacts | null;
  fetchOk: boolean; // true iff the manifest was fetched (200) — false doesn't imply "missing", could be error
}

export interface AmbiguousCandidate {
  role: LaneRole;
  candidates: string[]; // repo names
}

export interface InferenceResult {
  languageCode: string | null;
  languageName: string | null;
  direction: "ltr" | "rtl" | null;
  tnRepo: string | null;
  litRepo: string | null;
  simRepo: string | null;
  litLabel: string | null;
  simLabel: string | null;
  tqRepo: string | null;
  twlRepo: string | null;
  twRepo: string | null;
  taRepo: string | null;
  missing: string[]; // roles with no repo found at all: 'tn'|'tq'|'twl'|'tw'|'ta'|'lit'|'sim'
  ambiguous: AmbiguousCandidate[];
  warnings: string[];
}

const RTL_LANGS = new Set(["ar", "he", "fa", "ur", "ps", "syr", "dv"]);

function directionFor(languageCode: string | null): "ltr" | "rtl" | null {
  if (!languageCode) return null;
  const base = languageCode.split(/[-_]/)[0].toLowerCase();
  return RTL_LANGS.has(base) ? "rtl" : "ltr";
}

// Pure function: given the org's repo list and a manifest lookup for each repo
// that was actually fetched, decide the inferred config. `manifests` maps
// repo name -> RepoManifestInfo for every repo the caller chose to fetch
// (typically: the tn repo(s), any *_ult/_glt/_ust/_gst-shaped repo, and any
// relation-referenced repo under the same org).
export function inferFromRepoList(
  org: string,
  repos: OrgRepo[],
  manifests: Map<string, RepoManifestInfo>,
): InferenceResult {
  const warnings: string[] = [];
  const names = repos.map((r) => r.name);
  const nameSet = new Set(names);

  // tn repo(s)
  const tnMatches = names.filter((n) => TN_REPO_RE.test(n));
  let tnRepo: string | null = null;
  let langCode: string | null = null;
  const ambiguous: AmbiguousCandidate[] = [];
  if (tnMatches.length === 1) {
    tnRepo = tnMatches[0];
    const m = TN_REPO_RE.exec(tnRepo);
    langCode = m ? m[1] : null;
  } else if (tnMatches.length > 1) {
    warnings.push(`multiple tn repos found: ${tnMatches.join(", ")}`);
  }

  // Presence-probe tq/twl/tw/ta by naming convention {lang}_{res}.
  const probe = (suffix: string): string | null => {
    if (!langCode) return null;
    const n = `${langCode}_${suffix}`;
    return nameSet.has(n) ? n : null;
  };
  const tqRepo = probe("tq");
  const twlRepo = probe("twl");
  const twRepo = probe("tw");
  const taRepo = probe("ta");

  // lit/sim candidates, in two tiers:
  //  1. Repos matching {lang}_(ult|glt) or {lang}_(ust|gst) whose OWN manifest
  //     confirms both a Bible-ish subject AND an identifier from that role's
  //     explicit table — auto-assignable.
  //  2. Everything else under {lang}_* (excluding tn/tq/twl/tw/ta and the
  //     already-considered standard names) whose manifest confirms a
  //     Bible-ish subject but carries a NONSTANDARD identifier (avd, nav, …).
  //     These are never auto-picked — they fall back to an ambiguous
  //     candidate list for BOTH roles (we can't tell lit from sim on
  //     identifier alone), letting the admin choose explicitly.
  const litVerified: string[] = [];
  const simVerified: string[] = [];
  const nonstandardBibleRepos: string[] = [];
  const consideredNames = new Set<string>([tnRepo, tqRepo, twlRepo, twRepo, taRepo].filter((n): n is string => !!n));

  if (langCode) {
    const standardNames = new Set<string>();
    for (const role of ["lit", "sim"] as LaneRole[]) {
      const idents = LANE_IDENTIFIERS[role];
      for (const ident of idents) {
        const repoName = `${langCode}_${ident}`;
        standardNames.add(repoName);
        if (!nameSet.has(repoName)) continue;
        const info = manifests.get(repoName);
        const facts = info?.facts ?? null;
        const bibleOk = isBibleSubject(facts?.subject ?? null);
        const identOk = facts?.identifier ? idents.includes(facts.identifier) : true;
        if (bibleOk && identOk) {
          if (role === "lit") litVerified.push(repoName);
          else simVerified.push(repoName);
        }
      }
    }
    for (const name of standardNames) consideredNames.add(name);

    // Tier 2: any other {lang}_* repo the caller fetched a manifest for.
    const prefix = `${langCode}_`;
    for (const name of names) {
      if (!name.startsWith(prefix) || consideredNames.has(name)) continue;
      const info = manifests.get(name);
      if (!info) continue; // caller chose not to fetch this one
      if (isBibleSubject(info.facts?.subject ?? null)) {
        nonstandardBibleRepos.push(name);
      }
    }
  }

  let litRepo: string | null = null;
  let simRepo: string | null = null;
  if (litVerified.length === 1) litRepo = litVerified[0];
  else if (litVerified.length > 1) ambiguous.push({ role: "lit", candidates: litVerified });
  if (simVerified.length === 1) simRepo = simVerified[0];
  else if (simVerified.length > 1) ambiguous.push({ role: "sim", candidates: simVerified });

  // enforce lit !== sim (defensive — the identifier tables are disjoint by
  // construction, so this only fires if manifest data is self-contradictory)
  if (litRepo && litRepo === simRepo) {
    warnings.push(`lit/sim conflict: both resolved to ${litRepo}`);
    litRepo = null;
    simRepo = null;
    ambiguous.push({ role: "lit", candidates: litVerified });
    ambiguous.push({ role: "sim", candidates: simVerified });
  }

  // Nonstandard-identifier fallback: surface as ambiguous for whichever
  // role(s) are still unresolved, never auto-assigned.
  if (nonstandardBibleRepos.length > 0) {
    if (!litRepo && !ambiguous.some((a) => a.role === "lit")) {
      ambiguous.push({ role: "lit", candidates: nonstandardBibleRepos });
    }
    if (!simRepo && !ambiguous.some((a) => a.role === "sim")) {
      ambiguous.push({ role: "sim", candidates: nonstandardBibleRepos });
    }
  }

  const missing: string[] = [];
  if (!tnRepo) missing.push("tn");
  if (!tqRepo) missing.push("tq");
  if (!twlRepo) missing.push("twl");
  if (!twRepo) missing.push("tw");
  if (!taRepo) missing.push("ta");
  if (!litRepo && !ambiguous.some((a) => a.role === "lit")) missing.push("lit");
  if (!simRepo && !ambiguous.some((a) => a.role === "sim")) missing.push("sim");

  const litLabel = litRepo ? litRepo.slice(langCode ? langCode.length + 1 : 0).toUpperCase() : null;
  const simLabel = simRepo ? simRepo.slice(langCode ? langCode.length + 1 : 0).toUpperCase() : null;

  // Prefer the tn repo manifest's own dublin_core.language.{title,direction}
  // (authoritative) over the repo-name code and the RTL heuristic; the admin
  // can still edit the draft. Fall back to the code / heuristic when the
  // manifest omits them or wasn't parseable.
  const tnFacts = tnRepo ? manifests.get(tnRepo)?.facts ?? null : null;
  const languageName = tnFacts?.languageTitle ?? langCode;
  const direction = tnFacts?.languageDirection ?? directionFor(langCode);

  void org;
  return {
    languageCode: langCode,
    languageName,
    direction,
    tnRepo,
    litRepo,
    simRepo,
    litLabel,
    simLabel,
    tqRepo,
    twlRepo,
    twRepo,
    taRepo,
    missing,
    ambiguous,
    warnings,
  };
}

// ── Candidate manifest selection (which repos the route fetches manifests for) ─

const CANDIDATE_NON_LANE_SUFFIXES = new Set(["tn", "tq", "twl", "tw", "ta"]);
// Standard lane identifiers, reserved BEFORE the cap so they can never be
// starved behind nonstandard {lang}_* repos that happen to list earlier.
const STANDARD_LANE_IDENTS = ["glt", "ult", "gst", "ust"];

// Pick which repos to fetch a manifest for, capped at `max`. Order:
//   1. every *_tn repo (needed for language + relation)
//   2. the standard lane candidates {lang}_(glt|ult|gst|ust) — reserved so a
//      repo-heavy org can't push them past the cap and falsely report lit/sim
//      missing
//   3. any other {lang}_* repo that isn't a known non-lane resource (BSOJ-style
//      ar_avd/ar_nav), filling the remaining budget in listing order
export function selectCandidateRepos(
  langCode: string | null,
  names: string[],
  tnMatches: string[],
  max: number,
): string[] {
  // Build a priority-ordered, deduped list, then hard-slice to `max`. Priority
  // (tn → standard lanes → other {lang}_*) decides who survives the cap, so the
  // cap is a real ceiling on the subrequest budget AND the standard lanes still
  // win over nonstandard fillers.
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (n: string) => {
    if (!seen.has(n)) {
      seen.add(n);
      ordered.push(n);
    }
  };
  for (const n of tnMatches) push(n);
  if (langCode) {
    const prefix = `${langCode}_`;
    const nameSet = new Set(names);
    for (const ident of STANDARD_LANE_IDENTS) {
      const n = `${prefix}${ident}`;
      if (nameSet.has(n)) push(n);
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      if (CANDIDATE_NON_LANE_SUFFIXES.has(name.slice(prefix.length))) continue;
      push(name);
    }
  }
  return ordered.slice(0, Math.max(0, max));
}

// ── Repo -> resource key mapping helper (used by the route to build repos{}) ──

export function repoRoleMap(inf: InferenceResult): Partial<Record<ResourceKey, string>> {
  const out: Partial<Record<ResourceKey, string>> = {};
  if (inf.litRepo) out.lit = inf.litRepo;
  if (inf.simRepo) out.sim = inf.simRepo;
  if (inf.tnRepo) out.tn = inf.tnRepo;
  if (inf.tqRepo) out.tq = inf.tqRepo;
  if (inf.twlRepo) out.twl = inf.twlRepo;
  if (inf.twRepo) out.tw = inf.twRepo;
  if (inf.taRepo) out.ta = inf.taRepo;
  return out;
}

// ── Manifest fetch helper (network I/O — not pure) ──────────────────────────

export type ManifestFetchResult =
  | { status: "ok"; facts: ManifestFacts | null }
  | { status: "not_found" }
  | { status: "error" };

export async function fetchManifest(
  env: Env,
  org: string,
  repo: string,
  deps?: { fetch?: (env: Env, url: string, opts?: { noAuth?: boolean }) => Promise<FetchTextResult> },
): Promise<ManifestFetchResult> {
  const doFetch = deps?.fetch ?? fetchTextWithStatus;
  const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
  const url = `${base}/${org}/${repo}/raw/branch/master/manifest.yaml`;
  let res = await doFetch(env, url);
  // A write-scoped service token can be rejected on public raw endpoints where
  // anonymous access succeeds — retry unauthenticated so public orgs resolve
  // (matches the fallback in listOrgRepos).
  if ((res.status === 401 || res.status === 403) && env.DCS_SERVICE_TOKEN) {
    res = await doFetch(env, url, { noAuth: true });
  }
  if (res.status === 404) return { status: "not_found" };
  if (res.status !== 200 || res.text == null || res.truncated) return { status: "error" };
  return { status: "ok", facts: parseManifestFacts(res.text) };
}
