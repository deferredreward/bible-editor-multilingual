// Shared types across handlers. Mirrors api/migrations/0001_init.sql.

export type RowKind = "tn" | "tq" | "twl";

export interface TnRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  tags: string | null;
  support_reference: string | null;
  quote: string | null;
  occurrence: number | null;
  note: string | null;
  sort_order: number | null;
  version: number;
  restored_from_version: number | null;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
  /**
   * Visible, restorable soft-delete. Set via /trash (the delete button),
   * cleared via /restore. Distinct from deleted_at: a trashed note stays in
   * the chapter read (grayed, sorted last) until the 06:00 UTC nightly job
   * promotes it to a permanent deleted_at tombstone. NULL means "not trashed".
   */
  trashed_at: number | null;
  /** Explicit "survive future AI pipeline sweeps" bit. Set via /preserve. */
  preserve: 0 | 1;
  /**
   * Editor-authored stub queued for the next chapter-wide AI pipeline run:
   * the proxy gathers these into options.hints, the sweep excludes them,
   * and applyTnHintExpansion updates the row in place when the AI returns.
   */
  hint: 0 | 1;
  /**
   * Workflow-only review flag (NOT exported to DCS — buildTnTsv emits an
   * explicit column list). Set when a note was adapted from a parallel passage
   * and needs a human check: review_kind categorizes it ('quote' | 'xref' |
   * 'sundial' | …) and review_reason is the human-readable detail shown in the
   * "issues to clean up" chip. Cleared on the next TN content save.
   * NULL = no review needed.
   */
  review_kind: string | null;
  review_reason: string | null;
  /**
   * Translation-mode state machine (multilingual; PIPELINE-SPEC §4.1).
   * NULL for the English root project and any row untouched by the translate
   * pipeline. 'ai_draft' → the translate pipeline applied an AI translation;
   * 'edited' → a human changed the draft; 'validated' → a human approved it.
   */
  translation_state: "ai_draft" | "edited" | "validated" | null;
  /** Hash of the EN source row the draft was made from (source-drift detection). */
  source_row_hash: string | null;
  /** translate-report.json entry for this row (confidence/fallback/terms); NULL if no sidecar. */
  draft_meta_json: string | null;
  /**
   * Last PUBLISHED content ({note, tags}), snapshotted when the translate
   * pipeline overwrites the row with an ai_draft (migration 0049). The nightly
   * export emits this for non-validated rows; cleared on validate. NULL =
   * never drafted, or drafted pre-migration (legacy — exports current content).
   */
  pre_draft_json: string | null;
  /**
   * Source label from the row's most recent edit_log entry. 'ai_pipeline'
   * when the last write came from the AI auto-apply step (which means the
   * chip should show); NULL after any subsequent human edit/keep wipes it.
   * Computed at read time — there's no column on tn_rows.
   */
  latest_source?: string | null;
}

export interface TqRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  tags: string | null;
  quote: string | null;
  occurrence: number | null;
  question: string | null;
  response: string | null;
  sort_order: number | null;
  version: number;
  restored_from_version: number | null;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
  /**
   * Translation-mode state machine (multilingual; PIPELINE-SPEC §4.1). Mirrors
   * TnRow. NULL for the English root project and any row untouched by the
   * translate pipeline. 'ai_draft' → the translate pipeline applied an AI
   * translation; 'edited' → a human changed the draft; 'validated' → approved.
   */
  translation_state: "ai_draft" | "edited" | "validated" | null;
  /** Hash of the EN source row the draft was made from (source-drift detection). */
  source_row_hash: string | null;
  /** translate-report.json entry for this row (confidence/fallback/terms); NULL if no sidecar. */
  draft_meta_json: string | null;
  /** Last published {question, response}, snapshotted at draft apply — see TnRow.pre_draft_json. */
  pre_draft_json: string | null;
  /** See TnRow.latest_source. */
  latest_source?: string | null;
}

export interface TwlRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  tags: string | null;
  orig_words: string | null;
  occurrence: number | null;
  tw_link: string | null;
  sort_order: number | null;
  version: number;
  restored_from_version: number | null;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
}

// tW / tA translatable markdown article file (article_units, migration 0039).
// Keyed by (resource, path). See docs/design/tw-ta-translation-modules.md.
export interface ArticleUnit {
  resource: "tw" | "ta";
  path: string;              // repo-relative markdown path (the round-trip id)
  article_id: string;        // grouping key: 'kt/god', 'translate/figs-aside'
  part: "body" | "title" | "sub-title";
  source_md: string;         // English source markdown
  source_sha: string | null;
  target_md: string | null;  // the translation (NULL = not started)
  translation_state: "ai_draft" | "edited" | "validated" | null;
  draft_meta_json: string | null;
  /** Last published {target_md} (null target_md = never translated), snapshotted at draft apply — see TnRow.pre_draft_json. */
  pre_draft_json: string | null;
  version: number;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
  /** See TnRow.latest_source (computed at read time from edit_log). */
  latest_source?: string | null;
}

// Translatable note template (template_units, migration 0053). Keyed by
// template_id (sheet column D, or a positional fallback). Mirrors ArticleUnit,
// including its unix-epoch timestamp / user-FK conventions.
export interface TemplateUnit {
  template_id: string;
  support_ref: string;
  sheet_order: number | null;
  type: string | null;
  source_md: string;
  source_hash: string;
  origin: string;
  target_md: string | null;
  translation_state: "ai_draft" | "edited" | "validated" | null;
  draft_meta_json: string | null;
  pre_draft_json: string | null;
  version: number;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
  /** See TnRow.latest_source (computed at read time from edit_log). */
  latest_source?: string | null;
}

export interface VerseRow {
  book: string;
  chapter: number;
  verse: number;
  // Inclusive end of a multi-verse block (e.g. `\v 6-9` → verse=6, verse_end=9).
  // NULL for singleton verses.
  verse_end: number | null;
  bible_version: string;
  /** Lane generation for ULT/UST; always 1 for UHB/UGNT. */
  source_generation: number;
  content_json: string;
  plain_text: string | null;
  version: number;
  updated_by: number | null;
  updated_at: number;
  created_by_job_id?: string | null;
}

export interface VerseStatus {
  book: string;
  chapter: number;
  verse: number;
  done: 0 | 1;
  updated_at: number;
}

// The per-resource checkoff lanes. "text" covers ULT + UST together (they are
// never checked/proofread solo); the rest map to the resource panels.
export type CheckLane = "text" | "tn" | "tw" | "tq";
export const CHECK_LANES: readonly CheckLane[] = ["text", "tn", "tw", "tq"] as const;

// One checkoff stamp: a (verse, lane) checked by one user. Multiple rows per
// (verse, lane) — one per checker — drive the who-checked shading.
export interface VerseLaneCheck {
  book: string;
  chapter: number;
  verse: number;
  lane: CheckLane;
  checked_by: number;
  checked_at: number;
}

export interface ChapterPayload {
  book: string;
  chapter: number;
  verses: Record<string, Record<number, VerseDto>>; // verses[ULT][1] = VerseDto
  tn: TnRow[];
  tq: TqRow[];
  twl: TwlRow[];
  verseStatuses: VerseStatus[];
  verseLaneChecks: VerseLaneCheck[];
}

export interface VerseDto extends Omit<VerseRow, "content_json"> {
  content: unknown; // parsed usfm-js verse object
}
