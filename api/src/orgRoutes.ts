// Manifest inference route (PR B): GET /api/orgs/:org/inferred-config.
// Draft-only — applies NOTHING. The admin reviews/completes the returned
// proposal and applies it via PUT /api/project-config (custom-gl preset).

import { Hono } from "hono";
import type { Env } from "./index";
import { requireAuth, requireAdmin } from "./auth.ts";
import { isIdent, parseDoor43SourceRef } from "./repoUrl.ts";
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

// GET /api/orgs/search?q=<query> — clean-match org verify for the Setup
// wizard's org-entry step. Admin-gated like inferred-config.
//
// Guaranteed path: an EXACT canonical verify against DCS via GET
// /api/v1/orgs/{q} (Gitea org lookups are case-insensitive), so a typed org
// that exactly resolves comes back as a single clean match with `canonical`.
// DCS 1.26 exposes NO fuzzy org-search endpoint — /api/v1/orgs/search routes
// to GetOrgByName (name="search") and /api/v1/users/search returns users, not
// cleanly-identifiable orgs — so `matches` carries only the canonical exact
// match (or is empty when the query resolves to nothing). Returning a stable
// shape ({ matches, canonical? }) lets a later fuzzy source drop in without a
// client change.
orgRoutes.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) {
    return c.json({ matches: [] as { org: string; fullName: string }[] });
  }
  // Only an ident-shaped query can be an org name; anything else can't resolve
  // (and must not be interpolated into the lookup URL). Return empty, not 400 —
  // the wizard treats "no match" and "invalid" the same (keep typing).
  if (!isIdent(q)) {
    return c.json({ matches: [] as { org: string; fullName: string }[] });
  }
  const rec = await lookupOrgRecord(c.env, q);
  if (!rec) {
    return c.json({ matches: [] as { org: string; fullName: string }[] });
  }
  return c.json({
    matches: [{ org: rec.username, fullName: rec.fullName }],
    canonical: rec.username,
  });
});

// GET /api/orgs/verify-source?url=<pasted Door43 URL> — resolve a pasted repo
// URL for the Setup wizard's per-resource source-org override (issue #84 slice).
// Parses the URL into { org, repo }, then confirms the REPO exists on DCS via a
// SINGLE GET /api/v1/repos/{owner}/{repo}. We deliberately DON'T also check
// /api/v1/orgs/{owner}: many DCS source repos live under a USER account (not an
// org), and the org endpoint 404s for users — that would wrongly refuse a valid
// pasted URL. The repo record's `full_name` already carries the canonical owner
// casing, so one round-trip both verifies existence and canonicalizes casing.
// Admin-gated like the rest of orgRoutes.
//
// A transient DCS failure (network / 429 / 5xx) must NOT masquerade as a genuine
// 404 (which would tell the wizard a real source doesn't exist): only a real 404
// from DCS → repo_not_found (404); transient → dcs_unavailable (503).
orgRoutes.get("/verify-source", async (c) => {
  const urlParam = (c.req.query("url") ?? "").trim();
  if (!urlParam) {
    return c.json({ ok: false, error: "empty_url" }, 400);
  }
  const parsed = parseDoor43SourceRef(urlParam);
  if (!parsed.ok) {
    return c.json({ ok: false, error: parsed.error }, 400);
  }
  const lookup = await lookupRepoRecord(c.env, parsed.org, parsed.repo);
  if (lookup.status === "unavailable") {
    return c.json({ ok: false, error: "dcs_unavailable", org: parsed.org, repo: parsed.repo }, 503);
  }
  if (lookup.status === "not_found") {
    return c.json({ ok: false, error: "repo_not_found", org: parsed.org, repo: parsed.repo }, 404);
  }
  // Optional content check (owner decision): for a SCRIPTURE lane source the repo
  // existing isn't enough — it must actually contain book (USFM) files. An empty
  // scaffolding-only repo (LICENSE/README/manifest, e.g. BibleEditorMLTest/en_glt)
  // is a trap: nothing to translate/import from. When `checkBooks` is requested we
  // add `hasBooks`; a transient contents-API failure OMITS the field (the client
  // treats "couldn't check" as retryable, never as empty) so a DCS blip can't
  // falsely flag a real source as empty.
  const resp: {
    ok: true;
    org: string;
    repo: string;
    fullName: string;
    hasBooks?: boolean;
  } = { ok: true, org: lookup.org, repo: lookup.repo, fullName: lookup.fullName };
  const wantBooks = (c.req.query("checkBooks") ?? "").trim() !== "";
  if (wantBooks) {
    const books = await repoHasBookFiles(c.env, lookup.org, lookup.repo);
    if (books !== "unavailable") resp.hasBooks = books === "has_books";
  }
  return c.json(resp);
});

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

