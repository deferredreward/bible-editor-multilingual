// Pure logic for the translation-memory panel — CSV round-trip, closed-picklist
// validation, and term normalization. Extracted from the Hono route module so it
// can be unit-tested under the node --experimental-strip-types runner without the
// Hono/D1 import chain (same split rationale as translateOptions.ts / pipeline-
// ImportClaim.ts). No Hono, no D1, no env imports here.

// ---- Closed picklists (docs/preferences-panel-design.md §3, §5.1) ----

// Term status: TBX-standard core (preferred/admitted/deprecated) + the CAT-tool
// layer (forbidden) + DNT. 'forbidden' pairs with a `replacement` (use-instead).
export const TERM_STATUSES = [
  "preferred",
  "admitted",
  "deprecated",
  "forbidden",
  "do_not_translate",
] as const;
export type TermStatus = (typeof TERM_STATUSES)[number];
export function isTermStatus(v: unknown): v is TermStatus {
  return typeof v === "string" && (TERM_STATUSES as readonly string[]).includes(v);
}

// Register: the one formality control standardized across MT vendors (DeepL /
// Amazon), as a closed enum rather than free-text tone prose.
export const REGISTERS = ["default", "formal", "informal"] as const;
export type Register = (typeof REGISTERS)[number];

// ---- Term shape (mirrors the D1 row, sans bookkeeping) ----

export type TermImport = {
  concept_id: string;
  source_term: string;
  target_term: string | null;
  status: TermStatus;
  replacement: string | null;
  comment: string | null;
  tw_link: string | null;
};

// Fold a text component of the term identity the way SQLite does — and only
// the way SQLite does. `LOWER()` in SQLite lowercases ASCII A-Z and nothing
// else; `TRIM()` strips U+0020 and nothing else. JS `.toLowerCase()` /
// `.trim()` are full-Unicode and therefore *stricter*: they fold "Élohim" and
// "élohim" together and trim tabs/NBSP, where SQL keeps them apart.
//
// A JS-vs-SQL mismatch is not cosmetic: termKey() is what the import dry-run
// counts with, while `LOWER(TRIM(...))` is what the UPDATE predicate and the
// unique index in migration 0063 match with. When they disagree the preview
// says "updated: 1, added: 0", the UPDATE matches nothing, the INSERT runs,
// and the index (agreeing with SQL, not JS) lets a near-duplicate rendering
// through — the operator was shown a diff that did not happen. Matching SQL
// exactly matters more than "nicer" Unicode folding, so this deliberately
// mirrors 0063's index expression instead of improving on it.
//
// Consequence, intended: within one CSV, "Élohim" and "élohim" are two
// different renderings and both get inserted — exactly what the DB will do.
export function sqlFold(s: string): string {
  let start = 0;
  let end = s.length;
  // TRIM(): U+0020 only, both ends.
  while (start < end && s.charCodeAt(start) === 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) === 0x20) end--;
  // LOWER(): ASCII A-Z only ([A-Z] without the /u flag is ASCII-only).
  return s.slice(start, end).replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// Dedup/upsert identity: a concept's *rendering* is identified by
// (concept_id, source_term, target_term, status). target_term is part of the key
// because docs/CONTEXT-REPO-CONTRACT.md §3.3 states that "one concept MAY have
// several preferred/admitted rows — sense-dependent renderings are legitimate;
// do not treat the table as one-term-one-string". Under the old three-part key a
// second, equally-valid `preferred` rendering silently overwrote the first.
// Mirrored in SQL by the unique index rebuilt in migration 0063.
//
// Null-safety: null / undefined / whitespace-only target_term all normalize to
// the empty string, so `do_not_translate` rows (empty target by contract) still
// collide with each other. The SQL side uses COALESCE(target_term, '') for the
// same reason — SQLite treats NULLs as always-distinct in a UNIQUE index.
//
// Case/whitespace folding goes through sqlFold(), which mirrors SQLite's
// LOWER(TRIM(...)) exactly rather than using JS's full-Unicode equivalents —
// see the sqlFold() comment for why a mismatch would make the import dry-run
// misreport. `status` is compared verbatim, matching `status = ?` in SQL.
//
// Deliberately NOT NFC-normalized here: SQL cannot normalize, so doing it in JS
// would make the key and the index disagree — strictly worse than the
// Arabic/Hebrew non-issue (those scripts are case-less, so LOWER() is a no-op).
export function termKey(t: {
  concept_id: string;
  source_term: string;
  target_term: string | null | undefined;
  status: string;
}): string {
  return `${termGroupKey(t)}\u0000${sqlFold(t.target_term ?? "")}\u0000${t.status}`;
}

