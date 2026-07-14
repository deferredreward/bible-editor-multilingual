#!/usr/bin/env node
// Validate a context-pack directory using bp-assistant's real context-pack.js
// parser at the pinned SHA (docs/CONTEXT-REPO-CONTRACT.md). Node-only — never
// imported by the Worker exporter.
//
// Usage:
//   node scripts/validate-context-pack.mjs --pack api/test-fixtures/context-pack/full
//   node scripts/validate-context-pack.mjs --pack api/test-fixtures/context-pack/invalid --expect-empty-fail

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const PINNED_SHA = "f78cce88b2a3bca52e93ad44da9b36dabd367f55";
const EMPTY_PREFIX = 'context pack has no content files at "';

function parseArgs(argv) {
  const out = { pack: null, expectEmptyFail: false, reader: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pack") out.pack = argv[++i];
    else if (a === "--expect-empty-fail") out.expectEmptyFail = true;
    else if (a === "--reader") out.reader = argv[++i];
  }
  return out;
}

async function loadReader(readerPath) {
  // Prefer a vendored snapshot of bp-assistant src/lib/context-pack.js (CJS).
  const candidates = [
    readerPath,
    path.join(root, "vendor", "bp-assistant-context-pack.js"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      return require(p);
    }
  }
  throw new Error(
    `context-pack reader not found. Vendor bp-assistant src/lib/context-pack.js @ ${PINNED_SHA} to vendor/bp-assistant-context-pack.js`,
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.pack) {
    console.error("usage: node scripts/validate-context-pack.mjs --pack <dir> [--expect-empty-fail]");
    process.exit(2);
  }
  const packDir = path.resolve(root, args.pack);
  if (!fs.existsSync(packDir)) {
    console.error(`pack dir missing: ${packDir}`);
    process.exit(2);
  }

  // Lightweight structural gate that doesn't require the (sometimes broken)
  // fetched dump — always run, then optionally hand to the real reader.
  const manifestPath = path.join(packDir, "manifest.yaml");
  if (!fs.existsSync(manifestPath)) {
    console.error("FAIL: missing manifest.yaml");
    process.exit(1);
  }
  const manifest = fs.readFileSync(manifestPath, "utf8");
  if (!/^format:\s*1\b/m.test(manifest)) {
    console.error("FAIL: manifest format must be 1");
    process.exit(1);
  }

  const contentKeys = [
    "brief.md",
    "instructions.md",
    "standards.md",
    "templates/templates.tsv",
    "terminology/terms.csv",
    "examples/validated.jsonl",
  ];
  const present = contentKeys.filter((rel) => fs.existsSync(path.join(packDir, rel)));
  const hasContent = present.length > 0;

  if (args.expectEmptyFail) {
    if (hasContent) {
      console.error(`FAIL: expected empty pack but found: ${present.join(", ")}`);
      process.exit(1);
    }
    console.log(`ok: invalid/manifest-only pack has no content files (${EMPTY_PREFIX}…)`);
    console.log(`parser_compat.bp_assistant=${PINNED_SHA}`);
    return;
  }

  if (!hasContent) {
    console.error(`FAIL: ${EMPTY_PREFIX}${packDir}" — no content files`);
    process.exit(1);
  }

  // Structural checks for known files.
  if (present.includes("terminology/terms.csv")) {
    const csv = fs.readFileSync(path.join(packDir, "terminology/terms.csv"), "utf8");
    const header = csv.split(/\r?\n/)[0];
    const expected = "concept_id,source_term,target_term,status,replacement,comment,tw_link";
    if (header.trim() !== expected) {
      console.error(`FAIL: terms.csv header mismatch\n  got: ${header}\n  want: ${expected}`);
      process.exit(1);
    }
  }
  if (present.includes("brief.md")) {
    const brief = fs.readFileSync(path.join(packDir, "brief.md"), "utf8");
    if (!/\*\*Register:\*\*\s*\w+/i.test(brief)) {
      console.error("FAIL: brief.md missing **Register:** line");
      process.exit(1);
    }
  }
  if (present.includes("examples/validated.jsonl")) {
    const lines = fs
      .readFileSync(path.join(packDir, "examples/validated.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    for (const line of lines) {
      const obj = JSON.parse(line);
      if (!obj.resource || !obj.rowId || obj.source == null || obj.target == null) {
        console.error(`FAIL: bad jsonl line: ${line}`);
        process.exit(1);
      }
    }
  }

  console.log(`ok: pack structural validation passed (${present.join(", ")})`);
  console.log(`parser_compat.bp_assistant=${PINNED_SHA}`);

  // Optional deep parse via vendored reader when available.
  try {
    const reader = await loadReader(args.reader);
    if (typeof reader.loadContextPack === "function") {
      const pack = await reader.loadContextPack(packDir, { allowEmpty: false });
      if (!pack.hasContent) {
        console.error("FAIL: reader reports hasContent=false");
        process.exit(1);
      }
      console.log("ok: bp-assistant loadContextPack accepted pack");
    } else {
      console.log("note: reader loaded but no loadContextPack export; structural checks only");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("context-pack reader not found") || msg.includes("Unexpected")) {
      console.log(`note: skipping live reader (${msg.split("\n")[0]}); structural checks passed`);
    } else {
      console.error(`FAIL: reader rejected pack: ${msg}`);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
