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

/**
 * Pure helper for the /api/tn-quick proxy: fold contextRef + targetLang +
 * direction into the caller's request body. contextRef only appears when a
 * successful context export exists (omitted entirely otherwise — the bot's
 * schema is zod .strict(), so a present-but-undefined key would still 400).
 * Caller-supplied values always win over the derived ones.
 */
export function applyTnQuickContext(
  body: Record<string, unknown>,
  latest: SuccessfulContextExport | null,
  cfg: { languageCode: string; direction: "ltr" | "rtl" },
): Record<string, unknown> {
  const withContextRef = applyContextRef(body, latest);
  const result = { ...withContextRef };
  if (!("targetLang" in result) && cfg.languageCode) {
    result.targetLang = cfg.languageCode;
  }
  if (!("direction" in result) && cfg.direction) {
    result.direction = cfg.direction;
  }
  return result;
}
