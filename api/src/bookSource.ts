// Per-book, per-resource source overrides (issue #103, Tier 1 step 1).
//
// The project-wide source model (#84 / PR #90) resolves a resource role to a
// concrete { org, repo } through resolveSourceRef (dcsSources.ts) — the single
// security-guarded resolution point that lane/reimport/export/aquifer all share.
// This module adds a BOOK-scoped layer ON TOP of it WITHOUT touching that
// resolver's signature: a thin per-book wrapper reads the override row, then
// falls back to the project-wide ref, then to the org's own default.
//
//   per-book override  →  project-wide translationSource  →  org's own repo (null)
//
// Storage: book_source_overrides (migration 0058), keyed by (book, resource).
//
// SECURITY: the stored org/repo are re-validated through normalizeSourceRef on
// EVERY read — never trusted raw. A non-ident value (e.g. a path traversal that
// somehow reached the row) resolves to null and falls through, exactly as an
// unvalidated project-wide override does. This is defense in depth on top of the
// ident validation at the write boundary (setBookSourceOverride).
//
// Scope: tN only for now. The (book, resource) key already fits tQ/tW/scripture;
// widen BookSourceResource and the import wiring when those fast-follows land.

import type { Env } from "./index";
import type { ProjectConfig } from "./projectConfig";
import { normalizeSourceRef, translationSourceRepoRef } from "./dcsSources.ts";
import { isIdent, type RepoRef } from "./repoUrl.ts";

// Resources that support a per-book override. tN first; the DB key and the
// resolver already generalize, so widening this union is the only change the
// tQ/tW fast-follow needs on the storage side.
export type BookSourceResource = "tn";

export const BOOK_SOURCE_RESOURCES: readonly BookSourceResource[] = ["tn"];

export function isBookSourceResource(v: string): v is BookSourceResource {
  return (BOOK_SOURCE_RESOURCES as readonly string[]).includes(v);
}

export interface BookSourceOverride {
  org: string;
  repo: string;
}

// The org's own default repo for a resource — the "no override" baseline. A
// per-book override that resolves to this is a no-op (see resolveEffectiveNoteSource).
function orgOwnRepoFor(cfg: ProjectConfig, resource: BookSourceResource): string {
  return cfg.repos[resource];
}

// ── Storage ──────────────────────────────────────────────────────────────

export async function getBookSourceOverride(
  env: Env,
  book: string,
  resource: BookSourceResource,
): Promise<BookSourceOverride | null> {
  try {
    const row = await env.DB
      .prepare("SELECT org, repo FROM book_source_overrides WHERE book = ? AND resource = ?")
      .bind(book, resource)
      .first<{ org: string; repo: string }>();
    return row ? { org: row.org, repo: row.repo } : null;
  } catch {
    // Table missing (migration 0058 not yet applied) or a transient D1 error.
    // This runs on EVERY book import; a throw here would break all imports until
    // the migration lands. "No override" is the correct safe default — the
    // import falls back to the project-wide / org's own source exactly as before
    // this feature existed. Mirrors getProjectConfig's table-missing fallback.
    return null;
  }
}

export async function listBookSourceOverrides(
  env: Env,
  book: string,
): Promise<Array<{ resource: string; org: string; repo: string; updated_at: number }>> {
  try {
    const rs = await env.DB
      .prepare(
        "SELECT resource, org, repo, updated_at FROM book_source_overrides WHERE book = ? ORDER BY resource",
      )
      .bind(book)
      .all<{ resource: string; org: string; repo: string; updated_at: number }>();
    return rs.results ?? [];
  } catch {
    // Table missing (migration not applied) → no overrides, not a 500.
    return [];
  }
}

// Upsert an override. org/repo MUST be valid DCS idents — the caller (route)
// has already parsed/validated a pasted URL, but we re-check here so no code
// path can persist a non-ident that would later be silently dropped on read.
export async function setBookSourceOverride(
  env: Env,
  book: string,
  resource: BookSourceResource,
  org: string,
  repo: string,
  userId: number | null,
): Promise<void> {
  if (!isIdent(org) || !isIdent(repo)) {
    throw new Error("invalid_org_or_repo");
  }
  await env.DB
    .prepare(
      `INSERT INTO book_source_overrides (book, resource, org, repo, updated_at, updated_by)
       VALUES (?, ?, ?, ?, unixepoch(), ?)
       ON CONFLICT(book, resource) DO UPDATE SET
         org = excluded.org, repo = excluded.repo,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(book, resource, org, repo, userId)
    .run();
}

export async function clearBookSourceOverride(
  env: Env,
  book: string,
  resource: BookSourceResource,
): Promise<void> {
  await env.DB
    .prepare("DELETE FROM book_source_overrides WHERE book = ? AND resource = ?")
    .bind(book, resource)
    .run();
}

// ── Resolution ───────────────────────────────────────────────────────────

// PURE resolver (no D1) — the precedence + security logic, unit-testable with a
// plain override object. Given the raw stored override (or null), the project
// config, and whether this import is a translate-from-source import, return the
// effective note-source RepoRef, or null to mean "use the org's own repo".
//
//   1. per-book override, IF it re-validates as an ident AND is not just the
//      org's own repo (an override equal to the default is a no-op → fall through)
//   2. else, IF translateFromSource, the project-wide translationSource ref
//   3. else null (the org's own repo; dcsUrls fills it in)
//
// A per-book override applies REGARDLESS of translateFromSource: it is an
// explicit per-book decision, so it beats the project-level flag.
export function resolveEffectiveNoteSource(
  cfg: ProjectConfig,
  resource: BookSourceResource,
  rawOverride: BookSourceOverride | null,
  translateFromSource: boolean,
): RepoRef | null {
  if (rawOverride) {
    // SECURITY: never trust the stored ref — re-validate idents. A non-ident
    // (traversal etc.) yields null and falls through to the project-wide path.
    const norm = normalizeSourceRef(cfg.org, { org: rawOverride.org, repo: rawOverride.repo });
    if (norm) {
      const own =
        norm.org.toLowerCase() === cfg.org.toLowerCase() &&
        norm.repo.toLowerCase() === orgOwnRepoFor(cfg, resource).toLowerCase();
      if (!own) {
        return { owner: norm.org, repo: norm.repo, ref: "master" };
      }
      // override == org's own default → not a real override; fall through so the
      // book is NOT spuriously stamped source:… and held out of reimport/export.
    }
  }
  if (translateFromSource) return translationSourceRepoRef(cfg, resource);
  return null;
}

// Async wrapper the import path calls: reads the per-book override row, then
// delegates to the pure resolver. This is the ONE per-book accessor callers use;
// it keeps the project-wide resolveSourceRef untouched (book-agnostic).
export async function resolveBookNoteSourceRef(
  env: Env,
  cfg: ProjectConfig,
  book: string,
  resource: BookSourceResource,
  translateFromSource: boolean,
): Promise<RepoRef | null> {
  const raw = await getBookSourceOverride(env, book, resource);
  return resolveEffectiveNoteSource(cfg, resource, raw, translateFromSource);
}
