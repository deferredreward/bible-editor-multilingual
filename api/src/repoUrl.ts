// Door43 repository URL normalization for scripture lane source/export refs.

export interface RepoRef {
  owner: string;
  repo: string;
  ref: string;
}

const DOOR43_HOSTS = new Set(["git.door43.org", "www.git.door43.org"]);

/**
 * Normalize a pasted Door43 repo-root or file URL to {owner,repo,ref}.
 * Accepts:
 *   https://git.door43.org/BSOJ/ar_avd
 *   https://git.door43.org/BSOJ/ar_avd/
 *   https://git.door43.org/BSOJ/ar_avd/src/branch/master/...
 *   https://git.door43.org/BSOJ/ar_avd/raw/branch/develop/38-ZEC.usfm
 *   BSOJ/ar_avd
 * Rejects non-Door43 hosts and non-repo paths.
 */
export function normalizeDoor43RepoUrl(
  input: string,
  defaultRef = "master",
): { ok: true; ref: RepoRef } | { ok: false; error: string } {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, error: "empty_url" };

  // Short form owner/repo[/...]
  if (!/^https?:\/\//i.test(raw)) {
    const parts = raw.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length < 2) return { ok: false, error: "expected_owner_repo" };
    const [owner, repo] = parts;
    if (!isIdent(owner) || !isIdent(repo)) return { ok: false, error: "invalid_owner_or_repo" };
    return { ok: true, ref: { owner, repo, ref: defaultRef } };
  }

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
  const [owner, repo, ...rest] = parts;
  if (!isIdent(owner) || !isIdent(repo)) return { ok: false, error: "invalid_owner_or_repo" };

  let ref = defaultRef;
  // /src/branch/<ref>/... or /raw/branch/<ref>/...
  if (rest.length >= 2 && (rest[0] === "src" || rest[0] === "raw") && rest[1] === "branch") {
    if (!rest[2]) return { ok: false, error: "missing_branch_ref" };
    ref = decodeURIComponent(rest[2]);
  } else if (rest.length > 0 && rest[0] !== "src" && rest[0] !== "raw" && rest[0] !== "releases") {
    // Unexpected path after owner/repo (e.g. issues) — still accept owner/repo root intent
    // only when the remainder looks like gitea UI crumbs we recognize; else reject.
    if (!["commits", "branches", "settings", "activity", "pulls", "wiki", "projects"].includes(rest[0])) {
      // Allow trailing empty noise only; unknown segments → error for safety
      if (!(rest[0] === "" && rest.length === 1)) {
        // src/raw without branch already handled; other UI paths OK if we take owner/repo
        if (!["tree", "blob"].includes(rest[0])) {
          /* keep defaultRef; treat as repo root with UI noise */
        }
      }
    }
  }

  return { ok: true, ref: { owner, repo, ref } };
}

function isIdent(s: string): boolean {
  return /^[A-Za-z0-9._~-]+$/.test(s);
}

export function repoRefEquals(a: RepoRef, b: RepoRef): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    a.ref === b.ref
  );
}

export function repoRefKey(r: RepoRef): string {
  return `${r.owner}/${r.repo}@${r.ref}`;
}
