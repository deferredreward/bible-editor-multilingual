// Shared helpers for the translate/*.test.mjs suites: fixture paths under
// api/test-fixtures/translate/ and the fetch-shaped fakes the loaders accept.
// Not a test file itself (no .test. in the name).

import { readFileSync } from "node:fs";

export const FIXTURES = new URL("../../test-fixtures/translate/", import.meta.url);

export function fixture(rel) {
  return readFileSync(new URL(rel, FIXTURES), "utf8");
}

/**
 * Fake DCS raw endpoint: `files` maps a repo-relative path to its content.
 * Anything else (including the branches API used for sha resolution) 404s.
 * Mirrors the fetch-like shape core.fetchResourceFile / contextPack expect:
 * { status, ok, headers, text(), json() }.
 */
/** The bot test's writeFixturePack() (translate-core.test.js), as a path→content map. */
export function fixturePackFiles({ templateStatus = "active", format = 1 } = {}) {
  return {
    "manifest.yaml": `format: ${format}\nlanguage: ar\ndirection: rtl\n`,
    "brief.md": "# Translation brief\n\n**Register:** formal\n\nBrief text.",
    "instructions.md": "Instruction text.",
    "templates/templates.tsv":
      "support_reference\ttarget_template\tstatus\tcomment\n"
      + `figs-metaphor\tقالب الاستعارة\t${templateStatus}\t\n`
      + "figs-idiom\ten-scaffold\tdraft\tignored\n",
    "terminology/terms.csv":
      "concept_id,source_term,target_term,status,replacement,comment,tw_link\n"
      + "names/yhwh,Yahweh,يهوه,preferred,,divine name,\n"
      + "kt/lord,Lord,السيد,forbidden,الرب,use standard,\n"
      + "names/tetragram,YHWH,,do_not_translate,,,\n"
      + "kt/covenant,covenant,عهد,admitted,,,\n"
      + 'kt/grace,"grace, gift",نعمة,preferred,,quoted comma,\n',
    "examples/validated.jsonl":
      JSON.stringify({
        resource: "tn", rowId: "a1", supportReference: "rc://*/ta/man/translate/figs-metaphor",
        source: "src A", target: "tgt A", validated_at: 100,
      }) + "\n"
      + JSON.stringify({
        resource: "tn", rowId: "b1", supportReference: "rc://*/ta/man/translate/figs-idiom",
        source: "src B", target: "tgt B", validated_at: 200,
      }) + "\n"
      + JSON.stringify({ resource: "tn", rowId: "a1", tombstone: true, validated_at: 300 }) + "\n"
      + JSON.stringify({
        resource: "tn", rowId: "c1", supportReference: "rc://*/ta/man/translate/figs-metaphor",
        source: "src C", target: "tgt C", validated_at: 400,
      }) + "\n"
      + "not json — must be skipped, not fatal\n",
  };
}

export function fakeRawFetch(files) {
  return async (url) => {
    const m = /\/raw\/(?:branch|commit)\/[^/]+\/(.+)$/.exec(url);
    if (m) {
      const p = decodeURIComponent(m[1]);
      if (files[p] == null) return { status: 404, ok: false, headers: null, text: async () => "" };
      return { status: 200, ok: true, headers: null, text: async () => files[p], json: async () => JSON.parse(files[p]) };
    }
    return { status: 404, ok: false, headers: null, text: async () => "" };
  };
}
