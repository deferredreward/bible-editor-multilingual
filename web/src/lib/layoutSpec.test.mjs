// Smoke test for layoutSpec.ts — LayoutSpec (v2, recursive container) validation
// + size normalization. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/layoutSpec.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors src/lib/replace.test.mjs.

import { validateLayoutSpec, normalizeSizes } from "./layoutSpec.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// A bp-review-like nested tree: vertical split (scripture on top; a horizontal
// split of two resource regions below). Returned fresh each call so mutations
// in `rejects` never leak between cases.
const validSpec = () => ({
  v: 2,
  id: "builtin:bp-review",
  name: "Book Package Review",
  builtin: true,
  rail: { visible: true },
  root: {
    kind: "split",
    orientation: "vertical",
    children: [
      {
        kind: "region",
        id: "scripture",
        size: 0.4,
        panels: [
          { id: "scripture-1", type: "scripture", config: { mode: "stacked", versions: "inherit" } },
        ],
      },
      {
        kind: "split",
        orientation: "horizontal",
        size: 0.6,
        children: [
          {
            kind: "region",
            id: "res-a",
            size: 0.5,
            display: "stacked",
            panels: [
              { id: "notes-1", type: "notes" },
              { id: "ta-1", type: "taArticle" },
            ],
          },
          {
            kind: "region",
            id: "res-b",
            size: 0.5,
            display: "stacked",
            panels: [
              { id: "words-1", type: "words" },
              { id: "tw-1", type: "twArticle" },
              { id: "questions-1", type: "questions" },
            ],
          },
        ],
      },
    ],
  },
});

// ─── Valid specs ───────────────────────────────────────────────────────
{
  console.log("\n[Valid] nested container spec");
  const r = validateLayoutSpec(validSpec());
  assert(r !== null, "valid nested spec passes");
  assert(r && r.root.kind === "split" && r.root.orientation === "vertical", "root split preserved");
  assert(
    r && r.root.children[1].kind === "split" && r.root.children[1].children.length === 2,
    "nested split preserved",
  );
  assert(
    r && r.root.children[0].panels[0].config.versions === "inherit",
    "scripture config preserved",
  );
}
{
  console.log("\n[Valid] requires:translation is preserved");
  const s = validSpec();
  s.requires = "translation";
  const r = validateLayoutSpec(s);
  assert(r !== null && r.requires === "translation", "requires kept");
}
{
  console.log("\n[Valid] versions:'inherit' and versions:['ULT']");
  const inherit = validateLayoutSpec(validSpec());
  assert(inherit !== null, "versions inherit accepted");
  const s = validSpec();
  s.root.children[0].panels[0].config.versions = ["ULT"];
  const r = validateLayoutSpec(s);
  assert(
    r !== null && Array.isArray(r.root.children[0].panels[0].config.versions),
    "versions string[] accepted",
  );
}
{
  console.log("\n[Valid] empty-panels region accepted");
  const s = validSpec();
  s.root.children[0].panels = [];
  assert(validateLayoutSpec(s) !== null, "an emptied region is valid");
}
{
  console.log("\n[Valid] unknown config keys are ignored, not rejected");
  const s = validSpec();
  s.root.children[0].panels[0].config.bogusKey = 123;
  const r = validateLayoutSpec(s);
  assert(r !== null, "unknown config key does not fail validation");
  assert(
    r && r.root.children[0].panels[0].config.bogusKey === undefined,
    "unknown config key is stripped",
  );
}
{
  console.log("\n[Valid] nesting at the depth cap is accepted");
  // Root split is depth 1; deepest region of nest(7) lands at depth 8 (== cap).
  const s = validSpec();
  s.root = nest(7);
  assert(validateLayoutSpec(s) !== null, "nest(7) (depth 8) accepted");
}

// ─── Invalid specs → null ──────────────────────────────────────────────
function rejects(mutate, msg) {
  const s = validSpec();
  mutate(s);
  assert(validateLayoutSpec(s) === null, msg);
}

