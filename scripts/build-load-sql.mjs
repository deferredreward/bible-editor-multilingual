// Generate the prod-D1 load SQL for the deterministic 2 Kings → Isaiah TN
// migration, from scripts/out/kings-isa/adapt-batch.json. OFFLINE — no network.
//
// Emits scripts/out/kings-isa/load-ISA-36-39.sql:
//   1. Soft-delete existing LIVE notes in each TARGET Isaiah verse (full replace
//      per the user: everything except 37:1-9; skips preserve/hint/trashed as
//      cheap safety). Never touches 37:1-9 or 38:9-20.
//   2. Insert the 236 adapted notes (deterministic ids, source='parallel_migration'
//      in edit_log so a later AI pipeline run won't sweep them; review_kind/reason
//      set on flagged notes → the in-app cleanup chip).
//
// IDs: deterministic via coerceRowId("<kingsId>:<isaRef>:<salt>"), de-duped within
// the batch AND against an optional existing-id exclude list
// (scripts/out/kings-isa/existing-isa-ids.txt, one id per line — fetch from prod
// at apply time so we never collide with a surviving/​tombstoned ISA id).
//
// Run: node scripts/build-load-sql.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Deterministic id minting. NB: rowId.ts's coerceRowId is unsuitable for minting
// MANY ids — its 3 trailing chars are a geometric progression of one hash value
// (mod 31), giving only ~700 distinct outputs, so hundreds of mints collide. We
// mint from INDEPENDENT bit-slices of an FNV-1a hash instead (~23·31³ ≈ 685k
// space), matching the grammar ^[a-z][a-z0-9]{3}$. Stable across re-runs.
const ID_LETTERS = "abcdefghijkmnpqrstuvwxyz"; // 23 (no l/o), matches rowId.ts
const ID_CHARS = ID_LETTERS + "23456789";      // 31
function fnv1a(str) { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0; return h >>> 0; }
function idFromHash(h) {
  return ID_LETTERS[h % ID_LETTERS.length]
    + ID_CHARS[(h >>> 7) % ID_CHARS.length]
    + ID_CHARS[(h >>> 14) % ID_CHARS.length]
    + ID_CHARS[(h >>> 21) % ID_CHARS.length];
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "out/kings-isa");
const MIGRATION_USER = 2; // established data-repair/system user id in prod (see STATE.md heal scripts)

const batch = JSON.parse(readFileSync(resolve(outDir, "adapt-batch.json"), "utf8"));
const notes = batch.notes;

const q = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

// Safety assertion: nothing should target the excluded zones.
const bad = notes.filter((n) => n.isaChapter === 37 && n.isaVerse >= 1 && n.isaVerse <= 9);
if (bad.length) { console.error(`ABORT: ${bad.length} notes target the human-done Isa 37:1-9 zone`, bad.map((b) => b.sourceId)); process.exit(1); }
const bad2 = notes.filter((n) => n.isaChapter === 38 && n.isaVerse >= 9 && n.isaVerse <= 20);
if (bad2.length) { console.error(`ABORT: ${bad2.length} notes target Isaiah-unique Isa 38:9-20`, bad2.map((b) => b.sourceId)); process.exit(1); }

// Deterministic id assignment.
const used = new Set();
const excludeFile = resolve(outDir, "existing-isa-ids.txt");
if (existsSync(excludeFile)) {
  for (const line of readFileSync(excludeFile, "utf8").split(/\r?\n/)) { const s = line.trim(); if (s) used.add(s); }
  console.log(`loaded ${used.size} existing ISA ids to avoid`);
} else {
  console.warn("· no existing-isa-ids.txt — within-batch dedup only; fetch prod ids before applying");
}
function deriveId(kingsId, isaRef) {
  let salt = 0, id;
  do { id = idFromHash(fnv1a(`${kingsId}:${isaRef}:${salt}`)); salt++; if (salt > 10000) throw new Error(`id mint runaway for ${kingsId}:${isaRef}`); } while (used.has(id));
  used.add(id);
  return id;
}

// Target verses (distinct), for the delete side.
const targetVerses = [...new Set(notes.map((n) => `${n.isaChapter}:${n.isaVerse}`))]
  .map((k) => k.split(":").map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

const lines = [];
lines.push("-- 2 Kings 18-20 → Isaiah 36-39 TN migration (deterministic load).");
lines.push(`-- Generated from adapt-batch.json. Sources: UHB(2KI) ${batch.versemap.sourceShas.uhb?.slice(0, 10)}, UHB(ISA) ${batch.versemap.targetShas.uhb?.slice(0, 10)}, TN(2KI) ${batch.versemap.sourceShas.tn?.slice(0, 10)}.`);
lines.push(`-- ${notes.length} notes across ${targetVerses.length} Isaiah verses. NEVER touches 37:1-9 or 38:9-20.`);
lines.push("-- D1 remote: no explicit BEGIN; statements apply sequentially.");
lines.push("");

// 1. Soft-delete existing live notes in target verses (full replace).
lines.push("-- ── replace: soft-delete existing live notes in target verses ──");
for (const [c, v] of targetVerses) {
  lines.push(
    `UPDATE tn_rows SET deleted_at = unixepoch(), version = version + 1, updated_at = unixepoch(), updated_by = ${MIGRATION_USER} ` +
    `WHERE book = 'ISA' AND chapter = ${c} AND verse = ${v} AND deleted_at IS NULL AND trashed_at IS NULL AND preserve = 0 AND hint = 0;`,
  );
}
lines.push("");

// 2. Insert adapted notes + edit_log create (source='parallel_migration').
lines.push("-- ── insert adapted notes ──");
const sortByVerse = {};
let inserted = 0;
for (const n of notes) {
  const isaRef = `${n.isaChapter}:${n.isaVerse}`;
  const id = deriveId(n.sourceId, isaRef);
  const so = (sortByVerse[isaRef] = (sortByVerse[isaRef] || 0) + 100);
  lines.push(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note, sort_order, review_kind, review_reason, updated_by, version, preserve, hint) ` +
    `VALUES (${q(id)}, 'ISA', ${n.isaChapter}, ${n.isaVerse}, ${q(isaRef)}, ${q(n.tags)}, ${q(n.support_reference)}, ${q(n.quote)}, ${q(n.occurrence)}, ${q(n.note)}, ${so}, ${q(n.review_kind)}, ${q(n.review_reason)}, ${MIGRATION_USER}, 1, 0, 0);`,
  );
  const payload = {
    book: "ISA", chapter: n.isaChapter, verse: n.isaVerse, ref_raw: isaRef,
    tags: n.tags, support_reference: n.support_reference, quote: n.quote,
    occurrence: n.occurrence, note: n.note,
    migrated_from: { book: "2KI", ref: n.sourceRef, id: n.sourceId },
  };
  lines.push(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, payload_json) ` +
    `VALUES ('tn', ${q(id)}, 'ISA', ${MIGRATION_USER}, NULL, 1, 'create', 'parallel_migration', ${q(JSON.stringify(payload))});`,
  );
  inserted++;
}

const outPath = resolve(outDir, "load-ISA-36-39.sql");
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`wrote ${outPath}`);
console.log(`  delete statements: ${targetVerses.length} target verses`);
console.log(`  insert: ${inserted} notes (+${inserted} edit_log rows)`);
console.log(`  total SQL statements: ${targetVerses.length + inserted * 2}`);
