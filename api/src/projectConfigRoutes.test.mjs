// Persist-boundary regression for the per-resource translation-source override.
// The PUT /api/project-config zod (TranslationSourceShape) MUST reject a
// non-ident override org/repo for EVERY preset — not just custom-gl — so a
// path-traversal value can never be STORED via a non-custom preset override and
// later interpolated into a git.door43.org URL. (Read-time normalizeSourceRef +
// URL-segment encoding are the other two defense layers; see dcsSources.test.mjs.)
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/projectConfigRoutes.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { TranslationSourceShape } from "./projectConfigRoutes.ts";

const ok = (ts) => TranslationSourceShape.safeParse(ts).success;

test("valid bare-string + per-resource { org, repo } refs pass", () => {
  assert.equal(
    ok({ org: "unfoldingWord", languageCode: "en", repos: { tn: "en_tn", tw: { org: "BibleAquifer", repo: "ar_tw" }, ta: { repo: "en_ta" } } }),
    true,
  );
  assert.equal(ok(null), true, "explicit null clears — allowed");
});

test("a traversal in the top-level org is rejected", () => {
  assert.equal(ok({ org: "uW/../../other", languageCode: "en", repos: { tn: "en_tn" } }), false);
});

test("a traversal in a per-resource override org is rejected", () => {
  assert.equal(ok({ org: "unfoldingWord", languageCode: "en", repos: { tn: { org: "a/../../b", repo: "x_tn" } } }), false);
});

test("a traversal / non-ident in a repo value is rejected (bare and ref forms)", () => {
  assert.equal(ok({ org: "unfoldingWord", languageCode: "en", repos: { tn: "../../etc" } }), false);
  assert.equal(ok({ org: "unfoldingWord", languageCode: "en", repos: { tn: { repo: "bad repo!" } } }), false);
  assert.equal(ok({ org: "unfoldingWord", languageCode: "en", repos: { tn: { org: "BibleAquifer" } } }), false, "ref missing repo → rejected");
});
