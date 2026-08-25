// Pure (React-free) logic behind the "Bring in this book" source sheet
// (docs/ux-simplification.md §1.3 / Track A3): turn the sheet's per-resource
// source rows into the ordered list of PUT /api/books/:book/sources payloads
// that must land BEFORE the import, plus the validation the server would only
// report one row at a time (partial bounds, intra-sheet overlaps).
//
// Kept in a plain .ts module (no JSX) so the node --strip-types web test runner
// can unit-test it directly (importSources.test.mjs), mirroring orgDraft.ts.

import { upstreamSourceForResource } from "./orgDraft.ts";

/** The only resources `book_source_overrides` can override (server-enforced). */
export type OverridableResource = "tn" | "tq";
export const OVERRIDABLE_RESOURCES: OverridableResource[] = ["tn", "tq"];

/**
 * Where one sheet row pulls its content from.
 *   default  → the project's own repos: NO override row is written (the server
 *              falls back to the project config), so a default row is a no-op.
 *   upstream → the unfoldingWord upstream preset (org/repo derived per resource
 *              via upstreamSourceForResource — issue #289).
 *   aquifer  → Aquifer notes (tN only; the server derives the language).
 *   url      → another Door43 repo, pasted as a URL and verified via
 *              api.verifySource before the PUT (the plan carries the raw URL).
 */
export type SheetSourceKind = "default" | "upstream" | "aquifer" | "url";

/** One editable row of the sheet: [source][from ch][to ch]. */
export interface SheetRow {
  resource: OverridableResource;
  kind: SheetSourceKind;
  /** Raw pasted Door43 URL; meaningful only when kind === "url". */
  url: string;
  /** Raw chapter-bound inputs; "" = unbounded. Both blank = whole book. */
  fromCh: string;
  toCh: string;
}

/** The sheet's initial state: one no-op default row per overridable resource. */
export function defaultSheetRows(): SheetRow[] {
  return OVERRIDABLE_RESOURCES.map((resource) => ({
    resource,
    kind: "default" as const,
    url: "",
    fromCh: "",
    toCh: "",
  }));
}

export type SheetRowErrorCode =
  // One bound filled, the other blank (mirrors the server's
  // range_needs_both_bounds — caught here so it lands on the right row).
  | "range_needs_both"
  // A bound isn't a whole number ≥ 0 (chapter 0 — front matter — is legal).
  | "bad_chapter"
  // from > to.
  | "range_reversed"
  // Aquifer requires an explicit chapter range (whole-book Aquifer goes
  // through "Pull Aquifer drafts" instead — same rule as the overrides panel).
  | "aquifer_needs_range"
  // Aquifer is tN-only (the UI shouldn't offer it for tQ; belt-and-braces).
  | "aquifer_tn_only"
  // kind "url" with a blank URL.
  | "url_required"
  // This row's range overlaps an EARLIER row for the same resource. Overlaps
  // with rows already stored server-side are the server's 409 to report.
  | "overlap";

export interface SheetRowError {
  /** Index into the `rows` array passed to planSourceWrites. */
  index: number;
  code: SheetRowErrorCode;
}

/**
 * One override the sheet must write before importing. For kind "url" the
 * caller must resolve `url` → { org, repo } via api.verifySource first; the
 * other kinds are fully resolved here. `index` points back at the originating
 * sheet row so a server 409 (overlapping_range) can be surfaced inline.
 */
export interface PlannedSourceWrite {
  index: number;
  resource: OverridableResource;
  kind: "upstream" | "aquifer" | "url";
  url?: string;
  org?: string;
  repo?: string;
  /** Both present (a range) or both absent (whole book — server default). */
  chapterStart?: number;
  chapterEnd?: number;
}

export type SheetPlan =
  | { ok: true; writes: PlannedSourceWrite[] }
  | { ok: false; errors: SheetRowError[] };

// "" → undefined; otherwise the parsed non-negative integer, or null when the
// text isn't one (fractional, negative, non-numeric).
function parseBound(raw: string): number | null | undefined {
  const s = raw.trim();
  if (s === "") return undefined;
  if (!/^\d+$/.test(s)) return null;
  return Number(s);
}

