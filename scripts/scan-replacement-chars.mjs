// Scan stored verses for U+FFFD REPLACEMENT CHARACTERs in `\zaln-s` alignment
// source attributes (x-content / x-lemma / x-morph) and repair them from the
// parallel original-language source (UHB / UGNT).
//
// These are AI-generation defects: the aligner mangled a multi-byte Hebrew vowel
// / cantillation mark / consonant into one or more U+FFFD (a UTF-8 round-trip
// bug). The garble round-tripped out to door43 master and flows back in through
// the nightly reimport, so e.g. HOS 8:4 UST "gold" renders as וּזְה❖❖בָם.
//
// The repair is the SAME shared helper the Worker now runs at import time
// (api/src/importParsers.ts: healReplacementChars) — script and runtime can't
// diverge. It is structure-preserving: only the corrupt attribute string is
// rewritten, reconstructed from the source word that shares the milestone's
// Strong's number and has the surviving (non-FFFD) characters as a subsequence.
// No node/`\w`/occurrence is touched, so no word can unalign. Ambiguous /
// unmatched attributes are LEFT AS-IS and reported (never guessed).
//
// Workflow:
//   1. Dump verses to JSON (run from api/):
//        npx wrangler d1 execute bible_editor --remote --env production \
//          --command "SELECT book,chapter,verse,bible_version,content_json,version FROM verses" \
//          --json > ../scripts/out/verses-dump.json
//      (local dev: bible_editor_dev --local). A dump scoped to the affected
//      verses + their UHB/UGNT siblings is enough; pairing is by book/ch/verse.
//   2. Scan (report only):
//        node --experimental-strip-types --no-warnings scripts/scan-replacement-chars.mjs scripts/out/verses-dump.json
//   3. Emit repair SQL for flagged verses:
//        node --experimental-strip-types --no-warnings scripts/scan-replacement-chars.mjs scripts/out/verses-dump.json --repair
//      → scripts/out/repair-replacement-chars.sql   (apply with wrangler d1 execute --file=…)
//
// Optional: limit to one book with BOOK=HOS.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSourceWords, healReplacementChars } from "../api/src/importParsers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const dumpPath = process.argv[2];
const doRepair = process.argv.includes("--repair");
const onlyBook = (process.env.BOOK ?? "").toUpperCase() || null;
if (!dumpPath) {
  console.error("usage: node scripts/scan-replacement-chars.mjs <verses-dump.json> [--repair]");
  process.exit(1);
}

// wrangler --json wraps results as [{ results: [...] }] (or sometimes a bare
// array). Normalize to the row array.
function loadRows(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(raw) && raw[0]?.results) return raw.flatMap((r) => r.results ?? []);
  if (Array.isArray(raw)) return raw;
  if (raw?.results) return raw.results;
  throw new Error("unrecognized dump shape");
}

const rows = loadRows(dumpPath);

// Index every verse by book/chapter/verse for source pairing.
const byKey = new Map(); // `${book}/${ch}/${v}` -> { [version]: row }
for (const r of rows) {
  const k = `${r.book}/${r.chapter}/${r.verse}`;
  if (!byKey.has(k)) byKey.set(k, {});
  byKey.get(k)[r.bible_version] = r;
}

function sourceWordsFor(peers) {
  const src = peers.UHB ?? peers.UGNT;
  if (!src) return [];
  try {
    return collectSourceWords(JSON.parse(src.content_json)?.verseObjects ?? []);
  } catch {
    return [];
  }
}

const TARGET_VERSIONS = new Set(["ULT", "UST", "GLT", "GST"]);
const flagged = []; // { book, chapter, verse, version, repaired, newContent }
const unrepairedRows = []; // { ref, unrepaired }

for (const r of rows) {
  if (!TARGET_VERSIONS.has(r.bible_version)) continue;
  if (onlyBook && r.book !== onlyBook) continue;
  if (!r.content_json.includes("�")) continue;
  let content;
  try {
    content = JSON.parse(r.content_json);
  } catch {
    continue;
  }
  if (!Array.isArray(content?.verseObjects)) continue;

  const srcWords = sourceWordsFor(byKey.get(`${r.book}/${r.chapter}/${r.verse}`) ?? {});
  const report = healReplacementChars(content.verseObjects, srcWords);

  if (report.unrepaired.length > 0) {
    unrepairedRows.push({ ref: `${r.book} ${r.chapter}:${r.verse} ${r.bible_version}`, unrepaired: report.unrepaired });
  }
  if (report.repaired.length > 0) {
    const newContent = JSON.stringify(content);
    if (newContent !== r.content_json) {
      flagged.push({ book: r.book, chapter: r.chapter, verse: r.verse, version: r.bible_version, repaired: report.repaired, newContent });
    }
  }
}

// ─── Report ────────────────────────────────────────────────────────────────
console.log(`\nScanned ${rows.length} verse rows${onlyBook ? ` (book=${onlyBook})` : ""}.\n`);
console.log(`Flagged ${flagged.length} verse(s) with repairable U+FFFD source attributes:`);
for (const f of flagged) {
  const summary = f.repaired.map((c) => `${c.attr}[${c.strong}] ${JSON.stringify(c.from)}→${JSON.stringify(c.to)}`).join(", ");
  console.log(`  ${f.book} ${f.chapter}:${f.verse} ${f.version}  ${summary}`);
}
if (unrepairedRows.length > 0) {
  console.log(`\n⚠ ${unrepairedRows.length} verse(s) had U+FFFD that could NOT be unambiguously repaired (left as-is):`);
  for (const u of unrepairedRows) console.log(`  ${u.ref}: ${JSON.stringify(u.unrepaired)}`);
} else {
  console.log(`\nNo ambiguous / unmatched U+FFFD — every defect resolved to a single clean source value. ✓`);
}

// ─── Repair ──────────────────────────────────────────────────────────────────
if (doRepair && flagged.length > 0) {
  const q = (v) => {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  const now = Math.floor(Date.now() / 1000);
  const lines = [
    `-- Repair AI-mangled U+FFFD in alignment source attributes. Generated ${new Date().toISOString()}`,
    `-- ${flagged.length} verse(s). Reconstructs \\zaln-s x-content/x-lemma/x-morph from the parallel`,
    `-- UHB/UGNT source word, bumps version (stale-client refetch), and logs an edit_log row.`,
    `-- Structure-preserving: only attribute strings change, so nothing unaligns.`,
    `-- No BEGIN/COMMIT: remote D1 rejects explicit transactions and wraps the file atomically itself.`,
  ];
  for (const f of flagged) {
    const key = `${f.book}/${f.chapter}/${f.verse}/${f.version}`;
    lines.push(
      `UPDATE verses SET content_json = ${q(f.newContent)}, version = version + 1, updated_at = ${now}`,
      ` WHERE book = ${q(f.book)} AND chapter = ${q(f.chapter)} AND verse = ${q(f.verse)} AND bible_version = ${q(f.version)};`,
      `INSERT INTO edit_log (kind, row_key, prev_version, new_version, action, payload_json)`,
      `  SELECT 'verse', ${q(key)}, version - 1, version, 'heal-replacement-chars', ${q(f.newContent)}`,
      `    FROM verses WHERE book = ${q(f.book)} AND chapter = ${q(f.chapter)} AND verse = ${q(f.verse)} AND bible_version = ${q(f.version)};`,
    );
  }
  const outDir = resolve(repoRoot, "scripts/out");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "repair-replacement-chars.sql");
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  console.log(`\nWrote repair SQL for ${flagged.length} verse(s): ${outPath}`);
}
