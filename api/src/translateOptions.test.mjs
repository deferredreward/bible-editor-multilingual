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
  assert(opts.delivery === "editor", "delivery defaults to editor (bot never pushes to Door43)");
  assert(opts.branchOnly === true, "branchOnly defaults to true");
  assert(opts.model === "opus", "model defaults to opus");
  assert(opts.direction === "rtl", "direction derived from config (ar → rtl)");
  assert(!("rowIds" in opts), "rowIds absent when not requested");
  assert(!("verseStart" in opts), "verseStart absent when not requested");
  assert(
    opts.literalRef === "BSOJ/ar_avd@master",
    "literalRef derived from project's own org + repos.lit (target-language literal Bible)",
  );
  assert(
    opts.simplifiedRef === "BSOJ/ar_nav@master",
    "simplifiedRef derived from project's own org + repos.sim (target-language simplified Bible)",
  );
}

console.log("[buildTranslateOptions] literalRef/simplifiedRef client override wins");
{
  const opts = buildTranslateOptions(arBsoj, {
    literalRef: "RLOB/ru_custom_glt@master",
    simplifiedRef: "RLOB/ru_custom_gst@master",
  });
  assert(
    opts.literalRef === "RLOB/ru_custom_glt@master",
    "literalRef client override wins over config-derived default",
  );
  assert(
    opts.simplifiedRef === "RLOB/ru_custom_gst@master",
    "simplifiedRef client override wins over config-derived default",
  );
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
  const branchOpts = buildTranslateOptions(arBsoj, { delivery: "branch" });
  assert(branchOpts.delivery === "branch", "explicit 'branch' override still accepted (one-release compat)");
  assert(Array.isArray(opts.rowIds) && opts.rowIds.length === 2, "rowIds folded in");
  assert(opts.verseStart === 3 && opts.verseEnd === 5, "verse range folded in");
  assert(opts.sourceRef === "unfoldingWord/en_tn@abc1234", "sourceRef override (pinned SHA)");
  assert(opts.targetOrg === "OtherOrg", "targetOrg override applied");
  assert(!("contextRef" in opts), "contextRef still omitted when not overridden");
}

console.log("[buildTranslateOptions] resourceType selects the source repo");
{
  const tn = buildTranslateOptions(arBsoj, undefined);
  assert(tn.resourceType === "tn", "resourceType defaults to 'tn'");
  const tq = buildTranslateOptions(arBsoj, { resourceType: "tq" });
  assert(tq.resourceType === "tq", "resourceType 'tq' passed through");
  assert(
    tq.sourceRef === "unfoldingWord/en_tq@master",
    "tq sourceRef derived from src.repos.tq (not tn)",
  );
}

console.log("[buildTranslateOptions] article resources (tw/ta) — articleId/articleUrl fold in");
{
  const tw = buildTranslateOptions(arBsoj, { resourceType: "tw", articleId: "kt/god" });
  assert(tw.resourceType === "tw", "resourceType 'tw' passed through");
  assert(tw.sourceRef === "unfoldingWord/en_tw@master", "tw sourceRef derived from src.repos.tw");
  assert(tw.articleId === "kt/god", "articleId folded in for tw");
  assert(!("articleUrl" in tw), "articleUrl absent when not given");
  const ta = buildTranslateOptions(arBsoj, {
    resourceType: "ta",
    articleUrl: "https://git.door43.org/unfoldingWord/en_ta/raw/branch/master/translate/figs-aside/01.md",
  });
  assert(ta.sourceRef === "unfoldingWord/en_ta@master", "ta sourceRef derived from src.repos.ta");
  assert(typeof ta.articleUrl === "string", "articleUrl folded in for ta");
  assert(!("articleId" in ta), "articleId absent when only articleUrl given");
}

console.log("[buildTranslateOptions] English root project → null (not_a_gl_project)");
{
  const opts = buildTranslateOptions(enRoot, undefined);
  assert(opts === null, "translationSource=null → null (caller turns into 400)");
}

console.log("[buildTranslateOptions] partial translationSource — resource with no source repo → null");
{
  // A GL project whose translationSource omits tq/tw/ta (blank in Setup): only
  // tn is sourced. The chosen resource without a source repo must yield NO
  // options (null → caller 400) rather than a `${org}/undefined@master` ref.
  const partial = {
    ...arBsoj,
    translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tn: "en_tn" } },
  };
  const tn = buildTranslateOptions(partial, undefined);
  assert(tn !== null && tn.sourceRef === "unfoldingWord/en_tn@master", "sourced tn still builds a valid sourceRef");
  assert(buildTranslateOptions(partial, { resourceType: "tq" }) === null, "tq (no source repo) → null, not undefined ref");
  assert(buildTranslateOptions(partial, { resourceType: "tw" }) === null, "tw (no source repo) → null");
  assert(buildTranslateOptions(partial, { resourceType: "ta" }) === null, "ta (no source repo) → null");
  // An explicit client sourceRef override still wins even when the repo is absent.
  const overridden = buildTranslateOptions(partial, { resourceType: "tw", sourceRef: "unfoldingWord/en_tw@abc123" });
  assert(overridden !== null && overridden.sourceRef === "unfoldingWord/en_tw@abc123", "explicit sourceRef override wins over missing repo");
}

console.log("[buildTranslateOptions] per-resource org override → sourceRef uses THAT org (#84 slice)");
{
  // tn sourced from a DIFFERENT org than translationSource.org (pasted URL).
  const perOrg = {
    ...arBsoj,
    translationSource: {
      org: "unfoldingWord",
      languageCode: "en",
      repos: { tn: { org: "BibleAquifer", repo: "ar_tn" }, tq: "en_tq" },
    },
  };
  const tn = buildTranslateOptions(perOrg, undefined);
  assert(
    tn !== null && tn.sourceRef === "BibleAquifer/ar_tn@master",
    "tn sourceRef points at the override org+repo, not translationSource.org",
  );
  const tq = buildTranslateOptions(perOrg, { resourceType: "tq" });
  assert(
    tq !== null && tq.sourceRef === "unfoldingWord/en_tq@master",
    "a legacy-string sibling role still resolves under the default org",
  );
}

console.log("\ntranslateOptions: all assertions passed");
