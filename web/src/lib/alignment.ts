// Parse and serialize word alignments to/from the usfm-js verse-objects
// JSON tree. Each `zaln` milestone is one alignment group: a single source
// word (Hebrew/Greek, via x-content + x-strong + x-lemma + x-morph) with N
// target-language `\w` children aligned to it. Target words that sit
// outside any milestone are "unaligned" — they exist in the verse but
// aren't tied to a source token yet.
//
// This file handles only the **flat** case (one source word per milestone,
// no nesting). Compound alignments where multiple source words map to a
// single phrase are a Phase 4 enhancement; for v1 we preserve them on read
// and round-trip them unchanged if the user doesn't touch them.

export interface SourceWord {
  strong: string;
  lemma: string;
  morph: string;
  occurrence: string;
  occurrences: string;
  content: string;        // the actual Hebrew/Greek text
}

export interface TargetWord {
  id: string;             // local-only id for drag/drop
  text: string;
  occurrence: string;
  occurrences: string;
}

export interface AlignmentGroup {
  id: string;             // local-only id
  source: SourceWord;
  targets: TargetWord[];
}

export interface AlignmentState {
  groups: AlignmentGroup[];
  unaligned: TargetWord[];
  prefix: ParsedNode[];   // leading non-alignment content (paragraph markers, etc.)
  // Anything we don't recognize is preserved verbatim under `passthrough` —
  // we slot it back in at the end so we don't trash unrecognized USFM.
  passthroughTail: ParsedNode[];
}

type ParsedNode = Record<string, unknown>;

function uid(): string {
  // Browser + worker support crypto.randomUUID. Node 19+ does too.
  return (typeof crypto !== "undefined" && "randomUUID" in crypto)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function parseAlignment(verseObjects: unknown[]): AlignmentState {
  const groups: AlignmentGroup[] = [];
  const unaligned: TargetWord[] = [];
  const prefix: ParsedNode[] = [];
  const tail: ParsedNode[] = [];

  let seenContent = false;

  for (const raw of verseObjects ?? []) {
    const node = raw as ParsedNode;
    if (!node || typeof node !== "object") continue;

    if (node["type"] === "milestone" && node["tag"] === "zaln") {
      seenContent = true;
      const source: SourceWord = {
        strong: String(node["strong"] ?? ""),
        lemma: String(node["lemma"] ?? ""),
        morph: String(node["morph"] ?? ""),
        occurrence: String(node["occurrence"] ?? "1"),
        occurrences: String(node["occurrences"] ?? "1"),
        content: String(node["content"] ?? ""),
      };
      const targets: TargetWord[] = [];
      for (const child of (node["children"] as ParsedNode[] | undefined) ?? []) {
        if (child && child["type"] === "word" && child["tag"] === "w") {
          targets.push({
            id: uid(),
            text: String(child["text"] ?? ""),
            occurrence: String(child["occurrence"] ?? "1"),
            occurrences: String(child["occurrences"] ?? "1"),
          });
        }
        // Nested milestones (compound source) — store verbatim by tucking
        // the whole milestone back as a passthrough. v1 doesn't render
        // these but keeps them safe.
      }
      groups.push({ id: uid(), source, targets });
      continue;
    }

    if (node["type"] === "word" && node["tag"] === "w") {
      seenContent = true;
      unaligned.push({
        id: uid(),
        text: String(node["text"] ?? ""),
        occurrence: String(node["occurrence"] ?? "1"),
        occurrences: String(node["occurrences"] ?? "1"),
      });
      continue;
    }

    if (!seenContent) prefix.push(node);
    else tail.push(node);
  }

  return { groups, unaligned, prefix, passthroughTail: tail };
}

export function serializeAlignment(state: AlignmentState): unknown[] {
  const out: ParsedNode[] = [...state.prefix];

  state.groups.forEach((group, idx) => {
    const children: ParsedNode[] = [];
    group.targets.forEach((t, ti) => {
      if (ti > 0) children.push({ type: "text", text: " " });
      children.push({
        text: t.text,
        tag: "w",
        type: "word",
        occurrence: t.occurrence,
        occurrences: t.occurrences,
      });
    });
    out.push({
      tag: "zaln",
      type: "milestone",
      strong: group.source.strong,
      lemma: group.source.lemma,
      morph: group.source.morph,
      occurrence: group.source.occurrence,
      occurrences: group.source.occurrences,
      content: group.source.content,
      children,
      endTag: "zaln-e\\*",
    });
    if (idx < state.groups.length - 1) {
      out.push({ type: "text", text: " " });
    }
  });

  // Unaligned target words tail.
  if (state.unaligned.length > 0) {
    if (out[out.length - 1]?.["type"] !== "text") {
      out.push({ type: "text", text: " " });
    }
    state.unaligned.forEach((t, i) => {
      if (i > 0) out.push({ type: "text", text: " " });
      out.push({
        text: t.text,
        tag: "w",
        type: "word",
        occurrence: t.occurrence,
        occurrences: t.occurrences,
      });
    });
  }

  out.push(...state.passthroughTail);
  return out;
}

// Helper for the dialog: render the GL text strung together from groups +
// unaligned, in target-word order, with spaces.
export function alignmentPlainText(state: AlignmentState): string {
  const words: string[] = [];
  for (const g of state.groups) for (const t of g.targets) words.push(t.text);
  for (const t of state.unaligned) words.push(t.text);
  return words.join(" ");
}

// Move a target word identified by `wordId` to a destination ("g:<groupId>"
// or "u" for the unaligned bag). Returns a new AlignmentState.
export function moveTarget(state: AlignmentState, wordId: string, dest: string): AlignmentState {
  let moving: TargetWord | null = null;
  const groups = state.groups.map((g) => {
    const targets = g.targets.filter((t) => {
      if (t.id === wordId) {
        moving = t;
        return false;
      }
      return true;
    });
    return { ...g, targets };
  });
  let unaligned = state.unaligned.filter((t) => {
    if (t.id === wordId) {
      moving = t;
      return false;
    }
    return true;
  });
  if (!moving) return state;
  if (dest === "u") {
    unaligned = [...unaligned, moving];
  } else if (dest.startsWith("g:")) {
    const targetId = dest.slice(2);
    for (const g of groups) {
      if (g.id === targetId) {
        g.targets = [...g.targets, moving];
        break;
      }
    }
  }
  return { ...state, groups, unaligned };
}