// The *narrower* (concept_id, source_term) grouping — the identity that held
// before migration 0063 widened it with target_term, minus status. The importer
// uses it to notice that an incoming row adds a rendering to a concept that
// already has one under the same status (an append, not a replacement). Shares
// sqlFold() with termKey by construction, so the two can never drift apart.
export function termGroupKey(t: { concept_id: string; source_term: string }): string {
  return `${sqlFold(t.concept_id)}\u0000${sqlFold(t.source_term)}`;
}

// Parse an `If-Match` header (bare or quoted integer). Shared by every
// version-CAS route in this router — kept import-light so it stays testable.
export function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const m = /^"?(\d+)"?$/.exec(header.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// Escape a user-supplied search fragment for safe use inside a SQL LIKE
// pattern (`%term%`). Without this, a literal % or _ in the query acts as
// a wildcard instead of matching itself — pair with ESCAPE '\\' in the query.
export function escapeLikeParam(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---- CSV (RFC-4180-ish, mirrors noteTemplates.ts parseCsv) ----

export const TERM_CSV_HEADER = [
  "concept_id",
  "source_term",
  "target_term",
  "status",
  "replacement",
  "comment",
  "tw_link",
] as const;

// One parsed CSV record: its cells plus the 1-based *physical* line of the
// file the record started on. The physical line is not the record index: blank
// lines are dropped and a quoted field may contain newlines, so any error or
// warning that quotes a line number to a human has to come from here rather
// than from counting records (a translator opens the file in a spreadsheet and
// jumps to that line).
export type CsvRow = { line: number; cells: string[] };

// Split CSV text into rows of string cells; handles quoted fields containing
// commas, newlines, and "" escapes. Trailing blank lines dropped.
export function parseCsvRows(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  // Physical line counter: `line` is where the record currently being built
  // started; `nextLine` advances past every newline, quoted ones included.
  let nextLine = 1;
  let line = 1;
  // Strip a UTF-8 BOM if present.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        // A newline inside a quoted field stays in the cell but still consumed
        // a physical line, so later rows don't drift.
        if (ch === "\n" || (ch === "\r" && src[i + 1] !== "\n")) nextLine++;
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cur);
      rows.push({ line, cells: row });
      row = [];
      cur = "";
      nextLine++;
      line = nextLine;
    } else {
      cur += ch;
    }
  }
  // Flush the last field/row if the file didn't end with a newline.
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push({ line, cells: row });
  }
  // Drop wholly-empty rows (e.g. a trailing blank line parsed to ['']).
  return rows.filter((r) => !(r.cells.length === 1 && r.cells[0].trim() === ""));
}

// A parsed CSV row carries the physical line it came from so the importer can
// name it in a warning. Deliberately a superset of TermImport rather than a
// field on TermImport itself: TermImport mirrors the D1 row (there is no `line`
// column), and every existing consumer — serializeTermsCsv, contextExport,
// exportWorkflow, the INSERT binder — accepts a ParsedTerm unchanged and
// ignores the extra field.
export type ParsedTerm = TermImport & { line: number };

export type CsvParseResult = {
  terms: ParsedTerm[];
  // Hard row failures — the row was dropped.
  errors: { line: number; message: string }[];
  // Soft findings — the row was kept, but the operator should know. Currently
  // just genuine duplicates (same full 4-part termKey), which used to collapse
  // silently in dedupeTerms; last-wins still applies, it's just no longer mute.
  warnings: { line: number; message: string }[];
};

