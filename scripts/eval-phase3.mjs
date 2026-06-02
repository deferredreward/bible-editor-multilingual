// Phase 3 PROTOTYPE / experiment harness (measurement only — no production or
// D1 changes). Answers: does a corpus co-occurrence FALLBACK track help, and
// does the Phase 2 uniqueness/IDF term — net-negative on its own — flip positive
// once noisy corpus candidates are in play?
//
// Runs a 2x2 matrix over the held-out books (JOS/NAM/ACT):
//        corpus-fallback {off,on}  ×  uniqueness {off,on}
// The {off,off} cell must reproduce the shipped Phase 1 numbers (prec@1 ~60.1,
// fw-fp ~6.7) — that is the proof the prototype scorer is faithful before we
// trust the other three cells.
//
// Self-contained on purpose (own scorer copy + flags) so production stays clean;
// if a cell clears the bar we productionize into web/src/lib/alignmentSuggest.ts
// + the endpoint + an align_cooc D1 table. Run: node scripts/eval-phase3.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import usfm from "usfm-js";
import {
  BOOK_NUMBERS, OT_BOOKS, NT_BOOKS, SEP, SPACE,
  normStrong, normSurface, walkAlign, usfmUrl,
} from "./lib/align-corpus.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cacheDir = resolve(repoRoot, "scripts/out/_cache");

const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const bible = flag("--bible", "ult").toLowerCase();
const K = parseInt(flag("--k", "5"), 10);
const CORPUS_K = 8; // max corpus fallback candidates per strong
const heldOut = argv.filter((a) => !a.startsWith("--") && BOOK_NUMBERS[a.toUpperCase()]).map((a) => a.toUpperCase());
const HELD_OUT = heldOut.length ? heldOut : ["JOS", "NAM", "ACT"];

const manifest = JSON.parse(readFileSync(resolve(repoRoot, "api/data/canonical.json"), "utf8"));
const res = manifest.resources.find((r) => r.bible === bible);
if (!res) { console.error(`No resource for bible '${bible}'`); process.exit(1); }

const GLUE = new Set(["the", "of", "and", "a", "an", "to", "in", "for", "with", "or", "that"]);
const isGlue = (surfaces) => surfaces.every((s) => GLUE.has(s));
const BLEND_WEIGHTS = { freq: 0.7, position: 0.7, occurrence: 0.4, uniqueness: 0.5 };
const HAS_SPACE = /\s/;

async function fetchBook(book) {
  mkdirSync(cacheDir, { recursive: true });
  const num = BOOK_NUMBERS[book];
  const cacheFile = resolve(cacheDir, `${bible}-${num}-${book}.usfm`);
  if (existsSync(cacheFile)) return readFileSync(cacheFile, "utf8");
  const r = await fetch(usfmUrl(res.repo, res.ref, book));
  if (!r.ok) return null;
  const text = await r.text();
  writeFileSync(cacheFile, text);
  return text;
}

