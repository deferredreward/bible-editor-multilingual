// Which way the notes pane is currently laying out source-vs-draft inside each
// note card.
//
// The value is published by NotesPanelBody rather than read from editorPrefs
// directly, because the pane applies one adjustment the raw preference doesn't
// know about: side by side is unusable in a narrow column, so a pane below
// PAIR_NARROW_PX renders stacked regardless of the stored choice. Cards consume
// the EFFECTIVE axis from here; the preference itself is never rewritten, so
// widening the pane restores the translator's actual choice.
//
// Default "vertical" means any card rendered outside a notes pane keeps the
// historical stacked layout.

import { createContext, useContext } from "react";
import type { NotePairAxis } from "../lib/editorPrefs";

export const NotePairAxisContext = createContext<NotePairAxis>("vertical");

export function useNotePairAxisContext(): NotePairAxis {
  return useContext(NotePairAxisContext);
}

// Below this pane width the two halves are too cramped to translate in, so the
// pane falls back to stacked. Tuned against the wide-notes-pane layout: side by
// side really wants a Flexible layout or a widened resource column.
export const PAIR_NARROW_PX = 620;
