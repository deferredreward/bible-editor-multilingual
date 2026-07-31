// Unit tests for assistedContextRef.ts — pure contextRef/targetLang/direction
// injection shared by tn-quick, template-quick, and the translate pipeline.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/assistedContextRef.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { applyContextRef, applyTnQuickContext } from "./assistedContextRef.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const latest = {
  sha: "abc1234",
  completedAt: 1700000000,
  terms: 1,
  examplesTn: 1,
  examplesTq: 0,
  templates: 0,
  contentFiles: 1,
  totalBytes: 100,
  owner: "BSOJ",
};

const cfg = { languageCode: "ar", direction: "rtl" };

console.log("[applyContextRef] no successful export -> options unchanged, no contextRef key");
{
  const opts = applyContextRef({ foo: "bar" }, null);
  assert(!("contextRef" in opts), "contextRef key absent when no export exists");
  assert(opts.foo === "bar", "other fields untouched");
}

console.log("[applyContextRef] successful export -> contextRef derived");
{
  const opts = applyContextRef({ foo: "bar" }, latest);
  assert(opts.contextRef === "BSOJ/translation-context@abc1234", "contextRef built from owner+sha");
}

console.log("[applyContextRef] caller-supplied contextRef always wins");
{
  const opts = applyContextRef({ contextRef: "OtherOrg/translation-context@master" }, latest);
  assert(
    opts.contextRef === "OtherOrg/translation-context@master",
    "explicit override is never replaced by the derived ref",
  );
}

console.log("[applyTnQuickContext] no successful export -> body has NO contextRef key at all");
{
  const body = { ref: { book: "TIT", chapter: 1, verse: 1 } };
  const result = applyTnQuickContext(body, null, cfg);
  assert(!Object.hasOwn(result, "contextRef"), "contextRef key entirely absent (not undefined) on the wire");
  const wire = JSON.parse(JSON.stringify(result));
  assert(!Object.hasOwn(wire, "contextRef"), "serialized body also has no contextRef key");
  assert(result.targetLang === "ar", "targetLang still derived from project config");
  assert(result.direction === "rtl", "direction still derived from project config");
}

console.log("[applyTnQuickContext] successful export -> body carries the expected contextRef string");
{
  const body = { ref: { book: "TIT", chapter: 1, verse: 1 } };
  const result = applyTnQuickContext(body, latest, cfg);
  assert(Object.hasOwn(result, "contextRef"), "contextRef key present on the wire");
  assert(result.contextRef === "BSOJ/translation-context@abc1234", "contextRef matches owner+sha of the latest export");
  const wire = JSON.parse(JSON.stringify(result));
  assert(wire.contextRef === "BSOJ/translation-context@abc1234", "survives JSON round-trip unchanged");
}

console.log("[applyTnQuickContext] client-supplied targetLang/direction/contextRef are STRIPPED and replaced by derived values");
{
  // Cross-tenant read / prompt-steering guard: tn-quick uses the shared
  // BT_API_TOKEN, so a client-controlled contextRef must never survive.
  const body = { targetLang: "es", direction: "ltr", contextRef: "Pinned/translation-context@deadbeef" };
  const result = applyTnQuickContext(body, latest, cfg);
  assert(result.targetLang === "ar", "client targetLang overridden by derived project config value");
  assert(result.direction === "rtl", "client direction overridden by derived project config value");
  assert(result.contextRef === "BSOJ/translation-context@abc1234", "client contextRef overridden by derived value");
}

console.log("[applyTnQuickContext] key-set contract: result is a subset of the bot's tn-quick allow-list");
{
  const TN_QUICK_ALLOWED_KEYS = new Set([
    "ref",
    "issueType",
    "ult",
    "ust",
    "hebrewGuess",
    "model",
    "contextRef",
    "targetLang",
    "direction",
  ]);
  const body = { ref: { book: "TIT", chapter: 1, verse: 1 }, issueType: "wording", model: "x" };
  const result = applyTnQuickContext(body, latest, cfg);
  for (const key of Object.keys(result)) {
    assert(TN_QUICK_ALLOWED_KEYS.has(key), `key "${key}" is in the bot's tn-quick allow-list`);
  }
}

console.log("[applyContextRef] key-set contract: result is a subset of the bot's template-quick allow-list");
{
  const TEMPLATE_QUICK_ALLOWED_KEYS = new Set([
    "templateId",
    "supportRef",
    "type",
    "sourceMd",
    "targetMd",
    "targetLang",
    "targetOrg",
    "direction",
    "model",
    "contextRef",
  ]);
  const body = {
    templateId: "t1",
    supportRef: "figs-metaphor",
    type: "note",
    sourceMd: "src",
    targetMd: "tgt",
    targetLang: "ar",
    targetOrg: "BSOJ",
    direction: "rtl",
  };
  const result = applyContextRef(body, latest);
  for (const key of Object.keys(result)) {
    assert(TEMPLATE_QUICK_ALLOWED_KEYS.has(key), `key "${key}" is in the bot's template-quick allow-list`);
  }
}

console.log('[applyTnQuickContext] cfg.languageCode === "" (custom-gl) -> no targetLang key');
{
  const body = { ref: { book: "TIT", chapter: 1, verse: 1 } };
  const result = applyTnQuickContext(body, latest, { languageCode: "", direction: "ltr" });
  assert(!("targetLang" in result), "targetLang key absent for empty languageCode");
}

console.log("[applyTnQuickContext] invalid languageCode shapes -> no targetLang key");
{
  for (const bad of ["pt_BR", "EN", "el-x-koine", "en "]) {
    const body = { ref: { book: "TIT", chapter: 1, verse: 1 } };
    const result = applyTnQuickContext(body, latest, { languageCode: bad, direction: "ltr" });
    assert(!("targetLang" in result), `targetLang key absent for invalid languageCode ${JSON.stringify(bad)}`);
  }
}

console.log("[applyContextRef] owner containing ~ produces a bot-illegal contextRef -> key omitted");
{
  const weirdOwner = { ...latest, owner: "Bad~Owner" };
  const result = applyContextRef({ foo: "bar" }, weirdOwner);
  assert(!("contextRef" in result), "contextRef key absent when the built ref fails bot validation");
}

// Note: the non-object-parsed-body guard (null/array/string/number JSON
// bodies must not be spread into the request) lives in the route
// (api/src/tnQuick.ts), not in this helper — applyTnQuickContext/
// applyContextRef both assume they're already handed a Record<string,
// unknown>. Not exercised here since it needs the Hono route, not this pure
// module.

console.log("\nassistedContextRef: all assertions passed");
