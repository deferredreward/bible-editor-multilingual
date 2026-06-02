// Held-out evaluation harness for non-AI alignment suggestions.
//
// Defines "better" with a number so every scoring change (Phases 1-3 of
// docs/alignment-suggestions.md) can be measured instead of eyeballed. It:
//   1. Trains an in-memory align_freq model on every released+aligned book
//      EXCEPT the held-out set (no leakage), via scripts/lib/align-corpus.mjs —
//      the same gold-walk the production trainer uses.
//   2. For each verse in the held-out books, simulates "alignment cleared"
//      (full word bank, every group empty) and runs the CURRENT suggester.
//   3. Compares the predictions to the gold `\zaln-s` alignments.
//
// Run (from worktree root):
//   node scripts/eval-aligner.mjs                 # held-out JOS NAM ACT, bible ult
//   node scripts/eval-aligner.mjs --bible ust JON
//   node scripts/eval-aligner.mjs --k 8 RUT
// First run fetches ~60 books off DCS (cached under scripts/out/_cache).
//
// SCORING NOTE: the match/blend (computeGhosts) is imported from the shared
// web/src/lib/alignmentSuggest.ts — the same module the app renders with, so
// there is no scorer drift. Only rankSuggestions (the endpoint's freq-share
// ranking, mirrors api/src/align.ts) is reproduced here; keep that in sync.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import usfm from "usfm-js";
import {
  BOOK_NUMBERS, OT_BOOKS, NT_BOOKS, SEP, SPACE,
  normStrong, normSurface, walkAlign, usfmUrl,
} from "./lib/align-corpus.mjs";
// The real client scorer — imported (not duplicated) so the eval scores exactly
// what ships. Needs `node --experimental-strip-types` (see the npm eval:align).
import { computeGhosts } from "../web/src/lib/alignmentSuggest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cacheDir = resolve(repoRoot, "scripts/out/_cache");

// ── args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const bible = flag("--bible", "ult").toLowerCase();
const K = parseInt(flag("--k", "5"), 10);
const heldOut = argv.filter((a) => !a.startsWith("--") && BOOK_NUMBERS[a.toUpperCase()])
  .map((a) => a.toUpperCase());
const HELD_OUT = heldOut.length ? heldOut : ["JOS", "NAM", "ACT"];

const manifest = JSON.parse(readFileSync(resolve(repoRoot, "api/data/canonical.json"), "utf8"));
const res = manifest.resources.find((r) => r.bible === bible);
if (!res) {
  console.error(`No resource for bible '${bible}' in api/data/canonical.json`);
  process.exit(1);
}

// "Glue" function words whose leak onto content strongs we want to track
// (issue #3 in docs/alignment-suggestions.md). Kept tight on purpose.
const GLUE = new Set(["the", "of", "and", "a", "an", "to", "in", "for", "with", "or", "that"]);
const isGlue = (surfaces) => surfaces.every((s) => GLUE.has(s));

// ── fetch (cached) ──────────────────────────────────────────────────────
async function fetchBook(book) {
  mkdirSync(cacheDir, { recursive: true });
  const num = BOOK_NUMBERS[book];
  const cacheFile = resolve(cacheDir, `${bible}-${num}-${book}.usfm`);
  if (existsSync(cacheFile)) return readFileSync(cacheFile, "utf8");
  const url = usfmUrl(res.repo, res.ref, book);
  const r = await fetch(url);
  if (!r.ok) return null;
  const text = await r.text();
  writeFileSync(cacheFile, text);
  return text;
}

// ── 1) train model on everything except the held-out books ────────────────
const trainBooks = [...OT_BOOKS, ...NT_BOOKS].filter((b) => !HELD_OUT.includes(b));
const counts = new Map();
process.stdout.write(`Training ${bible} on ${trainBooks.length} books (excluding ${HELD_OUT.join(SPACE)}) ...\n`);
let trained = 0;
for (const book of trainBooks) {
  const text = await fetchBook(book);
  if (!text) continue;
  const json = usfm.toJSON(text);
  const stats = { pairs: 0 };
  for (const ch of Object.values(json.chapters || {})) {
    for (const v of Object.values(ch)) walkAlign(v.verseObjects || [], [], bible, counts, stats);
  }
  if (stats.pairs > 0) trained++;
}
process.stdout.write(`  trained on ${trained} aligned books, ${counts.size} (strong,surface) rows\n\n`);

// Build per-strong candidate lists from the counts map, mirroring the ranking
// in api/src/align.ts (#3 there): single words and multi-word phrases scored as
// a frequency share within their own kind.
const HAS_SPACE = /\s/;
const byStrong = new Map(); // strong -> { surface, count }[]
for (const [k, c] of counts) {
  const [b, strong, surface] = k.split(SEP);
  if (b !== bible) continue;
  const list = byStrong.get(strong) ?? [];
  list.push({ surface, count: c });
  byStrong.set(strong, list);
}
function rankSuggestions(strong) {
  const mem = byStrong.get(strong);
  if (!mem || mem.length === 0) return { words: [], phrases: [] };
  const wordRows = mem.filter((m) => !HAS_SPACE.test(m.surface));
  const phraseRows = mem.filter((m) => HAS_SPACE.test(m.surface));
  const wordTotal = wordRows.reduce((a, b) => a + b.count, 0) || 1;
  const phraseTotal = phraseRows.reduce((a, b) => a + b.count, 0) || 1;
  const words = wordRows
    .map((m) => ({ surface: m.surface, count: m.count, confidence: m.count / wordTotal }))
    .sort((a, b) => b.confidence - a.confidence).slice(0, 8);
  const phrases = phraseRows
    .map((m) => ({ phrase: m.surface, tokens: m.surface.split(/\s+/), count: m.count, confidence: m.count / phraseTotal }))
    .sort((a, b) => b.count - a.count).slice(0, 6);
  return { words, phrases };
}

