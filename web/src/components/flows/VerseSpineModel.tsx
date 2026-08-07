// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// Derivation layer for the verse fidelity overview (VerseScreen), ported from
// docs/mockups/book-package/_vlib.js onto the app's real data.
//
// THE ANCHORING MODEL, unchanged from the mockup: every resource and every
// rendering points at an ORIGINAL-LANGUAGE WORD. The literal (ULT) and
// simplified (UST) verses each carry `\zaln-s` milestones naming the source
// words they render, so both lanes can be JOINED on the same original-word
// positions rather than merely shown side by side. "Does the simplified text
// render this word?" then becomes a lookup instead of a judgement call.
//
// The mockup had a build-time fixture (`_verse.js`) with pre-computed units and
// alignment groups. Here the same structure is derived at render time from the
// real trees:
//
//   original words   ← the UHB/UGNT verse's `\w` tokens, in document order
//   lane renderings  ← parseAlignment(targetTree, sourceTree).groups
//   the join         ← each alignment group's source words resolved back to
//                      original-word POSITIONS (three tiers, below)
//
// Nothing here invents content. Every observation is computed from the trees
// that were loaded; when something cannot be resolved it is reported as
// unresolved rather than guessed.

import { parseAlignment, type SourceWord } from "../../lib/alignment";
import { matchNorm, matchSourceTokens } from "../../lib/highlight";
import { decodeMorph, morphemeText, type DecodedMorph } from "../../lib/morph";
import { parseTaRef } from "../../lib/taArticle";
import { twShort } from "../../lib/twArticle";
import type { TnRow, TqRow, TwlRow } from "../../sync/api";

// ─── original words ─────────────────────────────────────────────────────────

export interface OriginalWord {
  /** 0-based index among the source verse's `\w` tokens, in document order. */
  position: number;
  /** Raw surface form — rendered as-is; every COMPARE goes through matchNorm. */
  text: string;
  strong: string;
  lemma: string;
  morph: string;
  /** The token's own `x-occurrence` attribute (1 when absent). */
  occurrence: number;
  decoded: DecodedMorph | null;
  /** One plain-English line per morpheme, e.g. "noun · feminine · singular". */
  glosses: string[];
  /**
   * Mirrors _vlib.js's `isFunctionOnly` inverted: a word is treated as a
   * CONTENT word when its morphology names a noun/verb/adjective/adverb/
   * pronoun — or when it carries no decodable morphology at all (the mockup
   * deliberately errs toward "content" there, so an undecodable word is never
   * silently demoted out of the loud flag).
   */
  isContentWord: boolean;
}

const CONTENT_POS = new Set(["noun", "verb", "adjective", "adverb", "pronoun"]);

function nodeIsWord(n: Record<string, unknown> | null): boolean {
  return !!n && n["type"] === "word" && n["tag"] === "w";
}
function nodeIsMilestone(n: Record<string, unknown> | null): boolean {
  return !!n && n["type"] === "milestone" && n["tag"] === "zaln";
}
function nodeIsPsalmTitle(n: Record<string, unknown> | null): boolean {
  return !!n && n["type"] === "section" && n["tag"] === "d";
}

// Deliberately mirrors highlight.ts's `collectBareWords` traversal (word /
// milestone / `\d` section) so POSITION here means the same thing it means to
// `matchSourceTokens` — the quote anchoring below maps between the two.
export function collectOriginalWords(verseObjects: unknown[] | null | undefined): OriginalWord[] {
  if (!Array.isArray(verseObjects)) return [];
  const out: OriginalWord[] = [];
  const walk = (nodes: unknown[]) => {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      if (nodeIsWord(o)) {
        const morph = String(o["morph"] ?? "");
        const decoded = decodeMorph(morph);
        const glosses = (decoded?.morphemes ?? []).map(morphemeText).filter(Boolean);
        const isContentWord =
          glosses.length === 0 ||
          (decoded?.morphemes ?? []).some((m) => CONTENT_POS.has(m.pos));
        out.push({
          position: out.length,
          text: String(o["text"] ?? ""),
          strong: String(o["strong"] ?? ""),
          lemma: String(o["lemma"] ?? ""),
          morph,
          occurrence: parseInt(String(o["occurrence"] ?? "1"), 10) || 1,
          decoded,
          glosses,
          isContentWord,
        });
      } else if (nodeIsMilestone(o) || nodeIsPsalmTitle(o)) {
        walk((o["children"] as unknown[] | undefined) ?? []);
      }
    }
  };
  walk(verseObjects);
  return out;
}

// ─── the join: alignment source word → original-word position ───────────────

