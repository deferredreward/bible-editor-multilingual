// Bulk chapter / whole-book review state for tn + tq (issue #296).
//
//   POST /api/books/:book/review-state        (admin only)
//   body: { resources: ("tn"|"tq")[], state: "validated" | "needs_review",
//           chapter?: number, allChapters?: true }
//
//   One of `chapter` or `allChapters: true` is required — a whole-book sweep is
//   thousands of rows and must be asked for, not arrived at by omission.
//
// Why this exists: when we import a body of existing work (Aquifer notes, a
// partner's ar_tn, a prior gatewayEdit run) we sometimes DO know its real
// status — "this book was already checked". Today the only way to say so is
// one note at a time, so the state machine describes the importer, not reality.
//
// ── The deliberate decisions (Benjamin, 2026-08-27 — issue #296 Option 1) ────
//
// 1. NULL-state (never-drafted / imported) rows MAY be bulk-validated. The
//    per-row helpers (setTnTranslationState in rows.ts) refuse this on purpose:
//    a row the translate pipeline never touched must not be stamped 'validated'
//    and then shipped as few-shot GOLD. This route bypasses that guard and pays
//    for it with a provenance stamp instead — see (2).
//
// 2. Every row this route validates is stamped `admin_bulk_state` (migration
//    0070) with the state it held immediately before the sweep ('none' encodes
//    a pre-sweep NULL). The few-shot example selectors
//    (VALIDATED_TN_EXAMPLES_SQL / VALIDATED_TQ_EXAMPLES_SQL in contextExport.ts,
//    and the /translation-memory/examples browse) add `admin_bulk_state IS NULL`,
//    so an admin sweep never becomes training gold. A later per-row human
//    approval clears the stamp (rows.ts) and the row becomes gold normally.
//    The audit trail gets the same news in human form: edit_log rows with
//    source='admin_bulk_state', distinguishable from a translator's approval
//    (source NULL).
//
// 3. Bulk approve DOES overwrite human-'edited'-but-unapproved rows — that is
//    the point of "this chapter is approved". It never touches rows that are
//    ALREADY 'validated': they keep their (unstamped) human provenance, so a
//    sweep can never demote a human approval out of the few-shot pool.
//
// 4. "Needs review" means `translation_state <> 'validated'` — that is exactly
//    what the review queue filters on (web/src/components/ReviewQueue.tsx:1153).
//    So the clear restores the PRE-SWEEP state rather than flattening to
//    'edited': a never-drafted row goes back to NULL. That matters — publishGate
//    OMITS NULL-state rows on foreign-provenance chapters but ships
//    snapshot-backed 'edited' ones, so a flatten-to-'edited' clear could not
//    undo an approve. Rows that were validated by a HUMAN (no stamp) clear to
//    'edited', matching per-row un-approve.
//
// 5. pre_draft_json is written only where there is NONE (COALESCE), which is
//    where this route deliberately parts company with the per-row helper. The
//    per-row helper overwrites the snapshot on every approval — safe, because a
//    human read that one row and approved its content. A sweep touches thousands
//    of rows nobody read, and for an ai_draft/edited row the existing snapshot IS
//    the last PUBLISHED content (Design 2, preDraftSnapshot.ts). Overwriting it
//    would destroy that content permanently and make the sweep un-undoable: the
//    clear would restore the state but the export would then ship the AI draft
//    instead of the human's published text. So: a never-drafted row (no snapshot)
//    gets one, giving it an approved baseline; a drafted row keeps the snapshot
//    it had, and a clear puts its export behaviour back exactly where it was.
//
// 6. Trashed tn rows are never touched (`trashed_at IS NULL`), nor are
//    tombstones (`deleted_at IS NULL`) — matching every other query. Nothing is
//    skipped silently: the response reports counts per category.
//
// ── Subrequest budget ────────────────────────────────────────────────────────
// A whole book is thousands of rows, so this does NOT build one statement per
// row the way aquiferImport.ts does (that shape is forced there by per-row
// values). Every write here is set-based — one UPDATE and one INSERT..SELECT
// audit per category — so the statement count is constant (<= 6 per resource)
// no matter how many rows are in scope, and they go out in a single DB.batch().
//
// ── Known limits, accepted ───────────────────────────────────────────────────
// - "Needs review" is not a rollback of everything an approve set in motion. If
//   the nightly export already published the swept rows to master, clearing them
//   SHRINKS the next render, which the TSV shrink guard (exportWorkflow.ts) will
//   refuse — the book's export stalls with an alert until someone runs it with
//   the shrink override. Undo the label promptly or expect that alert.
// - The sweep writes one edit_log row per changed row, and chapters.ts reads the
//   LATEST edit_log source per row for the 'ai_pipeline' chip — so an approve
//   clears that chip across the scope, exactly as a per-row human approval does
//   (rows.ts). A later clear does not bring the chip back.
// - A bulk-approved row that no human has ever edited is still `updated_by NULL`,
//   so the nightly reimport can still refresh its content from master while the
//   row stays labelled 'validated' (isReimportableRow, reimportClassify.ts).
//   Tracked separately; approving is a statement about review status, not a lock.
// - The counts come from a SELECT taken just before the batch, so a concurrent
//   write between the two can make the "already"/"skipped" numbers disagree with
//   what was written by a hair. The `changed` figures come from the UPDATEs
//   themselves and are exact.
// - Multi-resource calls are not atomic across resources: tn is swept, then tq.
//   A failure on the second leaves the first applied.

