// Tests for the web per-resource source accessor (web/src/lib/sourceRef.ts),
// mirroring api/src/dcsSources.ts resolveSourceRef. Run from web/:
//   node --experimental-strip-types --no-warnings --test src/lib/sourceRef.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { resolveSourceRef, normalizeSourceRef } from "./sourceRef.ts";

test("bare string resolves under the default (primary) org — backward-compat", () => {
  assert.deepEqual(normalizeSourceRef("unfoldingWord", "en_tn"), { org: "unfoldingWord", repo: "en_tn" });
});

test("missing / blank → null", () => {
  assert.equal(normalizeSourceRef("unfoldingWord", undefined), null);
  assert.equal(normalizeSourceRef("unfoldingWord", ""), null);
  assert.equal(normalizeSourceRef("unfoldingWord", { repo: "" }), null);
});

test("{ org, repo } ref honors the override org", () => {
  assert.deepEqual(
    normalizeSourceRef("unfoldingWord", { org: "BibleAquifer", repo: "ar_tw" }),
    { org: "BibleAquifer", repo: "ar_tw" },
  );
});

test("{ repo } (no org) falls back to the default org", () => {
  assert.deepEqual(normalizeSourceRef("unfoldingWord", { repo: "en_ta" }), { org: "unfoldingWord", repo: "en_ta" });
});

test("resolveSourceRef over a mixed partial map", () => {
  const ts = {
    org: "unfoldingWord",
    repos: { tn: "en_tn", tw: { org: "BibleAquifer", repo: "ar_tw" }, ta: { repo: "en_ta" } },
  };
  assert.deepEqual(resolveSourceRef(ts, "tn"), { org: "unfoldingWord", repo: "en_tn" });
  assert.deepEqual(resolveSourceRef(ts, "tw"), { org: "BibleAquifer", repo: "ar_tw" });
  assert.deepEqual(resolveSourceRef(ts, "ta"), { org: "unfoldingWord", repo: "en_ta" });
  assert.equal(resolveSourceRef(ts, "tq"), null); // absent role
});

test("resolveSourceRef(null) → null (not a translation project)", () => {
  assert.equal(resolveSourceRef(null, "tn"), null);
  assert.equal(resolveSourceRef(undefined, "tn"), null);
});

// ── PARITY PIN ───────────────────────────────────────────────────────────────
// web/src/lib/sourceRef.ts hand-mirrors api/src/dcsSources.ts normalizeSourceRef
// (can't share across the api/web build boundary). This fixed table pins the
// behavior of BOTH to identical cases — the SAME table lives in
// api/src/dcsSources.test.mjs assertions. If you change one module, this table
// (and its api twin) will catch a divergent edit. Format: [defaultOrg, value, expected].
const NORMALIZE_PARITY = [
  ["unfoldingWord", "en_tn", { org: "unfoldingWord", repo: "en_tn" }],
  ["unfoldingWord", "", null],
  ["unfoldingWord", "   ", null],
  ["unfoldingWord", undefined, null],
  ["unfoldingWord", null, null],
  ["unfoldingWord", { repo: "en_ta" }, { org: "unfoldingWord", repo: "en_ta" }],
  ["unfoldingWord", { org: "BibleAquifer", repo: "ar_tw" }, { org: "BibleAquifer", repo: "ar_tw" }],
  ["unfoldingWord", { org: "", repo: "en_tq" }, { org: "unfoldingWord", repo: "en_tq" }],
  ["unfoldingWord", { repo: "" }, null],
  // SECURITY: non-ident org/repo → null (must match api normalizeSourceRef).
  ["unfoldingWord", "bad repo!", null],
  ["unfoldingWord", { org: "a/../../b", repo: "x_tn" }, null],
  ["unfoldingWord", { repo: "../../etc" }, null],
];

test("PARITY: normalizeSourceRef matches the api table exactly", () => {
  for (const [defaultOrg, value, expected] of NORMALIZE_PARITY) {
    assert.deepEqual(
      normalizeSourceRef(defaultOrg, value),
      expected,
      `normalizeSourceRef(${JSON.stringify(defaultOrg)}, ${JSON.stringify(value)})`,
    );
  }
});