// Looks an org up on DCS via GET /api/v1/orgs/{org} (Gitea org lookups are
// case-insensitive). Returns the canonical record ({username, fullName}) on a
// 200, or null on 404 / any non-200 / network error. Unlike canonicalOrgName
// this DISTINGUISHES "exists" from "does not" — the org-search endpoint needs
// that distinction (a clean match vs. an empty result), whereas org detection
// only wants canonical casing and fails open.
async function lookupOrgRecord(
  env: Env,
  org: string,
): Promise<{ username: string; fullName: string } | null> {
  try {
    const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (env.DCS_SERVICE_TOKEN) headers.Authorization = `token ${env.DCS_SERVICE_TOKEN}`;
    const res = await fetch(`${base}/api/v1/orgs/${encodeURIComponent(org)}`, { headers });
    if (!res.ok) return null;
    const body = (await res.json()) as { username?: string; full_name?: string };
    if (!body.username) return null;
    return { username: body.username, fullName: body.full_name ?? body.username };
  } catch {
    return null;
  }
}

// Looks a repo up on DCS via GET /api/v1/repos/{owner}/{repo} (works for BOTH
// org- and user-owned namespaces, unlike GET /api/v1/orgs/{owner}). Distinguishes
// three outcomes so verify-source never turns a transient DCS blip into a false
// "does not exist":
//   ok         → 200 with a repo record (canonical owner/repo from full_name)
//   not_found  → a genuine 404 from DCS (the repo really isn't there)
//   unavailable→ network error / 429 / 5xx / other non-200 / unparseable 200
// Sends the service token when present (private repos / rate limits).
type RepoLookup =
  | { status: "ok"; org: string; repo: string; fullName: string }
  | { status: "not_found" }
  | { status: "unavailable" };

async function lookupRepoRecord(env: Env, owner: string, repo: string): Promise<RepoLookup> {
  let res: Response;
  try {
    const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (env.DCS_SERVICE_TOKEN) headers.Authorization = `token ${env.DCS_SERVICE_TOKEN}`;
    res = await fetch(
      `${base}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers },
    );
  } catch {
    return { status: "unavailable" }; // network error — retryable, not a 404
  }
  if (res.status === 404) return { status: "not_found" };
  if (!res.ok) return { status: "unavailable" }; // 429 / 5xx / 403 — transient
  let body: { name?: string; full_name?: string };
  try {
    body = (await res.json()) as { name?: string; full_name?: string };
  } catch {
    return { status: "unavailable" }; // malformed 200 — don't assert existence
  }
  if (!body.name) return { status: "unavailable" };
  // full_name is "Owner/repo" — the canonical owner + repo casing DCS holds.
  const fullName = body.full_name ?? `${owner}/${body.name}`;
  const slash = fullName.indexOf("/");
  const canonOwner = slash > 0 ? fullName.slice(0, slash) : owner;
  const canonRepo = slash > 0 ? fullName.slice(slash + 1) : body.name;
  return { status: "ok", org: canonOwner, repo: canonRepo, fullName };
}

// Does this repo contain scripture BOOK files? Lists the repo root via
// GET /api/v1/repos/{owner}/{repo}/contents and looks for any USFM file (RC Bible
// repos put `NN-BOOK.usfm` at the root). Distinguishes:
//   has_books   → at least one *.usfm file present
//   empty       → contents fetched OK but no USFM (scaffolding-only)
//   unavailable → network error / non-200 / unparseable (do NOT assert emptiness)
async function repoHasBookFiles(
  env: Env,
  owner: string,
  repo: string,
): Promise<"has_books" | "empty" | "unavailable"> {
  try {
    const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (env.DCS_SERVICE_TOKEN) headers.Authorization = `token ${env.DCS_SERVICE_TOKEN}`;
    const res = await fetch(
      `${base}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`,
      { headers },
    );
    if (!res.ok) return "unavailable";
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return "unavailable";
    }
    if (!Array.isArray(body)) return "unavailable";
    const hasUsfm = body.some(
      (e) =>
        e &&
        typeof e === "object" &&
        (e as { type?: unknown }).type === "file" &&
        typeof (e as { name?: unknown }).name === "string" &&
        /\.usfm$/i.test((e as { name: string }).name),
    );
    return hasUsfm ? "has_books" : "empty";
  } catch {
    return "unavailable";
  }
}

// Resolves an org name to DCS's canonical casing via GET /api/v1/orgs/{org}
// (Gitea's `username` field). Fails open to the input as-typed on any
// non-200 response or network error — same tolerance as the per-user lookup
// in adminUserRoutes.ts, since a lookup hiccup here must not block org
// detection when listOrgRepos already confirmed the org exists.
async function canonicalOrgName(env: Env, org: string): Promise<string> {
  const rec = await lookupOrgRecord(env, org);
  return rec?.username || org;
}
