// Web mirror of the backend repoUrl.parseDoor43SourceRef helper. Parses a pasted
// Door43 source URL (or bare `owner/repo`) into { org, repo } for the Setup
// wizard's per-resource source-org override. Accepts:
//   https://git.door43.org/BibleAquifer/ar_tn
//   https://git.door43.org/BibleAquifer/ar_tn/           (trailing slash)
//   https://git.door43.org/BibleAquifer/ar_tn.git        (.git suffix)
//   https://git.door43.org/BibleAquifer/ar_tn/src/branch/master/...
//   BibleAquifer/ar_tn                                   (bare owner/repo)
// Rejects non-Door43 hosts and anything not owner/repo-shaped.
//
// Kept in a plain .ts module (no JSX) so the node --strip-types web test runner
// can import and unit-test it directly.

const DOOR43_HOSTS = new Set(["git.door43.org", "www.git.door43.org"]);

// Repo/org idents: DCS repo and org names are ASCII slugs. Mirrors isIdent in
// api/src/repoUrl.ts.
function isIdent(s: string): boolean {
  return /^[A-Za-z0-9._~-]+$/.test(s);
}

/**
 * Canonical comparison form for a DCS owner (org/user) or repo NAME — mirrors
 * `dcsName` in api/src/repoUrl.ts. Gitea resolves org and repo names
 * case-insensitively, so any UI decision that asks "is this the same org?" must
 * compare these forms. Git refs are NOT covered (branch names are
 * case-sensitive).
 */
export function dcsName(s: string | undefined | null): string {
  return (s ?? "").trim().toLowerCase();
}

/** Two DCS owner (or repo) names denote the same thing. */
export function sameDcsName(a: string | undefined | null, b: string | undefined | null): boolean {
  return dcsName(a) === dcsName(b);
}

export type ParsedSourceRef =
  | { ok: true; org: string; repo: string }
  | { ok: false; error: string };

export function parseDoor43SourceRef(input: string): ParsedSourceRef {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, error: "empty_url" };

  let owner: string | undefined;
  let repo: string | undefined;

  if (!/^https?:\/\//i.test(raw)) {
    // Bare owner/repo[/...]
    const parts = raw.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length < 2) return { ok: false, error: "expected_owner_repo" };
    [owner, repo] = parts;
  } else {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, error: "invalid_url" };
    }
    if (!DOOR43_HOSTS.has(url.hostname.toLowerCase())) {
      return { ok: false, error: "unsupported_host" };
    }
    const parts = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length < 2) return { ok: false, error: "expected_owner_repo" };
    [owner, repo] = parts;
  }

  repo = repo.replace(/\.git$/i, "");
  if (!isIdent(owner) || !isIdent(repo)) {
    return { ok: false, error: "invalid_owner_or_repo" };
  }
  return { ok: true, org: owner, repo };
}
