// Pure helper: inject the pinned contextRef into translate options whenever a
// successful context export exists. Extracted so pipeline injection is
// unit-testable without the Hono route module. (The former assisted_mode gate
// was removed — prefs flow to the bot with zero user awareness.)

import { buildContextRef } from "./contextExport.ts";
import type { SuccessfulContextExport } from "./contextExportLib.ts";

export function applyContextRef(
  options: Record<string, unknown>,
  latest: SuccessfulContextExport | null,
): Record<string, unknown> {
  // Caller-supplied contextRef (explicit override) wins — leave it alone.
  if (typeof options.contextRef === "string" && options.contextRef.trim()) {
    return options;
  }
  if (!latest) return options;
  return {
    ...options,
    contextRef: buildContextRef(latest.owner, latest.sha),
  };
}