// A left-heavy split chain: nest(n) has its deepest region at depth (n+1) when
// validated as a spec root (root itself is depth 1).
function nest(n) {
  if (n <= 0) return { kind: "region", id: "leaf", panels: [] };
  return {
    kind: "split",
    orientation: "horizontal",
    children: [{ kind: "region", id: "r" + n, panels: [] }, nest(n - 1)],
  };
}

{
  console.log("\n[Invalid] structural violations return null");
  assert(validateLayoutSpec(null) === null, "null rejected");
  assert(validateLayoutSpec(undefined) === null, "undefined rejected");
  assert(validateLayoutSpec("x") === null, "string rejected");
  assert(validateLayoutSpec([]) === null, "array rejected");
  rejects((s) => (s.v = 1), "v!==2 rejected");
  rejects((s) => delete s.id, "missing id rejected");
  rejects((s) => (s.id = ""), "empty id rejected");
  rejects((s) => delete s.name, "missing name rejected");
  rejects((s) => (s.builtin = "yes"), "non-boolean builtin rejected");
  rejects((s) => (s.requires = "review"), "bad requires rejected");
  rejects((s) => delete s.rail, "missing rail rejected");
  rejects((s) => (s.rail = {}), "rail without visible rejected");
  rejects((s) => delete s.root, "missing root rejected");
}
{
  console.log("\n[Invalid] node/panel violations return null");
  rejects((s) => (s.root.orientation = "diagonal"), "bad orientation rejected");
  rejects((s) => (s.root.children = [s.root.children[0]]), "split with <2 children rejected");
  rejects((s) => delete s.root.children[0].panels, "region missing panels rejected");
  rejects((s) => (s.root.children[0].panels[0].type = "bogus"), "bad panel type rejected");
  rejects(
    (s) => (s.root.children[0].panels[0].config.mode = "grid"),
    "bad config.mode rejected",
  );
  rejects((s) => (s.root.children[0].id = ""), "region empty id rejected");
  rejects((s) => (s.root.children[0].display = "grid"), "bad region display rejected");
  rejects((s) => (s.root.children[0].panels[0].id = ""), "panel empty id rejected");
  rejects((s) => (s.root.children[0].size = "big"), "non-numeric size rejected");
  rejects((s) => (s.root = nest(8)), "nesting deeper than cap rejected");
}

// ─── normalizeSizes ────────────────────────────────────────────────────
{
  console.log("\n[normalize] rescales to sum 1.0");
  const items = [{ size: 2 }, { size: 2 }];
  const out = normalizeSizes(items);
  const sum = out.reduce((a, r) => a + r.size, 0);
  assert(Math.abs(sum - 1) < 1e-9, `sizes sum to 1 (got ${sum})`);
  assert(Math.abs(out[0].size - 0.5) < 1e-9, "equal inputs → equal fractions");
  assert(items[0].size === 2, "input not mutated");
}
{
  console.log("\n[normalize] missing size treated as equal share");
  const out = normalizeSizes([{}, {}, {}]);
  const sum = out.reduce((a, r) => a + r.size, 0);
  assert(Math.abs(sum - 1) < 1e-9, `sizes sum to 1 (got ${sum})`);
  assert(Math.abs(out[0].size - 1 / 3) < 1e-9, "each missing-size item → 1/3");
}
{
  console.log("\n[normalize] clamps tiny sizes to min then rescales");
  const out = normalizeSizes([{ size: 0.001 }, { size: 0.999 }]);
  const sum = out.reduce((a, r) => a + r.size, 0);
  assert(Math.abs(sum - 1) < 1e-9, `sizes still sum to 1 (got ${sum})`);
  assert(out[0].size >= 0.09, `tiny item floored near min (got ${out[0].size})`);
}
{
  console.log("\n[normalize] empty input → empty output");
  assert(normalizeSizes([]).length === 0, "empty stays empty");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll layoutSpec tests passed.");