// Parse a terminology CSV. Requires a header row naming at least concept_id,
// source_term, status. Unknown columns are ignored; missing optional columns
// default to null. A row with a bad status is reported as an error, not guessed.
export function parseTermsCsv(text: string): CsvParseResult {
  const rows = parseCsvRows(text);
  const errors: CsvParseResult["errors"] = [];
  const warnings: CsvParseResult["warnings"] = [];
  // First line each termKey was seen on, so a duplicate can name its original.
  const seenAt = new Map<string, number>();
  if (rows.length === 0) return { terms: [], errors: [{ line: 0, message: "empty file" }], warnings };

  const header = rows[0].cells.map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iConcept = col("concept_id");
  const iSource = col("source_term");
  const iTarget = col("target_term");
  const iStatus = col("status");
  const iReplace = col("replacement");
  const iComment = col("comment");
  const iTw = col("tw_link");
  if (iConcept < 0 || iSource < 0) {
    return {
      terms: [],
      errors: [{ line: 1, message: "header must include concept_id and source_term" }],
      warnings,
    };
  }

  const terms: ParsedTerm[] = [];
  // stripFormulaGuard undoes the excelSafe prefix so re-importing a
  // downloaded export doesn't accumulate quote marks.
  const at = (r: string[], i: number): string =>
    i >= 0 && i < r.length ? stripFormulaGuard(r[i].trim()) : "";
  const nullable = (s: string): string | null => (s === "" ? null : s);
  for (let r = 1; r < rows.length; r++) {
    // The row's physical line, not r + 1 — see CsvRow.
    const { line, cells } = rows[r];
    const concept_id = at(cells, iConcept);
    const source_term = at(cells, iSource);
    if (!concept_id || !source_term) {
      errors.push({ line, message: "concept_id and source_term are required" });
      continue;
    }
    const rawStatus = iStatus >= 0 ? at(cells, iStatus).toLowerCase() : "preferred";
    const status = rawStatus === "" ? "preferred" : rawStatus;
    if (!isTermStatus(status)) {
      errors.push({ line, message: `invalid status "${rawStatus}" (expected one of ${TERM_STATUSES.join(", ")})` });
      continue;
    }
    const replacement = nullable(at(cells, iReplace));
    const invariantError = termInvariantError({ status, replacement });
    if (invariantError) {
      errors.push({ line, message: invariantError });
      continue;
    }
    const term: ParsedTerm = {
      line,
      concept_id,
      source_term,
      target_term: nullable(at(cells, iTarget)),
      status,
      replacement,
      comment: nullable(at(cells, iComment)),
      tw_link: nullable(at(cells, iTw)),
    };
    // A genuine duplicate is a collision on the *full* identity (concept, source,
    // rendering, status). Two rows differing only by target_term are legitimate
    // sibling renderings (CONTEXT-REPO-CONTRACT.md §3.3) and warn about nothing.
    const key = termKey(term);
    const first = seenAt.get(key);
    if (first !== undefined) {
      warnings.push({
        line,
        message: `duplicate of line ${first} (same concept, source term, rendering and status) — the later row wins`,
      });
    } else {
      seenAt.set(key, line);
    }
    terms.push(term);
  }
  return { terms, errors, warnings };
}

// The forbidden→replacement invariant (docs/CONTEXT-REPO-CONTRACT.md §3.3): a
// forbidden rendering must carry a non-empty `replacement` so a QA flag can
// always say "don't use X, use Y" instead of a bare prohibition. Shared by the
// CSV importer above and the create/update routes in translationMemory.ts.
export function termInvariantError(t: { status: string; replacement: string | null }): string | null {
  if (t.status === "forbidden" && (!t.replacement || !t.replacement.trim())) {
    return "a forbidden term must carry a replacement (what to use instead)";
  }
  return null;
}

// Spreadsheet apps treat a cell whose first char is = + - @ (or a stray
// tab/CR) as a formula, so an editor-authored term like "=HYPERLINK(...)"
// would execute on a teammate's machine when they open the CSV in Excel.
// The guard prefixes Excel's own text marker ('); parseTermsCsv strips it
// back off, so a download → re-import round-trip is lossless.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function stripFormulaGuard(s: string): string {
  return s.startsWith("'") && FORMULA_LEAD.test(s.slice(1)) ? s.slice(1) : s;
}

// Quote a cell only when it contains a comma, quote, or newline (RFC-4180).
function csvCell(v: string | null | undefined, excelSafe: boolean): string {
  let s = v == null ? "" : String(v);
  if (excelSafe && FORMULA_LEAD.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Serialize terms back to CSV with the canonical header row.
//
// excelSafe applies the formula-injection guard above. It is opt-in because
// the two consumers want different bytes: the browser download (/terms/export)
// lands in Excel and gets the guard; the DCS context-repo copy
// (terminology/terms.csv) is a machine-read contract (CONTEXT-REPO-CONTRACT.md)
// consumed by bp-assistant, whose cells must not change underneath the bot.
export function serializeTermsCsv(
  terms: readonly TermImport[],
  opts: { excelSafe?: boolean } = {},
): string {
  const excelSafe = opts.excelSafe === true;
  const lines = [TERM_CSV_HEADER.join(",")];
  for (const t of terms) {
    lines.push(
      [t.concept_id, t.source_term, t.target_term, t.status, t.replacement, t.comment, t.tw_link]
        .map((v) => csvCell(v, excelSafe))
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

// Dedup an import batch, last-wins on termKey collisions, so a single upload
// with two rows for the same (concept, source, target, status) doesn't
// double-insert. Rows that differ only by target_term are distinct renderings of
// the same concept (CONTEXT-REPO-CONTRACT.md §3.3) and are all kept.
//
// Generic in the row type so a ParsedTerm batch keeps its `line` (the importer
// needs it to name the row in a warning) while a plain TermImport batch still
// typechecks.
export function dedupeTerms<T extends TermImport>(terms: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const t of terms) byKey.set(termKey(t), t);
  return [...byKey.values()];
}