// Consonant skeleton: NFC, then drop pointing/cantillation, joiners, maqaf and
// whitespace. ONLY used as the last-resort tier — the mockup's own bug note
// (docs/mockups/book-package/README.md) is that keying on the skeleton FIRST
// welds distinct words together, because `x-occurrence` counts occurrences of
// the exact POINTED form.
function foldConsonants(s: string): string {
  return s.normalize("NFC").replace(/[\p{Mn}\s־⁠‍-]/gu, "");
}

function nthOrFirst(keys: string[], want: string, occurrence: number): number {
  if (!want) return -1;
  let seen = 0;
  let first = -1;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== want) continue;
    seen += 1;
    if (first < 0) first = i;
    if (seen === occurrence) return i;
  }
  return first;
}

/**
 * Resolve one `\zaln-s` source word to the position of the original word it
 * names. Three tiers, in the order the mockup measured (README: 686 exact, 5
 * on Strong's, 4 on consonants, 0 unresolved across ZEC 1):
 *
 *   1. exact pointed form (matchNorm — NFC + joiner strip) + occurrence
 *   2. Strong's number + occurrence
 *   3. consonant skeleton + occurrence
 *
 * Returns -1 when no tier matches; the caller reports that as unjoined rather
 * than guessing.
 */
export function makePositionResolver(words: OriginalWord[]): (s: SourceWord) => number {
  const exact = words.map((w) => matchNorm(w.text));
  const strongs = words.map((w) => w.strong);
  const folds = words.map((w) => foldConsonants(w.text));
  return (s: SourceWord) => {
    const occ = Math.max(1, parseInt(s.occurrence, 10) || 1);
    if (s.content) {
      const hit = nthOrFirst(exact, matchNorm(s.content), occ);
      if (hit >= 0) return hit;
    }
    if (s.strong) {
      const hit = nthOrFirst(strongs, s.strong, occ);
      if (hit >= 0) return hit;
    }
    if (s.content) {
      const hit = nthOrFirst(folds, foldConsonants(s.content), occ);
      if (hit >= 0) return hit;
    }
    return -1;
  };
}

// ─── lanes ──────────────────────────────────────────────────────────────────

/** One alignment group of a lane: the words that render some original word(s). */
export interface LaneRendering {
  groupId: string;
  /** The group's target words, in document order, space-joined. */
  text: string;
  /** Document position of the group's first target word — the display order. */
  order: number;
  /** Original-word positions this group is aligned to (may be empty). */
  positions: number[];
}

export interface ProseWord {
  kind: "word";
  id: string;
  text: string;
  /** null = supplied: this word has no original word behind it. */
  groupId: string | null;
}
export interface ProseText {
  kind: "text";
  text: string;
}
export type ProseToken = ProseWord | ProseText;

export interface LaneModel {
  /** Role code — "ULT" / "UST". */
  code: string;
  /** False when this workspace has no verse row for the lane at all. */
  present: boolean;
  /** Document-order tokens for Read mode. */
  prose: ProseToken[];
  renderings: LaneRendering[];
  byPosition: Map<number, LaneRendering[]>;
  positionsByGroup: Map<string, number[]>;
  /** Target words with no original word behind them ("supplied"). */
  supplied: string[];
}

export const EMPTY_LANE = (code: string): LaneModel => ({
  code,
  present: false,
  prose: [],
  renderings: [],
  byPosition: new Map(),
  positionsByGroup: new Map(),
  supplied: [],
});

export function buildLane(
  code: string,
  targetVerseObjects: unknown[] | null,
  sourceVerseObjects: unknown[] | null,
  words: OriginalWord[],
): LaneModel {
  if (!targetVerseObjects) return EMPTY_LANE(code);

  // Passing the source tree does two things we want: it re-anchors AI-glued
  // maqaf milestones off the real UHB, and it synthesizes an EMPTY group for
  // every original word the target never referenced. We drop those empty
  // groups here — an original word with no group carrying target words IS the
  // "not rendered" hole, and that is the one thing this screen must not soften.
  const state = parseAlignment(targetVerseObjects, sourceVerseObjects);
  const resolve = makePositionResolver(words);

  const prose: ProseToken[] = [];
  const orderOfGroup = new Map<string, number>();
  let wordIndex = 0;
  for (const item of state.stream) {
    if (item.kind === "word") {
      prose.push({ kind: "word", id: item.word.id, text: item.word.text, groupId: item.alignedTo });
      if (item.alignedTo && !orderOfGroup.has(item.alignedTo)) {
        orderOfGroup.set(item.alignedTo, wordIndex);
      }
      wordIndex += 1;
    } else if (item.kind === "text") {
      prose.push({ kind: "text", text: item.text });
    } else {
      // Paragraph / poetry / footnote markers carry no readable body here —
      // keep the words from gluing together, drop the markup itself.
      prose.push({ kind: "text", text: " " });
    }
  }

  const renderings: LaneRendering[] = [];
  const positionsByGroup = new Map<string, number[]>();
  for (const g of state.groups) {
    const positions = [...new Set(g.source.map(resolve).filter((p) => p >= 0))].sort(
      (a, b) => a - b,
    );
    positionsByGroup.set(g.id, positions);
    if (g.targets.length === 0) continue; // synthetic coverage placeholder
    renderings.push({
      groupId: g.id,
      text: g.targets.map((t) => t.text).join(" "),
      order: orderOfGroup.get(g.id) ?? Number.MAX_SAFE_INTEGER,
      positions,
    });
  }
  renderings.sort((a, b) => a.order - b.order);

  const byPosition = new Map<number, LaneRendering[]>();
  for (const r of renderings) {
    for (const p of r.positions) {
      const list = byPosition.get(p);
      if (list) list.push(r);
      else byPosition.set(p, [r]);
    }
  }

  const supplied = state.unaligned
    .map((t) => t.text)
    .filter((t) => /\p{L}/u.test(t));

  return { code, present: true, prose, renderings, byPosition, positionsByGroup, supplied };
}

