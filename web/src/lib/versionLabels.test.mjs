import assert from "node:assert";
import { versionLabel } from "./versionLabels.ts";

// Minimal config stand-ins — only the label fields matter here.
const en = {
  litLabel: "ULT",
  simLabel: "UST",
  origHebrewLabel: "UHB",
  origGreekLabel: "UGNT",
};
const gl = {
  litLabel: "GLT",
  simLabel: "GST",
  origHebrewLabel: "UHB",
  origGreekLabel: "UGNT",
};
const arabic = {
  litLabel: "GLT",
  simLabel: "GST",
  origHebrewLabel: "التوراة العبرية",
  origGreekLabel: "UGNT",
};

let pass = 0;
function check(name, got, want) {
  assert.strictEqual(got, want, `${name}: expected "${want}", got "${got}"`);
  pass++;
  console.log(`  ok: ${name}`);
}

// Role codes map to the project's display labels.
check("en ULT → ULT", versionLabel(en, "ULT"), "ULT");
check("en UST → UST", versionLabel(en, "UST"), "UST");
check("gl ULT → GLT", versionLabel(gl, "ULT"), "GLT");
check("gl UST → GST", versionLabel(gl, "UST"), "GST");
check("gl UHB → UHB", versionLabel(gl, "UHB"), "UHB");
check("gl UGNT → UGNT", versionLabel(gl, "UGNT"), "UGNT");

// Originals can carry a native label per project.
check("arabic UHB → native", versionLabel(arabic, "UHB"), "التوراة العبرية");

// Unknown role codes pass through unchanged.
check("unknown code passthrough", versionLabel(gl, "NAV"), "NAV");

// Null config (first paint / offline) falls back to the role code.
check("null cfg → role code", versionLabel(null, "ULT"), "ULT");

// Older-schema config missing the originals labels falls back to the role code.
check(
  "missing origHebrewLabel → role code",
  versionLabel({ litLabel: "GLT", simLabel: "GST" }, "UHB"),
  "UHB",
);

console.log(`\nversionLabels: all ${pass} assertions passed.`);
