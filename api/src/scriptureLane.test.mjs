import assert from "node:assert/strict";
import {
  bibleVersionForLane,
  laneForBibleVersion,
  defaultLaneConfig,
  bsojLaneConfig,
  parseLaneConfig,
  configHash,
  allowVersePatch,
  activeVersesWhere,
  origSourceGeneration,
} from "./scriptureLane.ts";
import { PRESETS } from "./projectConfig.ts";

// ── bibleVersionForLane / laneForBibleVersion ────────────────────────────────

{
  assert.equal(bibleVersionForLane("lit"), "ULT");
  assert.equal(bibleVersionForLane("sim"), "UST");
  assert.equal(laneForBibleVersion("ULT"), "lit");
  assert.equal(laneForBibleVersion("UST"), "sim");
  assert.equal(laneForBibleVersion("ult"), "lit");
  assert.equal(laneForBibleVersion("UHB"), null);
  assert.equal(laneForBibleVersion("UGNT"), null);
  assert.equal(laneForBibleVersion("XYZ"), null);
}

// ── bsojLaneConfig ───────────────────────────────────────────────────────────

{
  const lit = bsojLaneConfig("lit");
  assert.equal(lit.label, "AVD");
  assert.equal(lit.source.repo, "ar_avd");
  assert.equal(lit.textReadOnly, true);
  assert.equal(lit.alignmentWritable, true);

  const sim = bsojLaneConfig("sim");
  assert.equal(sim.label, "NAV");
  assert.equal(sim.source.repo, "ar_nav");
  assert.equal(sim.textReadOnly, true);
  assert.equal(sim.alignmentWritable, true);
}

// ── defaultLaneConfig ────────────────────────────────────────────────────────

{
  const enCfg = PRESETS["en-unfoldingword"];
  const litCfg = defaultLaneConfig(enCfg, "lit");
  assert.equal(litCfg.label, "ULT");
  assert.equal(litCfg.source.owner, "unfoldingWord");
  assert.equal(litCfg.source.repo, "en_ult");
  assert.equal(litCfg.textReadOnly, false);
  assert.equal(litCfg.alignmentWritable, true);
}

// ── configHash ───────────────────────────────────────────────────────────────

{
  const cfg1 = bsojLaneConfig("lit");
  const cfg2 = bsojLaneConfig("lit");
  assert.equal(configHash(cfg1), configHash(cfg2));

  const cfg3 = bsojLaneConfig("sim");
  assert.notEqual(configHash(cfg1), configHash(cfg3));
}

// ── parseLaneConfig ──────────────────────────────────────────────────────────

{
  const cfg = bsojLaneConfig("lit");
  const json = JSON.stringify(cfg);
  const parsed = parseLaneConfig(json);
  assert.equal(parsed.label, "AVD");
  assert.equal(parsed.source.repo, "ar_avd");
}

// ── allowVersePatch permission matrix ────────────────────────────────────────

// Fully open
{
  const cfg = { label: "X", source: { owner: "o", repo: "r", ref: "m" }, export: null, textReadOnly: false, alignmentWritable: true };
  assert.ok(allowVersePatch(cfg, "text_edit").ok);
  assert.ok(allowVersePatch(cfg, "alignment_edit").ok);
  assert.ok(allowVersePatch(cfg, "find_replace").ok);
  assert.ok(allowVersePatch(cfg, "section_edit").ok);
}

// Text locked, alignment open (BSOJ-style)
{
  const cfg = bsojLaneConfig("lit");
  assert.ok(!allowVersePatch(cfg, "text_edit").ok);
  assert.ok(!allowVersePatch(cfg, "find_replace").ok);
  assert.ok(!allowVersePatch(cfg, "section_edit").ok);
  assert.ok(allowVersePatch(cfg, "alignment_edit").ok);
}

// Text open, alignment locked
{
  const cfg = { label: "X", source: { owner: "o", repo: "r", ref: "m" }, export: null, textReadOnly: false, alignmentWritable: false };
  assert.ok(allowVersePatch(cfg, "text_edit").ok);
  assert.ok(!allowVersePatch(cfg, "alignment_edit").ok);
}

// Both locked
{
  const cfg = { label: "X", source: { owner: "o", repo: "r", ref: "m" }, export: null, textReadOnly: true, alignmentWritable: false };
  assert.ok(!allowVersePatch(cfg, "text_edit").ok);
  assert.ok(!allowVersePatch(cfg, "alignment_edit").ok);
  assert.ok(!allowVersePatch(cfg, "find_replace").ok);
}

// ── activeVersesWhere ────────────────────────────────────────────────────────

{
  assert.equal(activeVersesWhere(), "v.source_generation = ?");
  assert.equal(activeVersesWhere("x"), "x.source_generation = ?");
}

// ── origSourceGeneration ─────────────────────────────────────────────────────

{
  assert.equal(origSourceGeneration(), 1);
}

console.log("scriptureLane tests passed");