/** The lane's rendering(s) of one original word, joined for display. "" = hole. */
export function laneTextFor(lane: LaneModel, position: number): string {
  const list = lane.byPosition.get(position);
  if (!list || list.length === 0) return "";
  return list.map((r) => r.text).join(" … ");
}

// ─── resources ──────────────────────────────────────────────────────────────

export type ResourceKind = "tn" | "twl" | "tq";

export interface ResourceItem {
  /** Stable selection key, e.g. "tn:<rowId>". */
  key: string;
  kind: ResourceKind;
  /** Short uppercase-ish tag shown at the start of the row. */
  tag: string;
  /** Source-language quote, when the resource carries one. */
  quote: string | null;
  /** One-line body for the list row. */
  summary: string;
  /** Original-word positions the quote resolved to. Empty = not anchored. */
  positions: number[];
  tn?: TnRow;
  twl?: TwlRow;
  tq?: TqRow;
}

/**
 * rc://*\/ta/man/translate/figs-idiom → "figs-idiom"; null when the reference
 * is absent or not a recognized tA ref. Uses the app's own parser so this
 * screen agrees with the article viewer about what is and isn't an article.
 */
export function supportRefId(raw: string | null | undefined): string | null {
  return parseTaRef(raw)?.slug ?? null;
}

/** rc://*\/tw/dict/bible/kt/prophet → "kt/prophet"; "" when unparseable. */
export function twLinkId(raw: string | null | undefined): string {
  return twShort(raw);
}

function firstBit(text: string | null | undefined, limit = 110): string {
  const s = String(text ?? "")
    .replace(/\\n/g, " ")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= limit) return s;
  return `${s.slice(0, limit).replace(/\s+\S*$/, "")}…`;
}

/**
 * Resolve a source-language quote to original-word POSITIONS.
 *
 * `matchSourceTokens` is the app's canonical quote resolver (gap markers,
 * occurrence selection, NFC/joiner tolerance) but it returns tokens, not
 * indices — so we map its result back through `(matchNorm(text), occurrence)`,
 * the same identity the source words carry. Two identical surface forms that
 * BOTH lack an `x-occurrence` attribute would collide onto the first; UHB/UGNT
 * stamps the attribute, so that shape is not expected in real data.
 */
