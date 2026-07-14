// tW / tA markdown-article EXPORT (FEASIBILITY Phase 4; design in
// docs/design/tw-ta-translation-modules.md §5). The article analogue of the
// TSV/USFM export in export.ts + exportWorkflow.ts.
//
// Rendering is nearly the identity function — that's the payoff of the
// file-per-row article_units model (migration 0039): for each unit with a
// non-null target_md, write target_md at its repo-relative `path` in the
// target repo ({lang}_tw / {lang}_ta). No transformation, no reshaping.
//
// This module holds the PURE, D1-only pieces so they can be unit-tested in
// isolation (articleExport.test.mjs). The DCS side (batch multi-file commit,
// tree listing) lives in export.ts next to commitToDcs so it can reuse that
// module's private branch-reset/base64 helpers.

import type { Env } from "./index";

export const ARTICLE_RESOURCES = ["tw", "ta"] as const;
export type ArticleResource = (typeof ARTICLE_RESOURCES)[number];

// One export STEP per (resource × top-level dir), mirroring the per-(book ×
// resource) granularity of the verse/TSV export so a flaky DCS commit retries
// a small slice instead of the whole run, and each commit stays well under the
// commit-size / subrequest budget. The dirs are exactly the importer's walk
// roots (scripts/import-articles.mjs collectTw/collectTa):
//   tw paths: bible/{kt,names,other}/<slug>.md
//   ta paths: {translate,checking,process,intro}/<article>/{01,title,sub-title}.md
export const ARTICLE_TOP_DIRS: Record<ArticleResource, string[]> = {
  tw: ["bible/kt", "bible/names", "bible/other"],
  ta: ["translate", "checking", "process", "intro"],
};

export interface ArticleStepUnit {
  resource: ArticleResource;
  topDir: string;
}

// The full (resource × topDir) step list, resource-major to match the verse
// loop's ordering. `resources` narrows it (e.g. a manual /api/exports/run).
export function articleStepUnits(resources?: readonly ArticleResource[]): ArticleStepUnit[] {
  const rs = resources && resources.length > 0 ? resources : ARTICLE_RESOURCES;
  const units: ArticleStepUnit[] = [];
  for (const resource of rs) {
    for (const topDir of ARTICLE_TOP_DIRS[resource]) units.push({ resource, topDir });
  }
  return units;
}

// SQLite LIKE prefix for "paths under this top-level dir". A trailing '/' anchors
// it to the directory boundary so 'bible/kt' never also matches 'bible/kthing'.
export function topDirLikePrefix(topDir: string): string {
  return `${topDir}/%`;
}

// A branch/snapshot/R2 label for a (resource, topDir) step — the article
// analogue of `book` in the verse path. Slashes → dashes so it's a git-ref-safe
// token buildExportBranch can consume (e.g. 'tw-bible-kt', 'ta-translate').
export function articleStepLabel(resource: ArticleResource, topDir: string): string {
  return `${resource}-${topDir.replace(/\//g, "-")}`;
}

export interface ArticleFile {
  path: string;
  content: string;
}

// Render the files to export for one (resource, topDir): every article_unit with
// a non-null target_md under that dir. Per design §5 + the completeness note,
// v1 exports WHATEVER exists (ai_draft / edited / validated alike) — release
// gating on completeness belongs to the future gl-publisher, not here. The
// English root project translates nothing (all target_md NULL), so this is a
// natural no-op there.
//
// ADDITIVE BY DESIGN (v1): this returns only the files that still render, and
// the commit path (commitFilesToDcs) only creates/updates — it never deletes.
// So clearing a target_md back to NULL, soft-deleting an article_unit, or moving
// an article to another dir removes it from the render but leaves the previously
// exported .md stale on the long-lived branch until the publisher prunes it.
// This is intentional: the design defers deletion/release-shaping to the
// gl-publisher (design §5, "export whatever exists"). The shrink guard's job is
// therefore to DETECT + alert on a suspicious mass shrink (truncated D1), not to
// gate a deletion — there is none. Revisit if per-file removal ever moves in scope.
export async function renderArticleFiles(
  env: Env,
  resource: ArticleResource,
  topDir: string,
): Promise<{ files: ArticleFile[]; count: number }> {
  const rs = await env.DB.prepare(
    `SELECT path, target_md FROM article_units
      WHERE resource = ?1 AND deleted_at IS NULL AND target_md IS NOT NULL
        AND path LIKE ?2
      ORDER BY path`,
  )
    .bind(resource, topDirLikePrefix(topDir))
    .all<{ path: string; target_md: string }>();
  const files: ArticleFile[] = (rs.results ?? []).map((r) => ({ path: r.path, content: r.target_md }));
  return { files, count: files.length };
}

// The single shrink-refusal policy shared by BOTH export paths: the TSV/USFM
// export (export.ts exportTsvShrinkRefused delegates here) and the article
// export (the shrink guard in exportWorkflow.ts). It is the backstop against a
// truncated / partial-D1 read shipping a destructive shrink — the twl_PSA
// clobber signature: refuse a render that drops a large fraction of what is
// already on the target (>25 units lost AND a >5% drop; sizeable targets only,
// so ordinary edits never trip it). Returns true = REFUSE.
//
// Lives in this (lower) module so export.ts can import it without a cycle
// (export.ts already imports gitBlobSha/ArticleFile from here). ONE copy keeps
// the two export paths' safety threshold from drifting apart.
//   rendered — units in the about-to-be-committed render (D1 rows / target_md files)
//   existing — units already on the target (master TSV rows / .md files under the dir)
export function shrinkRefused(rendered: number, existing: number): boolean {
  if (existing <= 0) return false; // nothing on the target to protect
  const lost = existing - rendered;
  if (lost <= 25) return false; // small/no shrink (incl. growth) — fine
  return lost / existing > 0.05;
}

// git blob sha1, matching DCS/Gitea blob shas: sha1("blob {byteLen}\0{content}").
// Lets the batch commit skip files whose content is byte-identical to what the
// branch already holds, so an unchanged nightly re-run makes no commit (the
// multi-file analogue of commitToDcs's existingBase64 === contentBase64 no-op).
// Async because it uses WebCrypto (crypto.subtle), available in Workers and in
// the Node test runner.
export async function gitBlobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const buf = new Uint8Array(header.length + body.length);
  buf.set(header, 0);
  buf.set(body, header.length);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
