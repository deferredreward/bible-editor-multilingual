// Book list + on-demand import from DCS.
//
// GET  /api/books              — list imported books (existing behaviour).
// POST /api/books/:book/import — pull ULT/UST/UHB-or-UGNT/tn/tq/twl for a
//   single book from DCS, parse, and write into D1. Idempotent: if the
//   book is already in book_imports we short-circuit and return ok.
//
// This is the Worker equivalent of `scripts/import-book.mjs`. Same shape,
// just running server-side so the editor's dropdown can auto-import a book
// on first selection instead of asking the operator to run a CLI.

import { Hono } from "hono";
import type { Env } from "./index";
import {
  extractUsfmHeaders,
  extractVersesForRange,
  makeVerseSortOrder,
  parseTsv,
  refParts,
} from "./importParsers";
import { requireAuth, requireEditor, requireAdmin, currentUserId, currentUserRole } from "./auth";
import { aquiferDrafts } from "./aquiferImport.ts";
import {
  BOOK_NUMBERS,
  dcsUrls,
  dcsResourceFile,
  fileCommitSha,
  fetchText,
  fetchTextWithStatus,
  shouldFallBackOnStatus,
  sourceProvenance,
  translationSourceRepoRef,
  type DcsRepoOverrides,
} from "./dcsSources";
import type { RepoRef } from "./repoUrl";
import { getProjectConfig } from "./projectConfig.ts";
import { populateReferencedArticles } from "./articlePopulate";
import type { Context } from "hono";
import { reimportBookFromDcs, recordResourceSync, resourceSourceRef, type Resource } from "./bookReimport";
import { lintTnRows, lintUsfmVerses } from "./lint";
import type { TnRow, VerseRow } from "./types";
import { ensureLaneState, requireLaneState, origSourceGeneration, activeLaneConfig } from "./scriptureLane";
import {
  acquireExportLease,
  releaseExportLease,
  renewExportLease,
} from "./scriptureLaneReplacement";

export const books = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

// Schedule article population off the import hot path — the fetch fan-out
// (~300-500 tW + ~50-70 tA×3 for a large book) must never run inside the
// importBookFromDcs subrequest budget. waitUntil keeps the response fast and
// lets the population settle after; a failure only logs (edits stay safe, and
// the POLL_CRON backstop + next import catch up).
function schedulePopulate(
  c: Context<{ Bindings: Env; Variables: { userId?: number } }>,
  book: string,
): void {
  const run = populateReferencedArticles(c.env, { book, maxFetches: 150 })
    .catch((e) => console.error("populateReferencedArticles failed", book, e instanceof Error ? e.message : String(e)));
  try {
    c.executionCtx.waitUntil(run);
  } catch {
    // No execution context (e.g. in a test harness) — fire and forget.
    void run;
  }
}

books.get("/", async (c) => {
  const rs = await c.env.DB.prepare(
    `SELECT book, imported_at FROM book_imports ORDER BY book`,
  ).all<{ book: string; imported_at: number }>();
  return c.json({ books: rs.results });
});

