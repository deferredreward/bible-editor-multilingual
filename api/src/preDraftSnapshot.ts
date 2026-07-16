// Pre-draft snapshot semantics (migration 0049), extracted as pure functions so
// they can be unit-tested under the node strip-types runner (same reason
// translateOptions.ts is split out from pipelines.ts — pipelineImport.ts /
// exportWorkflow.ts carry extensionless imports that don't resolve there).
//
// Contract (docs/plan Design 2): when the translate pipeline overwrites a row
// with an ai_draft, the content being destroyed is snapshotted into
// pre_draft_json; the nightly export emits the snapshot for non-validated rows
// so unapproved AI content never reaches DCS. Validate clears the snapshot
// (the approved content becomes the published content).

export type TranslationState = "ai_draft" | "edited" | "validated" | null;

// The pre_draft_json value to write alongside a draft apply.
//   prior NULL / 'validated'  → the current (about-to-be-overwritten) content
//                               is the last published content: fresh snapshot.
//   prior 'ai_draft'/'edited' → draft-over-draft: the existing snapshot still
//                               points at the last published content — carry it
//                               through unchanged (may be NULL for a legacy
//                               pre-migration draft; stays NULL).
export function nextPreDraftJson(
  priorState: TranslationState | string | null,
  existingPreDraftJson: string | null,
  currentContent: Record<string, unknown>,
): string | null {
  if (priorState === "ai_draft" || priorState === "edited") return existingPreDraftJson;
  return JSON.stringify(currentContent);
}

// Export-time decision for one row.
//   current  → row is validated / never drafted: export its live content.
//   snapshot → row is a non-validated draft with a snapshot: export the snapshot.
//   legacy   → non-validated draft but no snapshot (drafted before migration
//              0049, or unparseable): export current content and LOG — accepted
//              one-time exception per the 2026-07-16 decision.
export type ExportGateDecision =
  | { kind: "current" }
  | { kind: "snapshot"; snapshot: Record<string, unknown> }
  | { kind: "legacy" };

export function exportGateDecision(
  state: TranslationState | string | null,
  preDraftJson: string | null,
): ExportGateDecision {
  if (state !== "ai_draft" && state !== "edited") return { kind: "current" };
  if (preDraftJson == null) return { kind: "legacy" };
  try {
    const snapshot = JSON.parse(preDraftJson);
    if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
      return { kind: "snapshot", snapshot: snapshot as Record<string, unknown> };
    }
  } catch {
    // fall through — treat unparseable as legacy (export current, log)
  }
  return { kind: "legacy" };
}

// TSV export gate for one tn/tq row: substitute the snapshotted fields (tn:
// note/tags; tq: question/response) when the row is a non-validated draft with
// a snapshot; otherwise return the row unchanged. `legacy` tells the caller to
// log the one-time exception. Row count is never changed by this gate.
export function gateTsvRowForExport<
  T extends { translation_state?: string | null; pre_draft_json?: string | null },
>(
  row: T,
  fields: readonly string[],
): { row: T; legacy: boolean } {
  const decision = exportGateDecision(
    row.translation_state ?? null,
    row.pre_draft_json ?? null,
  );
  if (decision.kind === "current") return { row, legacy: false };
  if (decision.kind === "legacy") return { row, legacy: true };
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) out[f] = decision.snapshot[f] ?? null;
  return { row: out as T, legacy: false };
}

// Article export gate for one article_unit (additive export — see
// articleExport.ts). Returns the markdown to emit, or null to OMIT the file.
//   validated / never drafted        → current target_md.
//   draft + snapshot with target_md  → the snapshotted (last published) md.
//   draft + snapshot, target_md null → never previously published: omit.
//   draft, no snapshot (legacy)      → current target_md, legacy=true (log).
export function gateArticleForExport(
  state: TranslationState | string | null,
  preDraftJson: string | null,
  currentMd: string,
): { content: string | null; legacy: boolean } {
  const decision = exportGateDecision(state, preDraftJson);
  if (decision.kind === "current") return { content: currentMd, legacy: false };
  if (decision.kind === "legacy") return { content: currentMd, legacy: true };
  const snapMd = decision.snapshot["target_md"];
  return { content: typeof snapMd === "string" ? snapMd : null, legacy: false };
}
