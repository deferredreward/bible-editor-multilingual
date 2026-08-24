// lanePresetReconcile.test.mjs — project-mode switch must rewrite lane rows.
import assert from "node:assert/strict";
import {
  planLaneReconcile,
  sameLaneSource,
  desiredLaneConfig,
  bsojLaneConfig,
  defaultLaneConfig,
} from "./scriptureLane.ts";
import { PRESETS } from "./projectConfig.ts";

const legacyGlt = {
  label: "LEGACY",
  source: { owner: "BSOJ", repo: "ar_glt", ref: "master" },
  export: null,
  textReadOnly: true,
  alignmentWritable: false,
};

const mlTest = PRESETS["en-bible-editor-ml-test"];
const arBsoj = PRESETS["ar-bsoj"];

assert.equal(
  sameLaneSource(legacyGlt, bsojLaneConfig("lit")),
  false,
  "LEGACY glt is not AVD",
);

{
  const desired = desiredLaneConfig(mlTest, "lit");
  assert.equal(desired.source.owner, "BibleEditorMLTest");
  assert.equal(desired.source.repo, "en_glt");
  assert.equal(desired.label, "GLT");

  const plan = planLaneReconcile(legacyGlt, desired, 10);
  assert.equal(plan.action, "quarantine");
  if (plan.action === "quarantine") {
    assert.equal(plan.provenance.source.repo, "ar_glt");
    assert.equal(plan.pending.source.owner, "BibleEditorMLTest");
    assert.equal(plan.pending.source.repo, "en_glt");
    assert.equal(plan.pending.label, "GLT");
  }
  console.log("  ✓ BSOJ LEGACY + content → MLTest quarantine pending en_glt");
}

{
  const desired = desiredLaneConfig(arBsoj, "lit");
  const plan = planLaneReconcile(legacyGlt, desired, 10);
  assert.equal(plan.action, "quarantine");
  if (plan.action === "quarantine") {
    assert.equal(plan.pending.label, "AVD");
    assert.equal(plan.pending.source.repo, "ar_avd");
  }
  console.log("  ✓ BSOJ LEGACY + content → ar-bsoj pending AVD");
}

{
  const desired = desiredLaneConfig(mlTest, "lit");
  const plan = planLaneReconcile(legacyGlt, desired, 0);
  assert.equal(plan.action, "install");
  if (plan.action === "install") {
    assert.equal(plan.config.source.repo, "en_glt");
  }
  console.log("  ✓ no content → install desired (no quarantine)");
}

{
  const desired = desiredLaneConfig(mlTest, "lit");
  const already = defaultLaneConfig(mlTest, "lit");
  const plan = planLaneReconcile(already, desired, 5);
  assert.equal(plan.action, "install");
  console.log("  ✓ matching source + content → install (clear sticky quarantine)");
}

{
  // DCS/Gitea resolves owner and repo names case-insensitively. A real BSOJ
  // workspace had its lane source persisted as owner "bsoj" while the preset
  // (and the detect path) say "BSOJ" — the raw-string compare called that a
  // source CHANGE, so a populated lane quarantined and the config PUT 409'd
  // lane_source_change_requires_migration with no way out of the loop.
  const desiredAvd = bsojLaneConfig("lit");
  const miscased = {
    ...desiredAvd,
    source: { ...desiredAvd.source, owner: "bsoj", repo: "AR_AVD" },
  };
  assert.equal(sameLaneSource(miscased, desiredAvd), true, "case-only owner/repo difference is the same source");
  // A missing ref still defaults to master on BOTH sides.
  assert.equal(
    sameLaneSource({ ...miscased, source: { owner: "bsoj", repo: "ar_avd" } }, desiredAvd),
    true,
    "absent ref defaults to master",
  );
  // Git refs stay case-SENSITIVE — branch names are.
  assert.equal(
    sameLaneSource({ ...desiredAvd, source: { ...desiredAvd.source, ref: "Master" } }, desiredAvd),
    false,
    "a differently-cased git ref is NOT the same source",
  );
  // And a populated lane whose source differs only in case must INSTALL (adopt
  // the canonical casing), never quarantine.
  const plan = planLaneReconcile(miscased, desiredAvd, 42);
  assert.equal(plan.action, "install");
  console.log("  ✓ case-only owner/repo difference → same source, install (no 409 loop)");
}

console.log("lanePresetReconcile.test.mjs: all passed");
