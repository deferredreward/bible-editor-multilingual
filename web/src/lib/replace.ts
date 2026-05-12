// Smart verse-content rewriter for find/replace.
//
// The naive replace path collapses the whole verse to a single text token —
// which destroys every `\w` word AND every `\zaln-s` alignment milestone, so
// the aligner ends up with neither targets to drag nor any alignment to
// re-use. This module tries harder: when a match falls cleanly on word
// boundaries and the find/replace strings have matching word counts, we
// rewrite the affected `\w` leaves in place and leave the surrounding
// milestones intact, preserving alignment for that verse.
//
// When the structural conditions don't hold (match mid-word, word-count
// mismatch, etc.) we fall back to a re-tokenized rewrite: the new text is
// split into `\w` words + whitespace `text` nodes so the aligner at least
// has draggable targets in the unaligned bag instead of an empty verse.

export interface SmartReplaceResult {
  content: unknown;
  plainText: string;
  preservedAlignment: boolean;
}

interface Leaf {
  node: Record<string, unknown>;
  start: number;
  end: number;
}

function walkLeaves(verseObjects: unknown[]): { raw: string; leaves: Leaf[] } {
  const leaves: Leaf[] = [];
  let pos = 0;
  const walk = (nodes: unknown[]) => {
    for (const n of nodes ?? []) {
      const o = n as Record<string, unknown> | null;
      if (!o) continue;
      const text = o["text"];
      if (typeof text === "string") {
        leaves.push({ node: o, start: pos, end: pos + text.length });
        pos += text.length;
      }
      const children = o["children"];
      if (Array.isArray(children)) walk(children);
    }
  };
  walk(verseObjects);
  return { raw: leaves.map((l) => String(l.node["text"])).join(""), leaves };
}

function normalize(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function rebuildRaw(verseObjects: unknown[]): string {
  const parts: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const n of nodes ?? []) {
      const o = n as Record<string, unknown> | null;
      if (!o) continue;
      const text = o["text"];
      if (typeof text === "string") parts.push(text);
      const children = o["children"];
      if (Array.isArray(children)) walk(children);
    }
  };
  walk(verseObjects);
  return parts.join("");
}

function isWordLeaf(node: Record<string, unknown>): boolean {
  return node["type"] === "word" && node["tag"] === "w";
}

// Re-tokenize a plain string into a flat verseObjects-style array. Each
// non-whitespace run becomes a `\w` node so the aligner has draggable
// targets; the whitespace runs ride along as `text` nodes. Used only when
// the smart path bails.
export function tokenizePlainText(text: string): unknown[] {
  const out: unknown[] = [];
  const occByWord = new Map<string, number>();
  let i = 0;
  while (i < text.length) {
    const isSpace = /\s/.test(text[i]);
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j]) === isSpace) j++;
    const chunk = text.slice(i, j);
    if (isSpace) {
      out.push({ type: "text", text: chunk });
    } else {
      const occ = (occByWord.get(chunk) ?? 0) + 1;
      occByWord.set(chunk, occ);
      out.push({
        type: "word",
        tag: "w",
        text: chunk,
        occurrence: String(occ),
        occurrences: "1",
      });
    }
    i = j;
  }
  return out;
}

// Find the Nth (1-based) occurrence of `regex` in `text`. Returns null if
// fewer than `n` matches exist.
function nthMatchIn(text: string, regex: RegExp, n: number): { index: number; length: number } | null {
  const local = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = local.exec(text)) !== null) {
    count++;
    if (count === n) return { index: m.index, length: m[0].length };
    if (m[0].length === 0) local.lastIndex++;
  }
  return null;
}

// Count how many matches of `regex` appear in `text` strictly before
// position `before`. The active match's plain-text position lets us derive
// "this is the Nth occurrence" without re-running the entire verse search.
function countMatchesBefore(text: string, regex: RegExp, before: number): number {
  const local = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = local.exec(text)) !== null) {
    if (m.index >= before) break;
    n++;
    if (m[0].length === 0) local.lastIndex++;
  }
  return n;
}

