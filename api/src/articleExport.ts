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

// Shrink-guard analogue of export.ts exportTsvShrinkRefused, on FILE counts
// instead of TSV row counts. The article carry-over of the twl_PSA clobber
// backstop: an export whose render drops a large fraction of the files already
// present on the target is the truncated / partial-D1 signature (a stale or
// incomplete D1 read), NOT a legitimate single-night edit — so refuse to commit
// it rather than let it delete previously-exported article files.
//
// Thresholds mirror exportTsvShrinkRefused deliberately (kept independent to
// avoid an export.ts ⇄ articleExport.ts import cycle): protect only sizeable
// dirs (ignore ≤25 files lost) and require a >5% drop so ordinary edits never
// trip it. Returns true = REFUSE.
//   renderedCount — files in the about-to-be-committed render (D1 target_md rows)
//   existingCount — .md files already under this dir on the target's master
export function articleExportShrinkRefused(renderedCount: number, existingCount: number): boolean {
  if (existingCount <= 0) return false; // nothing on the target to protect
  const lost = existingCount - renderedCount;
  if (lost <= 25) return false; // small/no shrink (incl. growth) — fine
  return lost / existingCount > 0.05;
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