// GET /api/books/:book/lint — the in-app "issues to clean up" feed for a book.
// Runs the flag/escalate lint (the DCS checks the export can't auto-fix) over the
// book's live D1 rows and returns the issues, each with a ref + (for TN) a row id
// so the UI can jump straight to it. Read-only; any authed user can view.
books.get("/:book/lint", requireAuth, async (c) => {
  const book = c.req.param("book").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 400);

  const tn = await c.env.DB.prepare(
    `SELECT * FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL AND trashed_at IS NULL
       ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
  )
    .bind(book)
    .all<TnRow>();
  const ult = await c.env.DB.prepare(
    `SELECT * FROM verses WHERE book = ?1 AND bible_version = 'ULT' ORDER BY chapter, verse`,
  )
    .bind(book)
    .all<VerseRow>();
  const ust = await c.env.DB.prepare(
    `SELECT * FROM verses WHERE book = ?1 AND bible_version = 'UST' ORDER BY chapter, verse`,
  )
    .bind(book)
    .all<VerseRow>();

  const issues = [
    ...lintTnRows(tn.results ?? []).map((i) => ({ ...i, resource: "tn" })),
    ...lintUsfmVerses(ult.results ?? []).map((i) => ({ ...i, resource: "ult" })),
    ...lintUsfmVerses(ust.results ?? []).map((i) => ({ ...i, resource: "ust" })),
  ];
  const flagCount = issues.filter((i) => i.bucket === "flag").length;
  const escalateCount = issues.filter((i) => i.bucket === "escalate").length;
  return c.json({ book, total: issues.length, flagCount, escalateCount, issues });
});

// POST /api/books/:book/aquifer-drafts — re-source this book's tN from Aquifer as
// unapproved drafts merged onto the en_tn skeleton (admin-only).
books.post("/:book/aquifer-drafts", requireAdmin, aquiferDrafts);

books.post("/:book/import", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const book = c.req.param("book").toUpperCase();
  const num = BOOK_NUMBERS[book];
  if (!num) return c.json({ error: "unknown_book", book }, 400);

  // Optional body: { translateFromSource?, force?, confirmDiscardEdits? }. A
  // missing/invalid/empty body is normal (the UI's plain import posts nothing),
  // so never 4xx on it. Parsed up here because `force` gates the two early
  // returns below.
  let body: { translateFromSource?: unknown; force?: unknown; confirmDiscardEdits?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    /* no body → default options */
  }
  const translateFromSource = body?.translateFromSource === true;
  const force = body?.force === true;

  // force re-imports a book that is ALREADY imported — the only way to reach
  // the translate-from-source path for a book that was bootstrapped before the
  // feature existed (e.g. BSOJ/MAL). It wipes and re-loads the book, so it is
  // admin-only; the normal (non-forced) import stays editor-accessible, hence
  // the check lives here rather than on the route.
  if (force && currentUserRole(c) !== "admin") {
    return c.json({ error: "forbidden", detail: "force requires admin" }, 403);
  }

  if (force) {
    // Safety gate: the forced import DELETEs every tn/tq row for the book and
    // re-inserts from DCS, so any translated/edited note is destroyed. Count the
    // rows that represent real human work — translation_state 'edited'/'validated'
    // (migrations 0037/0038) or any row a user has touched (updated_by non-NULL,
    // the same pristine predicate the reimport uses) — and refuse unless the
    // caller has explicitly acknowledged the loss.
    const edits = await c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL
            AND (translation_state IN ('edited','validated') OR updated_by IS NOT NULL)) AS tn,
         (SELECT COUNT(*) FROM tq_rows WHERE book = ?1 AND deleted_at IS NULL
            AND (translation_state IN ('edited','validated') OR updated_by IS NOT NULL)) AS tq`,
    )
      .bind(book)
      .first<{ tn: number; tq: number }>();
    const tnEdits = edits?.tn ?? 0;
    const tqEdits = edits?.tq ?? 0;
    if (tnEdits + tqEdits > 0 && body?.confirmDiscardEdits !== true) {
      return c.json({ error: "has_local_edits", book, tn: tnEdits, tq: tqEdits }, 409);
    }
    // Destructive + irreversible from the app's side: leave a trace of who did
    // it, to what, and how much work it discarded.
    console.warn("forced book import: wiping and re-loading from DCS", {
      book,
      userId,
      translateFromSource,
      discardedEdits: { tn: tnEdits, tq: tqEdits },
    });
  }

  // Idempotency: already imported → fast path (skipped by force).
  const existing = await c.env.DB.prepare(
    `SELECT book, imported_at FROM book_imports WHERE book = ?1`,
  )
    .bind(book)
    .first<{ book: string; imported_at: number }>();
  if (existing && !force) {
    schedulePopulate(c, book);
    return c.json({ ok: true, book, alreadyImported: true, imported_at: existing.imported_at });
  }

  // Orphan recovery: a prior import inserted rows but crashed before writing the
  // final book_imports marker. That marker is the LAST write, so a clean crash
  // leaves the FULL resource set present — only then is it safe to re-register
  // without re-fetching. We therefore require ULT, UST, TN, TQ and TWL to all be
  // non-empty. A partial leftover (e.g. the original-language source survived a
  // delete but the translations/notes were removed) must NOT be mistaken for a
  // recoverable import: it falls through to the clean wipe-and-import below,
  // which re-fetches every resource from DCS.
  //
  // (Previously this checked only "any verse exists", so a book left with just
  // its UHB/UGNT source got stamped source_url='recovered' and could never be
  // re-imported — the marker made every later POST hit the alreadyImported fast
  // path above. This is exactly how ISA got stuck with Hebrew-only content.)
  //
  // force skips this too: a forced caller wants a real re-fetch, not a marker
  // that re-registers whatever rows happen to be lying around.
  const present = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM verses   WHERE book = ?1 AND bible_version = 'ULT') AS ult,
       (SELECT COUNT(*) FROM verses   WHERE book = ?1 AND bible_version = 'UST') AS ust,
       (SELECT COUNT(*) FROM tn_rows  WHERE book = ?1 AND deleted_at IS NULL)    AS tn,
       (SELECT COUNT(*) FROM tq_rows  WHERE book = ?1 AND deleted_at IS NULL)    AS tq,
       (SELECT COUNT(*) FROM twl_rows WHERE book = ?1 AND deleted_at IS NULL)    AS twl`,
  )
    .bind(book)
    .first<{ ult: number; ust: number; tn: number; tq: number; twl: number }>();
  const looksComplete =
    !!present &&
    present.ult > 0 &&
    present.ust > 0 &&
    present.tn > 0 &&
    present.tq > 0 &&
    present.twl > 0;
  if (looksComplete && !force) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO book_imports (book, source_url, imported_at, imported_by)
       VALUES (?1, 'recovered', unixepoch(), ?2)`,
    )
      .bind(book, userId)
      .run();
    schedulePopulate(c, book);
    return c.json({ ok: true, book, recovered: true });
  }

  // Cross-isolate import lock — `INSERT OR IGNORE` on the PK gives us an
  // atomic "first writer wins" handshake. The previous in-memory Set was
  // per-Worker-isolate, so a second POST that happened to land on a
  // different edge node would have raced the DELETE-then-INSERT pipeline
  // below and double-imported the book. A stale lock from a crashed Worker
  // is reclaimed by the */5 sweep in api/src/index.ts.
  const lock = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO book_import_locks (book, started_at, started_by)
     VALUES (?1, unixepoch(), ?2)`,
  )
    .bind(book, userId)
    .run();
  if (!lock.meta.changes) {
    return c.json({ error: "in_progress", book }, 409);
  }

  try {
    const result = await importBookFromDcs(c.env, book, num, userId, { translateFromSource });
    schedulePopulate(c, book);
    return c.json({ ok: true, book, ...result, ...(force ? { forced: true } : {}) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: "import_failed", book, message: msg }, 502);
  } finally {
    await c.env.DB.prepare(
      `DELETE FROM book_import_locks WHERE book = ?1`,
    )
      .bind(book)
      .run();
  }
});

// POST /api/books/:book/reimport — non-destructive per-chapter, per-resource
// re-import from DCS. Required body: { chapters: number[], resources: Resource[] }.
// Skips rows that have been edited locally (see bookReimport.ts for the
// pristine predicate). Requires the book to be bootstrapped (404 otherwise);
// reuses book_import_locks (409 in_progress if held).
const ALLOWED_RESOURCES: ReadonlyArray<Resource> = ["ult", "ust", "tn", "tq", "twl"];

books.post("/:book/reimport", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const book = c.req.param("book").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 400);

  let body: { chapters?: unknown; resources?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_body" }, 422);
  }
  const chapters = Array.isArray(body.chapters)
    ? body.chapters
        .map((n) => (typeof n === "number" ? Math.floor(n) : NaN))
        .filter((n) => Number.isFinite(n) && n >= 1)
    : [];
  const resources = Array.isArray(body.resources)
    ? body.resources.filter((r): r is Resource =>
        typeof r === "string" && (ALLOWED_RESOURCES as readonly string[]).includes(r),
      )
    : [];
  if (chapters.length === 0) {
    return c.json({ error: "invalid_body", detail: "chapters must be a non-empty list of positive integers" }, 422);
  }
  if (resources.length === 0) {
    return c.json({ error: "invalid_body", detail: "resources must include at least one of ult/ust/tn/tq/twl" }, 422);
  }

  try {
    const result = await reimportBookFromDcs(c.env, book, chapters, resources, userId, { source: "user" });
    // New tn/twl content can reference articles not yet populated — repopulate.
    if (resources.includes("tn") || resources.includes("twl")) schedulePopulate(c, book);
    return c.json({ ok: true, ...result });
  } catch (e) {
    const name = e instanceof Error ? e.constructor.name : "";
    if (name === "BookNotImportedError") return c.json({ error: "book_not_imported", book }, 404);
    if (name === "ImportInProgressError") return c.json({ error: "in_progress", book }, 409);
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: "reimport_failed", book, message: msg }, 502);
  }
});

interface ImportCounts {
  verses: number;
  tn: number;
  tq: number;
  twl: number;
  fetched: { ult: boolean; ust: boolean; orig: boolean; tn: boolean; tq: boolean; twl: boolean };
  /** Note-source provenance: 'source:<owner>/<repo>' when tn/tq came from the
   *  English translationSource instead of the org's own repo, else null. */
  sources: { tn: string | null; tq: string | null };
}

async function importBookFromDcs(
  env: Env,
  book: string,
  _num: string,
  userId: number,
  opts: { translateFromSource?: boolean } = {},
): Promise<ImportCounts> {
  // Assert lanes not frozen before starting import. A frozen lane (an open
  // replacement job) or a lane that still requires a replacement (BSOJ
  // transitional gen-1 quarantine) must not accept a fresh scripture import —
  // it would write gen-1 rows the replacement is meant to supersede.
  await ensureLaneState(env);
  const litState = await requireLaneState(env, "lit");
  const simState = await requireLaneState(env, "sim");
  if (litState.replacement_job_id) throw new Error("lit_lane_frozen_for_replacement");
  if (simState.replacement_job_id) throw new Error("sim_lane_frozen_for_replacement");
  if (litState.replacement_required) throw new Error("lit_lane_replacement_required");
  if (simState.replacement_required) throw new Error("sim_lane_replacement_required");

  const cfg = await getProjectConfig(env);

  // Opting in to translate-from-source only makes sense on a translation
  // project; without a configured translationSource there is nothing to pull.
  if (opts.translateFromSource && !cfg.translationSource) {
    throw new Error("not_a_translation_project");
  }

  // Per-resource note provenance: non-null = this resource came from the
  // English translationSource, not the org's own repo. Drives the book_imports
  // marker (which holds the book out of the nightly reimport + export) and the
  // watermark identity below.
  const noteSource: { tn: RepoRef | null; tq: RepoRef | null } = {
    tn: opts.translateFromSource ? translationSourceRepoRef(cfg, "tn") : null,
    tq: opts.translateFromSource ? translationSourceRepoRef(cfg, "tq") : null,
  };

  // Use lane source refs from active config for scripture USFM URLs
  const litCfg = activeLaneConfig(litState);
  const simCfg = activeLaneConfig(simState);
  const overrides: DcsRepoOverrides = {
    lit: litCfg.source,
    sim: simCfg.source,
    ...(noteSource.tn ? { tn: noteSource.tn } : {}),
    ...(noteSource.tq ? { tq: noteSource.tq } : {}),
  };
  const urls = dcsUrls(env, cfg, book, overrides);
  if (!urls) throw new Error(`unknown book: ${book}`);
  const origVersion = urls.origVersion;

  // Fire all six fetches in parallel. unfoldingWord's repos carry every
  // resource for every supported book, so any null here is a transient DCS
  // issue (timeout, 5xx, partial outage). Marking the book as imported with
  // a critical resource missing leaves it silently broken — see the ZEC
  // bootstrap that landed without TWLs. Fail loudly so the next attempt
  // succeeds cleanly.
  // `let`: tn/tq may be replaced by the translation-source fallback below.
  let [ultRaw, ustRaw, origRaw, tnRaw, tqRaw, twlRaw] = await Promise.all([
    fetchText(urls.ult),
    fetchText(urls.ust),
    fetchText(urls.orig),
    fetchText(urls.tn),
    fetchText(urls.tq),
    fetchText(urls.twl),
  ]);

  // Automatic fallback: the org GENUINELY has no tn/tq file for this book. On a
  // translation project the English source always carries one, so pull it from
  // there rather than failing the whole import, and mark the provenance so the
  // nightly reimport/export hold that resource out.
  //
  // 404-ONLY, deliberately. fetchText above collapses 404 / 5xx / network error
  // / truncated read all into null, and substituting English on a transient
  // failure would import the wrong language during a DCS outage AND permanently
  // hold the book out of reimport+export. So we re-probe the org URL with
  // fetchTextWithStatus and fall back only on a hard 404 (shouldFallBackOnStatus);
  // anything else falls through to the missing/throw path below and is retried.
  const noteUrls: Record<"tn" | "tq", string> = { tn: urls.tn, tq: urls.tq };
  // tn and tq are independent (disjoint noteSource/noteUrls keys), so run both
  // fallback probes concurrently rather than serially — a book missing both
  // files otherwise pays for 4 sequential DCS round-trips instead of 2 pairs
  // in parallel. Each resource still does its OWN probe (fetchTextWithStatus)
  // then its own primary-shaped fetch (fetchText, which retries once on
  // network-error/truncation — that retry is the twl_PSA / HAB truncation
  // guard, so it must stay fetchText and not be swapped for fetchTextWithStatus).
  const [tnFallback, tqFallback] = await Promise.all(
    (["tn", "tq"] as const).map(async (resource) => {
      const raw = resource === "tn" ? tnRaw : tqRaw;
      if (raw != null || noteSource[resource]) return null;
      const ref = translationSourceRepoRef(cfg, resource);
      if (!ref) return null;
      const probe = await fetchTextWithStatus(env, noteUrls[resource]);
      if (!shouldFallBackOnStatus(probe.status)) return null;
      const fallbackUrls = dcsUrls(env, cfg, book, { ...overrides, [resource]: ref })!;
      const url = fallbackUrls[resource];
      const fetched = await fetchText(url);
      if (fetched == null) return null;
      console.warn("import: org note file absent; falling back to translation source", {
        book,
        resource,
        url,
      });
      return { ref, url, fetched };
    }),
  );
  if (tnFallback) {
    noteSource.tn = tnFallback.ref;
    noteUrls.tn = tnFallback.url;
    tnRaw = tnFallback.fetched;
  }
  if (tqFallback) {
    noteSource.tq = tqFallback.ref;
    noteUrls.tq = tqFallback.url;
    tqRaw = tqFallback.fetched;
  }

  const missing: string[] = [];
  if (!ultRaw) missing.push(`ult (${urls.ult})`);
  if (!ustRaw) missing.push(`ust (${urls.ust})`);
  if (!origRaw) missing.push(`${origVersion.toLowerCase()} (${urls.orig})`);
  if (!tnRaw) missing.push(`tn (${noteUrls.tn})`);
  if (!tqRaw) missing.push(`tq (${noteUrls.tq})`);
  if (!twlRaw) missing.push(`twl (${urls.twl})`);
  if (missing.length > 0) {
    throw new Error(`DCS fetch failed for ${missing.length} resource(s); retry: ${missing.join("; ")}`);
  }

  // Re-check lane state AFTER the (potentially slow) DCS fetches. Then couple
  // the destructive wipe to a transactional lane-state predicate: DELETE only
  // while both lanes are still free at the expected generation (EXISTS). A
  // concurrent replacement freeze makes the DELETEs no-ops; we abort before
  // INSERT if the claim count is wrong.
  const litRecheck = await requireLaneState(env, "lit");
  const simRecheck = await requireLaneState(env, "sim");
  if (litRecheck.replacement_job_id) throw new Error("lit_lane_frozen_for_replacement");
  if (simRecheck.replacement_job_id) throw new Error("sim_lane_frozen_for_replacement");
  if (litRecheck.replacement_required) throw new Error("lit_lane_replacement_required");
  if (simRecheck.replacement_required) throw new Error("sim_lane_replacement_required");
  if (litRecheck.active_generation !== litState.active_generation) {
    throw new Error("lit_lane_generation_changed");
  }
  if (simRecheck.active_generation !== simState.active_generation) {
    throw new Error("sim_lane_generation_changed");
  }

  const litGen = litRecheck.active_generation;
  const simGen = simRecheck.active_generation;
  const olGen = origSourceGeneration();

  // Hold export leases on both lanes for the whole wipe+repopulate. Per-statement
  // EXISTS fences alone cannot roll back earlier committed batches if replacement
  // reserves mid-import; startReplacement refuses while these leases are held.
  const litLease = await acquireExportLease(env, "lit", `import:${book}`);
  if ("error" in litLease) throw new Error(`lit_import_lease:${litLease.error}`);
  const simLease = await acquireExportLease(env, "sim", `import:${book}`);
  if ("error" in simLease) {
    await releaseExportLease(env, litLease.leaseId).catch(() => {});
    throw new Error(`sim_import_lease:${simLease.error}`);
  }

  try {
    // Renew once before the wipe so a slow DCS fetch above doesn't leave a
    // near-expired heartbeat into the multi-batch writes.
    await renewExportLease(env, litLease.leaseId);
    await renewExportLease(env, simLease.leaseId);

    // Wipe + lane CAS in one batch. The leading UPDATEs must each affect 1 row
    // (lane still free at expected gen); DELETEs are further guarded by EXISTS.
    const wipe = await env.DB.batch([
      env.DB.prepare(
        `UPDATE scripture_lane_state SET updated_at = unixepoch()
          WHERE lane = 'lit'
            AND replacement_job_id IS NULL
            AND replacement_required = 0
            AND active_generation = ?1`,
      ).bind(litGen),
      env.DB.prepare(
        `UPDATE scripture_lane_state SET updated_at = unixepoch()
          WHERE lane = 'sim'
            AND replacement_job_id IS NULL
            AND replacement_required = 0
            AND active_generation = ?1`,
      ).bind(simGen),
      env.DB.prepare(`DELETE FROM tn_rows  WHERE book = ?1`).bind(book),
      env.DB.prepare(`DELETE FROM tq_rows  WHERE book = ?1`).bind(book),
      env.DB.prepare(`DELETE FROM twl_rows WHERE book = ?1`).bind(book),
      env.DB.prepare(
        `DELETE FROM verses WHERE book = ?1 AND bible_version = 'ULT' AND source_generation = ?2
           AND EXISTS (
             SELECT 1 FROM scripture_lane_state
              WHERE lane = 'lit' AND replacement_job_id IS NULL
                AND replacement_required = 0 AND active_generation = ?2
           )`,
      ).bind(book, litGen),
      env.DB.prepare(
        `DELETE FROM verses WHERE book = ?1 AND bible_version = 'UST' AND source_generation = ?2
           AND EXISTS (
             SELECT 1 FROM scripture_lane_state
              WHERE lane = 'sim' AND replacement_job_id IS NULL
                AND replacement_required = 0 AND active_generation = ?2
           )`,
      ).bind(book, simGen),
      env.DB.prepare(
        `DELETE FROM verses WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3`,
      ).bind(book, origVersion, olGen),
      env.DB.prepare(
        `DELETE FROM book_usfm_meta WHERE book = ?1 AND bible_version = 'ULT' AND source_generation = ?2
           AND EXISTS (
             SELECT 1 FROM scripture_lane_state
              WHERE lane = 'lit' AND replacement_job_id IS NULL
                AND replacement_required = 0 AND active_generation = ?2
           )`,
      ).bind(book, litGen),
      env.DB.prepare(
        `DELETE FROM book_usfm_meta WHERE book = ?1 AND bible_version = 'UST' AND source_generation = ?2
           AND EXISTS (
             SELECT 1 FROM scripture_lane_state
              WHERE lane = 'sim' AND replacement_job_id IS NULL
                AND replacement_required = 0 AND active_generation = ?2
           )`,
      ).bind(book, simGen),
      env.DB.prepare(
        `DELETE FROM book_usfm_meta WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3`,
      ).bind(book, origVersion, olGen),
    ]);
    if ((wipe[0]?.meta?.changes ?? 0) !== 1 || (wipe[1]?.meta?.changes ?? 0) !== 1) {
      throw new Error("lane_state_changed_during_import");
    }

    // Inserts are fenced with EXISTS predicates (not a separate recheck) so a
    // replacement freeze/activation between wipe and write cannot land.
    const counts: ImportCounts = {
      verses: 0,
      tn: 0,
      tq: 0,
      twl: 0,
      fetched: {
        ult: !!ultRaw,
        ust: !!ustRaw,
        orig: !!origRaw,
        tn: !!tnRaw,
        tq: !!tqRaw,
        twl: !!twlRaw,
      },
      sources: {
        tn: noteSource.tn ? sourceProvenance(noteSource.tn.owner, noteSource.tn.repo) : null,
        tq: noteSource.tq ? sourceProvenance(noteSource.tq.owner, noteSource.tq.repo) : null,
      },
    };

    const renewBoth = async () => {
      const okLit = await renewExportLease(env, litLease.leaseId);
      const okSim = await renewExportLease(env, simLease.leaseId);
      if (!okLit || !okSim) throw new Error("import_lease_lost");
    };

    await renewBoth();
    counts.verses += await insertVerses(env, book, "ULT", ultRaw, litGen, "lit");
    await renewBoth();
    counts.verses += await insertVerses(env, book, "UST", ustRaw, simGen, "sim");
    counts.verses += await insertVerses(env, book, origVersion, origRaw, olGen, null);

    await renewBoth();
    counts.tn = await insertTnRows(env, book, tnRaw, userId, litGen, simGen);
    await renewBoth();
    counts.tq = await insertTqRows(env, book, tqRaw, userId, litGen, simGen);
    await renewBoth();
    counts.twl = await insertTwlRows(env, book, twlRaw, userId, litGen, simGen);

    // Final marker — only if both lanes are still free at the expected gens.
    const sources = Object.entries(counts.fetched)
      .filter(([, ok]) => ok)
      .map(([k]) => k)
      .join(",");
    const marker = await env.DB.prepare(
      `INSERT OR REPLACE INTO book_imports (book, source_url, imported_at, imported_by, tn_source, tq_source)
       SELECT ?1, ?2, unixepoch(), ?3, ?6, ?7
        WHERE EXISTS (
              SELECT 1 FROM scripture_lane_state
               WHERE lane = 'lit' AND replacement_job_id IS NULL
                 AND replacement_required = 0 AND active_generation = ?4
            )
          AND EXISTS (
              SELECT 1 FROM scripture_lane_state
               WHERE lane = 'sim' AND replacement_job_id IS NULL
                 AND replacement_required = 0 AND active_generation = ?5
            )`,
    )
      .bind(book, `dcs:${sources}`, userId, litGen, simGen, counts.sources.tn, counts.sources.tq)
      .run();
    if ((marker.meta?.changes ?? 0) !== 1) {
      throw new Error("lane_state_changed_during_import");
    }

    // Seed per-resource SHA watermarks so the nightly self-heal can skip files
    // that haven't changed since this import (see book_resource_syncs +
    // bookReimport.ts). Best-effort — a missing watermark just means the first
    // nightly reimports that resource.
    for (const resource of ["ult", "ust", "tn", "tq", "twl"] as Resource[]) {
      if (!counts.fetched[resource]) continue;
      // Skip source-pulled tn/tq: they're already held out of the nightly
      // reimport (heldOutNoteResources), so a watermark here is write-only —
      // nothing ever reads it. Recording one under the org's identity would
      // also be a lie (resourceSourceRef no longer takes an override to say
      // otherwise). An absent watermark correctly fails open to a refetch if
      // provenance is later cleared.
      if (resource === "tn" && noteSource.tn) continue;
      if (resource === "tq" && noteSource.tq) continue;
      const file = dcsResourceFile(cfg, book, resource);
      if (!file) continue;
      const src = await resourceSourceRef(env, resource, cfg);
      const sha = await fileCommitSha(env, src.owner, src.repo, file.path, src.ref);
      if (sha) await recordResourceSync(env, book, resource, sha, "import", src);
    }

    return counts;
  } finally {
    await releaseExportLease(env, litLease.leaseId).catch(() => {});
    await releaseExportLease(env, simLease.leaseId).catch(() => {});
  }
}

// D1 batch() caps at 100 statements per call. Keep chunks well under that.
const CHUNK = 80;

async function insertVerses(
  env: Env,
  book: string,
  bibleVersion: string,
  rawUsfm: string | null,
  sourceGeneration?: number,
  lane?: "lit" | "sim" | null,
): Promise<number> {
  if (!rawUsfm) return 0;

  const gen = sourceGeneration ?? 1;

  const headers = extractUsfmHeaders(rawUsfm);
  if (headers) {
    if (lane) {
      const meta = await env.DB.prepare(
        `INSERT OR REPLACE INTO book_usfm_meta (book, bible_version, source_generation, headers_json)
         SELECT ?1, ?2, ?3, ?4
          WHERE EXISTS (
            SELECT 1 FROM scripture_lane_state
             WHERE lane = ?5 AND replacement_job_id IS NULL
               AND replacement_required = 0 AND active_generation = ?3
          )`,
      )
        .bind(book, bibleVersion, gen, JSON.stringify(headers), lane)
        .run();
      if ((meta.meta?.changes ?? 0) !== 1) {
        throw new Error("lane_state_changed_during_import");
      }
    } else {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO book_usfm_meta (book, bible_version, source_generation, headers_json)
         VALUES (?1, ?2, ?3, ?4)`,
      )
        .bind(book, bibleVersion, gen, JSON.stringify(headers))
        .run();
    }
  }

  // Whole-book extract; the [1, 999] range covers any chapter that exists.
  const verses = extractVersesForRange(rawUsfm, 1, 999);
  if (verses.length === 0) return 0;

  const stmt = lane
    ? env.DB.prepare(
        `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, source_generation, content_json, plain_text)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
          WHERE EXISTS (
            SELECT 1 FROM scripture_lane_state
             WHERE lane = ?9 AND replacement_job_id IS NULL
               AND replacement_required = 0 AND active_generation = ?6
          )`,
      )
    : env.DB.prepare(
        `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, source_generation, content_json, plain_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      );
  let inserted = 0;
  for (let i = 0; i < verses.length; i += CHUNK) {
    const slice = verses.slice(i, i + CHUNK);
    const results = await env.DB.batch(
      slice.map((v) =>
        lane
          ? stmt.bind(book, v.chapter, v.verse, v.verseEnd, bibleVersion, gen, v.contentJson, v.plainText, lane)
          : stmt.bind(book, v.chapter, v.verse, v.verseEnd, bibleVersion, gen, v.contentJson, v.plainText),
      ),
    );
    for (const r of results) inserted += r.meta?.changes ?? 0;
  }
  if (lane && inserted !== verses.length) {
    throw new Error("lane_state_changed_during_import");
  }
  return verses.length;
}

/** Dual-lane free predicate for bootstrap TSV inserts. */
function bothLanesFreeSql(litParam: string, simParam: string): string {
  return `EXISTS (
            SELECT 1 FROM scripture_lane_state
             WHERE lane = 'lit' AND replacement_job_id IS NULL
               AND replacement_required = 0 AND active_generation = ${litParam}
          )
        AND EXISTS (
            SELECT 1 FROM scripture_lane_state
             WHERE lane = 'sim' AND replacement_job_id IS NULL
               AND replacement_required = 0 AND active_generation = ${simParam}
          )`;
}

async function insertTnRows(
  env: Env,
  book: string,
  raw: string | null,
  userId: number,
  litGen: number,
  simGen: number,
): Promise<number> {
  if (!raw) return 0;
  const { rows } = parseTsv(raw);
  if (rows.length === 0) return 0;

  const insertStmt = env.DB.prepare(
    `INSERT INTO tn_rows
       (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note, sort_order)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
      WHERE ${bothLanesFreeSql("?12", "?13")}`,
  );
  const auditStmt = env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
     SELECT 'tn', ?1, ?2, ?3, NULL, 1, 'create', ?4
      WHERE changes() > 0`,
  );

  let expected = 0;
  let landed = 0;
  const nextSort = makeVerseSortOrder();
  let batch: D1PreparedStatement[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const results = await env.DB.batch(batch);
    for (let i = 0; i < results.length; i += 2) {
      if ((results[i]?.meta?.changes ?? 0) > 0) landed++;
    }
    batch = [];
  };

  for (const r of rows) {
    const id = r["ID"];
    if (!id) continue;
    const refRaw = r["Reference"] ?? "";
    const [ch, v] = refParts(refRaw);
    const occRaw = r["Occurrence"];
    const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
    const payload = {
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: r["Tags"] || null,
      support_reference: r["SupportReference"] || null,
      quote: r["Quote"] || null,
      occurrence,
      note: r["Note"] || null,
    };
    batch.push(
      insertStmt.bind(
        id, book, ch, v, refRaw,
        payload.tags, payload.support_reference, payload.quote, payload.occurrence, payload.note,
        nextSort(ch, v),
        litGen, simGen,
      ),
      auditStmt.bind(id, book, userId, JSON.stringify(payload)),
    );
    expected++;
    if (batch.length >= CHUNK) await flush();
  }
  await flush();
  if (landed !== expected) throw new Error("lane_state_changed_during_import");
  return landed;
}

