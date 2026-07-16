// Shared DCS-source helpers. The first-time book import (bookImport.ts) and
// the per-chapter re-import (bookReimport.ts) both read the same set of raw
// USFM / TSV files from git.door43.org — keep the URL shape and book-prefix
// table in one place so they can't drift.
//
// Multilingual: the owner org and repo names are no longer hardcoded to
// unfoldingWord/en_* — they come from the per-project config
// (projectConfig.ts). The `lit`/`sim` roles map onto the internal
// ULT/UST bible_version labels; the ORIGINAL-language repos (hbo_uhb /
// el-x-koine_ugnt under unfoldingWord) are universal across projects and
// stay fixed here.

import type { Env } from "./index";
import type { ProjectConfig } from "./projectConfig";
import type { RepoRef } from "./repoUrl";

// Standard unfoldingWord book number prefixes for USFM filenames. Mirror of
// the BOOK_NUMBERS map in scripts/import-book.mjs and api/src/export.ts.
export const BOOK_NUMBERS: Record<string, string> = {
  GEN: "01", EXO: "02", LEV: "03", NUM: "04", DEU: "05", JOS: "06", JDG: "07",
  RUT: "08", "1SA": "09", "2SA": "10", "1KI": "11", "2KI": "12", "1CH": "13",
  "2CH": "14", EZR: "15", NEH: "16", EST: "17", JOB: "18", PSA: "19",
  PRO: "20", ECC: "21", SNG: "22", ISA: "23", JER: "24", LAM: "25",
  EZK: "26", DAN: "27", HOS: "28", JOL: "29", AMO: "30", OBA: "31",
  JON: "32", MIC: "33", NAM: "34", HAB: "35", ZEP: "36", HAG: "37",
  ZEC: "38", MAL: "39",
  MAT: "41", MRK: "42", LUK: "43", JHN: "44", ACT: "45",
  ROM: "46", "1CO": "47", "2CO": "48", GAL: "49", EPH: "50",
  PHP: "51", COL: "52", "1TH": "53", "2TH": "54", "1TI": "55",
  "2TI": "56", TIT: "57", PHM: "58", HEB: "59", JAS: "60",
  "1PE": "61", "2PE": "62", "1JN": "63", "2JN": "64", "3JN": "65",
  JUD: "66", REV: "67",
};

export const NT_BOOKS = new Set([
  "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH",
  "PHP", "COL", "1TH", "2TH", "1TI", "2TI", "TIT", "PHM", "HEB", "JAS",
  "1PE", "2PE", "1JN", "2JN", "3JN", "JUD", "REV",
]);

export interface DcsUrlSet {
  ult: string;
  ust: string;
  orig: string;        // hbo_uhb for OT, el-x-koine_ugnt for NT
  origVersion: "UHB" | "UGNT";
  tn: string;
  tq: string;
  twl: string;
}

// The original-language repos are universal: every project aligns to the
// same UHB/UGNT under the unfoldingWord org, regardless of its own org.
export const ORIG_OWNER = "unfoldingWord";

// Optional per-resource RepoRef overrides from lane state. When provided,
// the lit/sim URL uses the lane source ref instead of hardcoding master.
export interface LaneRepoOverrides {
  lit?: RepoRef;
  sim?: RepoRef;
}

