// Phase 4 PROTOTYPE (measurement only) — morphology-conditioned ranking.
//
// The gold milestones carry x-morph (e.g. "He,Ncmsc" = construct, "He,Ncmsa" =
// absolute) which the trainer currently discards. Rendering often depends on it
// (construct → "land of" vs absolute → "the land"; verb stem; number). We
// condition the FREQ term on a coarse morph class via interpolation backoff:
//     conf = λ·P(surface | strong, morph) + (1-λ)·P(surface | strong),
//     λ = n_sm / (n_sm + K)
// so where the (strong,morph) cell is thin it falls back to Phase 1 and can't
// hurt. Everything else (position, occurrence, the two-pass match) is Phase 1.
//
// The morph-off cell must reproduce the shipped Phase 1 (prec@1 ~60.1, fw-fp
// ~6.7). Self-contained; productionize only if it clears the bar. Run:
//   node scripts/eval-morph.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import usfm from "usfm-js";
import {
  BOOK_NUMBERS, OT_BOOKS, NT_BOOKS, SEP, SPACE,
  normStrong, normSurface, leafSurfaces, usfmUrl,
} from "./lib/align-corpus.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cacheDir = resolve(repoRoot, "scripts/out/_cache");

const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const bible = flag("--bible", "ult").toLowerCase();
const heldOut = argv.filter((a) => !a.startsWith("--") && BOOK_NUMBERS[a.toUpperCase()]).map((a) => a.toUpperCase());
const HELD_OUT = heldOut.length ? heldOut : ["JOS", "NAM", "ACT"];

const manifest = JSON.parse(readFileSync(resolve(repoRoot, "api/data/canonical.json"), "utf8"));
const res = manifest.resources.find((r) => r.bible === bible);
if (!res) { console.error(`No resource for bible '${bible}'`); process.exit(1); }

const GLUE = new Set(["the", "of", "and", "a", "an", "to", "in", "for", "with", "or", "that"]);
const isGlue = (surfaces) => surfaces.every((s) => GLUE.has(s));
const BLEND_WEIGHTS = { freq: 0.7, position: 0.7, occurrence: 0.4 };
const HAS_SPACE = /\s/;

// Coarse morph class from an x-morph value like "He,Ncmsc" / "He,C:Vqw3ms" /
// "Gr,N,,,,NMP,". Take the head morpheme (after ':' — drops clitic prefixes),
// POS = first char; for Hebrew nouns append state a/c (the "of" driver).
function morphClass(morph) { // coarse: POS + noun state (a/c)
  if (!morph) return "";
  const parts = String(morph).split(",");
  const body = parts.length > 1 ? parts.slice(1).join(",") : parts[0];
  const seg = body.split(":").pop() || body;
  const pos = seg[0] || "";
  const last = seg[seg.length - 1] || "";
  if (pos === "N" && (last === "a" || last === "c")) return pos + last;
  return pos;
}
function morphClassFull(morph) { // full head-morpheme feature string, e.g. "Ncmsc"
  if (!morph) return "";
  const parts = String(morph).split(",");
  const body = parts.length > 1 ? parts.slice(1).join(",") : parts[0];
  return body.split(":").pop() || body;
}
const CLASSIFIERS = { coarse: morphClass, full: morphClassFull };

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

// ── scorer internals (copied from alignmentSuggest.ts; morph-off reproduces P1)
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
const rel = (i, len) => (len > 0 ? (i + 1) / len : 0);
function blend(freqConf, srcRel, tgtRel, srcOcc, tgtOcc) {
  const occ = srcOcc > 0 && tgtOcc > 0 ? Math.min(srcOcc, tgtOcc) / Math.max(srcOcc, tgtOcc) : 0;
  const position = 1 - Math.abs(srcRel - tgtRel);
  return (freqConf * BLEND_WEIGHTS.freq + position * BLEND_WEIGHTS.position + occ * BLEND_WEIGHTS.occurrence) /
    (BLEND_WEIGHTS.freq + BLEND_WEIGHTS.position + BLEND_WEIGHTS.occurrence);
}

