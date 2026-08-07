// Build _verse.js — everything an exegete needs to judge ONE verse, for a whole
// chapter of real data.
//
// Run from the repo root (type-stripping is needed to import the product's morph
// decoder, which is TypeScript):
//
//   node --experimental-strip-types --no-warnings docs/mockups/book-package/_extract-verse.mjs
//
// The central idea: every resource is anchored to the ORIGINAL-LANGUAGE WORD.
// The UHB gives the words, lemma, strong and morphology. The ULT and the UST are
// both aligned to those same words (x-content / x-strong on \zaln-s), so the two
// renderings can be joined per word rather than merely displayed side by side.
// That join is what makes incoherence visible — a Hebrew word the simplified text
// never renders, or a term linked to the wrong word, shows up as a hole.
//
// Morphology is decoded by web/src/lib/morph.ts — the product's own tested
// decoder (ported from bibletags-ui-helper) — not by anything invented here.
// translationAcademy and translationWords prose is read from the real en_ta and
// en_tw checkouts on disk. Nothing in the output is written by hand.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decodeMorph, morphemeText } from "../../../web/src/lib/morph.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const samples = join(repo, "docs", "samples");
const EN_TA = "C:/GH/en_ta";
const EN_TW = "C:/GH/en_tw";

const CHAPTER = 1;
const SOURCES = {
  uhb: "hbo_uhb_38-ZEC.usfm",
  ult: "en_ult_38-ZEC.usfm",
  ust: "en_ust_38-ZEC.usfm",
  tn: "en_tn_tn_ZEC.tsv",
  tq: "en_tq_tq_ZEC.tsv",
  twl: "en_twl_twl_ZEC.tsv",
};
const read = (f) => readFileSync(join(samples, f), "utf8");

// ---------------------------------------------------------------- helpers

function tsv(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length);
  const head = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row = {};
    head.forEach((h, i) => (row[h] = cells[i] === undefined ? "" : cells[i]));
    return row;
  });
}

// Consonantal skeleton. Separators go first: the maqqef (U+05BE) lives inside the
// accent range and would otherwise weld two words together.
const skel = (s) =>
  String(s || "")
    .normalize("NFC")
    .replace(/[\u05BE\u200B\u200C\u200D\u2060\uFEFF\s]/g, " ")
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const tight = (s) => skel(s).replace(/ /g, "");

function verseChunks(usfm, chapter) {
  const chapters = usfm.split(/\\c\s+/).slice(1);
  const chunk = chapters.find((c) => parseInt(c, 10) === chapter);
  if (!chunk) throw new Error(`chapter ${chapter} not found`);
  const out = {};
  chunk.split(/\\v\s+/).slice(1).forEach((vp) => {
    const m = /^(\d+)(?:-(\d+))?\s+([\s\S]*)$/.exec(vp);
    if (!m) return;
    out[m[1]] = m[3];
  });
  return out;
}

// ---------------------------------------------------------------- UHB

// \w surface|lemma="…" strong="…" x-morph="…"\w*  plus the maqqef/punctuation
// that sits between words.
function parseUhbVerse(body) {
  const words = [];
  const re = /\\w\s+([^|\\]+)\|([^\\]*)\\w\*|([\u05BE\u05C0\u05C3\u05C6,.;:!?]+)/g;
  let m;
  let pendingJoin = "";
  while ((m = re.exec(body)) !== null) {
    if (m[3] !== undefined) {
      // punctuation between words: a maqqef joins, sof-pasuq ends the verse
      if (words.length) words[words.length - 1].after = m[3];
      pendingJoin = m[3].includes("\u05BE") ? "\u05BE" : "";
      continue;
    }
    const surface = m[1];
    const attrs = m[2] || "";
    const lemma = (/lemma="([^"]*)"/.exec(attrs) || [])[1] || "";
    const strong = (/strong="([^"]*)"/.exec(attrs) || [])[1] || "";
    const morph = (/x-morph="([^"]*)"/.exec(attrs) || [])[1] || "";
    const decoded = decodeMorph(morph);
    words.push({
      i: words.length,
      w: surface,
      lemma,
      strong,
      morph,
      // Plain-English morphology, from the product's decoder.
      gloss: decoded ? decoded.morphemes.map((x) => morphemeText(x)) : [],
      pron: decoded && decoded.pronounSuffix ? decoded.pronounSuffix : null,
      join: pendingJoin,
      after: "",
    });
    pendingJoin = "";
  }
  return words;
}

