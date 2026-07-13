// Unit tests for buildTranslateOptions (translateOptions.ts).
//
// The load-bearing regression this guards: the live bot FAILS a translate run
// when the caller supplies a contextRef whose repo has no content files
// (BIBLE-EDITOR-INTEGRATION.md §4). The editor used to auto-derive+send
// `${org}/translation-context@master` unconditionally, so every live run against
// a not-yet-populated context repo would fail. contextRef is now opt-in: absent
// by default (bot proceeds as raw baseline), present only when a caller passes it.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/translateOptions.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { buildTranslateOptions } from "./translateOptions.ts";
import { PRESETS } from "./projectConfig.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const arBsoj = PRESETS["ar-bsoj"];
const enRoot = PRESETS["en-unfoldingword"];

console.log("[buildTranslateOptions] default (no overrides), ar-bsoj");
{
  const opts = buildTranslateOptions(arBsoj, undefined);
  assert(opts !== null, "GL project returns options (not null)");
  assert(opts.targetLang === "ar", "targetLang derived from config languageCode");
  assert(opts.targetOrg === "BSOJ", "targetOrg derived from config exportOrg");
  assert(
    opts.sourceRef === "unfoldingWord/en_tn@master",
    "sourceRef points at the published EN tN (translate FROM English)",
  );
  assert(
    !("contextRef" in opts),
    "contextRef is OMITTED by default — the §4 guard fix (no auto-derive)",
  );
  assert(opts.delivery === "branch", "delivery defaults to branch");
  assert(opts.branchOnly === true, "branchOnly defaults to true");
  assert(opts.model === "opus", "model defaults to opus");
  assert(opts.direction === "rtl", "direction derived from config (ar → rtl)");
  assert(!("rowIds" in opts), "rowIds absent when not requested");
  assert(!("verseStart" in opts), "verseStart absent when not requested");
}

console.log("[buildTranslateOptions] explicit contextRef override → included");
{
  const opts = buildTranslateOptions(arBsoj, {
    contextRef: "BSOJ/translation-context@master",
  });
  assert(
    opts.contextRef === "BSOJ/translation-context@master",
    "contextRef included verbatim when the caller passes it (assisted mode)",
  );
}

console.log("[buildTranslateOptions] other overrides fold in");
{
  const opts = buildTranslateOptions(arBsoj, {
    model: "sonnet",
    delivery: "path",
    rowIds: ["xm1w", "ab2c"],
    verseStart: 3,
    verseEnd: 5,
    sourceRef: "unfoldingWord/en_tn@abc1234",
    targetOrg: "OtherOrg",
  });
  assert(opts.model === "sonnet", "model override applied");
  assert(opts.delivery === "path", "delivery override applied");
  assert(Array.isArray(opts.rowIds) && opts.rowIds.length === 2, "rowIds folded in");
  assert(opts.verseStart === 3 && opts.verseEnd === 5, "verse range folded in");
  assert(opts.sourceRef === "unfoldingWord/en_tn@abc1234", "sourceRef override (pinned SHA)");
  assert(opts.targetOrg === "OtherOrg", "targetOrg override applied");
  assert(!("contextRef" in opts), "contextRef still omitted when not overridden");
}

console.log("[buildTranslateOptions] English root project → null (not_a_gl_project)");
{
  const opts = buildTranslateOptions(enRoot, undefined);
  assert(opts === null, "translationSource=null → null (caller turns into 400)");
}

console.log("\ntranslateOptions: all assertions passed");