export function anchorPositions(
  sourceVerseObjects: unknown[] | null,
  words: OriginalWord[],
  quote: string | null | undefined,
  occurrence: number | null | undefined,
): number[] {
  if (!sourceVerseObjects || !quote) return [];
  const tokens = matchSourceTokens(sourceVerseObjects, quote, occurrence ?? 1);
  if (tokens.length === 0) return [];
  const index = new Map<string, number>();
  for (const w of words) {
    const key = `${matchNorm(w.text)}|${w.occurrence}`;
    if (!index.has(key)) index.set(key, w.position);
  }
  const out: number[] = [];
  for (const t of tokens) {
    const hit = index.get(`${matchNorm(t.text)}|${t.occurrence}`);
    if (hit !== undefined) out.push(hit);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export function buildResources(
  tn: TnRow[],
  twl: TwlRow[],
  tq: TqRow[],
  sourceVerseObjects: unknown[] | null,
  words: OriginalWord[],
): ResourceItem[] {
  const out: ResourceItem[] = [];
  for (const row of tn) {
    out.push({
      key: `tn:${row.id}`,
      kind: "tn",
      tag: supportRefId(row.support_reference)?.replace(/^(figs|writing|grammar|translate)-/, "") ?? "note",
      quote: row.quote,
      summary: firstBit(row.note),
      positions: anchorPositions(sourceVerseObjects, words, row.quote, row.occurrence),
      tn: row,
    });
  }
  for (const row of twl) {
    const id = twLinkId(row.tw_link);
    out.push({
      key: `twl:${row.id}`,
      kind: "twl",
      tag: id.split("/")[0] || "term",
      quote: row.orig_words,
      summary: id.split("/")[1] ?? id,
      positions: anchorPositions(sourceVerseObjects, words, row.orig_words, row.occurrence),
      twl: row,
    });
  }
  for (const row of tq) {
    out.push({
      key: `tq:${row.id}`,
      kind: "tq",
      tag: "q",
      quote: null,
      summary: firstBit(row.question),
      positions: [],
      tq: row,
    });
  }
  return out;
}

// ─── coherence observations ─────────────────────────────────────────────────
//
// Observations, not verdicts — the mockup's own framing, kept verbatim in
// spirit: each entry is a FACT computed from the alignment that an exegete
// would otherwise reconstruct by eye. There is no score and no pass/fail.

export interface CoherenceFlag {
  id: string;
  level: "ok" | "attention" | "note";
  label: string;
  detail: string;
  /** Original-word positions the flag is about; drives click-to-audit. */
  positions: number[];
}

function hebOf(words: OriginalWord[], positions: number[]): string {
  return positions.map((p) => words[p]?.text ?? "").filter(Boolean).join(" · ");
}

export function coherence(
  words: OriginalWord[],
  lit: LaneModel,
  sim: LaneModel,
  resources: ResourceItem[],
): CoherenceFlag[] {
  const out: CoherenceFlag[] = [];
  if (words.length === 0) return out;

  const holes = (lane: LaneModel) =>
    words.filter((w) => (lane.byPosition.get(w.position) ?? []).length === 0).map((w) => w.position);

  const laneFlags = (lane: LaneModel, kind: "sim" | "lit", laneName: string) => {
    if (!lane.present) return;
    const missing = holes(lane);
    const content = missing.filter((p) => words[p].isContentWord);
    const fn = missing.filter((p) => !words[p].isContentWord);

    if (kind === "sim" || content.length) {
      out.push({
        id: `${kind}-holes`,
        level: content.length ? "attention" : "ok",
        label: `${laneName} renders every original word`,
        detail: content.length
          ? `${content.length} content word${content.length === 1 ? "" : "s"} not rendered: ${hebOf(words, content)}`
          : missing.length
            ? `every content word rendered; ${missing.length} function word${missing.length === 1 ? "" : "s"} not (normal)`
            : `all ${words.length} original words rendered`,
        positions: content,
      });
    }
    if (fn.length) {
      out.push({
        id: `${kind}-function`,
        level: "note",
        label: `Function words ${laneName.toLowerCase()} drops`,
        detail: hebOf(words, fn),
        positions: fn,
      });
    }
  };

  // Simplified first — it is the lane whose holes are worth looking at most
  // often — then literal, matching the mockup's flag order.
  laneFlags(sim, "sim", "Simplified text");
  laneFlags(lit, "lit", "Literal text");

  // One original word carried by target words in more than one place: a
  // restructure, worth seeing but not a fault.
  const spread = words
    .filter(
      (w) =>
        (lit.byPosition.get(w.position) ?? []).length > 1 ||
        (sim.byPosition.get(w.position) ?? []).length > 1,
    )
    .map((w) => w.position);
  if (spread.length) {
    out.push({
      id: "spread",
      level: "note",
      label: "Word rendered in more than one place",
      detail: `${spread.length} word${spread.length === 1 ? "" : "s"}: ${hebOf(words, spread)}`,
      positions: spread,
    });
  }

  const quoted = resources.filter((r) => r.kind === "tn" && r.quote);
  const unanchored = quoted.filter((r) => r.positions.length === 0);
  if (quoted.length) {
    out.push({
      id: "tn-anchor",
      level: unanchored.length ? "attention" : "ok",
      label: "Every note's quote is found in the original",
      detail: unanchored.length
        ? `${unanchored.length} of ${quoted.length} note quote${quoted.length === 1 ? "" : "s"} no longer match the original text`
        : `${quoted.length} of ${quoted.length} anchored`,
      positions: [],
    });
  }

  const notes = resources.filter((r) => r.kind === "tn");
  const noArticle = notes.filter((r) => !supportRefId(r.tn?.support_reference));
  if (noArticle.length) {
    out.push({
      id: "tn-article",
      level: "note",
      label: "Notes with no translationAcademy article",
      detail: `${noArticle.length} of ${notes.length}`,
      positions: [],
    });
  }

  if (lit.supplied.length) {
    out.push({
      id: "supplied-lit",
      level: "note",
      label: "Literal words with no original behind them",
      detail: lit.supplied.join(" · "),
      positions: [],
    });
  }
  if (sim.supplied.length) {
    out.push({
      id: "supplied-sim",
      level: "note",
      label: "Simplified words with no original behind them",
      detail: sim.supplied.join(" · "),
      positions: [],
    });
  }

  return out;
}