// ---------------------------------------------------------------- ULT / UST

// Walk the alignment tree, emitting one group per contiguous run of English words
// that share the same open \zaln-s stack. Each group records the Hebrew surface
// forms (x-content) and strongs of every milestone above it.
function parseAlignedVerse(body) {
  let s = body.replace(/\\f\s[\s\S]*?\\f\*/g, "").replace(/\\x\s[\s\S]*?\\x\*/g, "");
  const re =
    /\\(zaln-s|zaln-e|k-s|k-e)\s*((?:\|[^\\]*)?)\\\*|\\w\s+([^|\\]*)(?:\|([^\\]*))?\\w\*|\\([a-z]+\d*)\*|\\([a-z]+\d*)\s?/g;

  const groups = [];
  const stack = [];
  let m;
  let last = 0;
  let plain = "";

  const key = () => stack.map((x) => x.content).join("\u0000");

  const push = (text, aligned) => {
    if (!text) return;
    const k = aligned ? key() : "";
    const prev = groups[groups.length - 1];
    if (prev && prev.k === k) prev.e += text;
    else
      groups.push({
        k,
        e: text,
        h: aligned ? stack.map((x) => x.content) : [],
        strongs: aligned ? stack.map((x) => x.strong) : [],
        occ: aligned ? stack.map((x) => x.occ) : [],
      });
    plain += text;
  };

  while ((m = re.exec(s)) !== null) {
    if (m.index > last) {
      const raw = s.slice(last, m.index).replace(/\\\*/g, "").replace(/\s+/g, " ");
      if (!/^\s*$/.test(raw)) push(raw.replace(/^\s+(?=[,.;:!?’”])/, ""), stack.length > 0);
    }
    last = re.lastIndex;
    if (m[1] === "zaln-s") {
      const a = m[2] || "";
      stack.push({
        content: (/x-content="([^"]*)"/.exec(a) || [])[1] || "",
        strong: (/x-strong="([^"]*)"/.exec(a) || [])[1] || "",
        occ: (/x-occurrence="([^"]*)"/.exec(a) || [])[1] || "",
      });
    } else if (m[1] === "zaln-e") {
      stack.pop();
    } else if (m[3] !== undefined) {
      const prev = groups[groups.length - 1];
      const needSpace = prev && !/[\s’“(\[{]$/.test(prev.e);
      push((needSpace ? " " : "") + m[3], stack.length > 0);
    }
  }
  if (last < s.length) {
    const raw = s.slice(last).replace(/\\\*/g, "").replace(/\s+/g, " ");
    if (!/^\s*$/.test(raw)) push(raw, false);
  }

  groups.forEach((g, i) => (g.id = i));
  for (const g of groups) {
    g.e = g.e.replace(/\s{2,}/g, " ");
    delete g.k;
  }
  const tailIdx = groups.length - 1;
  if (tailIdx >= 0) groups[tailIdx].e = groups[tailIdx].e.replace(/\s+$/, "");
  return groups;
}

// Map an alignment group onto UHB word indices.
//
// The load-bearing detail: x-occurrence counts occurrences of the EXACT accented
// surface form, not of the consonantal skeleton. In ZEC 1:3 the three instances of
// צבאות carry three different accentuations and are each "occurrence 1", while the
// two identically-accented יְהוָ֣ה are occurrences 1 and 2. Keying the index on a
// stripped skeleton therefore collapses distinct words onto one and mis-joins the
// verse — so the exact NFC form is the primary key, and looser keys are fallbacks
// whose use is counted and reported rather than hidden.
function buildIndex(words) {
  const byExact = new Map();
  const bySkel = new Map();
  const byStrong = new Map();
  const add = (map, key, i) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(i);
  };
  words.forEach((w) => {
    add(byExact, w.w.normalize("NFC"), w.i);
    add(bySkel, tight(w.w), w.i);
    add(byStrong, w.strong, w.i);
  });
  return { byExact, bySkel, byStrong };
}

// Tier counters, so the fixture can state how it joined rather than implying it.
const joinTiers = { exact: 0, strong: 0, skeleton: 0, weak: 0, none: 0 };

