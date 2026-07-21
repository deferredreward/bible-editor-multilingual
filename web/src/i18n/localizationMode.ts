// Tiny app-wide store for "localization mode" (issue #77, inspect-to-edit).
// Lives outside the React tree (not Context) because the toggle lives in the
// Localization tab of Preferences while the inspector overlay must keep
// working after the user navigates back to the main Shell — Preferences and
// Shell are mutually-exclusive sibling views in App.tsx, so a module-level
// store is simpler than threading the flag through a shared ancestor.
import { useSyncExternalStore } from "react";

let enabled = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function isLocalizationModeEnabled(): boolean {
  return enabled;
}

export function setLocalizationModeEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: re-renders the caller whenever localization mode toggles. */
export function useLocalizationMode(): boolean {
  return useSyncExternalStore(subscribe, isLocalizationModeEnabled, isLocalizationModeEnabled);
}
