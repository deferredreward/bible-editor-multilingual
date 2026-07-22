// Per-book / per-chapter-range, per-resource source overrides (issue #103).
//
// The project-wide source model (#84 / PR #90) resolves a resource role to a
// concrete { org, repo } through resolveSourceRef (dcsSources.ts) — the single
// security-guarded resolution point that lane/reimport/export/aquifer all share.
// This module adds a BOOK- and CHAPTER-RANGE-scoped layer ON TOP of it WITHOUT
// touching that resolver's signature: thin wrappers read the override rows, then
// fall back to the project-wide ref, then to the org's own default.
//
//   per-range override → per-book(whole) override → project-wide → org's own (null)
//
// Storage: book_source_overrides (migrations 0058 + 0059). A (book, resource)
// may carry MULTIPLE ranges [chapter_start, chapter_end] inclusive; whole-book
// (Tier 1) is the single range (0, 999).
//
// SECURITY: the stored org/repo are re-validated through normalizeSourceRef on
// EVERY read — never trusted raw. A non-ident value resolves to null and falls
// through, exactly as an unvalidated project-wide override does. Defense in depth
// on top of the ident validation at the write boundary.
//
// Scope: tN + tQ (the row-based note resources). tW (twl) is language-neutral —
// its word-links have no meaningful "other source" — and scripture belongs to the
// lane/generation model (frozen-lane guards, #94); neither is a coherent target
// for this override, so BookSourceResource is deliberately tn|tq only.

import type { Env } from "./index";
import type { ProjectConfig } from "./projectConfig";
import { normalizeSourceRef, translationSourceRepoRef } from "./dcsSources.ts";
import { isIdent, type RepoRef } from "./repoUrl.ts";

// Resources that support a per-book/range override. tN + tQ only (see header).
export type BookSourceResource = "tn" | "tq";

export const BOOK_SOURCE_RESOURCES: readonly BookSourceResource[] = ["tn", "tq"];

export function isBookSourceResource(v: string): v is BookSourceResource {
  return (BOOK_SOURCE_RESOURCES as readonly string[]).includes(v);
}

// Whole-book range sentinels (migration 0059). 0 includes front matter (refParts
// maps "front" → chapter 0); 999 exceeds any real chapter count.
export const WHOLE_BOOK_START = 0;
export const WHOLE_BOOK_END = 999;

export interface BookSourceOverride {
  org: string;
  repo: string;
}

export interface BookSourceRange {
  chapter_start: number;
  chapter_end: number;
  org: string;
  repo: string;
}

// The org's own default repo for a resource — the "no override" baseline. An
// override that resolves to this is a no-op (see resolveEffectiveNoteSource).
function orgOwnRepoFor(cfg: ProjectConfig, resource: BookSourceResource): string {
  return cfg.repos[resource];
}

// A D1/SQLite "no such table" error — the one read failure safe to treat as
// "no override configured" (see getBookSourceRanges). Matched on message; D1
// surfaces the underlying SQLite text ("no such table: book_source_overrides").
export function isMissingTableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /no such table/i.test(msg);
}

function isWholeBook(r: { chapter_start: number; chapter_end: number }): boolean {
  return r.chapter_start === WHOLE_BOOK_START && r.chapter_end === WHOLE_BOOK_END;
}

export function rangeCoversChapter(r: { chapter_start: number; chapter_end: number }, chapter: number): boolean {
  return chapter >= r.chapter_start && chapter <= r.chapter_end;
}

// Do two inclusive ranges overlap? Used to reject overlapping writes.
export function rangesOverlap(
  a: { chapter_start: number; chapter_end: number },
  b: { chapter_start: number; chapter_end: number },
): boolean {
  return a.chapter_start <= b.chapter_end && b.chapter_start <= a.chapter_end;
}

// ── Storage ──────────────────────────────────────────────────────────────

// All ranges for a (book, resource), ordered by chapter_start. Table-missing →
// [] (migration not applied → no overrides); any other read error rethrows so a
// transient failure is never silently treated as "no override" (which would let
// an import pull from the wrong repo and clobber overridden rows).
export async function getBookSourceRanges(
  env: Env,
  book: string,
  resource: BookSourceResource,
): Promise<BookSourceRange[]> {
  try {
    const rs = await env.DB
      .prepare(
        `SELECT chapter_start, chapter_end, org, repo FROM book_source_overrides
          WHERE book = ? AND resource = ? ORDER BY chapter_start`,
      )
      .bind(book, resource)
      .all<BookSourceRange>();
    return rs.results ?? [];
  } catch (e) {
    if (isMissingTableError(e)) return [];
    throw e;
  }
}

// The WHOLE-BOOK override (0, 999) for a (book, resource), if one exists. Tier 1
// accessor: callers that want single-source, whole-book semantics use this and
// ignore per-chapter ranges.
export async function getBookSourceOverride(
  env: Env,
  book: string,
  resource: BookSourceResource,
): Promise<BookSourceOverride | null> {
  const ranges = await getBookSourceRanges(env, book, resource);
  const whole = ranges.find(isWholeBook);
  return whole ? { org: whole.org, repo: whole.repo } : null;
}

