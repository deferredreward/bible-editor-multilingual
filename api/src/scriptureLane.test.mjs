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
  planReplacementBooks,
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

// ── planReplacementBooks (issue #94 selective replacement) ───────────────────

const REQUIRED = ["GEN", "JOL", "MAL", "OBA"];

// undefined selection → replace all, nothing carried (unchanged whole-lane path)
{
  const plan = planReplacementBooks(REQUIRED);
  assert.deepEqual(plan.staged, REQUIRED);
  assert.deepEqual(plan.carryForward, []);
  // returns a copy, not the same array reference
  assert.notEqual(plan.staged, REQUIRED);
}

// subset selection → staged = selected, carryForward = complement (both in
// requiredBooks order regardless of the selection's order)
{
  const plan = planReplacementBooks(REQUIRED, ["MAL", "GEN"]);
  assert.deepEqual(plan.staged, ["GEN", "MAL"]);
  assert.deepEqual(plan.carryForward, ["JOL", "OBA"]);
}

// empty selection → replace nothing, carry everything forward
{
  const plan = planReplacementBooks(REQUIRED, []);
  assert.deepEqual(plan.staged, []);
  assert.deepEqual(plan.carryForward, REQUIRED);
}

// full selection → carryForward empty (equivalent to whole-lane replace)
{
  const plan = planReplacementBooks(REQUIRED, [...REQUIRED]);
  assert.deepEqual(plan.staged, REQUIRED);
  assert.deepEqual(plan.carryForward, []);
}

// unknown book → throws unknown_books (400), never silently dropped
{
  let threw = null;
  try {
    planReplacementBooks(REQUIRED, ["MAL", "REV"]);
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, "expected planReplacementBooks to throw on an unknown book");
  assert.equal(threw.message, "unknown_books");
  assert.equal(threw.status, 400);
  assert.deepEqual(threw.detail.unknown, ["REV"]);
}

console.log("scriptureLane tests passed");