// Build the set of DCS raw-content URLs for a given book. `book` is the
// uppercase 3-char canonical id (e.g. "ZEC", "1CO"). Returns null if the
// book id isn't in BOOK_NUMBERS (unknown book). Owner + repo names come
// from the project config (roles lit/sim → internal ULT/UST labels).
// Optional `overrides` lets callers supply lane-specific source refs.
export function dcsUrls(
  env: Env,
  cfg: ProjectConfig,
  book: string,
  overrides?: LaneRepoOverrides,
): DcsUrlSet | null {
  const num = BOOK_NUMBERS[book];
  if (!num) return null;
  const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
  const usfmName = `${num}-${book}.usfm`;
  const isNt = NT_BOOKS.has(book);
  const origRepo = isNt ? "el-x-koine_ugnt" : "hbo_uhb";
  const org = cfg.org;

  const litOwner = overrides?.lit?.owner ?? org;
  const litRepo = overrides?.lit?.repo ?? cfg.repos.lit;
  const litRef = overrides?.lit?.ref ?? "master";
  const simOwner = overrides?.sim?.owner ?? org;
  const simRepo = overrides?.sim?.repo ?? cfg.repos.sim;
  const simRef = overrides?.sim?.ref ?? "master";

  return {
    ult: `${base}/${litOwner}/${litRepo}/raw/branch/${litRef}/${usfmName}`,
    ust: `${base}/${simOwner}/${simRepo}/raw/branch/${simRef}/${usfmName}`,
    orig: `${base}/${ORIG_OWNER}/${origRepo}/raw/branch/master/${usfmName}`,
    origVersion: isNt ? "UGNT" : "UHB",
    tn: `${base}/${org}/${cfg.repos.tn}/raw/branch/master/tn_${book}.tsv`,
    tq: `${base}/${org}/${cfg.repos.tq}/raw/branch/master/tq_${book}.tsv`,
    twl: `${base}/${org}/${cfg.repos.twl}/raw/branch/master/twl_${book}.tsv`,
  };
}

// Best-effort text fetch. 404 / network failure → null, so callers can warn
// and continue when a single file is missing (matches the "incomplete sample
// dir" behaviour of scripts/import-book.mjs).
//
// Completeness-checked: a SHORT body (fewer bytes than the declared
// Content-Length) is a truncated fetch and is rejected, not silently accepted.
// This is the root-cause guard for the twl_PSA data-loss incident — a partial
// ~350KB read of a ~547KB file loaded 4880 of 7776 rows into D1, the watermark
// certified it "in sync", and the nightly export then shipped the partial over
// master (deleting 2,896 rows). Accepting half a file as if it were whole is
// never the right answer, so we treat it as a fetch failure: the bootstrap
// throws + retries, the reimport skips (and never stamps a false watermark).
// One retry, since the truncation is transient (not a deterministic size cap —
// larger files like tn_PSA / ISA tn fetch fine).
//
// We reject only SHORT bodies, never LONGER-than-declared ones: transparent
// gzip makes the decoded length exceed the (compressed) Content-Length, which
// is not a truncation.
//
// BLIND SPOT (the HAB tn incident, 2026-06-23/24): this declared-length check
// is BYPASSED when the response carries no Content-Length at all — HAB's raw
// endpoint apparently omits it, so a partial body slipped through twice, the
// reimport stamped the master commit SHA onto it, and the nightly prune then
// soft-deleted 559 pristine rows (twl_PSA pattern, recurring). Transport here
// cannot verify completeness without a declared length, so we at least SURFACE
// the condition (warn) — the real backstop is the reimport's row-count gate
// (tsvFetchLooksTruncated in bookReimport.ts), which rejects a body that parses
// to drastically fewer rows than the book already holds in D1.
export async function fetchText(url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      const cl = r.headers.get("content-length");
      const expected = cl == null ? null : Number(cl);
      if (expected != null && Number.isFinite(expected) && buf.byteLength < expected) {
        console.error("fetchText: short read (truncated fetch); retrying", {
          url,
          expectedBytes: expected,
          gotBytes: buf.byteLength,
          attempt,
        });
        continue;
      }
      if (expected == null) {
        // No declared length → completeness unverifiable at this layer. Log so
        // the condition that hid the HAB truncation is visible; downstream
        // callers must apply their own sanity check (see tsvFetchLooksTruncated).
        console.warn("fetchText: response has no content-length; completeness unverified", {
          url,
          gotBytes: buf.byteLength,
        });
      }
      return new TextDecoder("utf-8").decode(buf);
    } catch {
      // network error → retry once, then null
    }
  }
  return null;
}

// Status-aware sibling of fetchText, for callers that must distinguish a 404
// (terminal "this file doesn't exist at the source") from a transient 5xx /
// network error / truncated read (retryable). fetchText collapses all of those
// into null; the article populator needs the distinction to decide whether to
// record a 'not_found' (terminal) vs an 'error' (retry) fetch-state row.
//
// SUCCESS is strictly status===200 && text!==null && !truncated. A truncated
// 200 (short body vs declared Content-Length — the twl_PSA data-loss signature)
// is a RETRYABLE failure: text stays null, truncated:true, and it is NEVER
// treated as content. Sends the DCS service token when present (private repos /
// rate limits), matching fileCommitSha. fetchText itself is left untouched.
export interface FetchTextResult {
  status: number; // 0 = network error / exception
  text: string | null;
  truncated?: boolean;
}