// Phase 1 computeGhosts, but candidates come from candsFor({strong,morph}) so
// the same strong with a different morph can rank differently.
function computeGhostsMorph(groups, streamWords, candsFor) {
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
  const tgtOcc = (surface) => { if (tgtOccCache.has(surface)) return tgtOccCache.get(surface); let n = 0; for (const w of streamWords) if (surfaceMatch(surface, w.text)) n++; tgtOccCache.set(surface, n); return n; };
  const order = new Map(); groups.forEach((g, i) => order.set(g.id, i));
  const srcRelOf = (g) => rel(order.get(g.id) ?? 0, numGroups);
  const empty = groups.filter((g) => g.targets.length === 0);

  for (const g of empty) { // Pass 1 — phrases
    const srcRel = srcRelOf(g);
    let best = null;
    for (const s of g.source) {
      const srcOcc = srcOccByStrong.get(s.strong) ?? 1;
      for (const p of candsFor(s).phrases) {
        const len = p.tokens.length;
        for (let i = 0; i + len <= numStream; i++) {
          let ok = true;
          for (let j = 0; j < len; j++) { const w = streamWords[i + j]; if (w.aligned || claimed.has(w.id) || !surfaceMatch(p.tokens[j], w.text)) { ok = false; break; } }
          if (!ok) continue;
          const score = blend(p.confidence, srcRel, rel(i + (len - 1) / 2, numStream), srcOcc, srcOcc);
          if (!best || score > best.score) best = { score, run: streamWords.slice(i, i + len) };
        }
      }
    }
    if (best) { best.run.forEach((w) => claimed.add(w.id)); result.set(g.id, { wordIds: best.run.map((w) => w.id) }); }
  }
  for (const g of empty) { // Pass 2 — single words
    if (result.has(g.id)) continue;
    const srcRel = srcRelOf(g);
    let best = null;
    for (const s of g.source) {
      const srcOcc = srcOccByStrong.get(s.strong) ?? 1;
      for (const cand of candsFor(s).words) {
        const occ = tgtOcc(cand.surface);
        for (let wi = 0; wi < numStream; wi++) {
          const w = streamWords[wi];
          if (w.aligned || claimed.has(w.id) || !surfaceMatch(cand.surface, w.text)) continue;
          const score = blend(cand.confidence, srcRel, rel(wi, numStream), srcOcc, occ);
          if (!best || score > best.score) best = { score, word: w };
        }
      }
    }
    if (best) { claimed.add(best.word.id); result.set(g.id, { wordIds: [best.word.id] }); }
  }
  return result;
}

// gold groups + word bank, carrying per-source-token morph
function verseGroupsAndBank(verseObjects) {
  const bank = []; const segments = []; let cur = null;
  const walk = (nodes, stack) => {
    for (const n of nodes || []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "milestone" && n.tag === "zaln") {
        const s = normStrong(n.strong);
        walk(n.children || [], s ? [...stack, { strong: s, morph: n.morph || "" }] : stack);
        cur = null;
      } else if (n.type === "word" && n.tag === "w") {
        const surf = normSurface(n.text); if (!surf) continue;
        const id = String(bank.length); bank.push({ id, surface: surf });
        if (!stack.length) { cur = null; continue; }
        const key = stack.map((x) => x.strong).join(">");
        if (cur && cur.key === key) { cur.surfaces.push(surf); cur.wordIds.push(id); }
        else { cur = { key, stack: [...stack], surfaces: [surf], wordIds: [id] }; segments.push(cur); }
      } else if (Array.isArray(n.children)) walk(n.children, stack);
    }
  };
  walk(verseObjects, []);
  return { bank, segments };
}

// ── train: strong-only counts + (strong,morphClass) counts ───────────────────
const trainBooks = [...OT_BOOKS, ...NT_BOOKS].filter((b) => !HELD_OUT.includes(b));
process.stdout.write(`Training ${bible} on ${trainBooks.length} books (excluding ${HELD_OUT.join(SPACE)}) ...\n`);
const countsStrong = new Map(); // strong\tsurface -> count (words + phrases)
const cm = { coarse: new Map(), full: new Map() }; // mode -> strong\tclass\tsurface -> count (words only)
const bumpS = (st, su) => countsStrong.set(st + SEP + su, (countsStrong.get(st + SEP + su) ?? 0) + 1);
const bumpM = (map, st, c, su) => { const k = st + SEP + c + SEP + su; map.set(k, (map.get(k) ?? 0) + 1); };
function walkMorph(nodes, active) {
  for (const n of nodes || []) {
    if (!n || typeof n !== "object") continue;
    if (n.type === "milestone" && n.tag === "zaln") {
      const s = normStrong(n.strong);
      if (s) { const phrase = leafSurfaces(n); if (phrase.length >= 2) bumpS(s, phrase.join(SPACE)); }
      const entry = s ? { s, coarse: morphClass(n.morph), full: morphClassFull(n.morph) } : null;
      walkMorph(n.children || [], entry ? [...active, entry] : active);
    } else if (n.type === "word" && n.tag === "w") {
      const surf = normSurface(n.text);
      if (surf) for (const a of active) { bumpS(a.s, surf); bumpM(cm.coarse, a.s, a.coarse, surf); bumpM(cm.full, a.s, a.full, surf); }
    } else if (Array.isArray(n.children)) walkMorph(n.children, active);
  }
}
for (const book of trainBooks) {
  const text = await fetchBook(book);
  if (!text) continue;
  const json = usfm.toJSON(text);
  for (const ch of Object.values(json.chapters || {})) for (const v of Object.values(ch)) walkMorph(v.verseObjects || [], []);
}