// The effective [start, end] interval a write occupies for overlap purposes.
// A whole-book write spans everything — same convention as the server's
// stored (0, 999) whole-book row.
const WHOLE_BOOK_START = 0;
const WHOLE_BOOK_END = 999;
function interval(w: PlannedSourceWrite): [number, number] {
  return w.chapterStart === undefined
    ? [WHOLE_BOOK_START, WHOLE_BOOK_END]
    : [w.chapterStart, w.chapterEnd ?? w.chapterStart];
}

/**
 * Validate the sheet and produce the ordered setBookSource payload list.
 * Default rows produce nothing (and don't participate in overlap checks —
 * "project default" is what applies wherever no override row exists). Returns
 * every error at once so the sheet can mark all offending rows in one pass.
 */
export function planSourceWrites(rows: SheetRow[]): SheetPlan {
  const errors: SheetRowError[] = [];
  const writes: PlannedSourceWrite[] = [];

  rows.forEach((row, index) => {
    if (row.kind === "default") return; // no-op by design

    const from = parseBound(row.fromCh);
    const to = parseBound(row.toCh);

    if (from === null || to === null) {
      errors.push({ index, code: "bad_chapter" });
      return;
    }
    if ((from === undefined) !== (to === undefined)) {
      errors.push({ index, code: "range_needs_both" });
      return;
    }
    if (from !== undefined && to !== undefined && from > to) {
      errors.push({ index, code: "range_reversed" });
      return;
    }

    if (row.kind === "aquifer") {
      if (row.resource !== "tn") {
        errors.push({ index, code: "aquifer_tn_only" });
        return;
      }
      if (from === undefined || to === undefined) {
        errors.push({ index, code: "aquifer_needs_range" });
        return;
      }
      writes.push({ index, resource: "tn", kind: "aquifer", chapterStart: from, chapterEnd: to });
      return;
    }

    const bounds = from !== undefined && to !== undefined ? { chapterStart: from, chapterEnd: to } : {};

    if (row.kind === "url") {
      if (row.url.trim() === "") {
        errors.push({ index, code: "url_required" });
        return;
      }
      writes.push({ index, resource: row.resource, kind: "url", url: row.url.trim(), ...bounds });
      return;
    }

    // upstream — resolved here so the sheet and the overrides panel can never
    // disagree about what the preset points at.
    const { org, repo } = upstreamSourceForResource(row.resource);
    writes.push({ index, resource: row.resource, kind: "upstream", org, repo, ...bounds });
  });

  // Intra-sheet overlap: pairwise per resource, error pinned on the LATER row.
  for (let i = 0; i < writes.length; i++) {
    for (let j = 0; j < i; j++) {
      if (writes[i].resource !== writes[j].resource) continue;
      const [s1, e1] = interval(writes[i]);
      const [s2, e2] = interval(writes[j]);
      if (s1 <= e2 && s2 <= e1) {
        errors.push({ index: writes[i].index, code: "overlap" });
        break; // one overlap error per row is enough
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, writes };
}

/**
 * The body api.setBookSource expects for a planned write, given the resolved
 * { org, repo } for kind "url" (from api.verifySource). Upstream writes carry
 * their own org/repo; Aquifer sends kind:"aquifer" with no repo at all (the
 * server derives the language from the project).
 */
export function setBookSourceBody(
  write: PlannedSourceWrite,
  verified?: { org: string; repo: string },
): {
  resource: OverridableResource;
  kind?: "aquifer";
  org?: string;
  repo?: string;
  chapterStart?: number;
  chapterEnd?: number;
} {
  const bounds =
    write.chapterStart !== undefined
      ? { chapterStart: write.chapterStart, chapterEnd: write.chapterEnd }
      : {};
  if (write.kind === "aquifer") {
    return { resource: write.resource, kind: "aquifer", ...bounds };
  }
  const org = write.kind === "url" ? verified?.org : write.org;
  const repo = write.kind === "url" ? verified?.repo : write.repo;
  return { resource: write.resource, org, repo, ...bounds };
}
