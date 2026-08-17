// Client-side editor preferences (localStorage-backed).
//
// These are lightweight, per-browser behavior toggles that are deliberately NOT
// part of the server-materialized ProjectConfig (which carries org/language/mode
// and is shared across the whole project). They're intended to graduate into the
// expanded Preferences pane later; for now they have no in-app UI and default to
// their safe value. To flip one today, set the localStorage key from the console
// and reload — e.g. `localStorage.setItem("be:lockUnapprovedDrafts", "false")`.
//
// Wiring one into the Preferences pane later is a one-liner: import the hook and
// bind a checkbox to it (mirrors useLogosSyncVisible in LogosSyncToggle.tsx).

import { useEffect, useState } from "react";

// When ON (default), unapproved AI/Aquifer draft notes — those still sitting in
// translation_state === "ai_draft", i.e. raw machine/Aquifer output nobody has
// approved — are read-only while the project is in Editor (authoring) mode. The
// rationale: an editor should not touch raw drafts until a translator has
// approved them in Translator mode. Human-edited ("edited") and approved
// ("validated") notes are unaffected, as are English-root projects (their
// translation_state is null). Set to "false" to allow editing drafts in Editor
// mode too.
const LOCK_UNAPPROVED_DRAFTS_KEY = "be:lockUnapprovedDrafts";

export function getLockUnapprovedDrafts(): boolean {
  try {
    // Default ON: only an explicit "false" disables the lock.
    return localStorage.getItem(LOCK_UNAPPROVED_DRAFTS_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setLockUnapprovedDrafts(next: boolean): void {
  try {
    localStorage.setItem(LOCK_UNAPPROVED_DRAFTS_KEY, String(next));
  } catch {
    /* quota or private mode — soft fail */
  }
}

// React hook form, ready for a future Preferences-pane checkbox. Reads once on
// mount (there's no in-app writer yet, so no cross-component reactivity needed).
export function useLockUnapprovedDrafts(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabledState] = useState<boolean>(getLockUnapprovedDrafts);
  const setEnabled = (next: boolean) => {
    setEnabledState(next);
    setLockUnapprovedDrafts(next);
  };
  return [enabled, setEnabled];
}

// ── Note pair axis ──────────────────────────────────────────────────────────
//
// Which way a translation-mode note lays out its English source against the
// editable target draft, INSIDE the existing note card. Everything else about
// the card — quote, support reference, template/suggest, flag chips, the
// approve/re-run row — is identical either way; only these two blocks move.
//
//   "vertical"   — source stacked above the draft. This is exactly the card
//                  that shipped before this preference existed, so it is the
//                  DEFAULT and nothing changes appearance until a translator
//                  opts in.
//   "horizontal" — source and draft side by side, the tcCreate reading.
//
// This is deliberately a GLOBAL, per-browser preference rather than a property
// of a layout. `PanelConfig.pairAxis` exists in the layout schema for the same
// idea but is per-panel, and a per-panel value can only ever be per-layout — it
// would let Classic and Flexible silently disagree about how a translator's
// notes look. The requirement is the opposite: the choice follows the notes
// pane into every layout and survives reload. So this pref is the single
// runtime source of truth, `pairAxis` is left in the schema as accepted-but-
// advisory (stored layouts stay valid, and a future per-panel override remains
// possible), and nothing reads `pairAxis` at runtime.
export type NotePairAxis = "vertical" | "horizontal";

const NOTE_PAIR_AXIS_KEY = "be:notePairAxis";
const NOTE_PAIR_AXES: readonly NotePairAxis[] = ["vertical", "horizontal"];

export function getNotePairAxis(): NotePairAxis {
  try {
    const raw = localStorage.getItem(NOTE_PAIR_AXIS_KEY);
    return NOTE_PAIR_AXES.includes(raw as NotePairAxis) ? (raw as NotePairAxis) : "vertical";
  } catch {
    return "vertical";
  }
}

// Unlike the toggle above, this pref HAS an in-app writer (the notes-pane
// control) and several panes can be mounted at once in a Flexible layout, so
// writes must fan out to every mounted reader. A module-level subscriber set is
// enough — `storage` events only fire cross-tab, not for same-document writes.
const pairAxisListeners = new Set<(axis: NotePairAxis) => void>();

export function setNotePairAxis(next: NotePairAxis): void {
  try {
    localStorage.setItem(NOTE_PAIR_AXIS_KEY, next);
  } catch {
    /* quota or private mode — soft fail, still notify so the UI stays live */
  }
  for (const listener of pairAxisListeners) listener(next);
}

export function useNotePairAxis(): [NotePairAxis, (next: NotePairAxis) => void] {
  const [axis, setAxisState] = useState<NotePairAxis>(getNotePairAxis);
  useEffect(() => {
    pairAxisListeners.add(setAxisState);
    return () => {
      pairAxisListeners.delete(setAxisState);
    };
  }, []);
  return [axis, setNotePairAxis];
}

// ── Article rail collapse ───────────────────────────────────────────────────
//
// Whether the tW/tA article list rail (ArticleWorkspace.tsx and
// ArticlesScreen.tsx) is fully collapsed to a slim strip. Shared between both
// article viewers so collapsing it in one carries into the other. Defaults OFF
// (rail shown) so nothing changes appearance until a translator opts in.
const ARTICLE_RAIL_COLLAPSED_KEY = "be:articleRailCollapsed";

export function getArticleRailCollapsed(): boolean {
  try {
    return localStorage.getItem(ARTICLE_RAIL_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

// Both article views can be mounted independently across navigations, so
// writes fan out to every mounted reader the same way setNotePairAxis does.
const articleRailCollapsedListeners = new Set<(collapsed: boolean) => void>();

export function setArticleRailCollapsed(next: boolean): void {
  try {
    localStorage.setItem(ARTICLE_RAIL_COLLAPSED_KEY, String(next));
  } catch {
    /* quota or private mode — soft fail, still notify so the UI stays live */
  }
  for (const listener of articleRailCollapsedListeners) listener(next);
}

export function useArticleRailCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsedState] = useState<boolean>(getArticleRailCollapsed);
  useEffect(() => {
    articleRailCollapsedListeners.add(setCollapsedState);
    return () => {
      articleRailCollapsedListeners.delete(setCollapsedState);
    };
  }, []);
  return [collapsed, setArticleRailCollapsed];
}
