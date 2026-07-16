// orgInference.test.mjs — manifest parsing + pure inference tests (PR B).

import assert from "node:assert/strict";
import test from "node:test";
import {
  parseManifestFacts,
  inferFromRepoList,
} from "./orgInference.ts";

// ── Manifest fixtures ────────────────────────────────────────────────────────

const UW_BLOCK_MANIFEST = `
dublin_core:
  identifier: "glt"
  language:
    identifier: "en"
    title: "English"
    direction: "ltr"
  subject: "Aligned Bible"
  relation:
    - "en/tn"
    - "en/tq"
    - "en/twl?v=5"
`;

const BSOJ_STYLE_MANIFEST = `
dublin_core:
  identifier: "avd"
  language: "ar"
  subject: "Bible"
  relation: ["ar/tn", "ar/tq"]
`;

const FLOW_LIST_MANIFEST = `dublin_core: {identifier: glt, language: en, subject: "Aligned Bible", relation: [en/tn, en/tq]}`;

const MISSING_RELATION_MANIFEST = `
dublin_core:
  identifier: "tn"
  language:
    identifier: "en"
  subject: "Translation Notes"
`;

const NON_BIBLE_SUBJECT_MANIFEST = `
dublin_core:
  identifier: "ta"
  language: "en"
  subject: "Translation Academy"
`;

test("parseManifestFacts: uW block-style manifest with relation list", () => {
  const facts = parseManifestFacts(UW_BLOCK_MANIFEST);
  assert.ok(facts);
  assert.equal(facts.language, "en");
  assert.equal(facts.identifier, "glt");
  assert.equal(facts.subject, "Aligned Bible");
  assert.deepEqual(facts.relation, ["en/tn", "en/tq", "en/twl"]); // ?v= stripped
});

test("parseManifestFacts: BSOJ-style (bare language string, non-standard identifier)", () => {
  const facts = parseManifestFacts(BSOJ_STYLE_MANIFEST);
  assert.ok(facts);
  assert.equal(facts.language, "ar");
  assert.equal(facts.identifier, "avd");
  assert.equal(facts.subject, "Bible");
});

test("parseManifestFacts: flow-style YAML relation list", () => {
  const facts = parseManifestFacts(FLOW_LIST_MANIFEST);
  assert.ok(facts);
  assert.equal(facts.language, "en");
  assert.deepEqual(facts.relation, ["en/tn", "en/tq"]);
});

test("parseManifestFacts: missing relation field defaults to empty array", () => {
  const facts = parseManifestFacts(MISSING_RELATION_MANIFEST);
  assert.ok(facts);
  assert.deepEqual(facts.relation, []);
});

test("parseManifestFacts: ?v= suffix stripped from relation entries", () => {
  const facts = parseManifestFacts(UW_BLOCK_MANIFEST);
  assert.ok(facts.relation.every((r) => !r.includes("?")));
});

test("parseManifestFacts: non-Bible subject is parsed but not lane-verifiable (checked by caller)", () => {
  const facts = parseManifestFacts(NON_BIBLE_SUBJECT_MANIFEST);
  assert.ok(facts);
  assert.equal(facts.subject, "Translation Academy");
});

test("parseManifestFacts: malformed YAML returns null", () => {
  assert.equal(parseManifestFacts("not: valid: yaml: [unclosed"), null);
});

test("parseManifestFacts: missing dublin_core returns null", () => {
  assert.equal(parseManifestFacts("foo: bar"), null);
});

// ── inferFromRepoList ────────────────────────────────────────────────────────

function manifestMap(entries) {
  const m = new Map();
  for (const [repo, facts] of Object.entries(entries)) {
    m.set(repo, { repoName: repo, facts, fetchOk: facts != null });
  }
  return m;
}

test("inferFromRepoList: full GL set resolves lit/sim/tn/tq/twl/tw/ta cleanly", () => {
  const repos = [
    { name: "en_tn" }, { name: "en_tq" }, { name: "en_twl" },
    { name: "en_tw" }, { name: "en_ta" },
    { name: "en_glt" }, { name: "en_gst" },
  ];
  const manifests = manifestMap({
    en_glt: { language: "en", relation: [], identifier: "glt", subject: "Aligned Bible" },
    en_gst: { language: "en", relation: [], identifier: "gst", subject: "Aligned Bible" },
  });
  const inf = inferFromRepoList("BibleEditorMLTest", repos, manifests);
  assert.equal(inf.languageCode, "en");
  assert.equal(inf.tnRepo, "en_tn");
  assert.equal(inf.litRepo, "en_glt");
  assert.equal(inf.simRepo, "en_gst");
  assert.equal(inf.tqRepo, "en_tq");
  assert.equal(inf.twlRepo, "en_twl");
  assert.equal(inf.twRepo, "en_tw");
  assert.equal(inf.taRepo, "en_ta");
  assert.deepEqual(inf.missing, []);
  assert.deepEqual(inf.ambiguous, []);
});