// derive byStrong + totals
const byStrong = new Map();           // strong -> [{surface,count}]
const strongWordTot = new Map();      // strong -> total word count
const strongPhraseTot = new Map();    // strong -> total phrase count
for (const [k, c] of countsStrong) {
  const i1 = k.indexOf(SEP); const st = k.slice(0, i1); const su = k.slice(i1 + 1);
  const l = byStrong.get(st) ?? []; l.push({ surface: su, count: c }); byStrong.set(st, l);
  if (HAS_SPACE.test(su)) strongPhraseTot.set(st, (strongPhraseTot.get(st) ?? 0) + c);
  else strongWordTot.set(st, (strongWordTot.get(st) ?? 0) + c);
}
const smWordTot = { coarse: new Map(), full: new Map() }; // mode -> strong\tclass -> total
for (const mode of ["coarse", "full"]) {
  for (const [k, c] of cm[mode]) { const i2 = k.lastIndexOf(SEP); const sm = k.slice(0, i2); smWordTot[mode].set(sm, (smWordTot[mode].get(sm) ?? 0) + c); }
}
process.stdout.write(`  ${countsStrong.size} strong-surface rows; morph rows coarse ${cm.coarse.size}, full ${cm.full.size}\n\n`);

function makeCandsFor(useMorph, K, mode) {
  const cache = new Map();
  const classify = CLASSIFIERS[mode] || morphClass;
  const cmap = cm[mode] || cm.coarse;
  const smap = smWordTot[mode] || smWordTot.coarse;
  return (src) => {
    const mclass = useMorph ? classify(src.morph) : "";
    const key = src.strong + SEP + mclass;
    if (cache.has(key)) return cache.get(key);
    const rows = byStrong.get(src.strong) ?? [];
    const wTot = strongWordTot.get(src.strong) || 1;
    const pTot = strongPhraseTot.get(src.strong) || 1;
    const nSM = useMorph ? (smap.get(src.strong + SEP + mclass) || 0) : 0;
    const lambda = nSM > 0 ? nSM / (nSM + K) : 0;
    const words = rows.filter((r) => !HAS_SPACE.test(r.surface)).map((r) => {
      const pS = r.count / wTot;
      let conf = pS;
      if (lambda > 0) {
        const c = cmap.get(src.strong + SEP + mclass + SEP + r.surface) || 0;
        conf = lambda * (c / nSM) + (1 - lambda) * pS;
      }
      return { surface: r.surface, confidence: conf };
    }).sort((a, b) => b.confidence - a.confidence).slice(0, 8);
    const phrases = rows.filter((r) => HAS_SPACE.test(r.surface))
      .map((r) => ({ tokens: r.surface.split(/\s+/), confidence: r.count / pTot, count: r.count }))
      .sort((a, b) => b.count - a.count).slice(0, 6);
    const out = { words, phrases };
    cache.set(key, out); return out;
  };
}

// ── evaluate ─────────────────────────────────────────────────────────────────
const eq = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
const heldOutJson = {};
for (const book of HELD_OUT) { const t = await fetchBook(book); if (t) heldOutJson[book] = usfm.toJSON(t); }

function evalCell(useMorph, K, mode) {
  const candsFor = makeCandsFor(useMorph, K, mode);
  const m = { gold: 0, predicted: 0, correct: 0, phraseGold: 0, phraseHit: 0, contentGold: 0, fwFp: 0 };
  for (const book of HELD_OUT) {
    const json = heldOutJson[book]; if (!json) continue;
    for (const ch of Object.values(json.chapters || {})) {
      for (const v of Object.values(ch)) {
        const { bank, segments } = verseGroupsAndBank(v.verseObjects || []);
        if (!segments.length) continue;
        const streamWords = bank.map((w) => ({ id: w.id, text: w.surface, aligned: false }));
        const groups = segments.map((seg, i) => ({ id: String(i), source: seg.stack, targets: [] }));
        const ghosts = computeGhostsMorph(groups, streamWords, candsFor);
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
  ["morph OFF        (= Phase 1)", false, 0, "coarse"],
  ["morph ON coarse  K=5", true, 5, "coarse"],
  ["morph ON full    K=5", true, 5, "full"],
  ["morph ON full    K=2", true, 2, "full"],
];
console.log(`Morph-conditioned ranking — bible=${bible}, held-out=${HELD_OUT.join(",")}\n`);
console.log("config                         cover%  prec@1  phrase     fw-fp%");
for (const [label, useMorph, K, mode] of cells) {
  const m = evalCell(useMorph, K, mode);
  console.log(`${label.padEnd(28)}  ${pct(m.predicted, m.gold)}  ${pct(m.correct, m.predicted)}  ${String(m.phraseHit).padStart(4)}/${String(m.phraseGold).padStart(5)}  ${pct(m.fwFp, m.contentGold)}`);
}
console.log("\n(morph-OFF must match shipped Phase 1: prec@1 ~60.1, fw-fp ~6.7)");