import type { Context } from "hono";
import type { Env } from "./index";
import { currentUserId } from "./auth.ts";
import { BOOK_NUMBERS } from "./dcsSources.ts";
import { PRE_SWEEP_STATE, CAPTURE_PRE_SWEEP_STATE, RETIRE_STAMP } from "./adminBulkStamp.ts";

/** edit_log.source written by this route — the audit-trail marker. */
export const ADMIN_BULK_SOURCE = "admin_bulk_state";

export type ReviewStateResource = "tn" | "tq";

export type ReviewStateCounts = {
  /** Live (non-deleted) rows in scope, trashed included. */
  total: number;
  /** Rows whose translation_state this call changed. */
  changed: number;
  /** approve: rows moved to 'validated'. */
  validated: number;
  /** approve: rows already 'validated', left alone (human provenance kept). */
  alreadyValidated: number;
  /** clear: admin-swept rows put back to their pre-sweep state. */
  restored: number;
  /** clear: human-validated (unstamped) rows moved to 'edited'. */
  unvalidated: number;
  /** clear: rows already outside the approved set, left alone. */
  alreadyNeedsReview: number;
  /**
   * clear: rows carrying a stale stamp (swept, then moved on by a human edit or
   * a new AI draft). Their state is left alone — only the stamp is retired — so
   * they are counted in `alreadyNeedsReview` too, not in `changed`.
   */
  stampRetired: number;
  /** tn only — trashed rows are never touched. */
  skippedTrashed: number;
};

function emptyCounts(total = 0, skippedTrashed = 0): ReviewStateCounts {
  return {
    total,
    changed: 0,
    validated: 0,
    alreadyValidated: 0,
    restored: 0,
    unvalidated: 0,
    alreadyNeedsReview: 0,
    stampRetired: 0,
    skippedTrashed,
  };
}

type ResourceSpec = {
  table: string;
  /** tn_rows carries trashed_at (migration 0026); tq_rows does not. */
  hasTrashed: boolean;
  /** The pre_draft_json snapshot written on approval. */
  snapshotJson: string;
};

const SPECS: Record<ReviewStateResource, ResourceSpec> = {
  tn: {
    table: "tn_rows",
    hasTrashed: true,
    snapshotJson: "json_object('note', note, 'tags', tags)",
  },
  tq: {
    table: "tq_rows",
    hasTrashed: false,
    snapshotJson: "json_object('question', question, 'response', response)",
  },
};

/**
 * The scope predicate, with `book` and (optionally) `chapter` bound AFTER the
 * statement's own parameters — so each caller knows its own indices up front
 * and the numbering stays stable whether or not a chapter was given.
 */
function scope(
  spec: ResourceSpec,
  extras: readonly unknown[],
  book: string,
  chapter: number | null,
  opts: { liveOnly?: boolean } = {},
): { where: string; binds: unknown[] } {
  const b = extras.length + 1;
  const parts = [`book = ?${b}`, "deleted_at IS NULL"];
  const binds: unknown[] = [...extras, book];
  if (chapter != null) {
    parts.push(`chapter = ?${b + 1}`);
    binds.push(chapter);
  }
  // Trashed tn rows stay out of every write (they are pending tombstones); the
  // count query deliberately leaves them IN so they can be reported as skipped.
  if (opts.liveOnly && spec.hasTrashed) parts.push("trashed_at IS NULL");
  return { where: parts.join(" AND "), binds };
}

type ScopeCounts = { total: number; trashed: number; validated: number };

