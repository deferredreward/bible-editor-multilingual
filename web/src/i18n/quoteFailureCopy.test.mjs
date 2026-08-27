// Regression guard for #346 item 1: the tn-quick "couldn't align the quote"
// copy must be script/lane-neutral. `built.error.reason === "hebrew_not_found"`
// fires for BOTH original-language (Hebrew/Greek) quotes and English quotes
// (web/src/lib/tnQuickRequest.ts), so the message rendered at every call site
// must not give English-/ULT-specific advice ("this English", "copy … from
// ULT") — for an OL quote that advice is not actionable. The three call sites:
//   - web/src/components/Shell.tsx            → appShell.shell.aiHebrewNotFound
//   - web/src/components/ReviewQueue.tsx      → flowReview.queue.quoteNotAligned
//   - web/src/components/flows/TranslateNotesScreen.tsx → flowTranslate.quoteMatchFailed
// The third was already label-parameterized/generic; this guards the other two
// (and keeps the third generic) so the English/ULT wording can't creep back.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings src/i18n/quoteFailureCopy.test.mjs

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const en = JSON.parse(readFileSync(resolve(__dirname, "locales/en.json"), "utf8"));
const ar = JSON.parse(readFileSync(resolve(__dirname, "locales/ar.json"), "utf8"));

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// The two OL-failure call-site strings that used to hardcode English/ULT advice.
const neutralKeys = [
  ["appShell.shell.aiHebrewNotFound", (o) => o.appShell?.shell?.aiHebrewNotFound],
  ["flowReview.queue.quoteNotAligned", (o) => o.flowReview?.queue?.quoteNotAligned],
];

for (const [name, get] of neutralKeys) {
  const enVal = get(en);
  assert(typeof enVal === "string" && enVal.length > 0, `en ${name} present`);
  // Script-neutral: must not name a specific gateway language or the ULT lane —
  // the same reason code covers Hebrew/Greek and English quotes alike.
  assert(!/\bULT\b/.test(enVal), `en ${name} does not name "ULT" (got ${JSON.stringify(enVal)})`);
  assert(!/\bEnglish\b/.test(enVal), `en ${name} does not name "English" (got ${JSON.stringify(enVal)})`);
  const arVal = get(ar);
  assert(typeof arVal === "string" && arVal.length > 0, `ar ${name} present`);
  assert(!/ULT/.test(arVal), `ar ${name} does not name "ULT" (got ${JSON.stringify(arVal)})`);
}

// The third call site was already the generic, label-parameterized variant —
// keep it that way (still interpolates the lane label rather than hardcoding).
for (const [label, o] of [["en", en], ["ar", ar]]) {
  const v = o.flowTranslate?.quoteMatchFailed;
  assert(typeof v === "string" && v.length > 0, `${label} flowTranslate.quoteMatchFailed present`);
  assert(v.includes("{{label}}"), `${label} flowTranslate.quoteMatchFailed stays label-parameterized (got ${JSON.stringify(v)})`);
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll quote-failure copy checks passed.");