// ── scorer internals (copied from web/src/lib/alignmentSuggest.ts so the
// {off,off} cell reproduces Phase 1; faithfulness is checked at runtime) ──────
function stemWord(w) {
  let s = w.toLowerCase().normalize("NFC").replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  s = s.replace(/'s$/, "");
  for (const suf of ["ing", "edly", "ed", "es", "ly", "s"]) {
    if (s.length > suf.length + 2 && s.endsWith(suf)) return s.slice(0, -suf.length);
  }
  return s;
}
function surfaceMatch(candidate, word) {
  const a = candidate.toLowerCase().normalize("NFC");
  const b = word.toLowerCase().normalize("NFC");
  if (a === b) return true;
  const sa = stemWord(a);
  return sa.length >= 3 && sa === stemWord(b);
}
function weightedAverage(parts) {
  let s = 0, w = 0;
  for (const p of parts) { s += p.score * p.weight; w += p.weight; }
  return w ? s / w : 0;
}
const rel = (i, len) => (len > 0 ? (i + 1) / len : 0);
function blend(freqConf, srcRel, tgtRel, srcOcc, tgtOcc, uniqueness) {
  const parts = [
    { score: freqConf, weight: BLEND_WEIGHTS.freq },
    { score: 1 - Math.abs(srcRel - tgtRel), weight: BLEND_WEIGHTS.position },
    { score: srcOcc > 0 && tgtOcc > 0 ? Math.min(srcOcc, tgtOcc) / Math.max(srcOcc, tgtOcc) : 0, weight: BLEND_WEIGHTS.occurrence },
  ];
  if (uniqueness !== undefined) parts.push({ score: uniqueness, weight: BLEND_WEIGHTS.uniqueness });
  return weightedAverage(parts);
}

// computeGhosts with two flags. cfg.corpus adds a gold-priority corpus fallback
// (tier 2, fires only where gold matched nothing); cfg.uniq adds the uniqueness
// term to the word blend (gold + corpus). Phrases are gold-only and never use
// uniqueness — identical across all four cells.
function computeGhostsP3(groups, streamWords, goldSugg, corpusWords, cfg) {
  const result = new Map();
  const claimed = new Set();
  const numStream = streamWords.length;
  if (numStream === 0) return result;
  const numGroups = groups.length || 1;
  const srcOccByStrong = new Map();
  for (const g of groups) {
    const seen = new Set();
    for (const s of g.source) { if (seen.has(s.strong)) continue; seen.add(s.strong); srcOccByStrong.set(s.strong, (srcOccByStrong.get(s.strong) ?? 0) + 1); }
  }
  const tgtOccCache = new Map();
  const tgtOcc = (surface) => {
    if (tgtOccCache.has(surface)) return tgtOccCache.get(surface);
    let n = 0; for (const w of streamWords) if (surfaceMatch(surface, w.text)) n++;
    tgtOccCache.set(surface, n); return n;
  };
  const order = new Map(); groups.forEach((g, i) => order.set(g.id, i));
  const srcRelOf = (g) => rel(order.get(g.id) ?? 0, numGroups);
  const empty = groups.filter((g) => g.targets.length === 0);

  // Pass 1 — phrases (gold only).
  for (const g of empty) {
    const srcRel = srcRelOf(g);
    let best = null;
    for (const s of g.source) {
      const srcOcc = srcOccByStrong.get(s.strong) ?? 1;
      for (const p of goldSugg(s.strong).phrases) {
        const len = p.tokens.length;
        for (let i = 0; i + len <= numStream; i++) {
          let ok = true;
          for (let j = 0; j < len; j++) { const w = streamWords[i + j]; if (w.aligned || claimed.has(w.id) || !surfaceMatch(p.tokens[j], w.text)) { ok = false; break; } }
          if (!ok) continue;
          const score = blend(p.confidence, srcRel, rel(i + (len - 1) / 2, numStream), srcOcc, srcOcc, undefined);
          if (!best || score > best.score) best = { score, run: streamWords.slice(i, i + len) };
        }
      }
    }
    if (best) { best.run.forEach((w) => claimed.add(w.id)); result.set(g.id, { wordIds: best.run.map((w) => w.id) }); }
  }

  // Pass 2 — single word. Tier 1 = gold; tier 2 (only if tier 1 found nothing
  // for this group) = corpus fallback. Mirrors wordMAP's gold-preference.
  const wordTier = (g, candsFor) => {
    const srcRel = srcRelOf(g);
    let best = null;
    for (const s of g.source) {
      const srcOcc = srcOccByStrong.get(s.strong) ?? 1;
      for (const cand of candsFor(s.strong)) {
        const occ = tgtOcc(cand.surface);
        const uniq = cfg.uniq ? cand.uniqueness : undefined;
        for (let wi = 0; wi < numStream; wi++) {
          const w = streamWords[wi];
          if (w.aligned || claimed.has(w.id) || !surfaceMatch(cand.surface, w.text)) continue;
          const score = blend(cand.confidence, srcRel, rel(wi, numStream), srcOcc, occ, uniq);
          if (!best || score > best.score) best = { score, word: w };
        }
      }
    }
    return best;
  };
  // Pass 2a — gold words for ALL groups first, so a corpus guess on an early
  // group can never steal a word a later group's gold legitimately needs.
  for (const g of empty) {
    if (result.has(g.id)) continue;
    const best = wordTier(g, (strong) => goldSugg(strong).words);
    if (best) { claimed.add(best.word.id); result.set(g.id, { wordIds: [best.word.id] }); }
  }
  // Pass 2b — corpus fallback claims only leftover words.
  if (cfg.corpus) {
    for (const g of empty) {
      if (result.has(g.id)) continue;
      const best = wordTier(g, (strong) => corpusWords(strong));
      if (best) { claimed.add(best.word.id); result.set(g.id, { wordIds: [best.word.id] }); }
    }
  }
  return result;
}

// gold groups + word bank per held-out verse (same as eval-aligner.mjs)
function verseGroupsAndBank(verseObjects) {
  const bank = []; const segments = []; let cur = null;
  const walk = (nodes, stack) => {
    for (const n of nodes || []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "milestone" && n.tag === "zaln") { const s = normStrong(n.strong); walk(n.children || [], s ? [...stack, s] : stack); cur = null; }
      else if (n.type === "word" && n.tag === "w") {
        const surf = normSurface(n.text); if (!surf) continue;
        const id = String(bank.length); bank.push({ id, surface: surf });
        if (!stack.length) { cur = null; continue; }
        const key = stack.join(">");
        if (cur && cur.key === key) { cur.surfaces.push(surf); cur.wordIds.push(id); }
        else { cur = { key, stack: [...stack], surfaces: [surf], wordIds: [id] }; segments.push(cur); }
      } else if (Array.isArray(n.children)) walk(n.children, stack);
    }
  };
  walk(verseObjects, []);
  return { bank, segments };
}

