// Build _zec.js from the real unfoldingWord fixtures in docs/samples/.
//
// Run from the repo root:  node docs/mockups/book-package/_extract.mjs
//
// Everything the mockups display comes from here. Only RAW rows and verse text
// are baked; every count, percentage and distribution is computed in the page at
// runtime, so no number on screen is hand-typed twice.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, "..", "..", "samples");
const read = (f) => readFileSync(join(samples, f), "utf8");

const SOURCES = {
  ult: "en_ult_38-ZEC.usfm",
  tn: "en_tn_tn_ZEC.tsv",
  tq: "en_tq_tq_ZEC.tsv",
  twl: "en_twl_twl_ZEC.tsv",
};

// ---------------------------------------------------------------- TSV

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

// ------------------------------------------- USFM -> aligned verse segments
//
// The ULT carries a real alignment tree: \zaln-s milestones hold the Hebrew
// surface form in x-content, and the \w words nested inside them are the English
// that renders it. We walk that tree and emit one segment per contiguous run of
// English words sharing the same open Hebrew stack:
//
//   { e: "In the eighth month", h: "בַּ⁠חֹ֨דֶשׁ֙" }   aligned run
//   { e: ", " }                                        unaligned text / punctuation
//
// Plain reading text is the concatenation of every `e`, so it is never stored
// twice. Highlighting a Hebrew tN quote is then a real lookup against `h`, not a
// guess.

// Tokenise one verse body into markers, \w words and bare text.
function tokenizeVerse(body) {
  let s = body;
  s = s.replace(/\\f\s[\s\S]*?\\f\*/g, ""); // footnotes carry no reading text
  s = s.replace(/\\x\s[\s\S]*?\\x\*/g, "");

  const tokens = [];
  const re =
    /\\(zaln-s|zaln-e|k-s|k-e|w)\s*((?:\|[^\\]*)?)\\\*|\\w\s+([^|\\]*)(?:\|([^\\]*))?\\w\*|\\([a-z]+\d*)\*|\\([a-z]+\d*)\s?/g;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) tokens.push({ kind: "text", text: s.slice(last, m.index) });
    last = re.lastIndex;
    if (m[1] === "zaln-s") {
      const c = /x-content="([^"]*)"/.exec(m[2] || "");
      tokens.push({ kind: "open", content: c ? c[1] : "" });
    } else if (m[1] === "zaln-e") {
      tokens.push({ kind: "close" });
    } else if (m[3] !== undefined) {
      tokens.push({ kind: "word", text: m[3] });
    }
    // \k-s / \k-e and every other marker contribute no reading text
  }
  if (last < s.length) tokens.push({ kind: "text", text: s.slice(last) });
  return tokens;
}

