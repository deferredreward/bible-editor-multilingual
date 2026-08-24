// Tests for snapshotPrUrl (Door43 PR link derivation on GET /api/exports).
// Run from api/:
//   node --experimental-strip-types --no-warnings src/exportPrUrl.test.mjs
// Not a framework; failures exit non-zero. Mirrors export.test.mjs.

import { snapshotPrUrl } from "./exportPrUrl.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

assert(
  snapshotPrUrl("https://git.door43.org", { owner: "BSOJ", repo: "ar_tn" }, 12) ===
    "https://git.door43.org/BSOJ/ar_tn/pulls/12",
  "assembles the Gitea web PR URL",
);

assert(
  snapshotPrUrl("https://git.door43.org/", { owner: "BSOJ", repo: "ar_tn" }, 12) ===
    "https://git.door43.org/BSOJ/ar_tn/pulls/12",
  "trailing slash on the base URL does not double up",
);

assert(snapshotPrUrl("https://git.door43.org", { owner: "o", repo: "r" }, null) === null,
  "no pr_number -> null");

assert(snapshotPrUrl("https://git.door43.org", null, 5) === null,
  "unknown destination (e.g. lane export disabled) -> null");

assert(snapshotPrUrl(undefined, { owner: "o", repo: "r" }, 5) === null,
  "missing base URL -> null");

assert(
  snapshotPrUrl("https://git.door43.org", { owner: "a b", repo: "r/x" }, 3) ===
    "https://git.door43.org/a%20b/r%2Fx/pulls/3",
  "owner/repo are URL-encoded",
);

if (failed > 0) {
  console.error(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("exportPrUrl.test.mjs: all assertions passed");
