// Shared gating for the flows Translate Notes "Redo" verb.
//
// Verse notes use the quote-anchored tn-quick path (support_reference +
// quote required). Intro/general notes (`verse === 0`) have neither — they
// retranslate through the existing single-row translate pipeline instead
// (same path classic NoteCard "Re-run" already uses). See issue #300.

export type TnRedoRow = {
  verse: number;
  support_reference?: string | null;
  quote?: string | null;
};

export function isIntroTnRow(row: Pick<TnRedoRow, "verse">): boolean {
  return row.verse === 0;
}

/** True when Redo should start a translate pipeline job rather than tn-quick. */
export function tnRedoUsesPipeline(row: Pick<TnRedoRow, "verse">): boolean {
  return isIntroTnRow(row);
}

// Escape hatch for intro Redo: a fresh single-row translate rarely needs this
// long, but the spinner must not stick forever if onComplete never fires.
export const INTRO_REDO_TIMEOUT_MS = 15 * 60 * 1000;

// When a row-scoped intro Redo is answered `already_running`, pipelineStore.start
// latched onto a broader in-flight translate rather than starting a fresh
// single-row run: per #347 item 1, a covering chapter-wide job is returned with
// its own id. Chapter runs are documented as ~1h (pipelineStore header), so the
// 15-minute budget would flip a perfectly healthy run to a false `timeout`
// failure (#376). Give the shared job a chapter-run-sized budget instead.
export const CHAPTER_REDO_TIMEOUT_MS = 90 * 60 * 1000;

/**
 * Stuck-spinner budget (ms) for an intro Redo, chosen from how
 * `pipelineStore.start` answered. An `already_running` answer means we're
 * waiting on a broader job already in flight (chapter-wide, documented ~1h), so
 * a fresh-run 15-minute timeout would misreport a healthy run as `timeout`
 * (#376). Every other status keeps the short single-row budget.
 */
export function introRedoTimeoutMs(
  startStatus: "running" | "queued" | "already_running",
): number {
  return startStatus === "already_running"
    ? CHAPTER_REDO_TIMEOUT_MS
    : INTRO_REDO_TIMEOUT_MS;
}

export function tnRedoBlockedReason(
  row: TnRedoRow | null | undefined,
  opts: {
    aiUnavailable: string | null;
    noNoteSelected: string;
    needsSupportRef: string;
    needsQuote: string;
  },
): string | null {
  if (opts.aiUnavailable) return opts.aiUnavailable;
  if (!row) return opts.noNoteSelected;
  // Intros skip quote/supportRef — the pipeline retranslates free-form markdown.
  if (tnRedoUsesPipeline(row)) return null;
  if (!row.support_reference) return opts.needsSupportRef;
  if (!row.quote) return opts.needsQuote;
  return null;
}
