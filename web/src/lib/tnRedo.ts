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
