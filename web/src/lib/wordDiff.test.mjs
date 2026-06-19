// Unit tests for wordDiff.ts — the word-level LCS diff shared by the note +
// verse history dialogs. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/wordDiff.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { tokenize, diffWords } from "./wordDiff.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const text = (ops) => ops.map((o) => o.text).join("");
const eqOnly = (ops) => ops.every((o) => o.type === "eq");

// --- tokenize keeps word and non-word runs separate ---
assert(JSON.stringify(tokenize("a, b")) === JSON.stringify(["a", ", ", "b"]), "tokenize splits word/non-word runs");
assert(tokenize("").length === 0, "tokenize empty → []");

// --- identical strings → all eq, reconstructs the input ---
{
  const ops = diffWords("the quick fox", "the quick fox");
  assert(eqOnly(ops), "identical → all eq");
  assert(text(ops) === "the quick fox", "identical → reconstructs input");
}

// --- a single word change shows del + add, surrounding words stay eq ---
{
  const ops = diffWords("the quick fox", "the slow fox");
  assert(!eqOnly(ops), "one-word change is not all-eq");
  assert(ops.some((o) => o.type === "del" && o.text.includes("quick")), "old word marked del");
  assert(ops.some((o) => o.type === "add" && o.text.includes("slow")), "new word marked add");
  // "the " and " fox" survive as eq context.
  assert(ops.some((o) => o.type === "eq" && o.text.includes("the")), "leading context eq");
  assert(ops.some((o) => o.type === "eq" && o.text.includes("fox")), "trailing context eq");
}

// --- punctuation flips in its own token without dragging the word ---
{
  const ops = diffWords("Yahweh.", "Yahweh:");
  assert(ops.some((o) => o.type === "eq" && o.text === "Yahweh"), "word stays eq across punctuation change");
  assert(ops.some((o) => o.type === "del" && o.text === "."), "old punctuation del");
  assert(ops.some((o) => o.type === "add" && o.text === ":"), "new punctuation add");
}

// --- pure insertion (empty → text) is all add ---
{
  const ops = diffWords("", "added words");
  assert(ops.every((o) => o.type === "add"), "empty → text is all add");
  assert(text(ops) === "added words", "insertion reconstructs target");
}

// --- pure deletion (text → empty) is all del ---
{
  const ops = diffWords("removed words", "");
  assert(ops.every((o) => o.type === "del"), "text → empty is all del");
}

// --- same-type runs are merged into single ops ---
{
  const ops = diffWords("one two three", "");
  assert(ops.length === 1 && ops[0].type === "del", "adjacent dels merge into one op");
}

console.log("\nwordDiff.test.mjs: all assertions passed");
