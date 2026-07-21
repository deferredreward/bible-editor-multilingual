// Web mirror of the backend dcsSources.resolveSourceRef accessor. A per-resource
// translation source can be a bare repo string (org = translationSource.org) OR
// an { org?, repo } ref pointing the resource at a DIFFERENT org (a pasted
// Door43 URL — pragmatic slice of #84). The source panes (ResourceColumn,
// TwArticleDialog) MUST read every translationSource.repos[role] through here so
// a missing/blank entry cleanly means "no source" and a per-resource org
// override is honored — never fetch `${org}/undefined/...`.
//
// Kept in a plain .ts module (no JSX) so the node --strip-types web test runner
// can import and unit-test it directly.

export interface SourceRef {
  org: string;
  repo: string;
}

/** A persisted per-resource value: bare repo, or an { org?, repo } ref. */
export type SourceRefValue = string | { org?: string; repo?: string };

export interface TranslationSourceLike {
  org: string;
  repos: Partial<Record<string, SourceRefValue>>;
}

// DCS ident (org/repo). Mirrors isIdent in api/src/repoUrl.ts.
function isIdent(s: string): boolean {
  return /^[A-Za-z0-9._~-]+$/.test(s);
}

// Normalize one persisted value against the default (primary) org. Mirror of
// api/src/dcsSources.ts normalizeSourceRef — keep in lockstep (see
// sourceRef.test.mjs, which pins both to a shared table). SECURITY: the resolved
// org/repo are interpolated into browser-side git.door43.org fetch URLs
// (useSourceNotes / twArticle), so a non-ident org/repo → null (no source).
export function normalizeSourceRef(
  defaultOrg: string,
  value: SourceRefValue | null | undefined,
): SourceRef | null {
  if (value == null) return null;
  let repo: string;
  let org: string;
  if (typeof value === "string") {
    repo = value.trim();
    org = defaultOrg;
  } else if (typeof value === "object") {
    repo = (value.repo ?? "").trim();
    org = (value.org ?? "").trim() || defaultOrg;
  } else {
    return null;
  }
  if (!repo) return null;
  if (!isIdent(org) || !isIdent(repo)) return null;
  return { org, repo };
}

// Resolve a translationSource role to a concrete { org, repo }, or null when the
// project has no translationSource / the role has no upstream source.
export function resolveSourceRef(
  translationSource: TranslationSourceLike | null | undefined,
  role: string,
): SourceRef | null {
  if (!translationSource) return null;
  return normalizeSourceRef(translationSource.org, translationSource.repos[role]);
}
