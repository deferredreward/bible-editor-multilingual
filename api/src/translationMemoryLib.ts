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

// Dedup/upsert identity: a concept's rendering is identified by
// (concept_id, source_term, status) — the same concept can hold a preferred and
// a forbidden rendering of the same source term without colliding.
export function termKey(t: { concept_id: string; source_term: string; status: string }): string {
  return `${t.concept_id.trim().toLowerCase()}\u0000${t.source_term.trim().toLowerCase()}\u0000${t.status}`;
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

// Split CSV text into rows of string cells; handles quoted fields containing
// commas, newlines, and "" escapes. Trailing blank lines dropped.
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
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
      rows.push(row);
      row = [];
      cur = "";
    } else {
      cur += ch;
    }
  }
  // Flush the last field/row if the file didn't end with a newline.
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  // Drop wholly-empty rows (e.g. a trailing blank line parsed to ['']).
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

export type CsvParseResult = {
  terms: TermImport[];
  errors: { line: number; message: string }[];
};

// Parse a terminology CSV. Requires a header row naming at least concept_id,
// source_term, status. Unknown columns are ignored; missing optional columns
// default to null. A row with a bad status is reported as an error, not guessed.
export function parseTermsCsv(text: string): CsvParseResult {
  const rows = parseCsvRows(text);
  const errors: CsvParseResult["errors"] = [];
  if (rows.length === 0) return { terms: [], errors: [{ line: 0, message: "empty file" }] };

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iConcept = col("concept_id");
  const iSource = col("source_term");
  const iTarget = col("target_term");
  const iStatus = col("status");
  const iReplace = col("replacement");
  const iComment = col("comment");
  const iTw = col("tw_link");
  if (iConcept < 0 || iSource < 0) {
    return { terms: [], errors: [{ line: 1, message: "header must include concept_id and source_term" }] };
  }

  const terms: TermImport[] = [];
  // stripFormulaGuard undoes the excelSafe prefix so re-importing a
  // downloaded export doesn't accumulate quote marks.
  const at = (r: string[], i: number): string =>
    i >= 0 && i < r.length ? stripFormulaGuard(r[i].trim()) : "";
  const nullable = (s: string): string | null => (s === "" ? null : s);
  for (let r = 1; r < rows.length; r++) {
    const line = r + 1;
    const cells = rows[r];
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
    terms.push({
      concept_id,
      source_term,
      target_term: nullable(at(cells, iTarget)),
      status,
      replacement,
      comment: nullable(at(cells, iComment)),
      tw_link: nullable(at(cells, iTw)),
    });
  }
  return { terms, errors };
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
// with two rows for the same (concept, source, status) doesn't double-insert.
export function dedupeTerms(terms: readonly TermImport[]): TermImport[] {
  const byKey = new Map<string, TermImport>();
  for (const t of terms) byKey.set(termKey(t), t);
  return [...byKey.values()];
}