// ── 1) train gold model + 2) corpus co-occurrence (needed strongs only) ──────
const trainBooks = [...OT_BOOKS, ...NT_BOOKS].filter((b) => !HELD_OUT.includes(b));
process.stdout.write(`Training ${bible} on ${trainBooks.length} books (excluding ${HELD_OUT.join(SPACE)}) ...\n`);

// strongs we actually need candidates for (from held-out gold)
const needed = new Set();
const heldOutJson = {};
for (const book of HELD_OUT) {
  const text = await fetchBook(book);
  if (!text) continue;
  heldOutJson[book] = usfm.toJSON(text);
  const collect = (nodes) => { for (const n of nodes || []) { if (!n || typeof n !== "object") continue; if (n.type === "milestone" && n.tag === "zaln") { const s = normStrong(n.strong); if (s) needed.add(s); collect(n.children); } else if (Array.isArray(n.children)) collect(n.children); } };
  for (const ch of Object.values(heldOutJson[book].chapters || {})) for (const v of Object.values(ch)) collect(v.verseObjects || []);
}

const counts = new Map();           // gold (strong,surface) counts
const cooc = new Map();             // strong -> Map(surface -> co-occurring verse count) [needed strongs]
const strongDoc = new Map();        // strong -> verses containing it [needed]
const surfaceDoc = new Map();       // surface -> verses containing it [all]
let nVerses = 0;
for (const book of trainBooks) {
  const text = await fetchBook(book);
  if (!text) continue;
  const json = usfm.toJSON(text);
  for (const ch of Object.values(json.chapters || {})) {
    for (const v of Object.values(ch)) {
      const stats = { pairs: 0 };
      walkAlign(v.verseObjects || [], [], bible, counts, stats); // gold memory
      // corpus co-occurrence over the whole verse (NOT just gold-aligned pairs)
      const vStrongs = new Set(); const vSurfaces = new Set();
      const scan = (nodes) => { for (const n of nodes || []) { if (!n || typeof n !== "object") continue; if (n.type === "milestone" && n.tag === "zaln") { const s = normStrong(n.strong); if (s && needed.has(s)) vStrongs.add(s); scan(n.children); } else if (n.type === "word" && n.tag === "w") { const su = normSurface(n.text); if (su && !HAS_SPACE.test(su)) vSurfaces.add(su); } else if (Array.isArray(n.children)) scan(n.children); } };
      scan(v.verseObjects || []);
      if (vSurfaces.size === 0) continue;
      nVerses++;
      for (const su of vSurfaces) surfaceDoc.set(su, (surfaceDoc.get(su) ?? 0) + 1);
      for (const st of vStrongs) {
        strongDoc.set(st, (strongDoc.get(st) ?? 0) + 1);
        let m = cooc.get(st); if (!m) { m = new Map(); cooc.set(st, m); }
        for (const su of vSurfaces) m.set(su, (m.get(su) ?? 0) + 1);
      }
    }
  }
}
process.stdout.write(`  gold rows ${counts.size}; corpus tracked for ${cooc.size}/${needed.size} needed strongs over ${nVerses} verses\n\n`);

// uniqueness = corpus IDF over verses, defined for every training surface.
const lnN = Math.log(nVerses || 2);
const uniqOf = (surface) => { const dfv = surfaceDoc.get(surface) ?? 1; const u = Math.log((nVerses || 2) / dfv) / lnN; return Math.max(0, Math.min(1, u)); };