export async function fetchTextWithStatus(env: Env, url: string): Promise<FetchTextResult> {
  try {
    const headers: Record<string, string> = {};
    if (env.DCS_SERVICE_TOKEN) headers.Authorization = `token ${env.DCS_SERVICE_TOKEN}`;
    const r = await fetch(url, Object.keys(headers).length ? { headers } : undefined);
    if (!r.ok) return { status: r.status, text: null };
    const buf = await r.arrayBuffer();
    const cl = r.headers.get("content-length");
    const expected = cl == null ? null : Number(cl);
    if (expected != null && Number.isFinite(expected) && buf.byteLength < expected) {
      // Short read → truncated. Retryable; never content.
      return { status: 200, text: null, truncated: true };
    }
    return { status: 200, text: new TextDecoder("utf-8").decode(buf) };
  } catch {
    return { status: 0, text: null };
  }
}

// ── Per-resource repo/path + git-SHA helpers (incremental self-heal reimport) ──
// The reimport reads the project's configured source on master — the same
// org dcsUrls() resolves. The SHA check below MUST agree with the raw fetch on
// owner/repo/path/ref, so both derive from this one mapping.

export type ReimportResource = "ult" | "ust" | "tn" | "tq" | "twl";

// Map a reimport resource role to the project's repo name.
function repoForResource(cfg: ProjectConfig, resource: ReimportResource): string {
  switch (resource) {
    case "ult": return cfg.repos.lit;
    case "ust": return cfg.repos.sim;
    case "tn":  return cfg.repos.tn;
    case "tq":  return cfg.repos.tq;
    case "twl": return cfg.repos.twl;
  }
}

// {repo, in-repo path} for a (book, resource). Mirror of dcsUrls()'s shape; null
// for an unknown book. Keep in sync with dcsUrls — the path formulas are
// identical (USFM `${num}-${BOOK}.usfm`, TSV `${res}_${BOOK}.tsv`).
export function dcsResourceFile(
  cfg: ProjectConfig,
  book: string,
  resource: ReimportResource,
): { repo: string; path: string } | null {
  const num = BOOK_NUMBERS[book];
  if (!num) return null;
  const repo = repoForResource(cfg, resource);
  switch (resource) {
    case "ult":
    case "ust":
      return { repo, path: `${num}-${book}.usfm` };
    default:
      return { repo, path: `${resource}_${book}.tsv` };
  }
}

// Raw content URL for an owner/repo/path at a given ref (defaults to master).
// A 40-char hex ref is treated as an immutable commit SHA (Gitea/Door43
// `/raw/commit/<sha>/…`); anything else uses `/raw/branch/<ref>/…`.
export function dcsRawUrl(env: Env, owner: string, repo: string, path: string, ref = "master"): string {
  const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
  const kind = /^[0-9a-f]{40}$/i.test(ref) ? "commit" : "branch";
  return `${base}/${owner}/${repo}/raw/${kind}/${ref}/${path}`;
}

// Latest commit SHA on master that touched `path` in `repo`, or null on
// 404 / empty history / network error. Used as the change-detection watermark
// for the incremental reimport (skip a (book,resource) whose file SHA matches
// what we last synced). Sends the service token when present so private repos
// and rate limits are handled the same way the export path is.
export async function fileCommitSha(env: Env, owner: string, repo: string, path: string, ref = "master"): Promise<string | null> {
  const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
  const url =
    `${base}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/commits?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}&limit=1&stat=false&verification=false&files=false`;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (env.DCS_SERVICE_TOKEN) headers.Authorization = `token ${env.DCS_SERVICE_TOKEN}`;
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const commits = (await r.json()) as Array<{ sha?: string }>;
    return commits[0]?.sha ?? null;
  } catch {
    return null;
  }
}
