import assert from "node:assert/strict";
import {
  stripAlignmentNodes,
  canonicalizeNonAlignmentContent,
  nonAlignmentContentEqual,
  derivePlainText,
  canonicalizeUsfmWithoutAlignment,
  nonAlignmentUsfmEqual,
} from "./alignmentCanonical.ts";

// ── stripAlignmentNodes ──────────────────────────────────────────────────────

// Strips zaln milestones, flattening children
{
  const input = [
    {
      type: "milestone",
      tag: "zaln",
      children: [
        { type: "word", tag: "w", text: "hello" },
        { type: "text", text: " " },
        { type: "word", tag: "w", text: "world" },
      ],
    },
  ];
  const result = stripAlignmentNodes(input);
  assert.equal(result.length, 3);
  // \w nodes keep their full shape (lemma/strong/morph preserved); only zaln
  // wrappers are unwrapped.
  assert.equal(result[0].type, "word");
  assert.equal(result[0].tag, "w");
  assert.equal(result[0].text, "hello");
  assert.equal(result[1].text, " ");
  assert.equal(result[2].text, "world");
}

// Linguistic attrs on words are NOT alignment-owned — must survive strip
{
  const input = [
    {
      type: "word",
      tag: "w",
      text: "God",
      strong: "G2316",
      lemma: "θεός",
      morph: "Gr,N,,,,,NMS,",
    },
  ];
  const result = stripAlignmentNodes(input);
  assert.equal(result.length, 1);
  assert.equal(result[0].strong, "G2316");
  assert.equal(result[0].lemma, "θεός");
  assert.equal(result[0].morph, "Gr,N,,,,,NMS,");
  // Different Strong's → not equal under nonAlignmentContentEqual
  const a = { verseObjects: input };
  const b = {
    verseObjects: [{ type: "word", tag: "w", text: "God", strong: "G9999", lemma: "θεός", morph: "Gr,N,,,,,NMS," }],
  };
  assert.ok(!nonAlignmentContentEqual(a, b), "Strong's drift must not compare equal");
}

// Occurrence bookkeeping is alignment-owned — stale vs normalized must equal
{
  const a = {
    verseObjects: [
      { type: "word", tag: "w", text: "God", strong: "G2316", occurrence: "1", occurrences: "2" },
    ],
  };
  const b = {
    verseObjects: [
      { type: "word", tag: "w", text: "God", strong: "G2316", occurrence: "2", occurrences: "2" },
    ],
  };
  assert.ok(nonAlignmentContentEqual(a, b), "occurrence-only drift is alignment-editable");
  const stripped = stripAlignmentNodes(a.verseObjects);
  assert.equal(stripped[0].occurrence, undefined);
  assert.equal(stripped[0].strong, "G2316");
}

// Passes through non-alignment nodes
{
  const input = [
    { type: "text", text: "plain text" },
    { type: "paragraph", tag: "p" },
  ];
  const result = stripAlignmentNodes(input);
  assert.equal(result.length, 2);
}

// ── nonAlignmentContentEqual ─────────────────────────────────────────────────

// Same text, different alignment → equal
{
  const a = {
    verseObjects: [
      { type: "milestone", tag: "zaln", children: [{ type: "word", tag: "w", text: "hello" }] },
    ],
  };
  const b = {
    verseObjects: [
      { type: "milestone", tag: "zaln", children: [{ type: "word", tag: "w", text: "hello" }] },
    ],
  };
  assert.ok(nonAlignmentContentEqual(a, b));
}

// Different text → not equal
{
  const a = { verseObjects: [{ type: "word", tag: "w", text: "hello" }] };
  const b = { verseObjects: [{ type: "word", tag: "w", text: "world" }] };
  assert.ok(!nonAlignmentContentEqual(a, b));
}

// Null content
{
  assert.ok(nonAlignmentContentEqual(null, null));
  assert.ok(nonAlignmentContentEqual(null, { verseObjects: [] }));
}

// ── derivePlainText ──────────────────────────────────────────────────────────

{
  const content = {
    verseObjects: [
      {
        type: "milestone",
        tag: "zaln",
        children: [
          { type: "word", tag: "w", text: "In" },
          { type: "text", text: " " },
          { type: "word", tag: "w", text: "the beginning" },
        ],
      },
    ],
  };
  assert.equal(derivePlainText(content), "In the beginning");
}

{
  assert.equal(derivePlainText(null), "");
  assert.equal(derivePlainText({}), "");
}

// ── canonicalizeUsfmWithoutAlignment / nonAlignmentUsfmEqual ─────────────────

{
  const base = `\\id TIT EN_ULT
\\c 1
\\p
\\v 1 \\zaln-s |x-strong="G2316"|\\*\\w God\\w*\\zaln-e\\* speaks.
\\v 2 Hello world.
`;
  const alignedDiff = `\\id TIT EN_ULT
\\c 1
\\p
\\v 1 \\zaln-s |x-strong="G9999"|\\*\\w God\\w*\\zaln-e\\* speaks.
\\v 2 Hello world.
`;
  const textDiff = `\\id TIT EN_ULT
\\c 1
\\p
\\v 1 God speaks differently.
\\v 2 Hello world.
`;
  const missingVerse = `\\id TIT EN_ULT
\\c 1
\\p
\\v 1 God speaks.
`;
  const headerDiff = `\\id TIT EN_AVD
\\c 1
\\p
\\v 1 God speaks.
\\v 2 Hello world.
`;

  const a = canonicalizeUsfmWithoutAlignment(base);
  const b = canonicalizeUsfmWithoutAlignment(alignedDiff);
  assert.ok(a && b, "both parse");
  assert.equal(a, b, "alignment-only change is equal after strip");

  assert.equal(nonAlignmentUsfmEqual(base, alignedDiff).ok, true);
  assert.equal(nonAlignmentUsfmEqual(base, textDiff).ok, false);
  assert.equal(nonAlignmentUsfmEqual(base, missingVerse).ok, false, "verse deletion fails");
  assert.equal(nonAlignmentUsfmEqual(base, headerDiff).ok, false, "header drift fails");
  assert.equal(nonAlignmentUsfmEqual(base, "\\not valid {{{{").ok, false);
}

console.log("alignmentCanonical tests passed");