// gold candidates (freq share within kind) — mirrors api/src/align.ts
const byStrong = new Map();
for (const [k, c] of counts) { const [b, st, su] = k.split(SEP); if (b !== bible) continue; const l = byStrong.get(st) ?? []; l.push({ surface: su, count: c }); byStrong.set(st, l); }
const goldCache = new Map();
function goldSugg(strong) {
  if (goldCache.has(strong)) return goldCache.get(strong);
  const mem = byStrong.get(strong) ?? [];
  const wordRows = mem.filter((m) => !HAS_SPACE.test(m.surface));
  const phraseRows = mem.filter((m) => HAS_SPACE.test(m.surface));
  const wt = wordRows.reduce((a, b) => a + b.count, 0) || 1;
  const pt = phraseRows.reduce((a, b) => a + b.count, 0) || 1;
  const out = {
    words: wordRows.map((m) => ({ surface: m.surface, confidence: m.count / wt, uniqueness: uniqOf(m.surface) })).sort((a, b) => b.confidence - a.confidence).slice(0, 8),
    phrases: phraseRows.map((m) => ({ tokens: m.surface.split(/\s+/), confidence: m.count / pt, count: m.count })).sort((a, b) => b.count - a.count).slice(0, 6),
  };
  goldCache.set(strong, out); return out;
}
// corpus fallback candidates: conditional p(surface|strong), excluding gold surfaces
const corpusCache = new Map();
function corpusWords(strong) {
  if (corpusCache.has(strong)) return corpusCache.get(strong);
  const m = cooc.get(strong); const sd = strongDoc.get(strong);
  if (!m || !sd) { corpusCache.set(strong, []); return []; }
  const goldSurf = new Set(goldSugg(strong).words.map((w) => w.surface));
  const out = [...m.entries()]
    .filter(([su]) => !goldSurf.has(su))
    .map(([su, c]) => ({ surface: su, confidence: c / sd, uniqueness: uniqOf(su) }))
    .sort((a, b) => b.confidence - a.confidence).slice(0, CORPUS_K);
  corpusCache.set(strong, out); return out;
}

// ── 3) evaluate each cell ────────────────────────────────────────────────────
const eq = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
function evalCell(cfg) {
  const m = { gold: 0, predicted: 0, correct: 0, phraseGold: 0, phraseHit: 0, contentGold: 0, fwFp: 0 };
  for (const book of HELD_OUT) {
    const json = heldOutJson[book]; if (!json) continue;
    for (const ch of Object.values(json.chapters || {})) {
      for (const v of Object.values(ch)) {
        const { bank, segments } = verseGroupsAndBank(v.verseObjects || []);
        if (!segments.length) continue;
        const streamWords = bank.map((w) => ({ id: w.id, text: w.surface, aligned: false }));
        const groups = segments.map((seg, i) => ({ id: String(i), source: seg.stack.map((strong) => ({ strong })), targets: [] }));
        const ghosts = computeGhostsP3(groups, streamWords, goldSugg, corpusWords, cfg);
        segments.forEach((seg, i) => {
          m.gold++;
          const gold = seg.surfaces; const content = !isGlue(gold);
          if (content) m.contentGold++;
          if (gold.length >= 2) m.phraseGold++;
          const gh = ghosts.get(String(i)); if (!gh) return;
          m.predicted++;
          const pred = gh.wordIds.map((id) => bank[+id].surface);
          const hit = eq(pred, gold);
          if (hit) m.correct++;
          if (gold.length >= 2 && hit) m.phraseHit++;
          if (content && pred.length === 1 && GLUE.has(pred[0])) m.fwFp++;
        });
      }
    }
  }
  return m;
}

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : "  - ").padStart(6);
const cells = [
  ["P1            (corpus off, uniq off)", { corpus: false, uniq: false }],
  ["P1+P2         (corpus off, uniq on )", { corpus: false, uniq: true }],
  ["P1+P3         (corpus on , uniq off)", { corpus: true, uniq: false }],
  ["P1+P2+P3      (corpus on , uniq on )", { corpus: true, uniq: true }],
];
console.log(`Phase 3 prototype — bible=${bible}, held-out=${HELD_OUT.join(",")}\n`);
console.log("config                                  cover%  prec@1  phrase     fw-fp%");
for (const [label, cfg] of cells) {
  const m = evalCell(cfg);
  console.log(`${label}  ${pct(m.predicted, m.gold)}  ${pct(m.correct, m.predicted)}  ${String(m.phraseHit).padStart(4)}/${String(m.phraseGold).padStart(5)}  ${pct(m.fwFp, m.contentGold)}`);
}
console.log("\n(gold groups constant across cells; the {off,off} row should match the shipped Phase 1: prec@1 ~60.1, fw-fp ~6.7)");
