// Pure helper: given assisted_mode + latest successful export, decide whether
// to inject contextRef into translate options. Extracted so pipeline injection
// is unit-testable without the Hono route module.

import { buildContextRef } from "./contextExport.ts";
import type { SuccessfulContextExport } from "./contextExportLib.ts";

export function applyAssistedContextRef(
  options: Record<string, unknown>,
  assistedMode: boolean,
  latest: SuccessfulContextExport | null,
): Record<string, unknown> {
  // Caller-supplied contextRef (explicit override) wins — leave it alone.
  if (typeof options.contextRef === "string" && options.contextRef.trim()) {
    return options;
  }
  if (!assistedMode || !latest) return options;
  return {
    ...options,
    contextRef: buildContextRef(latest.owner, latest.sha),
  };
}
