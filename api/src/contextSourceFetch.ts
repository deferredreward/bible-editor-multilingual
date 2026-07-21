// Batched English-source fetch for context-pack example export.
// Groups validated rows by book; one DCS raw fetch per book × resource.
// Fail-closed: truncated TSV (Content-Length short-read via fetchText) or a
// missing book file aborts — never build a partial EN map quietly.

import type { Env } from "./index";
import type { ProjectConfig } from "./projectConfig.ts";
import { fetchText, dcsRawUrl, resolveSourceRef } from "./dcsSources.ts";
import { parseTsv } from "./importParsers.ts";
import {
  sourceRowKey,
  type EnSourceMaps,
  type ValidatedTnRow,
  type ValidatedTqRow,
} from "./contextExport.ts";

export type SourceFetchResult =
  // `skipped` lists resources ("tn"/"tq") that had validated rows but NO upstream
  // source repo (blank in Setup) — their maps are empty and the caller proceeds
  // without those examples. This is NOT a failure; only genuine fetch/truncation
  // errors return { ok: false }.
  | { ok: true; sources: EnSourceMaps; skipped: string[] }
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
  const skipped: string[] = [];

  // translationSource.repos is PARTIAL and per-resource: a resource left blank in
  // Setup has NO upstream source, and a resource may point at a DIFFERENT org
  // than src.org. Resolve each role's org+repo through the shared accessor. Skip
  // a sourceless resource (its map stays empty) and continue with the OTHERS —
  // NEVER fetch `${org}/undefined/...`, and never fail the whole export just
  // because one resource is sourceless. Genuine fetch failures / truncation below
  // still hard-fail. `tnSrc` captured after the guard so TS knows it's defined
  // inside the loop.
  const tnSrc = resolveSourceRef(src, "tn");
  if (tnRows.length > 0 && !tnSrc) {
    skipped.push("tn");
  } else if (tnSrc) {
    for (const book of booksOf(tnRows)) {
      const path = `tn_${book}.tsv`;
      const url = dcsRawUrl(env, tnSrc.org, tnSrc.repo, path);
      const raw = await fetchText(url);
      if (raw == null) {
        return { ok: false, reason: `en_fetch_failed:tn:${book}` };
      }
      if (tsvLooksTruncated(raw)) {
        return { ok: false, reason: `en_tsv_truncated:tn:${book}` };
      }
      bookCacheTn.set(book, indexTn(raw));
    }
  }

  const tqSrc = resolveSourceRef(src, "tq");
  if (tqRows.length > 0 && !tqSrc) {
    skipped.push("tq");
  } else if (tqSrc) {
    for (const book of booksOf(tqRows)) {
      const path = `tq_${book}.tsv`;
      const url = dcsRawUrl(env, tqSrc.org, tqSrc.repo, path);
      const raw = await fetchText(url);
      if (raw == null) {
        return { ok: false, reason: `en_fetch_failed:tq:${book}` };
      }
      if (tsvLooksTruncated(raw)) {
        return { ok: false, reason: `en_tsv_truncated:tq:${book}` };
      }
      bookCacheTq.set(book, indexTq(raw));
    }
  }

  for (const r of tnRows) {
    const bookMap = bookCacheTn.get(r.book.toUpperCase());
    const hit = bookMap?.get(r.id);
    // Key by book:id — bare id is only unique within a book TSV.
    if (hit) sources.tn.set(sourceRowKey(r.book, r.id), hit);
  }
  for (const r of tqRows) {
    const bookMap = bookCacheTq.get(r.book.toUpperCase());
    const hit = bookMap?.get(r.id);
    if (hit) sources.tq.set(sourceRowKey(r.book, r.id), hit);
  }

  return { ok: true, sources, skipped };
}