// Every override row for a book (all resources), for the GET route.
export async function listBookSourceOverrides(
  env: Env,
  book: string,
): Promise<
  Array<{ resource: string; chapter_start: number; chapter_end: number; org: string; repo: string; updated_at: number }>
> {
  try {
    const rs = await env.DB
      .prepare(
        `SELECT resource, chapter_start, chapter_end, org, repo, updated_at
           FROM book_source_overrides WHERE book = ? ORDER BY resource, chapter_start`,
      )
      .bind(book)
      .all<{
        resource: string;
        chapter_start: number;
        chapter_end: number;
        org: string;
        repo: string;
        updated_at: number;
      }>();
    return rs.results ?? [];
  } catch (e) {
    if (isMissingTableError(e)) return [];
    throw e;
  }
}

// Upsert a whole-book override — the Tier 1 write. Delegates to setBookSourceRange
// with the (0, 999) whole-book range.
export async function setBookSourceOverride(
  env: Env,
  book: string,
  resource: BookSourceResource,
  org: string,
  repo: string,
  userId: number | null,
): Promise<void> {
  await setBookSourceRange(env, book, resource, WHOLE_BOOK_START, WHOLE_BOOK_END, org, repo, userId);
}

// Upsert ONE chapter range. Validates idents and the range bounds, and rejects a
// range that would overlap a DIFFERENT existing range for the same (book,
// resource) — overlapping ranges make per-chapter resolution ambiguous. A range
// with the same chapter_start replaces the existing one (ON CONFLICT).
export async function setBookSourceRange(
  env: Env,
  book: string,
  resource: BookSourceResource,
  chapterStart: number,
  chapterEnd: number,
  org: string,
  repo: string,
  userId: number | null,
): Promise<void> {
  if (!isIdent(org) || !isIdent(repo)) throw new Error("invalid_org_or_repo");
  if (
    !Number.isInteger(chapterStart) ||
    !Number.isInteger(chapterEnd) ||
    chapterStart < 0 ||
    chapterEnd < chapterStart
  ) {
    throw new Error("invalid_range");
  }
  const existing = await getBookSourceRanges(env, book, resource);
  const candidate = { chapter_start: chapterStart, chapter_end: chapterEnd };
  for (const r of existing) {
    if (r.chapter_start === chapterStart) continue; // same start → replace, not overlap
    if (rangesOverlap(r, candidate)) throw new Error("overlapping_range");
  }
  await env.DB
    .prepare(
      `INSERT INTO book_source_overrides (book, resource, chapter_start, chapter_end, org, repo, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch(), ?)
       ON CONFLICT(book, resource, chapter_start) DO UPDATE SET
         chapter_end = excluded.chapter_end, org = excluded.org, repo = excluded.repo,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(book, resource, chapterStart, chapterEnd, org, repo, userId)
    .run();
}

// Clear ALL ranges for a (book, resource) — the Tier 1 "clear this resource".
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

// Clear ONE range (by its chapter_start).
export async function clearBookSourceRange(
  env: Env,
  book: string,
  resource: BookSourceResource,
  chapterStart: number,
): Promise<void> {
  await env.DB
    .prepare("DELETE FROM book_source_overrides WHERE book = ? AND resource = ? AND chapter_start = ?")
    .bind(book, resource, chapterStart)
    .run();
}

// ── Resolution ───────────────────────────────────────────────────────────

// PURE resolver (no D1) — the precedence + security logic, unit-testable with a
// plain override object. Given the raw stored override (or null), the project
// config, and whether this import is a translate-from-source import, return the
// effective note-source RepoRef, or null to mean "use the org's own repo".
//
//   1. override, IF it re-validates as an ident AND is not just the org's own
//      repo (an override equal to the default is a no-op → fall through)
//   2. else, IF translateFromSource, the project-wide translationSource ref
//   3. else null (the org's own repo; dcsUrls fills it in)
//
// An override applies REGARDLESS of translateFromSource: it is an explicit
// decision, so it beats the project-level flag.
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
      if (!own) return { owner: norm.org, repo: norm.repo, ref: "master" };
      // override == org's own default → not a real override; fall through so the
      // chapter is NOT spuriously stamped source:… and held out.
    }
  }
  if (translateFromSource) return translationSourceRepoRef(cfg, resource);
  return null;
}

// Whole-book note source (Tier 1 accessor the import path uses today). Reads the
// (0, 999) override only — per-chapter ranges are handled by planBookNoteSources.
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

// A resolved cross-org source for a chapter range: only ranges whose override
// genuinely points at a DIFFERENT repo than the base source survive here (the
// org's-own no-op and non-ident guards happen in resolveEffectiveNoteSource).
export interface ResolvedSourceRange {
  chapter_start: number;
  chapter_end: number;
  ref: RepoRef;
}

// The import/reimport/export plan for a book's note resource:
//   base   — the source for chapters NOT covered by a cross-org range
//            (project-wide translationSource, or null = the org's own repo)
//   ranges — the cross-org ranges (each with a resolved, ident-guarded RepoRef)
//
// PURE (no D1) so it is unit-testable; the async planBookNoteSources feeds it the
// stored ranges. A whole-book (0,999) cross-org range collapses into `base`
// (it IS the base for the whole book) and yields no per-chapter ranges — that is
// exactly Tier 1, so a whole-book override still takes the single-source path.
export function planNoteSourcesFromRanges(
  cfg: ProjectConfig,
  resource: BookSourceResource,
  ranges: BookSourceRange[],
  translateFromSource: boolean,
): { base: RepoRef | null; ranges: ResolvedSourceRange[] } {
  const base = resolveEffectiveNoteSource(cfg, resource, null, translateFromSource);
  const resolved: ResolvedSourceRange[] = [];
  let wholeBookBase: RepoRef | null = null;
  for (const r of ranges) {
    const ref = resolveEffectiveNoteSource(cfg, resource, { org: r.org, repo: r.repo }, translateFromSource);
    if (!ref) continue; // non-ident or org's-own no-op → not a cross-org range
    if (isWholeBook(r)) {
      wholeBookBase = ref; // a whole-book override replaces the base entirely
      continue;
    }
    resolved.push({ chapter_start: r.chapter_start, chapter_end: r.chapter_end, ref });
  }
  resolved.sort((a, b) => a.chapter_start - b.chapter_start);
  return { base: wholeBookBase ?? base, ranges: resolved };
}

export async function planBookNoteSources(
  env: Env,
  cfg: ProjectConfig,
  book: string,
  resource: BookSourceResource,
  translateFromSource: boolean,
): Promise<{ base: RepoRef | null; ranges: ResolvedSourceRange[] }> {
  const ranges = await getBookSourceRanges(env, book, resource);
  return planNoteSourcesFromRanges(cfg, resource, ranges, translateFromSource);
}

// The cross-org RepoRef for a specific CHAPTER, or null if that chapter falls to
// the base source. Used by reimport/export to decide per-chapter hold-out.
export function sourceRefForChapter(
  plan: { base: RepoRef | null; ranges: ResolvedSourceRange[] },
  chapter: number,
): RepoRef | null {
  for (const r of plan.ranges) {
    if (rangeCoversChapter(r, chapter)) return r.ref;
  }
  return null;
}

// ── Hold-out (range-scoped) ────────────────────────────────────────────────
// Which chapters of a book's note resource are HELD OUT of the org's own nightly
// reimport + export — i.e. sourced off the org's own master, so reimporting from
// the org repo would clobber them and exporting would push borrowed content over
// master. Returned as ranges (not a materialized set) so a "12..999 = to end"
// range costs nothing to represent. `{ all: true }` = the whole resource is held
// out (a whole-book marker or a whole-book override).

export type HeldOut = { all: true } | { all: false; ranges: Array<{ start: number; end: number }> };

export const NOTHING_HELD_OUT: HeldOut = { all: false, ranges: [] };

export function isChapterHeldOut(h: HeldOut, chapter: number): boolean {
  if (h.all) return true;
  return h.ranges.some((r) => chapter >= r.start && chapter <= r.end);
}

// PURE: derive hold-out from the book-level provenance marker + the stored
// ranges. The marker (book_imports.tn_source/tq_source: aquifer:… / source:…)
// is the WHOLE-BOOK signal — aquifer-drafts, the 404 fallback, a whole-book
// override — and short-circuits to { all: true }. Otherwise only ranges that
// resolve to a genuine cross-org source (the org's-own no-op + non-ident guards
// in resolveEffectiveNoteSource drop the rest) are held out; a whole-book range
// that survives is also { all: true }. translateFromSource is false here: a
// range override is explicit and flag-independent, and the whole-book
// translate-from-source case is already the marker.
export function heldOutChaptersFromRanges(
  cfg: ProjectConfig,
  resource: BookSourceResource,
  ranges: BookSourceRange[],
  marker: string | null | undefined,
): HeldOut {
  if (marker) return { all: true };
  const out: Array<{ start: number; end: number }> = [];
  for (const r of ranges) {
    const ref = resolveEffectiveNoteSource(cfg, resource, { org: r.org, repo: r.repo }, false);
    if (!ref) continue; // org's-own no-op or non-ident → not held out
    if (isWholeBook(r)) return { all: true };
    out.push({ start: r.chapter_start, end: r.chapter_end });
  }
  return { all: false, ranges: out };
}

// Async wrapper: read the ranges, apply the marker from the caller's book_imports
// row. Table-missing is already handled in getBookSourceRanges (→ []), so a book
// with no overrides and no marker is simply NOTHING_HELD_OUT.
export async function heldOutChapters(
  env: Env,
  cfg: ProjectConfig,
  book: string,
  resource: BookSourceResource,
  marker: string | null | undefined,
): Promise<HeldOut> {
  const ranges = await getBookSourceRanges(env, book, resource);
  return heldOutChaptersFromRanges(cfg, resource, ranges, marker);
}