function mapGroup(g, idx) {
  const hits = [];
  const misses = [];
  for (let n = 0; n < g.h.length; n++) {
    const occ = parseInt(g.occ[n], 10) || 1;
    const exact = idx.byExact.get(String(g.h[n]).normalize("NFC"));
    if (exact && exact.length >= occ) {
      hits.push(exact[occ - 1]);
      joinTiers.exact++;
      continue;
    }
    const byStr = idx.byStrong.get(g.strongs[n]);
    if (byStr && byStr.length >= occ) {
      hits.push(byStr[occ - 1]);
      joinTiers.strong++;
      continue;
    }
    const sk = idx.bySkel.get(tight(g.h[n]));
    if (sk && sk.length >= occ) {
      hits.push(sk[occ - 1]);
      joinTiers.skeleton++;
      continue;
    }
    if (sk && sk.length) {
      hits.push(sk[0]);
      joinTiers.weak++;
      continue;
    }
    misses.push(g.h[n]);
    joinTiers.none++;
  }
  return { words: [...new Set(hits)].sort((a, b) => a - b), misses };
}

// ---------------------------------------------------------------- units
//
// A "unit" is the coherence atom: one or more consecutive Hebrew words that the
// literal text and the simplified text both treat as a single move. Merging
// consecutive words that share BOTH renderings is what turns three separate
// texts into one readable, checkable row.
function buildUnits(words, ultGroups, ustGroups, idx) {
  const ultOf = new Map();
  const ustOf = new Map();
  const stats = { ultMapped: 0, ultMiss: 0, ustMapped: 0, ustMiss: 0 };

  ultGroups.forEach((g) => {
    if (!g.h.length) return;
    const { words: ws, misses } = mapGroup(g, idx);
    stats.ultMapped += ws.length ? 1 : 0;
    stats.ultMiss += misses.length;
    ws.forEach((i) => {
      if (!ultOf.has(i)) ultOf.set(i, []);
      ultOf.get(i).push(g.id);
    });
  });
  ustGroups.forEach((g) => {
    if (!g.h.length) return;
    const { words: ws, misses } = mapGroup(g, idx);
    stats.ustMapped += ws.length ? 1 : 0;
    stats.ustMiss += misses.length;
    ws.forEach((i) => {
      if (!ustOf.has(i)) ustOf.set(i, []);
      ustOf.get(i).push(g.id);
    });
  });

  const units = [];
  const keyFor = (i) =>
    (ultOf.get(i) || []).join(",") + "|" + (ustOf.get(i) || []).join(",");

  words.forEach((w) => {
    const k = keyFor(w.i);
    const prev = units[units.length - 1];
    if (prev && prev.k === k) prev.words.push(w.i);
    else units.push({ k, words: [w.i], ult: ultOf.get(w.i) || [], ust: ustOf.get(w.i) || [] });
  });

  units.forEach((u, n) => {
    u.n = n;
    u.ultText = u.ult.map((id) => ultGroups[id].e).join("").trim();
    u.ustText = u.ust.map((id) => ustGroups[id].e).join("").trim();
    delete u.k;
  });

  // English that is aligned to nothing: supplied words, discourse glue.
  const unalignedUlt = ultGroups.filter((g) => !g.h.length).map((g) => g.e.trim()).filter(Boolean);
  const unalignedUst = ustGroups.filter((g) => !g.h.length).map((g) => g.e.trim()).filter(Boolean);

  return { units, unalignedUlt, unalignedUst, stats };
}

// ---------------------------------------------------------------- resources

// Anchor a Hebrew phrase (tN Quote or tWL OrigWords) to UHB word indices.
function anchorPhrase(phrase, words) {
  const parts = String(phrase || "").split(/\s*(?:&|…|\.\.\.)\s*/).filter(Boolean);
  const all = [];
  let unresolved = 0;
  for (const part of parts) {
    const want = skel(part).split(" ").filter((t) => t.length >= 2);
    const pool = want.length ? want : skel(part).split(" ").filter(Boolean);
    const hit = [];
    const remaining = pool.slice();
    words.forEach((w) => {
      const t = tight(w.w);
      const at = remaining.findIndex((x) => t === x || t.includes(x) || x.includes(t));
      if (at >= 0) {
        remaining.splice(at, 1);
        hit.push(w.i);
      }
    });
    if (!hit.length) unresolved++;
    hit.forEach((i) => all.push(i));
  }
  return { words: [...new Set(all)].sort((a, b) => a - b), unresolved, parts: parts.length };
}

