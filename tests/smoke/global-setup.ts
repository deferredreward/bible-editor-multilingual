import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The actual empty-DB wipe + migration runs inside scripts/dev-smoke.mjs,
// BEFORE it spawns `wrangler dev` — not here. Playwright's own runner
// (createGlobalSetupTasks in node_modules/playwright/lib/runner/index.js)
// starts webServer plugins (dev-smoke.mjs, waited on until its readiness URL
// responds) BEFORE running the config's globalSetup file, the opposite of
// what this file's original design assumed. By the time this function runs,
// wrangler dev already holds the --persist-to SQLite file open for the rest
// of the suite, so attempting the directory delete here EPERMs every time
// (confirmed empirically, not just a transient race — see the smoke suite's
// PR description).
//
// This file still runs a migrations-apply as a low-cost idempotent sanity
// check: SQLite tolerates a second connection for a quick DDL-ledger check
// (unlike a directory delete, which needs exclusive access), so it's a safe,
// redundant confirmation that the schema dev-smoke.mjs applied is actually
// current — not the source of the empty-DB guarantee.
export default async function globalSetup() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../..");
  const persistTo = process.env.SMOKE_PERSIST || "C:/be-smoke";

  console.log("[smoke-setup] verifying migrations are current (dev-smoke.mjs already wiped + migrated)…");
  const apply = spawnSync(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "bible_editor_dev", "--local", "--persist-to", persistTo],
    {
      cwd: resolve(repoRoot, "api"),
      stdio: "inherit",
      shell: true,
    },
  );
  if (apply.status !== 0) {
    throw new Error(`wrangler d1 migrations apply failed (status ${apply.status}).`);
  }

  console.log("[smoke-setup] complete");
}
