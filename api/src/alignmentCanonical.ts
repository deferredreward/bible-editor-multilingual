// Canonical non-alignment comparison for text-locked scripture lanes.
// Alignment metadata/grouping may differ; words, punctuation, markers,
// headings, footnotes, and linguistic attrs must be identical after removing
// only explicitly alignment-owned structure (zaln milestones).

import usfm from "usfm-js";

/** Keys owned by the word-alignment layer — dropped from comparison. */
const ALIGNMENT_OWNED_KEYS: ReadonlySet<string> = new Set([
  // Occurrence bookkeeping is rewritten by alignment saves/exports; treating it
  // as locked text would reject valid alignment-only work as drift.
  "occurrence",
  "occurrences",
  "x-occurrence",
  "x-occurrences",
]);

function stripAlignmentOwnedKeys(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (ALIGNMENT_OWNED_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Deep-clone a node tree, unwrapping `\zaln` milestones and preserving every
 * non-alignment attribute (lemma, Strong's, morph, footnote attrs, custom
 * marker metadata, etc.).
 */
export function stripAlignmentNodes(nodes: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") {
      out.push(node);
      continue;
    }
    const o = node as Record<string, unknown>;
    if (o["type"] === "milestone" && o["tag"] === "zaln") {
      if (Array.isArray(o["children"])) out.push(...stripAlignmentNodes(o["children"] as unknown[]));
      continue;
    }
    const kept = stripAlignmentOwnedKeys(o);
    if (Array.isArray(kept["children"])) {
      kept["children"] = stripAlignmentNodes(kept["children"] as unknown[]);
    }
    out.push(kept);
  }
  return out;
}

function normalizeLeaves(nodes: unknown[]): unknown[] {
  // Collapse adjacent text nodes and drop empty text so serialization
  // segmentation differences don't false-positive. Preserve all other attrs.
  const flat: unknown[] = [];
  const walk = (list: unknown[]) => {
    for (const n of list) {
      if (!n || typeof n !== "object") continue;
      const o = n as Record<string, unknown>;
      if (o["type"] === "text" && typeof o["text"] === "string") {
        const t = o["text"];
        if (!t) continue;
        const prev = flat[flat.length - 1] as Record<string, unknown> | undefined;
        if (prev && prev["type"] === "text" && typeof prev["text"] === "string") {
          // Only merge pure text leaves that carry no other distinguishing attrs.
          const prevKeys = Object.keys(prev).filter((k) => k !== "type" && k !== "text");
          const curKeys = Object.keys(o).filter((k) => k !== "type" && k !== "text");
          if (prevKeys.length === 0 && curKeys.length === 0) {
            prev["text"] = (prev["text"] as string) + t;
            continue;
          }
        }
        flat.push({ ...o });
        continue;
      }
      if (Array.isArray(o["children"])) {
        flat.push({
          ...o,
          children: normalizeLeaves(o["children"] as unknown[]),
        });
      } else {
        flat.push({ ...o });
      }
    }
  };
  walk(nodes);
  return flat;
}

export function canonicalizeNonAlignmentContent(content: unknown): string {
  const vos = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
  if (!Array.isArray(vos)) return "[]";
  return JSON.stringify(normalizeLeaves(stripAlignmentNodes(vos)));
}

export function nonAlignmentContentEqual(a: unknown, b: unknown): boolean {
  return canonicalizeNonAlignmentContent(a) === canonicalizeNonAlignmentContent(b);
}

/** Derive a simple plain-text from verseObjects for locked-lane saves. */
export function derivePlainText(content: unknown): string {
  const vos = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
  if (!Array.isArray(vos)) return "";
  const parts: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const n of nodes) {
      if (!n || typeof n !== "object") continue;
      const o = n as Record<string, unknown>;
      if (typeof o["text"] === "string") parts.push(o["text"]);
      if (typeof o["content"] === "string" && o["type"] === "paragraph") {
        /* paragraph content is a marker; skip */
      } else if (typeof o["content"] === "string" && o["tag"] && !o["text"]) {
        // section headings etc. often use content
        if (o["type"] !== "marker" || o["tag"] === "s" || o["tag"] === "s1" || o["tag"] === "s2") {
          if (o["type"] === "section" || (typeof o["tag"] === "string" && /^s\d*$/.test(o["tag"]))) {
            parts.push(o["content"]);
          }
        }
      }
      if (Array.isArray(o["children"])) walk(o["children"] as unknown[]);
    }
  };
  walk(stripAlignmentNodes(vos));
  return parts.join("").replace(/\s+/g, " ").trim();
}

/**
 * Canonicalize a whole-book USFM document with alignment milestones removed.
 * Returns null if the USFM cannot be parsed. Used by textReadOnly export gates
 * so headers, headings, chapter material, and verse key sets are compared —
 * not only overlapping verse bodies.
 */
export function canonicalizeUsfmWithoutAlignment(usfmText: string): string | null {
  let json: {
    headers?: unknown;
    chapters?: Record<string, Record<string, { verseObjects?: unknown[] }>>;
  };
  try {
    json = usfm.toJSON(usfmText) as typeof json;
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;

  const chaptersOut: Record<string, Record<string, unknown>> = {};
  const chapters = json.chapters ?? {};
  const chapterKeys = Object.keys(chapters).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  for (const ch of chapterKeys) {
    const verses = chapters[ch] ?? {};
    const verseKeys = Object.keys(verses).sort((a, b) => {
      if (a === "front") return -1;
      if (b === "front") return 1;
      return Number(a) - Number(b) || a.localeCompare(b);
    });
    const verseOut: Record<string, unknown> = {};
    for (const vk of verseKeys) {
      const vos = verses[vk]?.verseObjects;
      verseOut[vk] = Array.isArray(vos)
        ? normalizeLeaves(stripAlignmentNodes(vos))
        : [];
    }
    chaptersOut[ch] = verseOut;
  }
  return JSON.stringify({
    headers: json.headers ?? null,
    chapters: chaptersOut,
  });
}

export function nonAlignmentUsfmEqual(a: string, b: string): { ok: boolean; detail: string } {
  const ca = canonicalizeUsfmWithoutAlignment(a);
  const cb = canonicalizeUsfmWithoutAlignment(b);
  if (ca == null) return { ok: false, detail: "rendered_unparseable" };
  if (cb == null) return { ok: false, detail: "dest_unparseable" };
  if (ca === cb) return { ok: true, detail: "ok" };
  return { ok: false, detail: "usfm_body_diverged" };
}