function shortRef(rc) {
  const bits = String(rc || "").split("/");
  return bits[bits.length - 1];
}
function twKey(rc) {
  const m = /\/tw\/dict\/bible\/([^\/]+)\/([^\/]+)$/.exec(rc || "");
  return m ? `${m[1]}/${m[2]}` : "";
}

// ---------------------------------------------------------------- build

const uhbV = verseChunks(read(SOURCES.uhb), CHAPTER);
const ultV = verseChunks(read(SOURCES.ult), CHAPTER);
const ustV = verseChunks(read(SOURCES.ust), CHAPTER);

const tnAll = tsv(read(SOURCES.tn));
const tqAll = tsv(read(SOURCES.tq));
const twlAll = tsv(read(SOURCES.twl));
const inChapter = (ref) => new RegExp(`^${CHAPTER}:`).test(ref);

const verses = {};
const totals = { ultMapped: 0, ultMiss: 0, ustMapped: 0, ustMiss: 0, tnAnchored: 0, tnUnresolved: 0, twlAnchored: 0, twlUnresolved: 0 };
const taWanted = new Set();
const twWanted = new Set();

Object.keys(uhbV)
  .map(Number)
  .sort((a, b) => a - b)
  .forEach((v) => {
    const ref = `${CHAPTER}:${v}`;
    const words = parseUhbVerse(uhbV[v]);
    const idx = buildIndex(words);
    const ult = ultV[v] ? parseAlignedVerse(ultV[v]) : [];
    const ust = ustV[v] ? parseAlignedVerse(ustV[v]) : [];
    const built = buildUnits(words, ult, ust, idx);

    totals.ultMapped += built.stats.ultMapped;
    totals.ultMiss += built.stats.ultMiss;
    totals.ustMapped += built.stats.ustMapped;
    totals.ustMiss += built.stats.ustMiss;

    const tn = tnAll
      .filter((r) => r.Reference === ref)
      .map((r) => {
        const a = anchorPhrase(r.Quote, words);
        if (r.Quote) {
          if (a.words.length) totals.tnAnchored++;
          else totals.tnUnresolved++;
        }
        if (r.SupportReference) taWanted.add(shortRef(r.SupportReference));
        return {
          id: r.ID,
          tags: r.Tags || "",
          sr: r.SupportReference || "",
          article: shortRef(r.SupportReference),
          quote: r.Quote || "",
          occ: r.Occurrence || "",
          note: r.Note || "",
          words: a.words,
          resolved: r.Quote ? a.words.length > 0 : null,
        };
      });

    const twl = twlAll
      .filter((r) => r.Reference === ref)
      .map((r) => {
        const a = anchorPhrase(r.OrigWords, words);
        if (a.words.length) totals.twlAnchored++;
        else totals.twlUnresolved++;
        const key = twKey(r.TWLink);
        if (key) twWanted.add(key);
        return {
          id: r.ID,
          tags: r.Tags || "",
          words: a.words,
          orig: r.OrigWords || "",
          occ: r.Occurrence || "",
          link: r.TWLink || "",
          key,
        };
      });

    const tq = tqAll
      .filter((r) => r.Reference === ref)
      .map((r) => ({ id: r.ID, quote: r.Quote || "", occ: r.Occurrence || "", q: r.Question || "", a: r.Response || "" }));

    verses[ref] = {
      v,
      words,
      ult,
      ust,
      units: built.units,
      unalignedUlt: built.unalignedUlt,
      unalignedUst: built.unalignedUst,
      tn,
      tq,
      twl,
    };
  });

// Chapter intro note (real, and part of judging a verse in context).
const introRow = tnAll.find((r) => r.Reference === `${CHAPTER}:intro`);

// ---------------------------------------------------------------- articles

function readTa(slug) {
  for (const manual of ["translate", "checking", "intro", "process"]) {
    const dir = join(EN_TA, manual, slug);
    if (!existsSync(join(dir, "01.md"))) continue;
    const body = readFileSync(join(dir, "01.md"), "utf8");
    const title = existsSync(join(dir, "title.md")) ? readFileSync(join(dir, "title.md"), "utf8").trim() : slug;
    const sub = existsSync(join(dir, "sub-title.md")) ? readFileSync(join(dir, "sub-title.md"), "utf8").trim() : "";
    return { slug, manual, title, sub, body };
  }
  return null;
}