/** Statement + binds pair, kept together so DB.batch() ordering is explicit. */
type Stmt = { sql: string; binds: unknown[] };

function auditStmt(
  spec: ResourceSpec,
  resource: ReviewStateResource,
  action: "validate" | "unvalidate",
  userId: number | null,
  book: string,
  chapter: number | null,
  extraWhere: string,
): Stmt {
  // Written BEFORE its UPDATE in the batch, because this UPDATE changes the very
  // columns the SELECT matches on — afterwards the predicate would find nothing.
  // (The per-row helpers in rows.ts audit AFTER their UPDATE; they can, because
  // their guard column is one the UPDATE leaves matching.)
  // Version is carried unchanged (prev = new): a state flip is not a content
  // edit and must not invalidate an in-flight If-Match, exactly like the
  // per-row validate route.
  const { where, binds } = scope(spec, [userId ?? null, action], book, chapter, { liveOnly: true });
  return {
    sql: `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
          SELECT '${resource}', id, book, ?1, version, version, ?2, '${ADMIN_BULK_SOURCE}'
            FROM ${spec.table}
           WHERE ${where} AND ${extraWhere}`,
    binds,
  };
}

// Rows a bulk approve moves: everything live that is not already approved.
const NOT_YET_VALIDATED = "(translation_state IS NULL OR translation_state <> 'validated')";
// Rows still under the sweep's control: stamped AND still holding the state the
// sweep gave them. A stamped row that has since been demoted (a human edited it)
// is no longer ours to restore — we only drop the now-meaningless stamp.
const SWEPT_AND_STILL_VALIDATED = "admin_bulk_state IS NOT NULL AND translation_state = 'validated'";
const SWEPT_BUT_MOVED_ON = "admin_bulk_state IS NOT NULL AND translation_state IS NOT 'validated'";
const HUMAN_VALIDATED = "admin_bulk_state IS NULL AND translation_state = 'validated'";

