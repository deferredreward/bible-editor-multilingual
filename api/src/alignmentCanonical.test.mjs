import assert from "node:assert/strict";
import {
  stripAlignmentNodes,
  canonicalizeNonAlignmentContent,
  nonAlignmentContentEqual,
  derivePlainText,
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
  // \w nodes become {type: "text", text: ...}; non-word text nodes carry
  // the full node shape from the normalizer (tag/content/endMarker undefined).
  assert.equal(result[0].type, "text");
  assert.equal(result[0].text, "hello");
  assert.equal(result[1].text, " ");
  assert.equal(result[2].text, "world");
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

console.log("alignmentCanonical tests passed");