// Deep-clone the verseObjects tree so callers can swap content without
// mutating shared state.
function cloneVerseObjects(verseObjects: unknown[]): unknown[] {
  return JSON.parse(JSON.stringify(verseObjects)) as unknown[];
}

// Smart replace: given the verse content, the plain text the match was
// found in, the regex used, and the literal active-match info, produce a
// new content + plain text. Tries to keep alignment when possible.
export function smartReplaceVerse(
  content: unknown,
  plainText: string,
  regex: RegExp,
  matchStartInPlain: number,
  matchLenInPlain: number,
  replaceText: string,
): SmartReplaceResult {
  const verseObjects = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
  // No verseObjects to work with — just rebuild the verse from the new
  // plain text, tokenized.
  if (!Array.isArray(verseObjects)) {
    const before = plainText.slice(0, matchStartInPlain);
    const after = plainText.slice(matchStartInPlain + matchLenInPlain);
    const newPlain = normalize(before + replaceText + after);
    return {
      content: { verseObjects: tokenizePlainText(newPlain) },
      plainText: newPlain,
      preservedAlignment: false,
    };
  }

  // Determine which occurrence (1-based) the active match is, then find
  // the corresponding occurrence in the raw verseObjects concatenation.
  const occurrenceNum = countMatchesBefore(plainText, regex, matchStartInPlain) + 1;
  const cloned = cloneVerseObjects(verseObjects);
  const { raw, leaves } = walkLeaves(cloned);
  const rawMatch = nthMatchIn(raw, regex, occurrenceNum);

  // If the raw search yields nothing (normalization wiped a match), fall
  // back to the flat tokenized path so we at least produce \w nodes.
  if (!rawMatch) {
    const before = plainText.slice(0, matchStartInPlain);
    const after = plainText.slice(matchStartInPlain + matchLenInPlain);
    const newPlain = normalize(before + replaceText + after);
    return {
      content: { verseObjects: tokenizePlainText(newPlain) },
      plainText: newPlain,
      preservedAlignment: false,
    };
  }

  const rawStart = rawMatch.index;
  const rawEnd = rawStart + rawMatch.length;
  const rawMatchText = raw.slice(rawStart, rawEnd);

  // Smart in-place path requires:
  //   (a) match boundaries align with leaf boundaries — no mid-leaf splits;
  //   (b) word-count parity between find and replace strings;
  //   (c) same number of \w leaves in the affected range as words on
  //       either side, so the 1:1 mapping is unambiguous.
  const affected = leaves.filter((l) => l.start < rawEnd && l.end > rawStart);
  const startsAtBoundary = affected.length > 0 && affected[0].start === rawStart;
  const endsAtBoundary = affected.length > 0 && affected[affected.length - 1].end === rawEnd;
  const matchWords = rawMatchText.split(/\s+/).filter(Boolean);
  const replaceWords = replaceText.split(/\s+/).filter(Boolean);
  const wordLeaves = affected.filter((l) => isWordLeaf(l.node));
  const canPreserve =
    startsAtBoundary &&
    endsAtBoundary &&
    matchWords.length === replaceWords.length &&
    wordLeaves.length === matchWords.length;

  if (canPreserve) {
    // 1:1 word mapping. Whitespace text leaves between words stay as-is.
    for (let i = 0; i < wordLeaves.length; i++) {
      wordLeaves[i].node["text"] = replaceWords[i];
    }
    const newRaw = rebuildRaw(cloned);
    return {
      content: { verseObjects: cloned },
      plainText: normalize(newRaw),
      preservedAlignment: true,
    };
  }

  // Structural mismatch — re-tokenize the whole verse. Alignment is lost,
  // but the aligner gets back a verse full of \w nodes to drag instead of
  // a single text token.
  const before = raw.slice(0, rawStart);
  const after = raw.slice(rawEnd);
  const newRaw = before + replaceText + after;
  return {
    content: { verseObjects: tokenizePlainText(newRaw) },
    plainText: normalize(newRaw),
    preservedAlignment: false,
  };
}