// ── 2) extract gold groups + word bank per held-out verse ──────────────────
// One group per maximal run of target words sharing the same active milestone
// strong-stack (mirrors the app's compound/leaf grouping closely enough).
function verseGroupsAndBank(verseObjects) {
  const bank = [];      // { id, surface }
  const segments = [];  // { stack: [strong], surfaces: [surface], wordIds: [id] }
  let cur = null;
  const walk = (nodes, stack) => {
    for (const n of nodes || []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "milestone" && n.tag === "zaln") {
        const s = normStrong(n.strong);
        walk(n.children || [], s ? [...stack, s] : stack);
        cur = null; // a nested milestone interrupts the current run
      } else if (n.type === "word" && n.tag === "w") {
        const surf = normSurface(n.text);
        if (!surf) continue;
        const id = String(bank.length);
        bank.push({ id, surface: surf });
        if (!stack.length) { cur = null; continue; } // unaligned word: in bank, not gold
        const key = stack.join(">");
        if (cur && cur.key === key) { cur.surfaces.push(surf); cur.wordIds.push(id); }
        else { cur = { key, stack: [...stack], surfaces: [surf], wordIds: [id] }; segments.push(cur); }
      } else if (Array.isArray(n.children)) {
        walk(n.children, stack);
      }
    }
  };
  walk(verseObjects, []);
  return { bank, segments };
}

// ── 3) evaluate ────────────────────────────────────────────────────────────
const eq = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

function evalBook(json) {
  const m = {
    gold: 0, predicted: 0, correct: 0,        // coverage / precision@1
    recallHit: 0, recallDen: 0,               // recall@K over single-word gold
    phraseGold: 0, phraseHit: 0,              // multi-word gold
    contentGold: 0, fwFp: 0,                  // function-word false positives
  };
  for (const ch of Object.values(json.chapters || {})) {
    for (const v of Object.values(ch)) {
      const { bank, segments } = verseGroupsAndBank(v.verseObjects || []);
      if (segments.length === 0) continue;
      const streamWords = bank.map((w) => ({ id: w.id, text: w.surface, aligned: false }));
      const suggestions = {};
      for (const seg of segments) for (const strong of seg.stack) {
        if (!suggestions[strong]) suggestions[strong] = rankSuggestions(strong);
      }
      const groups = segments.map((seg, i) => ({ id: String(i), source: seg.stack.map((strong) => ({ strong })), targets: [] }));
      const ghosts = computeGhosts(groups, streamWords, suggestions);
      const surfOf = (id) => bank[+id].surface;

      segments.forEach((seg, i) => {
        m.gold++;
        const goldSurf = seg.surfaces;
        const content = !isGlue(goldSurf);
        if (content) m.contentGold++;
        // recall@K (model knowledge): single-word gold present in top-K words
        if (goldSurf.length === 1) {
          m.recallDen++;
          const topK = new Set(seg.stack.flatMap((s) => rankSuggestions(s).words.slice(0, K).map((w) => w.surface)));
          if (topK.has(goldSurf[0])) m.recallHit++;
        }
        if (goldSurf.length >= 2) m.phraseGold++;
        const gh = ghosts.get(String(i));
        if (!gh) return;
        m.predicted++;
        const predSurf = gh.wordIds.map(surfOf);
        const hit = eq(predSurf, goldSurf);
        if (hit) m.correct++;
        if (goldSurf.length >= 2 && hit) m.phraseHit++;
        if (content && predSurf.length === 1 && GLUE.has(predSurf[0])) m.fwFp++;
      });
    }
  }
  return m;
}

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : "  - ").padStart(5);
const rows = [];
const total = { gold: 0, predicted: 0, correct: 0, recallHit: 0, recallDen: 0, phraseGold: 0, phraseHit: 0, contentGold: 0, fwFp: 0 };
for (const book of HELD_OUT) {
  const text = await fetchBook(book);
  if (!text) { console.warn(`  ${book}: not found at ${res.ref} - skip`); continue; }
  const m = evalBook(usfm.toJSON(text));
  if (m.gold === 0) { console.warn(`  ${book}: 0 gold groups (not aligned?) - skip`); continue; }
  for (const k of Object.keys(total)) total[k] += m[k];
  rows.push([book, m]);
}

console.log(`\nHeld-out eval — bible=${bible}, K=${K}`);
console.log("book   gold  cover%  prec@1  rec@" + K + "%  phrase    fw-fp%");
const line = (label, m) =>
  `${label.padEnd(5)} ${String(m.gold).padStart(5)}  ${pct(m.predicted, m.gold)}  ${pct(m.correct, m.predicted)}  ` +
  `${pct(m.recallHit, m.recallDen)}  ${String(m.phraseHit).padStart(4)}/${String(m.phraseGold).padStart(4)}  ${pct(m.fwFp, m.contentGold)}`;
for (const [book, m] of rows) console.log(line(book, m));
console.log("-".repeat(58));
console.log(line("ALL", total));
console.log(
  "\nlegend: cover% = groups with a suggestion; prec@1 = of those, exact-gold;\n" +
  `        rec@${K}% = single-word gold in model top-${K}; phrase = exact multi-word hits;\n` +
  "        fw-fp% = content groups whose top suggestion is a glue word (lower is better).",
);
