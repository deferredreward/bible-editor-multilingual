// Pure helper: inject the pinned contextRef into translate options whenever a
// successful context export exists. Extracted so pipeline injection is
// unit-testable without the Hono route module. (The former assisted_mode gate
// was removed — prefs flow to the bot with zero user awareness.)

import { buildContextRef } from "./contextExport.ts";
import type { SuccessfulContextExport } from "./contextExportLib.ts";

// The bot's zod schema is .strict() — any key it doesn't declare, or any
// value that fails its own field validation, 400s the WHOLE request. So every
// derived value here is checked against the bot's own shape before being
// added; a mismatch is omitted (and logged) rather than sent, because the
// alternative is "every Suggest/draft call 400s" for any project whose
// config happens to hold a value the bot doesn't like.
//
// targetLang: mirrors the bot's language-tag validation. cfg.languageCode is
// deliberately unvalidated at the persist boundary (projectConfigRoutes.ts —
// "languageCode stays loose, it's not a URL path segment"), so real-world
// values like "el-x-koine", "zh-Hans-CN", "pt_BR", "EN" can reach here.
const TARGET_LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

// contextRef: mirrors the bot's ref validation. Our own isIdent (used to
// validate org/repo at the persist boundary) allows "~", which the bot
// rejects — so a built ref must be re-checked against the bot's stricter
// shape, not assumed valid just because the owner passed isIdent.
const CONTEXT_REF_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@\S{1,}$/;
const CONTEXT_REF_MIN_LEN = 3;
const CONTEXT_REF_MAX_LEN = 200;

function isValidContextRef(ref: string): boolean {
  return ref.length >= CONTEXT_REF_MIN_LEN && ref.length <= CONTEXT_REF_MAX_LEN && CONTEXT_REF_RE.test(ref);
}

/** Build the pinned contextRef and validate it against the bot's shape; omit + warn on mismatch. */
function derivedContextRef(latest: SuccessfulContextExport | null): string | undefined {
  if (!latest) return undefined;
  const ref = buildContextRef(latest.owner, latest.sha);
  if (isValidContextRef(ref)) return ref;
  console.warn(`assistedContextRef: built contextRef failed bot validation, omitting: ${ref}`);
  return undefined;
}

/**
 * Validate a project's languageCode against the bot's targetLang shape;
 * omit + warn on mismatch. Exported for templates.ts, whose template-quick
 * body builds targetLang directly from cfg.languageCode rather than through
 * applyTnQuickContext.
 */
export function derivedTargetLang(languageCode: string): string | undefined {
  if (!languageCode) return undefined;
  if (TARGET_LANG_RE.test(languageCode)) return languageCode;
  console.warn(`assistedContextRef: languageCode failed bot validation, omitting targetLang: ${languageCode}`);
  return undefined;
}

export function applyContextRef(
  options: Record<string, unknown>,
  latest: SuccessfulContextExport | null,
): Record<string, unknown> {
  // Caller-supplied contextRef (explicit override) wins — leave it alone.
  // Safe here because every caller of this function builds `options`
  // server-side (pipelines.ts's translate branch, templates.ts) — never from
  // end-user request bodies. See applyTnQuickContext for the path where the
  // caller IS end-user input and this trust assumption does not hold.
  if (typeof options.contextRef === "string" && options.contextRef.trim()) {
    return options;
  }
  const ref = derivedContextRef(latest);
  if (!ref) return options;
  return { ...options, contextRef: ref };
}

/**
 * Drop the three context fields from a caller-supplied body. The tn-quick
 * route must forward a stripped body even when the derivation below fails,
 * so this is exported separately from applyTnQuickContext: degrading to the
 * caller's raw body would hand a client-controlled contextRef to the bot
 * under our shared token (see applyTnQuickContext for why that matters).
 */
export function stripClientContextFields(body: Record<string, unknown>): Record<string, unknown> {
  const { contextRef: _ref, targetLang: _lang, direction: _dir, ...rest } = body;
  return { ...rest };
}

/**
 * Pure helper for the /api/tn-quick proxy: fold contextRef + targetLang +
 * direction into the caller's request body, ALWAYS deriving them server-side.
 *
 * Unlike applyContextRef, this path never honors a client-supplied
 * contextRef/targetLang/direction: the tn-quick route forwards to the bot
 * using our own shared BT_API_TOKEN, so a caller-controlled contextRef would
 * let any authenticated editor read another workspace's curated context pack
 * (cross-tenant read) or steer the draft with an arbitrary ref
 * (prompt-steering). Any such fields on the incoming body are dropped before
 * the derived values are applied.
 *
 * contextRef only appears when a successful context export exists AND it
 * passes the bot's own ref shape (omitted entirely otherwise — the bot's
 * schema is zod .strict(), so a present-but-undefined key would still 400).
 */
export function applyTnQuickContext(
  body: Record<string, unknown>,
  latest: SuccessfulContextExport | null,
  cfg: { languageCode: string; direction: "ltr" | "rtl" },
): Record<string, unknown> {
  const result: Record<string, unknown> = stripClientContextFields(body);
  const ref = derivedContextRef(latest);
  if (ref) result.contextRef = ref;
  const targetLang = derivedTargetLang(cfg.languageCode);
  if (targetLang) result.targetLang = targetLang;
  if (cfg.direction) result.direction = cfg.direction;
  return result;
}
