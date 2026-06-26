// One-shot importer for the TWL suggestion-filtering decisions exported from the
// upstream TWL tool. Populates twl_unlinked_words + twl_deleted_rows (migration
// 0033) that the per-verse Suggestions feature consults to suppress links
// translators already rejected.
//
// Reads two CSVs (gzipped or plain):
//   twl_unlinked_words.csv  — columns incl. origWords, twLink
//   twl_deleted_rows.csv    — columns incl. book, reference, normalizedOrigWords
// Only those columns matter; the rest (timestamps, glQuote, userIdentifier …)
// are ignored.
//
// Run (defaults to ~/Downloads/twl_*.csv[.gz]):
//   node scripts/import-twl-filters.mjs
//   node scripts/import-twl-filters.mjs <unlinked.csv> <deleted.csv>
// Then apply (local dev):
//   (cd api && npx wrangler d1 execute bible_editor_dev --local --file=../scripts/out/import-twl-filters.sql)
// Or prod:
//   (cd api && npx wrangler d1 execute bible_editor --remote --env production --file=../scripts/out/import-twl-filters.sql)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = join(repoRoot, "scripts", "out");
mkdirSync(outDir, { recursive: true });

// Locate an input file: explicit argv path, else the first existing candidate
// (plain then .gz) in ~/Downloads.
function locate(explicit, ...candidates) {
  if (explicit) return explicit;
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`could not find input; tried: ${candidates.join(", ")}`);
}

const dl = join(homedir(), "Downloads");
const [, , argUnlinked, argDeleted] = process.argv;
const unlinkedPath = locate(
  argUnlinked,
  join(dl, "twl_unlinked_words.csv"),
  join(dl, "twl_unlinked_words.csv.gz"),
);
const deletedPath = locate(
  argDeleted,
  join(dl, "twl_deleted_rows.csv"),
  join(dl, "twl_deleted_rows.csv.gz"),
);

function readMaybeGz(path) {
  const buf = readFileSync(path);
  return (path.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf-8");
}

// Minimal RFC-4180-ish CSV parser: handles quoted fields, "" escapes, CRLF.
function parseCSV(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
      } else {
        field += c;
        i++;
      }
    } else if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else if (c === "\r") {
      i++;
    } else {
      field += c;
      i++;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Parse into {header: index} + data rows.
function table(text) {
  const rows = parseCSV(text).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
  if (rows.length === 0) return { col: () => -1, data: [] };
  const header = rows[0];
  const col = (name) => header.indexOf(name);
  return { col, data: rows.slice(1) };
}

function escapeSql(s) {
  if (s == null) return "NULL";
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Unlinked — (origWords, twLink), deduped.
const u = table(readMaybeGz(unlinkedPath));
const uOrig = u.col("origWords");
const uLink = u.col("twLink");
if (uOrig < 0 || uLink < 0) throw new Error("unlinked CSV missing origWords/twLink columns");
const unlinkedSet = new Map(); // key -> [norm, link]
for (const r of u.data) {
  const norm = (r[uOrig] ?? "").trim();
  const link = (r[uLink] ?? "").trim();
  if (!norm || !link) continue;
  unlinkedSet.set(`${norm}|${link}`, [norm, link]);
}
const unlinked = [...unlinkedSet.values()];

// Deleted — (BOOK, reference, normalizedOrigWords), deduped.
const d = table(readMaybeGz(deletedPath));
const dBook = d.col("book");
const dRef = d.col("reference");
const dNorm = d.col("normalizedOrigWords");
if (dBook < 0 || dRef < 0 || dNorm < 0) {
  throw new Error("deleted CSV missing book/reference/normalizedOrigWords columns");
}
const deletedSet = new Map(); // key -> [BOOK, ref, norm]
for (const r of d.data) {
  const book = (r[dBook] ?? "").trim().toUpperCase();
  const ref = (r[dRef] ?? "").trim();
  const norm = (r[dNorm] ?? "").trim();
  if (!book || !ref || !norm) continue;
  deletedSet.set(`${book}|${ref}|${norm}`, [book, ref, norm]);
}
const deleted = [...deletedSet.values()];

console.log(`unlinked: ${unlinked.length} distinct (from ${u.data.length} rows)`);
console.log(`deleted:  ${deleted.length} distinct (from ${d.data.length} rows)`);
if (unlinked.length === 0 && deleted.length === 0) {
  throw new Error("nothing parsed — aborting");
}

const lines = ["DELETE FROM twl_unlinked_words;", "DELETE FROM twl_deleted_rows;"];
const BATCH = 100;
for (let i = 0; i < unlinked.length; i += BATCH) {
  const batch = unlinked.slice(i, i + BATCH);
  lines.push("INSERT OR IGNORE INTO twl_unlinked_words (norm_orig_words, tw_link) VALUES");
  lines.push(batch.map(([n, l]) => `(${escapeSql(n)}, ${escapeSql(l)})`).join(",\n") + ";");
}
for (let i = 0; i < deleted.length; i += BATCH) {
  const batch = deleted.slice(i, i + BATCH);
  lines.push("INSERT OR IGNORE INTO twl_deleted_rows (book, reference, norm_orig_words) VALUES");
  lines.push(batch.map(([b, r, n]) => `(${escapeSql(b)}, ${escapeSql(r)}, ${escapeSql(n)})`).join(",\n") + ";");
}

const sqlPath = join(outDir, "import-twl-filters.sql");
writeFileSync(sqlPath, lines.join("\n") + "\n");
console.log(`wrote ${sqlPath} (${(lines.join("\n").length / 1024).toFixed(0)} KB)`);
