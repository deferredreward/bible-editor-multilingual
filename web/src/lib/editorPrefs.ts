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

import { useState } from "react";

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