function segmentsFor(body) {
  const tokens = tokenizeVerse(body);
  const stack = [];
  const segs = [];

  const push = (text, h) => {
    if (!text) return;
    const prev = segs[segs.length - 1];
    if (prev && prev.h === h) prev.e += text;
    else segs.push(h ? { e: text, h } : { e: text });
  };

  for (const t of tokens) {
    if (t.kind === "open") stack.push(t.content);
    else if (t.kind === "close") stack.pop();
    else if (t.kind === "word") {
      const h = stack.filter(Boolean).join(" ") || undefined;
      const prev = segs[segs.length - 1];
      const needSpace = prev && !/[\s’“(\[{]$/.test(prev.e);
      push((needSpace ? " " : "") + t.text, h);
    } else {
      // bare text: punctuation, quote marks, brackets from \add etc.
      const cleaned = t.text.replace(/\\\*/g, "").replace(/\s+/g, " ");
      if (/^\s+$/.test(cleaned)) continue; // spacing is reconstructed above
      push(cleaned.replace(/^\s+(?=[,.;:!?’”])/, ""), undefined);
    }
  }
  // tidy: collapse double spaces, then trim the verse's trailing whitespace
  for (const s of segs) s.e = s.e.replace(/\s{2,}/g, " ");
  const tail = segs[segs.length - 1];
  if (tail) {
    tail.e = tail.e.replace(/\s+$/, "");
    if (!tail.e) segs.pop();
  }
  return segs;
}

function parseUlt(usfm) {
  const idLine = /\\id\s+(\S+)([^\n]*)/.exec(usfm);
  const h = /\\h\s+([^\n]+)/.exec(usfm);
  const toc1 = /\\toc1\s+([^\n]+)/.exec(usfm);

  const segs = {};
  const verseCounts = {};
  const chunks = usfm.split(/\\c\s+/).slice(1);

  for (const chunk of chunks) {
    const cn = parseInt(chunk, 10);
    const vparts = chunk.split(/\\v\s+/).slice(1);
    let last = 0;
    for (const vp of vparts) {
      const m = /^(\d+)(?:-(\d+))?\s+([\s\S]*)$/.exec(vp);
      if (!m) continue;
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : start;
      const built = segmentsFor(m[3]);
      const label = m[2] ? `${start}-${end}` : String(start);
      segs[`${cn}:${label}`] = built;
      for (let v = start; v <= end; v++) {
        if (m[2]) segs[`${cn}:${v}`] = built; // bridge addressable by each verse
        last = Math.max(last, v);
      }
    }
    verseCounts[cn] = last;
  }

  return {
    id: idLine ? idLine[1] : null,
    idTail: idLine ? idLine[2].trim() : "",
    h: h ? h[1].trim() : null,
    toc1: toc1 ? toc1[1].trim() : null,
    segs,
    verseCounts,
  };
}

// ---------------------------------------------------------------- build

const ult = parseUlt(read(SOURCES.ult));

const tn = tsv(read(SOURCES.tn)).map((r) => ({
  ref: r.Reference,
  id: r.ID,
  tags: r.Tags || "",
  sr: r.SupportReference || "",
  quote: r.Quote || "",
  occ: r.Occurrence || "",
  note: r.Note || "",
}));

const tq = tsv(read(SOURCES.tq)).map((r) => ({
  ref: r.Reference,
  id: r.ID,
  quote: r.Quote || "",
  occ: r.Occurrence || "",
  q: r.Question || "",
  a: r.Response || "",
}));

const twl = tsv(read(SOURCES.twl)).map((r) => ({
  ref: r.Reference,
  id: r.ID,
  tags: r.Tags || "",
  words: r.OrigWords || "",
  occ: r.Occurrence || "",
  link: r.TWLink || "",
}));

const chapters = Object.keys(ult.verseCounts)
  .map(Number)
  .sort((a, b) => a - b)
  .map((n) => ({ n, verses: ult.verseCounts[n] }));

const out = {
  meta: {
    book: "ZEC",
    name: ult.h || "Zechariah",
    toc1: ult.toc1,
    usfmId: `${ult.id} ${ult.idTail}`.trim(),
    generatedFrom: Object.values(SOURCES),
    extractor: "docs/mockups/book-package/_extract.mjs",
  },
  chapters,
  segs: ult.segs,
  tn,
  tq,
  twl,
};

const banner = `// GENERATED — do not edit by hand.
// Source: ${out.meta.generatedFrom.join(", ")} (real unfoldingWord fixtures in docs/samples/)
// Regenerate: node ${out.meta.extractor}
//
// Raw tN/tQ/tWL rows plus the ULT's own alignment segments — nothing else.
// Every count, percentage, distribution and highlight the mockups display is
// computed from this object at runtime, so no value on screen is hand-typed.
`;

writeFileSync(
  join(here, "_zec.js"),
  `${banner}window.ZEC = ${JSON.stringify(out)};\n`,
  "utf8",
);

// ---------------------------------------------------------------- report

const chSum = (arr) => {
  const by = {};
  for (const r of arr) {
    const c = /^front/.test(r.ref) ? "front" : parseInt(r.ref, 10);
    by[c] = (by[c] || 0) + 1;
  }
  return by;
};

const plain = (k) => (out.segs[k] || []).map((s) => s.e).join("");
const keys = Object.keys(out.segs);

console.log("book        ", out.meta.usfmId, "|", out.meta.name);
console.log("chapters    ", chapters.length);
console.log("verses      ", chapters.reduce((a, c) => a + c.verses, 0));
console.log("per chapter ", chapters.map((c) => `${c.n}:${c.verses}`).join(" "));
console.log("verse keys  ", keys.length);
console.log("tn / tq / twl", tn.length, tq.length, twl.length);
console.log("tn by ch    ", JSON.stringify(chSum(tn)));
console.log("tq by ch    ", JSON.stringify(chSum(tq)));
console.log("twl by ch   ", JSON.stringify(chSum(twl)));
console.log("tn w/ SR    ", tn.filter((r) => r.sr).length, "of", tn.length);
console.log("distinct tA ", new Set(tn.filter((r) => r.sr).map((r) => r.sr)).size);
console.log("distinct tW ", new Set(twl.map((r) => r.link)).size);
console.log("segments    ", keys.reduce((a, k) => a + out.segs[k].length, 0),
  "| aligned", keys.reduce((a, k) => a + out.segs[k].filter((s) => s.h).length, 0));
console.log("empty verses", keys.filter((k) => !plain(k)).length);
console.log("leftover mkp", keys.filter((k) => /\\/.test(plain(k))).length);
console.log("1:1         ", plain("1:1"));
console.log("9:9         ", plain("9:9"));
