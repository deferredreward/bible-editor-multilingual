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

console.log("[applyTnQuickContext] caller-supplied targetLang/direction/contextRef all win over derived");
{
  const body = { targetLang: "es", direction: "ltr", contextRef: "Pinned/translation-context@deadbeef" };
  const result = applyTnQuickContext(body, latest, cfg);
  assert(result.targetLang === "es", "caller targetLang preserved");
  assert(result.direction === "ltr", "caller direction preserved");
  assert(result.contextRef === "Pinned/translation-context@deadbeef", "caller contextRef preserved");
}

console.log("\nassistedContextRef: all assertions passed");
