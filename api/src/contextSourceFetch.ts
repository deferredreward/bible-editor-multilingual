// Batched English-source fetch for context-pack example export.
// Groups validated rows by book; one DCS raw fetch per book × resource.
// Fail-closed: truncated TSV (Content-Length short-read via fetchText) or a
// missing book file aborts — never build a partial EN map quietly.

import type { Env } from "./index";
import type { ProjectConfig } from "./projectConfig.ts";
import { fetchText, dcsRawUrl } from "./dcsSources.ts";
import { parseTsv } from "./importParsers.ts";
import type { EnSourceMaps, ValidatedTnRow, ValidatedTqRow } from "./contextExport.ts";

export type SourceFetchResult =
  | { ok: true; sources: EnSourceMaps }
  | { ok: false; reason: string };

function booksOf(rows: readonly { book: string }[]): string[] {
  return [...new Set(rows.map((r) => r.book.toUpperCase()))].sort();
}

/** Reject absurdly short TSVs (header-only or truncated without Content-Length). */
export function tsvLooksTruncated(raw: string, minDataRows = 1): boolean {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 1 + minDataRows) return true;
  // Header must look like a tN/tQ header (ID column present).
  const headers = lines[0].split("\t");
  if (!headers.includes("ID")) return true;
  return false;
}

function indexTn(raw: string): Map<string, { note: string; quote: string | null }> {
  const { rows } = parseTsv(raw);
  const map = new Map<string, { note: string; quote: string | null }>();
  for (const r of rows) {
    const id = r.ID?.trim();
    if (!id || id === "ID") continue;
    map.set(id, {
      note: (r.Note ?? "").replace(/\\n/g, "\n"),
      quote: r.Quote ?? null,
    });
  }
  return map;
}

function indexTq(raw: string): Map<string, { question: string; response: string }> {
  const { rows } = parseTsv(raw);
  const map = new Map<string, { question: string; response: string }>();
  for (const r of rows) {
    const id = r.ID?.trim();
    if (!id || id === "ID") continue;
    map.set(id, {
      question: r.Question ?? "",
      response: r.Response ?? "",
    });
  }
  return map;
}

/**
 * Fetch and index EN tN/tQ TSVs needed to pair validated D1 rows with source text.
 * Uses translationSource.org + repos (never the GL target org).
 */
export async function fetchEnSourceMaps(
  env: Env,
  cfg: ProjectConfig,
  tnRows: readonly ValidatedTnRow[],
  tqRows: readonly ValidatedTqRow[],
): Promise<SourceFetchResult> {
  const src = cfg.translationSource;
  if (!src) {
    return { ok: false, reason: "no_translation_source" };
  }

  const sources: EnSourceMaps = { tn: new Map(), tq: new Map() };
  const bookCacheTn = new Map<string, Map<string, { note: string; quote: string | null }>>();
  const bookCacheTq = new Map<string, Map<string, { question: string; response: string }>>();

  for (const book of booksOf(tnRows)) {
    const path = `tn_${book}.tsv`;
    const url = dcsRawUrl(env, src.org, src.repos.tn, path);
    const raw = await fetchText(url);
    if (raw == null) {
      return { ok: false, reason: `en_fetch_failed:tn:${book}` };
    }
    if (tsvLooksTruncated(raw)) {
      return { ok: false, reason: `en_tsv_truncated:tn:${book}` };
    }
    bookCacheTn.set(book, indexTn(raw));
  }

  for (const book of booksOf(tqRows)) {
    const path = `tq_${book}.tsv`;
    const url = dcsRawUrl(env, src.org, src.repos.tq, path);
    const raw = await fetchText(url);
    if (raw == null) {
      return { ok: false, reason: `en_fetch_failed:tq:${book}` };
    }
    if (tsvLooksTruncated(raw)) {
      return { ok: false, reason: `en_tsv_truncated:tq:${book}` };
    }
    bookCacheTq.set(book, indexTq(raw));
  }

  for (const r of tnRows) {
    const bookMap = bookCacheTn.get(r.book.toUpperCase());
    const hit = bookMap?.get(r.id);
    if (hit) sources.tn.set(r.id, hit);
  }
  for (const r of tqRows) {
    const bookMap = bookCacheTq.get(r.book.toUpperCase());
    const hit = bookMap?.get(r.id);
    if (hit) sources.tq.set(r.id, hit);
  }

  return { ok: true, sources };
}
