// Shared corpus-parsing primitives for the alignment-memory trainer
// (scripts/train-aligner.mjs) and the held-out evaluation harness
// (scripts/eval-aligner.mjs). Extracted verbatim from the trainer so both
// build the frequency model from the gold `\zaln-s` alignments identically —
// the eval is only honest if its model matches what the trainer ships.

// Standard unfoldingWord USFM filename number prefixes. OT is 01-39, NT 41-67.
export const BOOK_NUMBERS = {
  GEN: "01", EXO: "02", LEV: "03", NUM: "04", DEU: "05", JOS: "06", JDG: "07",
  RUT: "08", "1SA": "09", "2SA": "10", "1KI": "11", "2KI": "12", "1CH": "13",
  "2CH": "14", EZR: "15", NEH: "16", EST: "17", JOB: "18", PSA: "19",
  PRO: "20", ECC: "21", SNG: "22", ISA: "23", JER: "24", LAM: "25",
  EZK: "26", DAN: "27", HOS: "28", JOL: "29", AMO: "30", OBA: "31",
  JON: "32", MIC: "33", NAM: "34", HAB: "35", ZEP: "36", HAG: "37",
  ZEC: "38", MAL: "39",
  MAT: "41", MRK: "42", LUK: "43", JHN: "44", ACT: "45",
  ROM: "46", "1CO": "47", "2CO": "48", GAL: "49", EPH: "50",
  PHP: "51", COL: "52", "1TH": "53", "2TH": "54", "1TI": "55",
  "2TI": "56", TIT: "57", PHM: "58", HEB: "59", JAS: "60",
  "1PE": "61", "2PE": "62", "1JN": "63", "2JN": "64", "3JN": "65",
  JUD: "66", REV: "67",
};
export const OT_BOOKS = Object.keys(BOOK_NUMBERS).filter((b) => +BOOK_NUMBERS[b] <= 39);
export const NT_BOOKS = Object.keys(BOOK_NUMBERS).filter((b) => +BOOK_NUMBERS[b] >= 41);

// (bible, strong, surface) counts are joined with a TAB so multi-word phrase
// surfaces (which contain spaces) survive the split at emit time. SPACE is
// computed, never typed inside a literal: a lone " " written via the editor
// has landed on disk as a NUL byte before, and phrase surfaces contain spaces
// (so a space separator would also collide). See docs/alignment-suggestions.md.
export const SEP = "\t";
export const SPACE = String.fromCharCode(32);

const LETTER_RE = /[\p{L}\p{M}\p{N}]/u;

// Normalize a Strong's reference to a single lookup key, matching
// api/src/align.ts / web normalizeStrong: first [HG]\d+[a-z]? token (drops
// clitic prefixes like "b:"), leading zeros stripped. "" when no real Strong's.
export function normStrong(raw) {
  const m = String(raw || "").match(/[HG]\d+[a-z]?/i);
  if (!m) return "";
  return m[0].toUpperCase().replace(/^([HG])0+/, "$1");
}

// Lowercase + NFC + trim non-letter edges. "" for tokens with no letters.
export function normSurface(t) {
  const s = String(t || "").normalize("NFC").toLowerCase();
  const first = s.search(LETTER_RE);
  if (first < 0) return "";
  let last = s.length - 1;
  while (last >= 0 && !LETTER_RE.test(s[last])) last--;
  return s.slice(first, last + 1);
}

// All target \w leaf surfaces under a node, in order — the English phrase a
// milestone covers (e.g. ["the","earth"] under הָאָרֶץ's H776 milestone).
export function leafSurfaces(node) {
  const out = [];
  const rec = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "word" && n.tag === "w") {
      const s = normSurface(n.text);
      if (s) out.push(s);
    } else if (Array.isArray(n.children)) {
      for (const c of n.children) rec(c);
    }
  };
  rec(node);
  return out;
}

// Increment the (bible, strong, surface) count in `counts`.
export function bump(counts, bible, strong, surface) {
  const k = bible + SEP + strong + SEP + surface;
  counts.set(k, (counts.get(k) || 0) + 1);
}

// Walk verseObjects, carrying the stack of active source Strong's from
// enclosing `\zaln-s` milestones. Each milestone contributes its full
// contiguous English phrase (multi-word, so "the earth" stays one unit); each
// `\w` word also counts toward every active Strong's (per-word memory + the
// lexicon-fallback basis). Mirrors the milestone/word shape in web alignment.ts.
export function walkAlign(nodes, active, bible, counts, stats) {
  for (const n of nodes || []) {
    if (!n || typeof n !== "object") continue;
    if (n.type === "milestone" && n.tag === "zaln") {
      const s = normStrong(n.strong);
      if (s) {
        const phrase = leafSurfaces(n);
        if (phrase.length >= 2) {
          bump(counts, bible, s, phrase.join(SPACE));
          stats.pairs++;
        }
      }
      walkAlign(n.children || [], s ? [...active, s] : active, bible, counts, stats);
    } else if (n.type === "word" && n.tag === "w") {
      const surf = normSurface(n.text);
      if (surf) {
        for (const s of active) {
          bump(counts, bible, s, surf);
          stats.pairs++;
        }
      }
    } else if (Array.isArray(n.children)) {
      walkAlign(n.children, active, bible, counts, stats);
    }
  }
}

// USFM raw-file URL on DCS for a book, e.g.
// https://git.door43.org/unfoldingWord/en_ult/raw/tag/v88/31-OBA.usfm
export function usfmUrl(repo, ref, book) {
  const num = BOOK_NUMBERS[book];
  return num ? `https://git.door43.org/${repo}/raw/${ref}/${num}-${book}.usfm` : null;
}