function readTw(key) {
  const p = join(EN_TW, "bible", key + ".md");
  if (!existsSync(p)) return null;
  const body = readFileSync(p, "utf8");
  const title = (/^#\s*(.+)$/m.exec(body) || [])[1] || key.split("/")[1];
  return { key, title: title.trim(), body };
}

const ta = {};
const taMissing = [];
[...taWanted].sort().forEach((slug) => {
  const a = readTa(slug);
  if (a) ta[slug] = a;
  else taMissing.push(slug);
});

const tw = {};
const twMissing = [];
[...twWanted].sort().forEach((key) => {
  const a = readTw(key);
  if (a) tw[key] = a;
  else twMissing.push(key);
});

const out = {
  meta: {
    book: "ZEC",
    name: "Zechariah",
    chapter: CHAPTER,
    generatedFrom: Object.values(SOURCES),
    articleSources: { ta: EN_TA, tw: EN_TW },
    extractor: "docs/mockups/book-package/_extract-verse.mjs",
    morphDecoder: "web/src/lib/morph.ts",
    // Recorded so the screens can state their own coverage instead of implying it.
    coverage: { ...totals, joinTiers, taMissing, twMissing },
  },
  intro: introRow ? { id: introRow.ID, note: introRow.Note } : null,
  verses,
  ta,
  tw,
};

const banner = `// GENERATED — do not edit by hand.
// Sources: ${out.meta.generatedFrom.join(", ")} (real unfoldingWord fixtures, docs/samples/)
//          en_ta + en_tw checkouts for article prose
// Morphology decoded by ${out.meta.morphDecoder} (the product's own decoder).
// Regenerate: node --experimental-strip-types --no-warnings ${out.meta.extractor}
`;

writeFileSync(join(here, "_verse.js"), `${banner}window.VERSE = ${JSON.stringify(out)};\n`, "utf8");

// ---------------------------------------------------------------- report

const refs = Object.keys(verses);
console.log("chapter        ", `${out.meta.book} ${CHAPTER}`);
console.log("verses         ", refs.length);
console.log("uhb words      ", refs.reduce((a, r) => a + verses[r].words.length, 0));
console.log("morph decoded  ", refs.reduce((a, r) => a + verses[r].words.filter((w) => w.gloss.length).length, 0));
console.log("with pron sfx  ", refs.reduce((a, r) => a + verses[r].words.filter((w) => w.pron).length, 0));
console.log("units          ", refs.reduce((a, r) => a + verses[r].units.length, 0));
console.log("ult groups     ", totals.ultMapped, "mapped |", totals.ultMiss, "unmapped milestones");
console.log("ust groups     ", totals.ustMapped, "mapped |", totals.ustMiss, "unmapped milestones");
console.log("units w/o ULT  ", refs.reduce((a, r) => a + verses[r].units.filter((u) => !u.ultText).length, 0));
console.log("units w/o UST  ", refs.reduce((a, r) => a + verses[r].units.filter((u) => !u.ustText).length, 0));
console.log("tn rows        ", refs.reduce((a, r) => a + verses[r].tn.length, 0), "| anchored", totals.tnAnchored, "| unresolved", totals.tnUnresolved);
console.log("twl rows       ", refs.reduce((a, r) => a + verses[r].twl.length, 0), "| anchored", totals.twlAnchored, "| unresolved", totals.twlUnresolved);
console.log("tq rows        ", refs.reduce((a, r) => a + verses[r].tq.length, 0));
console.log("tA articles    ", Object.keys(ta).length, "loaded |", taMissing.length, "missing", taMissing.join(",") || "");
console.log("tW articles    ", Object.keys(tw).length, "loaded |", twMissing.length, "missing", twMissing.join(",") || "");
console.log();
console.log("1:1 units:");
verses["1:1"].units.forEach((u) => {
  const heb = u.words.map((i) => verses["1:1"].words[i].w).join(" ");
  console.log(
    "  " + heb.padEnd(26),
    "| ULT:", (u.ultText || "—").padEnd(28),
    "| UST:", u.ustText || "—",
  );
});
console.log();
console.log("1:1 word 6 morph:", JSON.stringify(verses["1:1"].words[5]));
