import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Synthetic RTL fixture for the direction-guard spec (rtl-direction.spec.ts,
// issue #293). The seed applied in globalSetup below does three things: pins the
// workspace to the `en-unfoldingword` preset (so the ULT/UST scripture lanes are
// actually served — see the seed comment), and overwrites ONE ZEC verse's ULT
// plain_text with the Arabic string here so the flows notes/questions lanes have
// real right-to-left content while the UST lane stays English — a mixed screen to
// assert both `rtl` and `ltr` on. ZEC 6:1 is chosen because it already carries
// both a tn note and a tq question in the sample bundle, so both flows surfaces
// have a row to select. Only ULT plain_text is rewritten (not content_json), and
// the Hebrew UHB original — which the classic + book-view surfaces render RTL by
// script (versionIsRtl) — is left completely alone.
export const RTL_FIXTURE = {
  book: "ZEC",
  chapter: 6,
  verse: 1,
  // "This is Arabic text for testing the text direction." — a distinctive,
  // first-strong-RTL string so `dir="auto"` resolves the lane to rtl.
  arabicUlt: "هَٰذَا نَصٌّ عَرَبِيٌّ لِاخْتِبَارِ ٱتِّجَاهِ ٱلنَّصِّ.",
} as const;

// Runs once before any test. Re-imports ZEC from docs/samples into the local
// D1 instance so every test starts against a known fixture. We pick ZEC
// because the sample bundle already has its full TN/TQ/TWL/USFM set, and the
// importer is idempotent (REPLACE INTO + DELETE WHERE book='ZEC') so re-runs
// are safe.
//
// The webServer (api + web) is started by Playwright *after* this finishes,
// so we're free to write the SQLite file directly via `wrangler d1 execute`.
export default async function globalSetup() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../..");
  const sqlPath = resolve(repoRoot, "scripts/out/import-ZEC.sql");

  if (!existsSync(sqlPath)) {
    console.log("[setup] generating ZEC import SQL…");
    const gen = spawnSync("node", ["scripts/import-book.mjs", "ZEC"], {
      cwd: repoRoot,
      stdio: "inherit",
      shell: true,
    });
    if (gen.status !== 0) {
      throw new Error(`import-book.mjs ZEC failed with exit ${gen.status}`);
    }
  }

  console.log("[setup] applying ZEC import to local D1…");
  // wrangler d1 execute on Windows needs the .cmd shim; spawnSync with
  // shell:true picks it up automatically and avoids ENOENT.
  const apply = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      // The default (non-production) env's D1 is `bible_editor_dev` since the
      // dev/prod database split — the local SQLite store wrangler dev uses.
      // Seeding `bible_editor` (the prod name) would target the wrong/no DB.
      "bible_editor_dev",
      "--local",
      `--file=${sqlPath}`,
    ],
    {
      cwd: resolve(repoRoot, "api"),
      stdio: "inherit",
      shell: true,
    },
  );
  if (apply.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed (status ${apply.status}). ` +
        "Have migrations been applied? Try `npm --workspace api run db:migrate:local` first.",
    );
  }

  // Seed the synthetic Arabic ULT verse for the RTL direction guard (#293).
  // Written to a SQL file (rather than passed inline) so the Arabic string is
  // never split/mangled by the shell. Runs AFTER the ZEC import so it wins.
  console.log("[setup] seeding RTL fixture verse…");
  const seedSqlPath = resolve(repoRoot, "scripts/out/seed-rtl-fixture.sql");
  const esc = RTL_FIXTURE.arabicUlt.replace(/'/g, "''");
  writeFileSync(
    seedSqlPath,
    // Pin the test workspace to the standard English uW project (the canonical
    // authoring setup for a Hebrew book like ZEC). Without a project_config row
    // the env falls back to the `ar-bsoj` preset, which DELIBERATELY quarantines
    // the ULT/UST lanes (replacement_required) pending an AVD/NAV replacement, so
    // the chapter API serves only the Hebrew UHB and the scripture panes have no
    // target text to assert direction on. `en-unfoldingword` is LTR and does not
    // quarantine — the normal post-setup working state, inert to the note-only
    // specs (which never touch scripture lanes).
    `INSERT INTO project_config (id, preset, overrides_json, updated_at) ` +
      `VALUES (1, 'en-unfoldingword', NULL, unixepoch()) ` +
      `ON CONFLICT(id) DO UPDATE SET preset = 'en-unfoldingword', ` +
      `overrides_json = NULL, updated_at = unixepoch();\n` +
      // Drop any pre-existing lane rows so ensureLaneState recreates them under
      // the en preset with replacement_required = 0 (its INSERT OR IGNORE never
      // resets an existing row, so a stale ar-bsoj-quarantined row would linger).
      `DELETE FROM scripture_lane_state WHERE lane IN ('lit', 'sim');\n` +
      // Overwrite ONE ULT verse with Arabic so the `dir="auto"` flows lanes have
      // real RTL content to render, while UST stays English for the `ltr` half.
      `UPDATE verses SET plain_text = '${esc}' ` +
      `WHERE book = '${RTL_FIXTURE.book}' AND chapter = ${RTL_FIXTURE.chapter} ` +
      `AND verse = ${RTL_FIXTURE.verse} AND bible_version = 'ULT';\n`,
  );
  const seed = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "bible_editor_dev", "--local", `--file=${seedSqlPath}`],
    { cwd: resolve(repoRoot, "api"), stdio: "inherit", shell: true },
  );
  if (seed.status !== 0) {
    throw new Error(`RTL fixture seed failed (status ${seed.status}).`);
  }

  console.log("[setup] complete");
}