test("inferFromRepoList: nonstandard identifiers (avd/nav) are ambiguous, never auto-assigned", () => {
  // BSOJ-style org: Bible panes named ar_avd/ar_nav, not the standard
  // ult/glt/ust/gst suffixes at all.
  const repos = [
    { name: "ar_tn" }, { name: "ar_avd" }, { name: "ar_nav" },
  ];
  const manifests = manifestMap({
    ar_avd: { language: "ar", relation: [], identifier: "avd", subject: "Bible" },
    ar_nav: { language: "ar", relation: [], identifier: "nav", subject: "Bible" },
  });
  const inf = inferFromRepoList("BSOJ", repos, manifests);
  assert.equal(inf.tnRepo, "ar_tn");
  // avd/nav aren't in the explicit identifier table -> never auto-picked,
  // even though both manifests verify a Bible subject -> reported as an
  // ambiguous candidate list for BOTH roles, admin picks explicitly.
  assert.equal(inf.litRepo, null);
  assert.equal(inf.simRepo, null);
  const litAmb = inf.ambiguous.find((a) => a.role === "lit");
  const simAmb = inf.ambiguous.find((a) => a.role === "sim");
  assert.ok(litAmb);
  assert.ok(simAmb);
  assert.deepEqual(litAmb.candidates.sort(), ["ar_avd", "ar_nav"]);
  assert.deepEqual(simAmb.candidates.sort(), ["ar_avd", "ar_nav"]);
});

test("inferFromRepoList: a sim candidate whose manifest identifier doesn't match its own role table is not verified", () => {
  // en_gst's manifest wrongly claims identifier 'glt' (a lit identifier) —
  // the role-specific identifier check must reject it for the sim role
  // rather than trusting the naming convention alone.
  const repos = [{ name: "en_tn" }, { name: "en_glt" }, { name: "en_gst" }];
  const manifests = manifestMap({
    en_glt: { language: "en", relation: [], identifier: "glt", subject: "Aligned Bible" },
    en_gst: { language: "en", relation: [], identifier: "glt", subject: "Aligned Bible" },
  });
  const inf = inferFromRepoList("Org", repos, manifests);
  assert.equal(inf.litRepo, "en_glt");
  assert.equal(inf.simRepo, null);
  assert.ok(inf.missing.includes("sim"));
});

test("inferFromRepoList: multiple *_tn repos -> ambiguous, no order-based tiebreak", () => {
  const repos = [{ name: "en_tn" }, { name: "en2_tn" }];
  const inf = inferFromRepoList("Org", repos, new Map());
  assert.equal(inf.tnRepo, null);
  assert.ok(inf.warnings.some((w) => w.includes("multiple tn repos")));
  assert.deepEqual(inf.missing, ["tn", "tq", "twl", "tw", "ta", "lit", "sim"]);
});

test("inferFromRepoList: missing tw/ta reported in missing[]", () => {
  const repos = [
    { name: "en_tn" }, { name: "en_tq" }, { name: "en_twl" },
    { name: "en_glt" }, { name: "en_gst" },
  ];
  const manifests = manifestMap({
    en_glt: { language: "en", relation: [], identifier: "glt", subject: "Aligned Bible" },
    en_gst: { language: "en", relation: [], identifier: "gst", subject: "Aligned Bible" },
  });
  const inf = inferFromRepoList("Org", repos, manifests);
  assert.ok(inf.missing.includes("tw"));
  assert.ok(inf.missing.includes("ta"));
  assert.equal(inf.litRepo, "en_glt");
  assert.equal(inf.simRepo, "en_gst");
});

test("inferFromRepoList: non-Bible-subject manifest disqualifies a lit/sim candidate", () => {
  const repos = [{ name: "en_tn" }, { name: "en_glt" }];
  const manifests = manifestMap({
    // Same repo name pattern but the manifest's subject isn't Bible-ish —
    // must not be trusted as the lit pane.
    en_glt: { language: "en", relation: [], identifier: "glt", subject: "Translation Academy" },
  });
  const inf = inferFromRepoList("Org", repos, manifests);
  assert.equal(inf.litRepo, null);
  assert.ok(inf.missing.includes("lit"));
});

test("inferFromRepoList: tn repo without a langCode match yields no lane/presence candidates", () => {
  const repos = [{ name: "weird_tn" }];
  const inf = inferFromRepoList("Org", repos, new Map());
  assert.equal(inf.tnRepo, "weird_tn");
  assert.equal(inf.languageCode, "weird");
  assert.equal(inf.tqRepo, null);
});
