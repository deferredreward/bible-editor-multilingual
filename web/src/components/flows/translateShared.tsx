// Helpers shared by the translator queue screens (TranslateNotesScreen,
// TranslateQuestionsScreen). Extracted verbatim from TranslateNotesScreen so
// both screens run the identical save-settlement logic — this file changes no
// behaviour, it only stops the two screens from drifting apart.

import { onOutboxResult, type OutboxResult } from "../../sync/outbox";

// Row text comes across with literal "\n" escape sequences (the source TSV
// format), not real newlines — same treatment ReviewQueue/NoteCard give it.
export function unescapeNewlines(text: string | null | undefined): string {
  return (text ?? "").replace(/\\n/g, "\n");
}

// Wait for one outbox op to settle. "retry" is not a settlement — the op is
// still in flight and will be dispatched again. Resolves null on timeout (a
// read-only/frozen lane returns a no-op op that never settles), so the caller
// can say so honestly instead of assuming the save landed.
export function waitForOp(opId: string, timeoutMs = 20_000): Promise<OutboxResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    let off: (() => void) | null = null;
    const finish = (result: OutboxResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off?.();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    off = onOutboxResult((op, result) => {
      if (op.id !== opId || result.kind === "retry") return;
      finish(result);
    });
  });
}
