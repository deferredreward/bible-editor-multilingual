import test from "node:test";
import assert from "node:assert/strict";
import { isIntroTnRow, tnRedoBlockedReason, tnRedoUsesPipeline } from "./tnRedo.ts";

const msgs = {
  aiUnavailable: null,
  noNoteSelected: "no-note",
  needsSupportRef: "needs-ref",
  needsQuote: "needs-quote",
};

test("intro rows (verse 0) use the pipeline redo path", () => {
  assert.equal(isIntroTnRow({ verse: 0 }), true);
  assert.equal(tnRedoUsesPipeline({ verse: 0 }), true);
  assert.equal(tnRedoUsesPipeline({ verse: 1 }), false);
});

test("intro redo is not blocked by missing support_reference or quote", () => {
  const intro = { verse: 0, support_reference: null, quote: null };
  assert.equal(tnRedoBlockedReason(intro, msgs), null);
});

test("verse-note redo still requires support_reference and quote", () => {
  assert.equal(
    tnRedoBlockedReason({ verse: 1, support_reference: null, quote: "x" }, msgs),
    "needs-ref",
  );
  assert.equal(
    tnRedoBlockedReason(
      { verse: 1, support_reference: "rc://*/ta/man/translate/figs-metaphor", quote: "" },
      msgs,
    ),
    "needs-quote",
  );
  assert.equal(
    tnRedoBlockedReason(
      {
        verse: 1,
        support_reference: "rc://*/ta/man/translate/figs-metaphor",
        quote: "the word",
      },
      msgs,
    ),
    null,
  );
});

test("aiUnavailable and missing row still block every path", () => {
  assert.equal(tnRedoBlockedReason(null, msgs), "no-note");
  assert.equal(
    tnRedoBlockedReason(
      { verse: 0 },
      { ...msgs, aiUnavailable: "ai-off" },
    ),
    "ai-off",
  );
});