export async function applyReviewState(
  env: Env,
  resource: ReviewStateResource,
  book: string,
  chapter: number | null,
  state: "validated" | "needs_review",
  userId: number | null,
): Promise<ReviewStateCounts> {
  const spec = SPECS[resource];
  const now = Math.floor(Date.now() / 1000);

  const countScope = scope(spec, [], book, chapter);
  const pre = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            ${spec.hasTrashed ? "SUM(CASE WHEN trashed_at IS NOT NULL THEN 1 ELSE 0 END)" : "0"} AS trashed,
            SUM(CASE WHEN ${spec.hasTrashed ? "trashed_at IS NULL AND " : ""}translation_state = 'validated' THEN 1 ELSE 0 END) AS validated
       FROM ${spec.table} WHERE ${countScope.where}`,
  )
    .bind(...countScope.binds)
    .first<ScopeCounts>();

  const total = Number(pre?.total ?? 0);
  const trashed = Number(pre?.trashed ?? 0);
  const alreadyValidated = Number(pre?.validated ?? 0);
  const counts = emptyCounts(total, trashed);

  if (state === "validated") {
    const audit = auditStmt(spec, resource, "validate", userId, book, chapter, NOT_YET_VALIDATED);
    const up = scope(spec, [now], book, chapter, { liveOnly: true });
    const [, updated] = await env.DB.batch([
      env.DB.prepare(audit.sql).bind(...audit.binds),
      env.DB
        .prepare(
          `UPDATE ${spec.table}
              SET translation_state = 'validated',
                  admin_bulk_state = ${CAPTURE_PRE_SWEEP_STATE},
                  pre_draft_json = COALESCE(pre_draft_json, ${spec.snapshotJson}),
                  updated_at = ?1
            WHERE ${up.where} AND ${NOT_YET_VALIDATED}`,
        )
        .bind(...up.binds),
    ]);
    counts.validated = Number(updated.meta.changes ?? 0);
    counts.alreadyValidated = alreadyValidated;
    counts.changed = counts.validated;
    return counts;
  }

  // needs_review. Three disjoint categories, each audited before it is written.
  // Order is irrelevant to correctness (a swept row is never re-matched by the
  // human-validated predicate, because rows already 'validated' are never
  // stamped) but is kept stable for readability.
  const restoreAudit = auditStmt(spec, resource, "unvalidate", userId, book, chapter, SWEPT_AND_STILL_VALIDATED);
  const restore = scope(spec, [now], book, chapter, { liveOnly: true });
  const dropStamp = scope(spec, [now], book, chapter, { liveOnly: true });
  const humanAudit = auditStmt(spec, resource, "unvalidate", userId, book, chapter, HUMAN_VALIDATED);
  const human = scope(spec, [now], book, chapter, { liveOnly: true });

  const [, restored, stampRetired, , unvalidated] = await env.DB.batch([
    env.DB.prepare(restoreAudit.sql).bind(...restoreAudit.binds),
    env.DB
      .prepare(
        `UPDATE ${spec.table}
            SET translation_state = ${PRE_SWEEP_STATE},
                ${RETIRE_STAMP},
                updated_at = ?1
          WHERE ${restore.where} AND ${SWEPT_AND_STILL_VALIDATED}`,
      )
      .bind(...restore.binds),
    // A stamped row whose state has since moved on (human edit, new AI draft)
    // is already out of the approved set — leave the state alone, just retire
    // the stamp so it stops claiming the row's state came from a sweep.
    env.DB
      .prepare(
        `UPDATE ${spec.table}
            SET ${RETIRE_STAMP}, updated_at = ?1
          WHERE ${dropStamp.where} AND ${SWEPT_BUT_MOVED_ON}`,
      )
      .bind(...dropStamp.binds),
    env.DB.prepare(humanAudit.sql).bind(...humanAudit.binds),
    env.DB
      .prepare(
        `UPDATE ${spec.table}
            SET translation_state = 'edited', updated_at = ?1
          WHERE ${human.where} AND ${HUMAN_VALIDATED}`,
      )
      .bind(...human.binds),
  ]);

  counts.restored = Number(restored.meta.changes ?? 0);
  counts.unvalidated = Number(unvalidated.meta.changes ?? 0);
  counts.stampRetired = Number(stampRetired.meta.changes ?? 0);
  // `changed` counts translation_state changes only — retiring a stale stamp
  // leaves the row's state alone, so those rows are still "already needs
  // review", just reported separately rather than looking untouched.
  counts.changed = counts.restored + counts.unvalidated;
  counts.alreadyNeedsReview = Math.max(0, total - trashed - counts.changed);
  return counts;
}

type ParsedBody = {
  resources: ReviewStateResource[];
  chapter: number | null;
  state: "validated" | "needs_review";
};

// A whole-book sweep is thousands of rows, so it must be ASKED for: omitting
// `chapter` is not enough, the caller also has to send allChapters: true. A
// client that forgets to put the selected chapter in the body (or sends
// `chapter: undefined` because nothing is selected) then gets a 400 instead of
// silently sweeping the entire book.
const CHAPTER_REQUIRED = "chapter_or_all_chapters_required";

/** Hand-rolled instead of zod so the shape is testable without a Worker. */
export function parseReviewStateBody(raw: unknown): { ok: true; body: ParsedBody } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid_body" };
  const o = raw as Record<string, unknown>;

  const state = o.state;
  if (state !== "validated" && state !== "needs_review") return { ok: false, error: "invalid_state" };

  const rawResources = o.resources;
  if (!Array.isArray(rawResources) || rawResources.length === 0) return { ok: false, error: "invalid_resources" };
  const resources: ReviewStateResource[] = [];
  for (const r of rawResources) {
    if (r !== "tn" && r !== "tq") return { ok: false, error: "invalid_resources" };
    if (!resources.includes(r)) resources.push(r);
  }

  let chapter: number | null = null;
  if (o.chapter != null) {
    const n = typeof o.chapter === "number" ? o.chapter : NaN;
    // Chapter 0 is real here (front-matter rows), so the floor is 0, not 1.
    if (!Number.isInteger(n) || n < 0 || n > 999) return { ok: false, error: "invalid_chapter" };
    chapter = n;
  } else if (o.allChapters !== true) {
    return { ok: false, error: CHAPTER_REQUIRED };
  }

  return { ok: true, body: { resources, chapter, state } };
}

export async function bulkReviewState(c: Context<{ Bindings: Env; Variables: { userId?: number } }>) {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const book = (c.req.param("book") ?? "").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 400);

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseReviewStateBody(raw);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { resources, chapter, state } = parsed.body;

  const counts: Partial<Record<ReviewStateResource, ReviewStateCounts>> = {};
  for (const resource of resources) {
    counts[resource] = await applyReviewState(c.env, resource, book, chapter, state, userId);
  }

  const changed = resources.reduce((n, r) => n + (counts[r]?.changed ?? 0), 0);
  return c.json({ book, chapter, state, resources, changed, counts });
}
