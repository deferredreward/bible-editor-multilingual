// orgInference.test.mjs — manifest parsing + pure inference tests (PR B).

import assert from "node:assert/strict";
import test from "node:test";
import {
  parseManifestFacts,
  inferFromRepoList,
  selectCandidateRepos,
  listOrgRepos,
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
  assert.equal(facts.languageTitle, "English"); // from dublin_core.language.title
  assert.equal(facts.languageDirection, "ltr"); // from dublin_core.language.direction
  assert.equal(facts.identifier, "glt");
  assert.equal(facts.subject, "Aligned Bible");
  assert.deepEqual(facts.relation, ["en/tn", "en/tq", "en/twl"]); // ?v= stripped
});

test("parseManifestFacts: BSOJ-style (bare language string, non-standard identifier)", () => {
  const facts = parseManifestFacts(BSOJ_STYLE_MANIFEST);
  assert.ok(facts);
  assert.equal(facts.language, "ar");
  assert.equal(facts.languageTitle, null); // bare string carries no title
  assert.equal(facts.languageDirection, null); // nor direction
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

test("selectCandidateRepos: standard lane names are reserved before the cap (no starvation)", () => {
  // An org with many nonstandard {lang}_* repos listed BEFORE the standard
  // lane repos: with a tight cap, the standard glt/gst must still be fetched.
  const names = ["en_tn"];
  for (let i = 0; i < 30; i++) names.push(`en_extra${i}`);
  names.push("en_glt", "en_gst");
  const picked = selectCandidateRepos("en", names, ["en_tn"], 5);
  assert.ok(picked.includes("en_tn"), "tn repo always included");
  assert.ok(picked.includes("en_glt"), "standard lit reserved despite the cap");
  assert.ok(picked.includes("en_gst"), "standard sim reserved despite the cap");
  assert.ok(picked.length <= 5, "respects the cap");
});

test("selectCandidateRepos: fills remaining budget with nonstandard {lang}_* repos", () => {
  const names = ["ar_tn", "ar_avd", "ar_nav", "ar_tq"];
  const picked = selectCandidateRepos("ar", names, ["ar_tn"], 20);
  assert.ok(picked.includes("ar_avd") && picked.includes("ar_nav"), "nonstandard Bible panes included");
  assert.ok(!picked.includes("ar_tq"), "known non-lane resource excluded");
});

test("selectCandidateRepos: langCode null (ambiguous/multiple tn) fetches only the tn repos, no lane expansion", () => {
  const names = ["en_tn", "es_tn", "en_glt", "en_gst", "es_glt"];
  const picked = selectCandidateRepos(null, names, ["en_tn", "es_tn"], 20);
  assert.deepEqual(picked, ["en_tn", "es_tn"], "no lane candidates added when langCode is null");
});

test("listOrgRepos: full pages up to the cap fail closed (never a truncated ok)", async () => {
  const env = { DCS_BASE_URL: "https://git.door43.org" };
  const fiftyRepos = Array.from({ length: 50 }, (_, i) => ({ name: `r${i}` }));
  let calls = 0;
  const alwaysFull = async () => {
    calls++;
    return new Response(JSON.stringify(fiftyRepos), { status: 200, headers: { "content-type": "application/json" } });
  };
  const res = await listOrgRepos(env, "HugeOrg", { fetch: alwaysFull });
  assert.equal(res.ok, false, "cap exhaustion with full pages -> ok:false");
  assert.equal(calls, 20, "stops at the 20-page ceiling");
});

test("listOrgRepos: a short final page returns ok with the concatenated list", async () => {
  const env = { DCS_BASE_URL: "https://git.door43.org" };
  const fetchTwo = async (url) => {
    const p = Number(new URL(String(url)).searchParams.get("page"));
    const body = p === 1 ? Array.from({ length: 50 }, (_, i) => ({ name: `r${i}` })) : [{ name: "last" }];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const res = await listOrgRepos(env, "Org", { fetch: fetchTwo });
  assert.equal(res.ok, true);
  assert.equal(res.repos.length, 51);
  assert.equal(res.repos[50].name, "last");
});

test("selectCandidateRepos: the cap is a HARD ceiling even with many tn matches + lanes", () => {
  // 10 *_tn matches + 4 standard lanes would be 14 before any cap check; a
  // max of 3 must still yield exactly 3 (priority order: tn first).
  const tnMatches = Array.from({ length: 10 }, (_, i) => `l${i}_tn`);
  const names = [...tnMatches, "en_glt", "en_gst", "en_ult", "en_ust"];
  const picked = selectCandidateRepos("en", names, tnMatches, 3);
  assert.equal(picked.length, 3, "never exceeds max");
  assert.deepEqual(picked, ["l0_tn", "l1_tn", "l2_tn"], "highest-priority (tn) survive the cap");
});

test("inferFromRepoList: languageName/direction come from the tn manifest, not the heuristic", () => {
  // A language NOT in the RTL heuristic set whose tn manifest declares rtl +
  // a human title: both must come from the manifest, overriding the code and
  // the ltr default.
  const repos = [{ name: "xyz_tn" }, { name: "xyz_glt" }, { name: "xyz_gst" }];
  const manifests = manifestMap({
    xyz_tn: {
      language: "xyz",
      languageTitle: "Xyzian",
      languageDirection: "rtl",
      relation: [],
      identifier: "tn",
      subject: "Translation Notes",
    },
    xyz_glt: { language: "xyz", languageTitle: null, languageDirection: null, relation: [], identifier: "glt", subject: "Aligned Bible" },
    xyz_gst: { language: "xyz", languageTitle: null, languageDirection: null, relation: [], identifier: "gst", subject: "Aligned Bible" },
  });
  const inf = inferFromRepoList("XyzOrg", repos, manifests);
  assert.equal(inf.languageCode, "xyz");
  assert.equal(inf.languageName, "Xyzian"); // manifest title, not the "xyz" code
  assert.equal(inf.direction, "rtl"); // manifest direction, not the ltr default
});

test("inferFromRepoList: falls back to code + heuristic direction when the tn manifest omits them", () => {
  const repos = [{ name: "ar_tn" }, { name: "ar_glt" }, { name: "ar_gst" }];
  const manifests = manifestMap({
    ar_tn: { language: "ar", languageTitle: null, languageDirection: null, relation: [], identifier: "tn", subject: "Translation Notes" },
    ar_glt: { language: "ar", relation: [], identifier: "glt", subject: "Aligned Bible" },
    ar_gst: { language: "ar", relation: [], identifier: "gst", subject: "Aligned Bible" },
  });
  const inf = inferFromRepoList("SomeArabicOrg", repos, manifests);
  assert.equal(inf.languageName, "ar"); // no title in manifest -> code
  assert.equal(inf.direction, "rtl"); // ar is in the RTL heuristic set
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

test("inferFromRepoList: a standard-named repo with a Bible subject but NO identifier is NOT auto-verified", () => {
  // en_glt's manifest has a Bible subject but omits dublin_core.identifier —
  // it must not be trusted as the lit lane on the naming convention alone
  // (a malformed manifest shouldn't bypass explicit verification).
  const repos = [{ name: "en_tn" }, { name: "en_glt" }, { name: "en_gst" }];
  const manifests = manifestMap({
    en_glt: { language: "en", relation: [], identifier: null, subject: "Aligned Bible" },
    en_gst: { language: "en", relation: [], identifier: "gst", subject: "Aligned Bible" },
  });
  const inf = inferFromRepoList("Org", repos, manifests);
  assert.equal(inf.litRepo, null); // absent identifier → not verified
  assert.ok(inf.missing.includes("lit"));
  assert.equal(inf.simRepo, "en_gst"); // sim still verifies normally
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