async function insertTqRows(
  env: Env,
  book: string,
  raw: string | null,
  userId: number,
  litGen: number,
  simGen: number,
): Promise<number> {
  if (!raw) return 0;
  const { rows } = parseTsv(raw);
  if (rows.length === 0) return 0;

  const insertStmt = env.DB.prepare(
    `INSERT INTO tq_rows
       (id, book, chapter, verse, ref_raw, tags, quote, occurrence, question, response, sort_order)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
      WHERE ${bothLanesFreeSql("?12", "?13")}`,
  );
  const auditStmt = env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
     SELECT 'tq', ?1, ?2, ?3, NULL, 1, 'create', ?4
      WHERE changes() > 0`,
  );

  let expected = 0;
  let landed = 0;
  const nextSort = makeVerseSortOrder();
  let batch: D1PreparedStatement[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const results = await env.DB.batch(batch);
    for (let i = 0; i < results.length; i += 2) {
      if ((results[i]?.meta?.changes ?? 0) > 0) landed++;
    }
    batch = [];
  };

  for (const r of rows) {
    const id = r["ID"];
    if (!id) continue;
    const refRaw = r["Reference"] ?? "";
    const [ch, v] = refParts(refRaw);
    const occRaw = r["Occurrence"];
    const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
    const payload = {
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: r["Tags"] || null,
      quote: r["Quote"] || null,
      occurrence,
      question: r["Question"] || null,
      response: r["Response"] || null,
    };
    batch.push(
      insertStmt.bind(
        id, book, ch, v, refRaw,
        payload.tags, payload.quote, payload.occurrence, payload.question, payload.response,
        nextSort(ch, v),
        litGen, simGen,
      ),
      auditStmt.bind(id, book, userId, JSON.stringify(payload)),
    );
    expected++;
    if (batch.length >= CHUNK) await flush();
  }
  await flush();
  if (landed !== expected) throw new Error("lane_state_changed_during_import");
  return landed;
}

async function insertTwlRows(
  env: Env,
  book: string,
  raw: string | null,
  userId: number,
  litGen: number,
  simGen: number,
): Promise<number> {
  if (!raw) return 0;
  const { rows } = parseTsv(raw);
  if (rows.length === 0) return 0;

  const insertStmt = env.DB.prepare(
    `INSERT INTO twl_rows
       (id, book, chapter, verse, ref_raw, tags, orig_words, occurrence, tw_link, sort_order)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
      WHERE ${bothLanesFreeSql("?11", "?12")}`,
  );
  const auditStmt = env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
     SELECT 'twl', ?1, ?2, ?3, NULL, 1, 'create', ?4
      WHERE changes() > 0`,
  );

  let expected = 0;
  let landed = 0;
  const nextSort = makeVerseSortOrder();
  let batch: D1PreparedStatement[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const results = await env.DB.batch(batch);
    for (let i = 0; i < results.length; i += 2) {
      if ((results[i]?.meta?.changes ?? 0) > 0) landed++;
    }
    batch = [];
  };

  for (const r of rows) {
    const id = r["ID"];
    if (!id) continue;
    const refRaw = r["Reference"] ?? "";
    const [ch, v] = refParts(refRaw);
    const occRaw = r["Occurrence"];
    const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
    const payload = {
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: r["Tags"] || null,
      orig_words: r["OrigWords"] || null,
      occurrence,
      tw_link: r["TWLink"] || null,
    };
    batch.push(
      insertStmt.bind(
        id, book, ch, v, refRaw,
        payload.tags, payload.orig_words, payload.occurrence, payload.tw_link,
        nextSort(ch, v),
        litGen, simGen,
      ),
      auditStmt.bind(id, book, userId, JSON.stringify(payload)),
    );
    expected++;
    if (batch.length >= CHUNK) await flush();
  }
  await flush();
  if (landed !== expected) throw new Error("lane_state_changed_during_import");
  return landed;
}
