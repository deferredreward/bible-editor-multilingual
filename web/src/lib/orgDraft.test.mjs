// Tests for the pure org-draft override helpers (web/src/lib/orgDraft.ts) — the
// per-resource upstream model behind the Setup wizard's translationSource. The
// load-bearing claim is BACKWARD COMPATIBILITY: all-upstream with the default
// unfoldingWord upstream must reproduce the legacy UW_SOURCE byte-for-byte, and
// all-blank must reproduce the legacy `null`.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings --test src/lib/orgDraft.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import {
  UW_UPSTREAM_ORG,
  UW_UPSTREAM_LANG,
  UW_UPSTREAM_REPOS,
  defaultResourceSources,
  allResourceSources,
  buildTranslationSource,
  translationSourceOnFor,
} from "./orgDraft.ts";

// The legacy object the old buildOverrides emitted for `translationSourceOn === true`.
const LEGACY_UW_SOURCE = {
  org: "unfoldingWord",
  languageCode: "en",
  repos: { lit: "en_ult", sim: "en_ust", tn: "en_tn", tq: "en_tq", twl: "en_twl", tw: "en_tw", ta: "en_ta" },
};

function build(resourceSource, upstreamRepos = UW_UPSTREAM_REPOS, upstreamOrg = UW_UPSTREAM_ORG) {
  return buildTranslationSource({
    upstreamOrg,
    languageCode: UW_UPSTREAM_LANG,
    upstreamRepos,
    resourceSource,
  });
}

test("all-upstream default reproduces legacy UW_SOURCE exactly", () => {
  const ts = build(defaultResourceSources());
  assert.deepEqual(ts, LEGACY_UW_SOURCE);
});

test("legacy translationSourceOn === true parity (allResourceSources upstream)", () => {
  const ts = build(allResourceSources("upstream"));
  assert.deepEqual(ts, LEGACY_UW_SOURCE);
});

test("all-blank yields null (legacy translationSourceOn === false parity)", () => {
  assert.equal(build(allResourceSources("blank")), null);
});

test("some-blank omits only the blanked resources", () => {
  const sources = defaultResourceSources();
  sources.tw = { mode: "blank" };
  sources.ta = { mode: "blank" };
  const ts = build(sources);
  assert.deepEqual(ts.repos, {
    lit: "en_ult", sim: "en_ust", tn: "en_tn", tq: "en_tq", twl: "en_twl",
  });
  assert.equal("tw" in ts.repos, false);
  assert.equal("ta" in ts.repos, false);
});

test("some-override uses the override repo within the same upstream org", () => {
  const sources = defaultResourceSources();
  sources.lit = { mode: "override", repo: "en_glt" };
  const ts = build(sources);
  assert.equal(ts.repos.lit, "en_glt");
  assert.equal(ts.repos.sim, "en_ust"); // untouched resources stay upstream
  assert.equal(ts.org, "unfoldingWord");
});

test("override with a blank repo string is dropped (not emitted)", () => {
  const sources = allResourceSources("blank");
  sources.tn = { mode: "override", repo: "   " };
  assert.equal(build(sources), null);
});

test("upstream mode with a missing upstream repo is skipped", () => {
  const sources = allResourceSources("blank");
  sources.tn = { mode: "upstream" };
  const partialRepos = { ...UW_UPSTREAM_REPOS, tn: "" };
  assert.equal(build(sources, partialRepos), null);
});

test("mixed override + upstream + blank assembles the expected partial map", () => {
  const sources = {
    lit: { mode: "upstream" },
    sim: { mode: "override", repo: "en_gst" },
    tn: { mode: "blank" },
    tq: { mode: "upstream" },
    twl: { mode: "blank" },
    tw: { mode: "blank" },
    ta: { mode: "override", repo: "en_ta_alt" },
  };
  const ts = build(sources);
  assert.deepEqual(ts.repos, { lit: "en_ult", sim: "en_gst", tq: "en_tq", ta: "en_ta_alt" });
});

test("a non-default upstream org is carried onto translationSource.org", () => {
  const ts = build(defaultResourceSources(), UW_UPSTREAM_REPOS, "SomeOtherOrg");
  assert.equal(ts.org, "SomeOtherOrg");
});

test("translationSourceOnFor: true unless every resource is blank", () => {
  assert.equal(translationSourceOnFor(allResourceSources("upstream")), true);
  assert.equal(translationSourceOnFor(defaultResourceSources()), true);
  assert.equal(translationSourceOnFor(allResourceSources("blank")), false);
  const oneNonBlank = allResourceSources("blank");
  oneNonBlank.tn = { mode: "upstream" };
  assert.equal(translationSourceOnFor(oneNonBlank), true);
});
