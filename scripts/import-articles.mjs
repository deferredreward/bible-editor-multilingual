// Importer for translatable tW + tA markdown ARTICLE CONTENT into article_units
// (migration 0039). Unlike import-tw.mjs (which rebuilds the tw_articles catalog
// destructively), this NEVER deletes: it upserts source_md/source_sha and leaves
// target_md / translation_state / version-of-a-translated-row untouched, because
// the translation is precious.
//
// Mirrors import-tw.mjs: ONE archive download per repo (no per-file fetch, no npm
// zip dep — extraction shells out to the OS), walk, emit SQL.
//
// Run:
//   node scripts/import-articles.mjs
// Then apply (local dev):
//   (cd api && npx wrangler d1 execute bible_editor_dev --local --file=../scripts/out/import-articles.sql)
// Prod:
//   (cd api && npx wrangler d1 execute bible_editor --remote --env production --file=../scripts/out/import-articles.sql)
//
// path / article_id / part conventions match the bot's deriveArticleId:
//   tW: bible/kt/god.md            → article_id 'kt/god',              part 'body'
//   tA: translate/figs-aside/01.md → article_id 'translate/figs-aside', part 'body'
//       translate/figs-aside/title.md → same article_id, part 'title'
//       translate/figs-aside/sub-title.md → same article_id, part 'sub-title'

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  statSync,
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
  { resource: "tw", repo: "en_tw", archiveRoot: "en_tw" },
  { resource: "ta", repo: "en_ta", archiveRoot: "en_ta" },
];
const TW_CATEGORIES = ["kt", "names", "other"];
const TA_MANUALS = ["translate", "checking", "process", "intro"];
const TA_PART_BY_FILE = { "01.md": "body", "title.md": "title", "sub-title.md": "sub-title" };

function extractZip(zipPath, destDir) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force"`,
      { stdio: "inherit" },
    );
  } else {
    execSync(`unzip -oq "${zipPath}" -d "${destDir}"`, { stdio: "inherit" });
  }
}

async function downloadAndExtract(repo, archiveRoot) {
  const zipPath = join(tmpDir, `${repo}.zip`);
  const url = `https://git.door43.org/unfoldingWord/${repo}/archive/master.zip`;
  if (!existsSync(zipPath)) {
    console.log(`  downloading ${url} ...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  } else {
    console.log(`  reusing cached ${zipPath}`);
  }
  const extractDir = join(tmpDir, repo);
  if (!existsSync(join(extractDir, archiveRoot))) {
    console.log(`  extracting ${zipPath} ...`);
    extractZip(zipPath, extractDir);
  } else {
    console.log(`  reusing extracted ${extractDir}`);
  }
  return join(extractDir, archiveRoot);
}

// git blob sha1 (matches DCS blob shas): sha1("blob {bytelen}\0{content}").
function gitBlobSha(buf) {
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

function escapeSql(s) {
  if (s == null) return "NULL";
  return `'${String(s).replace(/'/g, "''")}'`;
}

// { resource, path, article_id, part, source_md, source_sha }
function collectTw(root) {
  const units = [];
  const bibleDir = join(root, "bible");
  if (!existsSync(bibleDir)) throw new Error(`expected ${bibleDir} in en_tw archive`);
  for (const category of TW_CATEGORIES) {
    const dir = join(bibleDir, category);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      const slug = f.replace(/\.md$/, "");
      const buf = readFileSync(join(dir, f));
      units.push({
        resource: "tw",
        path: `bible/${category}/${f}`,
        article_id: `${category}/${slug}`,
        part: "body",
        source_md: buf.toString("utf-8"),
        source_sha: gitBlobSha(buf),
      });
    }
  }
  return units;
}

function collectTa(root) {
  const units = [];
  for (const manual of TA_MANUALS) {
    const manualDir = join(root, manual);
    if (!existsSync(manualDir)) continue;
    for (const article of readdirSync(manualDir)) {
      const artDir = join(manualDir, article);
      if (!statSync(artDir).isDirectory()) continue;
      for (const f of readdirSync(artDir).filter((x) => x.endsWith(".md"))) {
        const part = TA_PART_BY_FILE[f];
        if (!part) continue; // ignore stray .md files; only body/title/sub-title
        const buf = readFileSync(join(artDir, f));
        units.push({
          resource: "ta",
          path: `${manual}/${article}/${f}`,
          article_id: `${manual}/${article}`,
          part,
          source_md: buf.toString("utf-8"),
          source_sha: gitBlobSha(buf),
        });
      }
    }
  }
  return units;
}

(async () => {
  const all = [];
  for (const src of SOURCES) {
    console.log(`${src.repo}:`);
    const root = await downloadAndExtract(src.repo, src.archiveRoot);
    const units = src.resource === "tw" ? collectTw(root) : collectTa(root);
    console.log(`  ${units.length} ${src.resource} units`);
    all.push(...units);
  }
  all.sort((a, b) => (a.resource + a.path).localeCompare(b.resource + b.path));
  console.log(`total article units: ${all.length}`);
  if (all.length === 0) throw new Error("no article units parsed — aborting");

  // Upsert preserving target_md / translation_state; bump version only when the
  // source actually changed. NEVER DELETE — a translation must survive reimport.
  const sqlPath = join(outDir, "import-articles.sql");
  const lines = [];
  const BATCH = 50; // articles are large; keep statements small for the applier
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    lines.push(
      "INSERT INTO article_units (resource, path, article_id, part, source_md, source_sha) VALUES",
    );
    lines.push(
      batch
        .map(
          (u) =>
            `(${escapeSql(u.resource)}, ${escapeSql(u.path)}, ${escapeSql(u.article_id)}, ${escapeSql(u.part)}, ${escapeSql(u.source_md)}, ${escapeSql(u.source_sha)})`,
        )
        .join(",\n"),
    );
    lines.push(
      "ON CONFLICT(resource, path) DO UPDATE SET" +
        " source_md = excluded.source_md, source_sha = excluded.source_sha," +
        " version = version + 1, updated_at = unixepoch()" +
        " WHERE article_units.source_sha IS NOT excluded.source_sha;",
    );
  }
  writeFileSync(sqlPath, lines.join("\n") + "\n");
  console.log(`wrote ${sqlPath} (${(lines.join("\n").length / 1024 / 1024).toFixed(1)} MB)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
