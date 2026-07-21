// Manifest inference route (PR B): GET /api/orgs/:org/inferred-config.
// Draft-only — applies NOTHING. The admin reviews/completes the returned
// proposal and applies it via PUT /api/project-config (custom-gl preset).

import { Hono } from "hono";
import type { Env } from "./index";
import { requireAuth, requireAdmin } from "./auth";
import { isIdent } from "./repoUrl.ts";
import {
  listOrgRepos,
  fetchManifest,
  inferFromRepoList,
  repoRoleMap,
  selectCandidateRepos,
  type RepoManifestInfo,
} from "./orgInference.ts";

export const orgRoutes = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

orgRoutes.use("*", requireAuth, requireAdmin);

const TN_REPO_RE = /^([a-z0-9-]+)_tn$/;
// Cap manifest fetches per org so a runaway org (hundreds of repos) can't
// blow the subrequest budget on a single draft-inference GET.
const MAX_CANDIDATE_FETCHES = 20;

orgRoutes.get("/:org/inferred-config", async (c) => {
  const org = c.req.param("org");
  if (!isIdent(org)) {
    return c.json({ error: "invalid_org" }, 400);
  }

  const listed = await listOrgRepos(c.env, org);
  if (!listed.ok) {
    const status = listed.error === "org_not_found" ? 404 : listed.error === "dcs_forbidden" ? 403 : 502;
    return c.json({ error: listed.error }, status);
  }

  // Canonicalize casing against DCS (org already confirmed to exist above via
  // listOrgRepos) — Gitea org lookups are case-insensitive, so an admin typing
  // "bsoj" would otherwise get echoed back verbatim and persisted lowercase
  // into org/exportOrg. Same fail-open pattern as the per-user lookup in
  // adminUserRoutes.ts: any non-200 or network error just keeps the as-typed
  // value rather than blocking the draft.
  const canonicalOrg = await canonicalOrgName(c.env, org);

  const names = listed.repos.map((r) => r.name);
  const tnMatches = names.filter((n) => TN_REPO_RE.test(n));
  if (tnMatches.length === 0) {
    return c.json({ error: "no_tn_repo" }, 422);
  }

  // Determine candidate langCode from an unambiguous tn match (if ambiguous,
  // inferFromRepoList reports it; we still need SOME langCode to build the
  // {lang}_{ult|glt|ust|gst|tq|twl|tw|ta} candidate set — use the first match
  // for candidate discovery only; the ambiguity itself is still surfaced).
  const firstMatch = TN_REPO_RE.exec(tnMatches[0]);
  const langCode = firstMatch ? firstMatch[1] : null;

  // Fetch manifests for the tn repo(s) and every other {lang}_* repo under
  // this org (lane candidates aren't limited to the standard ult/glt/ust/gst
  // suffixes — BSOJ-style orgs name their Bible panes ar_avd/ar_nav — so any
  // {lang}_* repo not already a known non-lane resource is a candidate,
  // verified by its own manifest's subject/identifier).
  const toFetch = new Set<string>(selectCandidateRepos(langCode, names, tnMatches, MAX_CANDIDATE_FETCHES));

  const manifests = new Map<string, RepoManifestInfo>();
  let manifestFound = false;
  const warnings: string[] = [];
  await Promise.all(
    Array.from(toFetch).map(async (repo) => {
      const res = await fetchManifest(c.env, org, repo);
      if (res.status === "ok") {
        manifests.set(repo, { repoName: repo, facts: res.facts, fetchOk: true });
        if (res.facts) manifestFound = true;
        else warnings.push(`manifest for ${repo} could not be parsed`);
      } else if (res.status === "not_found") {
        manifests.set(repo, { repoName: repo, facts: null, fetchOk: false });
      } else {
        manifests.set(repo, { repoName: repo, facts: null, fetchOk: false });
        warnings.push(`manifest fetch error for ${repo}`);
      }
    }),
  );

  const inf = inferFromRepoList(org, listed.repos, manifests);
  warnings.push(...inf.warnings);

  const repos = repoRoleMap(inf);

  const proposal = {
    languageCode: inf.languageCode,
    languageName: inf.languageName,
    languageTitle: inf.languageName,
    direction: inf.direction ?? "ltr",
    repos, // verified roles only
    litLabel: inf.litLabel,
    simLabel: inf.simLabel,
    // Suggestion only — never auto-applied. The admin must explicitly choose
    // a translationSource (or none) at apply time.
    suggestedTranslationSource: "UW_SOURCE" as const,
    suggestedExportOrg: canonicalOrg,
  };

  return c.json({
    org: canonicalOrg,
    proposal,
    missing: inf.missing,
    ambiguous: inf.ambiguous,
    manifestFound,
    warnings,
  });
});

// Resolves an org name to DCS's canonical casing via GET /api/v1/orgs/{org}
// (Gitea's `username` field). Fails open to the input as-typed on any
// non-200 response or network error — same tolerance as the per-user lookup
// in adminUserRoutes.ts, since a lookup hiccup here must not block org
// detection when listOrgRepos already confirmed the org exists.
async function canonicalOrgName(env: Env, org: string): Promise<string> {
  try {
    const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (env.DCS_SERVICE_TOKEN) headers.Authorization = `token ${env.DCS_SERVICE_TOKEN}`;
    const res = await fetch(`${base}/api/v1/orgs/${encodeURIComponent(org)}`, { headers });
    if (!res.ok) return org;
    const body = (await res.json()) as { username?: string };
    return body.username || org;
  } catch {
    return org;
  }
}
