// One-shot importer for UHAL (Unlocked Hebrew/Aramaic Lexicon) and UGL
// (Unlocked Greek Lexicon) from Door43 Content Service. Downloads each
// archive as a single zip, parses the per-Strong's markdown files, and
// emits a SQL file that targets the lexicon_entries table.
//
// Run:
//   node scripts/import-lexicon.mjs
// Then apply:
//   (cd api && npx wrangler d1 execute bible_editor --local --file=../scripts/out/import-lexicon.sql)
//
// Each entry stores: strong (e.g. "H2320"), resource ("uhal" / "ugl"),
// lemma (Hebrew/Greek wordform), part_of_speech, gloss (terse, shown in
// tooltip), and definition (longer paragraph). Source format is documented
// at https://ugl-info.readthedocs.io/en/latest/markdown.html and uses a
// shared ## Word data / ## Senses structure between the two lexica.

import { execSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const tmpDir = join(repoRoot, "scripts", "tmp");
const outDir = join(repoRoot, "scripts", "out");

mkdirSync(tmpDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const SOURCES = [
  {
    resource: "uhal",
    url: "https://git.door43.org/unfoldingWord/en_uhal/archive/master.zip",
    archiveRoot: "en_uhal",
  },
  {
    resource: "ugl",
    url: "https://git.door43.org/unfoldingWord/en_ugl/archive/master.zip",
    archiveRoot: "en_ugl",
  },
];

async function downloadAndExtract(url, archiveRoot, resource) {
  const zipPath = join(tmpDir, `${resource}.zip`);
  if (!existsSync(zipPath)) {
    console.log(`  downloading ${url} ...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(zipPath, buf);
  } else {
    console.log(`  reusing cached ${zipPath}`);
  }
  const extractDir = join(tmpDir, resource);
  if (!existsSync(join(extractDir, archiveRoot))) {
    mkdirSync(extractDir, { recursive: true });
    console.log(`  extracting ${zipPath} ...`);
    execSync(`tar -xf "${zipPath}" -C "${extractDir}"`, { stdio: "inherit" });
  } else {
    console.log(`  reusing extracted ${extractDir}`);
  }
  return join(extractDir, archiveRoot);
}

// --- markdown parser shared by UHAL and UGL ----------------------------------

// Pull a `* Field: value` bullet whose value sits either inline or on the
// following indented line(s). Returns the first non-empty line of value.
function bulletValue(text, field) {
  const lineMatch = text.match(
    new RegExp(`^\\*\\s+${field}\\s*:\\s*(.*)$`, "im"),
  );
  if (!lineMatch) return null;
  const inline = (lineMatch[1] ?? "").trim();
  if (inline) return inline;
  // Spec puts some values on the next line(s). Look ahead for the next
  // non-blank non-bullet line.
  const start = (lineMatch.index ?? 0) + lineMatch[0].length;
  const rest = text.slice(start);
  const next = rest.match(/\n+([^\n*#][^\n]*)/);
  return next ? next[1].trim() : null;
}

// Lift the first Sense's Glosses + Definition + Explanation. We squash to
// single lines, strip markdown links, and clamp lengths so the tooltip and
// transport payload stay compact.
function senseOne(text) {
  const m = text.match(/###\s+Sense\s+1\.0:?([\s\S]*?)(?=###\s+Sense|\Z)/i);
  if (!m) return { gloss: null, definition: null };
  const body = m[1];
  const grab = (name, max) => {
    const r = new RegExp(
      `####\\s+${name}\\s*:?\\s*([\\s\\S]*?)(?=^####|\\Z)`,
      "im",
    );
    const mm = body.match(r);
    if (!mm) return null;
    let v = mm[1]
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!v) return null;
    if (v.length > max) v = v.slice(0, max - 1) + "…";
    return v;
  };
  return {
    gloss: grab("Glosses", 200),
    definition: grab("Definition", 600) || grab("Explanation", 600),
  };
}

function parseEntry(text, fallbackStrong) {
  const lemmaM = text.match(/^#\s+(.+?)\s*$/m);
  const lemma = lemmaM ? lemmaM[1].trim() : null;
  let strong = bulletValue(text, "Strongs?");
  if (strong) strong = strong.replace(/[.,;]$/, "");
  if (!strong || !/^[HG]\d+/i.test(strong)) strong = fallbackStrong;
  let pos = bulletValue(text, "Part of Speech");
  // Strip markdown links and dot-trailing.
  if (pos) {
    pos = pos.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[.,;]+$/, "").trim();
  }
  const { gloss, definition } = senseOne(text);
  return { strong, lemma, part_of_speech: pos, gloss, definition };
}

function walkUhal(rootDir) {
  const contentDir = join(rootDir, "content");
  const out = [];
  const files = readdirSync(contentDir).filter((f) => /^H\d+\.md$/i.test(f));
  for (const f of files) {
    const fileStrong = `H${parseInt(f.slice(1), 10)}`; // H0001.md → H1
    const text = readFileSync(join(contentDir, f), "utf-8");
    const e = parseEntry(text, fileStrong);
    // Normalize the parsed strong too (drop leading zeros / prefix).
    if (e.strong) {
      const m = e.strong.match(/[HG]\d+/i);
      if (m) e.strong = m[0].toUpperCase().replace(/^H0+/, "H").replace(/^G0+/, "G");
    }
    if (!e.strong) e.strong = fileStrong;
    e.resource = "uhal";
    out.push(e);
  }
  return out;
}

function walkUgl(rootDir) {
  const contentDir = join(rootDir, "content");
  const out = [];
  const dirs = readdirSync(contentDir).filter((d) => /^G\d+$/i.test(d));
  for (const d of dirs) {
    const dirPath = join(contentDir, d);
    const file = join(dirPath, "01.md");
    if (!existsSync(file)) continue;
    // UGL "Strong's-Plus" id: directory is the classic Strong's * 10, zero
    // padded to 5 digits. So G00010 = G1, G25600 = G2560. The bullet inside
    // each file also uses the Strong's-Plus form, but our USFM source words
    // carry classic Strong's — derive that from the dirname and ignore the
    // in-file value.
    const num = parseInt(d.slice(1), 10);
    const fileStrong = Number.isFinite(num) ? `G${Math.floor(num / 10)}` : d;
    const text = readFileSync(file, "utf-8");
    const e = parseEntry(text, fileStrong);
    e.strong = fileStrong;
    e.resource = "ugl";
    out.push(e);
  }
  return out;
}

function escapeSql(s) {
  if (s == null) return "NULL";
  return `'${String(s).replace(/'/g, "''")}'`;
}

(async () => {
  const all = [];
  for (const src of SOURCES) {
    console.log(`processing ${src.resource}`);
    const dir = await downloadAndExtract(src.url, src.archiveRoot, src.resource);
    const entries = src.resource === "uhal" ? walkUhal(dir) : walkUgl(dir);
    console.log(`  parsed ${entries.length} entries`);
    all.push(...entries);
  }
  console.log(`total: ${all.length} entries`);
  const nonEmpty = all.filter((e) => e.gloss || e.definition || e.part_of_speech);
  console.log(`  ${nonEmpty.length} have at least one of gloss/definition/POS`);

  const sqlPath = join(outDir, "import-lexicon.sql");
  const lines = [];
  lines.push("DELETE FROM lexicon_entries;");
  const BATCH = 100;
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    lines.push(
      "INSERT OR REPLACE INTO lexicon_entries (strong, resource, lemma, part_of_speech, gloss, definition) VALUES",
    );
    const values = batch.map(
      (e) =>
        `(${escapeSql(e.strong)}, ${escapeSql(e.resource)}, ${escapeSql(e.lemma)}, ${escapeSql(e.part_of_speech)}, ${escapeSql(e.gloss)}, ${escapeSql(e.definition)})`,
    );
    lines.push(values.join(",\n") + ";");
  }
  writeFileSync(sqlPath, lines.join("\n") + "\n");
  console.log(`wrote ${sqlPath} (${(lines.join("\n").length / 1024 / 1024).toFixed(1)} MB)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
