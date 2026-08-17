import { useState } from "react";

// Shared save-state helper: tracks a section's in-flight save + transient
// status message. Lives in its own module so section components extracted out
// of PreferencesWorkspace.tsx (LocalizationSection, TerminologySection) can
// share it without importing back into PreferencesWorkspace (which would form a
// module cycle).
export function useSaveState() {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return { saving, setSaving, msg, setMsg, clear: () => setMsg(null) };
}
