// Nightly export — Cloudflare Workflow.
//
// Each (book × resource) is its own step. step.do persists results, so a
// transient DCS rate-limit retries that one step instead of restarting the
// whole run. A failed step that exhausts retries fails *the instance*; the
// next cron tick (or a manual /api/exports/run) starts a fresh instance and
// the unaffected resources land normally.
//
// What it produces per (book, resource):
//   1. Renders the file (TSV or USFM) from D1.
//   2. Stores it under R2 at exports/<instanceId>/<book>/<filename> for
//      inspection and as a local-only backup.
//   3. If DCS_SERVICE_TOKEN is set, commits the file to the conventional
//      unfoldingWord repo on the configured branch.
//   4. Records the outcome in export_snapshots so /api/exports can list it.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./index";
import {
  ALL_RESOURCES,
  buildExportBranch,
  buildTnTsv,
  buildTqTsv,
  buildTwlTsv,
  buildUsfm,
  closeDcsPr,
  commitToDcs,
  commitFilesToDcs,
  deleteDcsBranch,
  ensureDcsPr,
  exportTsvShrinkRefused,
  findDcsOpenPr,
  recreateExportBranchFromMaster,
  updateDcsPrBranch,
  usfmAlignmentShrinkRefused,
  resourceTargetsFor,
  type Resource,
} from "./export";
import {
  articleStepUnits,
  articleStepLabel,
  renderArticleFiles,
  shrinkRefused,
  type ArticleResource,
} from "./articleExport.ts";

// Banner target for export PR failures — same maintainer the post-export
// validator alerts (see postExport.ts ValidatorConfig.alertTargetUsername).
const EXPORT_ALERT_USERNAME = "deferredreward";

// DCS web URL of the org exports land on — for alert links.
async function exportOwnerUrl(env: Env): Promise<string> {
  const cfg = await getProjectConfig(env);
  return `${env.DCS_BASE_URL}/${exportOwnerFor(env, cfg)}`;
}

// Legacy export branch, superseded by per-(book,resource) contributor branches.
// Pruned best-effort on each export so it doesn't linger; safe to delete since
// the live-snapshot flow is no longer used (its post-export path is dormant).
const LEGACY_EXPORT_BRANCH = "live-snapshot";
import { applyTwlSortOrderUpdates } from "./twlSortOrderApply";
import { runPostExport, VALIDATORS } from "./postExport";
import { runChunkedReimport, storedResourceSha, resourceSourceRef, ALL_RESOURCES as REIMPORT_RESOURCES } from "./bookReimport";
import { dcsRawUrl, dcsResourceFile, fetchText, fileCommitSha, heldOutNoteResources, type ReimportResource } from "./dcsSources";
import { getProjectConfig, exportOwnerFor } from "./projectConfig.ts";
import { listRangeHeldOutKeys } from "./bookSource.ts";
import {
  laneForBibleVersion,
  assertLaneWritable,
  getLaneState,
  activeLaneConfig,
  activeGenerationForBibleVersion,
  configHash,
  type LaneKey,
} from "./scriptureLane";
import { nonAlignmentUsfmEqual } from "./alignmentCanonical";
import {
  acquireExportLease,
  renewExportLease,
  releaseExportLease,
  verifyExportFencingToken,
} from "./scriptureLaneReplacement";
import type { TnRow, TqRow, TwlRow, VerseRow } from "./types";
import { gateTsvRowForExport } from "./preDraftSnapshot";
import { lintUsfmVerses } from "./lint";
import {
  renderContextPack,
  contextRepoOwner,
  contextRepoName,
  type TranslationPrefsForRender,
  type ValidatedTnRow,
  type ValidatedTqRow,
} from "./contextExport.ts";
import { contextShrinkRefused, shrinkDetailCode, hasSemanticContent } from "./contextExportLib.ts";
import { fetchEnSourceMaps } from "./contextSourceFetch.ts";
import { commitContextPackToMaster, ensureContextRepoExists, getBranchTipSha } from "./contextExportDcs.ts";
import {
  insertContextExportQueued,
  finalizeContextExport,
  getLatestContextExportStats,
} from "./contextExportResults.ts";
import type { TermImport } from "./translationMemoryLib.ts";
import { workspaceEnv, resolveWorkspace } from "./workspaces.ts";

export interface ExportParams {
  // Workspace slug this run belongs to. Workflows don't inherit the
  // per-request env clone (see run() below), so this is how a queued run
  // knows which org's D1 binding to use. Absent = the default workspace
  // (pre-workspaces behavior).
  workspace?: string;
  // Restrict the run to one book. Useful for manual /api/exports/run.
  book?: string;
  // Restrict the run to one resource family.
  resource?: Resource;
  // Force-skip the DCS commit even if a service token is configured. Lets
  // us test the rendering pipeline against R2 without pushing anything live.
  dryDcs?: boolean;
  // Run the post-export validate-and-merge orchestrator (dispatches a Gitea
  // Actions workflow that auto-merges the live-snapshot PR on DCS). The
  // 05:30 UTC cron sets this true; manual /api/exports/run leaves it false
  // so a single-book test export doesn't accidentally trigger a real merge.
  validateAndMerge?: boolean;
  // Self-heal mode: run only the chunked DCS→D1 reimport for every book, then
  // stop before rendering/committing. Used by the 08:00 REIMPORT_CRON (which
  // has no WorkflowStep context of its own). Runs the reimport even without a
  // service token (reads public raw files) — unlike the pre-export sync, which
  // is gated on dcsAllowed.
  reimportOnly?: boolean;
  // Skip verse + article phases; run only the translation-context pack export
  // (same durable workflow bindings / auth / retries as a full export).
  contextOnly?: boolean;
  // Admin override for the context-pack semantic shrink guard.
  shrinkOverride?: boolean;
}

export interface StepResult {
  book: string;
  resource: Resource;
  rowCount: number;
  bytes: number;
  r2Key: string | null;
  // The per-(book,resource) DCS branch this resource was committed to, named
  // for the book + its human contributors. null only when nothing was rendered.
  branch: string | null;
  dcsCommitSha: string | null;
  dcsChanged: boolean;
  dcsSkippedReason: string | null;
  // The open PR ensured for this branch (so the DCS validate-and-merge workflow
  // can act on it). null when nothing was pushed, the run was dry, or PR
  // creation failed (see prReason).
  prNumber: number | null;
  prReason: string | null;
}

const isResource = (s: string): s is Resource => (ALL_RESOURCES as string[]).includes(s);

// One (resource × top-level dir) article export step's outcome. The article
// analogue of StepResult — keyed by a `label` (e.g. 'tw-bible-kt') rather than
// a book, and carrying a file count instead of a row count.
export interface ArticleStepResult {
  label: string;
  resource: ArticleResource;
  topDir: string;
  fileCount: number;
  committedCount: number;
  branch: string | null;
  dcsCommitSha: string | null;
  dcsSkippedReason: string | null;
  prNumber: number | null;
}

export interface ContextPackStepResult {
  status: string;
  commitSha: string | null;
  contentFiles: number;
  terms: number;
  examplesTn: number;
  examplesTq: number;
  failureReason: string | null;
}

export class ExportWorkflow extends WorkflowEntrypoint<Env, ExportParams> {
  async run(event: WorkflowEvent<ExportParams>, step: WorkflowStep): Promise<{
    instanceId: string;
    totalSteps: number;
    results: StepResult[];
    articleResults: ArticleStepResult[];
    contextResult: ContextPackStepResult | null;
  }> {
    const params = event.payload ?? {};

    // Workflows don't inherit the per-request env clone that index.ts's fetch
    // wrapper builds, so this.env is the RAW Worker env — this.env.DB would be
    // the default binding regardless of which org queued the run. Re-point it
    // once, here, so the ~60 `this.env` reads below are all workspace-correct.
    // With WORKSPACES unset this resolves to the same default binding as before.
    (this as unknown as { env: Env }).env = workspaceEnv(this.env, resolveWorkspace(this.env, params.workspace ?? null));

    // Folds the resolved workspace slug in so two orgs starting in the same
    // millisecond can't share an R2 staging prefix — instanceId is used as the
    // key prefix for both export snapshots (exports/<instanceId>/...) and
    // reimport staging (reimport-stage/<instanceId>/...), and the latter is
    // read back and applied to D1, so a collision would let one org import
    // another org's staged content. This is NOT the Workflow instance id
    // passed to EXPORT_WORKFLOW.create() (that's `nightly-${slug}-${day}` in
    // index.ts, already workspace-scoped for its own dedup purpose) — just the
    // R2 key prefix, which had no such scoping before.
    const instanceId = `export-${this.env.WORKSPACE_SLUG ?? "default"}-${new Date(event.timestamp).toISOString().replace(/[:.]/g, "-")}`;

    const dcsAllowed = !params.dryDcs && !!this.env.DCS_SERVICE_TOKEN;

    // contextOnly: first-class ExportWorkflow mode — skip verse/article/reimport;
    // same durable step retries + admin trigger as a full export.
    if (params.contextOnly) {
      const contextResult = await step.do(
        "export-context-pack",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async () => this.exportContextPack(instanceId, dcsAllowed, !!params.shrinkOverride),
      );
      return {
        instanceId,
        totalSteps: 1,
        results: [],
        articleResults: [],
        contextResult,
      };
    }

    // 1. Resolve the books list.
    const books = await step.do("list-books", async () => {
      const stmt = params.book
        ? this.env.DB.prepare(`SELECT book FROM book_imports WHERE book = ?1 ORDER BY book`).bind(params.book)
        : this.env.DB.prepare(`SELECT book FROM book_imports ORDER BY book`);
      const rs = await stmt.all<{ book: string }>();
      return rs.results.map((r) => r.book);
    });

    const resources: Resource[] = params.resource && isResource(params.resource)
      ? [params.resource]
      : ALL_RESOURCES;

    // Books whose tn/tq did NOT come from the configured org repo — re-sourced
    // from Aquifer (POST /aquifer-drafts), imported from the English
    // translationSource, or set to a per-book/per-chapter-range override (#103) —
    // are held out of that resource's EXPORT: their rows are source-keyed drafts,
    // and until validated their export snapshot is empty — exporting would push
    // blank/unapproved (or another org's) notes over the DCS tn/tq repo.
    // Export-direction handling for these books is deferred (see STATE.md); until
    // then, skip the held-out resource. Other resources (verses/twl) export
    // normally. Mirrors the reimport skip in bookReimport.
    //
    // Two sources of hold-out: (a) the whole-book book_imports marker, and (b) the
    // range table (#103 Tier 2). A PARTIALLY-sourced book has NO marker (its base
    // is the org's own repo), so (b) is what stops it from rendering the
    // cross-sourced chapters over master. NOTE: this is whole-RESOURCE skip, so a
    // partial book's OWNED chapters don't publish either — a documented limitation;
    // the merge-export that publishes owned chapters is a follow-up (STATE.md).
    const heldOutNotes = new Set(
      await step.do("list-held-out-note-books", async () => {
        const cfg = await getProjectConfig(this.env);
        const rs = await this.env.DB.prepare(
          `SELECT book, tn_source, tq_source FROM book_imports
            WHERE tn_source IS NOT NULL OR tq_source IS NOT NULL`,
        ).all<{ book: string; tn_source: string | null; tq_source: string | null }>();
        // step.do must return a JSON-serializable value → "BOOK:resource" strings.
        const markerKeys = rs.results.flatMap((r) =>
          [...heldOutNoteResources(r)].map((res) => `${r.book}:${res}`),
        );
        const rangeKeys = await listRangeHeldOutKeys(this.env, cfg);
        return [...new Set([...markerKeys, ...rangeKeys])];
      }),
    );

    // 1b. Sync D1 from current master before rendering. Pulls out-of-band master
    //     edits (other tooling, manual USFM cleanup, the bp-assistant bot) into
    //     D1's *pristine* rows so the export doesn't silently revert them on the
    //     branch; translator-edited rows are skipped by the reimport's pristine
    //     predicate (see bookReimport.ts). Without this, Part 2's reset-onto-
    //     master would make the export look like it's reverting master's edits.
    //
    //     One step.do per book (retries that book alone on a flaky DCS fetch),
    //     wrapped in try/catch so a single book's failure can't abort the whole
    //     export instance — same shape as the post-export reimport loop. Gated
    //     on dcsAllowed: a dry run / no-token run shouldn't mutate D1.
    if (dcsAllowed || params.reimportOnly) {
      for (const book of books) {
        try {
          // Chunked + SHA-gated + diff-aware reimport — steps through chapters so
          // a large book can't blow the 10-min step limit, and skips files whose
          // DCS commit SHA is unchanged. See bookReimport.ts:runChunkedReimport.
          await runChunkedReimport(this.env, step, book, instanceId, [...REIMPORT_RESOURCES], {});
        } catch (e) {
          // Lock contention / transient DCS failure / Cloudflare subrequest cap:
          // this book's D1 is now possibly stale relative to master. The
          // freshness gate in exportOne (masterSha vs watermark) refuses to
          // commit a stale render, so a failed sync no longer reverts master —
          // it just skips this book's export until a later sync succeeds. Alert
          // so the failure is visible rather than silently swallowed.
          const msg = e instanceof Error ? e.message : String(e);
          console.error("export pre-reimport failed", { book, error: msg });
          try {
            await step.do(`reimport-fail-alert-${book}`, async () =>
              this.recordSyncFailureAlert(book, msg),
            );
          } catch {
            /* alert is best-effort; never let it abort the export run */
          }
        }
      }
    }

    // Self-heal mode (08:00 REIMPORT_CRON): D1 is now synced from DCS; there's
    // nothing to render or commit, so stop before the export steps below.
    if (params.reimportOnly) {
      return { instanceId, totalSteps: 0, results: [], articleResults: [], contextResult: null };
    }

    // 2. One step per (book, resource). step.do persists, so a single flaky
    //    step retries without re-rendering the entire run.
    //
    //    Resource-major ordering: finish all books for one resource, then
    //    run the post-export validator (if one is configured) before moving
    //    on. Without this, a transient failure on TQ/TWL/ULT/UST would block
    //    TN validation from ever firing even after TN successfully pushed.
    const results: StepResult[] = [];
    for (const resource of resources) {
      for (const book of books) {
        // Aquifer- / English-source-sourced tn or tq: not exported yet (see above)
        if ((resource === "tn" || resource === "tq") && heldOutNotes.has(`${book}:${resource}`)) continue;
        const stepName = `export-${book}-${resource}`;
        try {
          const result = await step.do(
            stepName,
            { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
            async () => this.exportOne(book, resource, instanceId, dcsAllowed),
          );
          results.push(result);
        } catch (e) {
          // A single (book, resource) failure — most commonly a corrupt/dangling
          // DCS branch ref that ensureBranchVisible can't heal — must not abort
          // the whole instance and starve every other book (the resource-major
          // loop means one bad branch on the first book would otherwise block
          // all later books AND all later resources). Log, record the failure as
          // a snapshot for observability, and continue. Same isolation shape as
          // the pre-export reimport loop above.
          const reason = e instanceof Error ? e.message : String(e);
          console.error("export step failed", { book, resource, error: reason });
          try {
            await step.do(`${stepName}-record-fail`, async () =>
              this.recordSnapshot(book, resource, null, null, 0, `error:${reason.slice(0, 180)}`),
            );
          } catch {
            /* recording the failure is best-effort; never let it abort the run */
          }
          results.push({
            book,
            resource,
            rowCount: 0,
            bytes: 0,
            r2Key: null,
            branch: null,
            dcsCommitSha: null,
            dcsChanged: false,
            dcsSkippedReason: `error:${reason.slice(0, 180)}`,
            prNumber: null,
            prReason: null,
          });
        }
      }
      // Post-export validate-and-merge is opt-in via params.validateAndMerge.
      // The nightly cron sets it true; manual /api/exports/run defaults to
      // false so a one-off "render and push my single book" test doesn't
      // also kick off the auto-merge workflow on DCS.
      const validatorCfg = VALIDATORS.find((v) => v.resource === resource);
      if (validatorCfg && params.validateAndMerge === true) {
        await runPostExport(this.env, step, validatorCfg, dcsAllowed);
      }
    }

    // 2b. tW/tA article export. One step per (resource × top-level dir) —
    //     tw: bible/{kt,names,other}; ta: {translate,checking,process,intro} —
    //     mirroring the per-(book × resource) granularity above so a flaky
    //     commit retries a small slice. Only for TRANSLATION projects: the
    //     English root translates no articles (all target_md NULL), so there is
    //     nothing to export and we skip the DCS round-trips entirely. Also
    //     skipped for any NARROWED manual run: articles are book-independent, so
    //     a run scoped to one book (params.book — "re-export JON") or one verse
    //     resource (params.resource) didn't ask for the global tW/tA article
    //     export and must not fire it. Articles run only on a full-scope run
    //     (the nightly cron, or a manual run with neither book nor resource).
    const articleResults: ArticleStepResult[] = [];
    const projectCfgForArticles = await getProjectConfig(this.env);
    if (projectCfgForArticles.translationSource && !params.resource && !params.book) {
      for (const unit of articleStepUnits()) {
        const stepName = `export-article-${unit.resource}-${unit.topDir.replace(/\//g, "-")}`;
        try {
          const result = await step.do(
            stepName,
            { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
            async () => this.exportArticleDir(unit.resource, unit.topDir, instanceId, dcsAllowed),
          );
          articleResults.push(result);
        } catch (e) {
          // Same isolation shape as the verse loop: a single (resource, dir)
          // failure must not abort the instance or starve the other dirs.
          const reason = e instanceof Error ? e.message : String(e);
          const label = articleStepLabel(unit.resource, unit.topDir);
          console.error("export article step failed", { label, error: reason });
          try {
            await step.do(`${stepName}-record-fail`, async () =>
              this.recordSnapshot(label, unit.resource, null, null, 0, `error:${reason.slice(0, 180)}`),
            );
          } catch {
            /* recording the failure is best-effort; never let it abort the run */
          }
          articleResults.push({
            label,
            resource: unit.resource,
            topDir: unit.topDir,
            fileCount: 0,
            committedCount: 0,
            branch: null,
            dcsCommitSha: null,
            dcsSkippedReason: `error:${reason.slice(0, 180)}`,
            prNumber: null,
          });
        }
      }
    }

    // 2c. translation-context pack export. Full-scope GL runs only (nightly or
    //     manual with neither book nor resource). Writes {owner}/translation-context
    //     on master with CAS + shrink guard. See docs/CONTEXT-REPO-CONTRACT.md.
    let contextResult: ContextPackStepResult | null = null;
    const projectCfgForContext = await getProjectConfig(this.env);
    if (projectCfgForContext.translationSource && !params.resource && !params.book) {
      try {
        contextResult = await step.do(
          "export-context-pack",
          { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
          async () => this.exportContextPack(instanceId, dcsAllowed, !!params.shrinkOverride),
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error("export context-pack step failed", { error: reason });
        contextResult = {
          status: "failed",
          commitSha: null,
          contentFiles: 0,
          terms: 0,
          examplesTn: 0,
          examplesTq: 0,
          failureReason: reason.slice(0, 180),
        };
      }
    }

    // 3. Best-effort escalation of integrity issues the export can't auto-fix.
    //    Footnote (\f/\f*) imbalance is real data corruption a translator must
    //    resolve; surface it as an admin banner. Human-decision content issues
    //    (square brackets, Alternate-translation labels) are NOT nagged here —
    //    they're surfaced in-app via the per-book lint indicator
    //    (GET /api/books/:book/lint). Never aborts the run.
    try {
      await step.do("lint-escalate", async () => this.escalateIntegrityIssues(books));
    } catch (e) {
      console.error("export lint-escalate failed", { error: e instanceof Error ? e.message : String(e) });
    }

    return {
      instanceId,
      totalSteps: results.length + articleResults.length + (contextResult ? 1 : 0),
      results,
      articleResults,
      contextResult,
    };
  }

  // Render D1 translation memory → {owner}/translation-context@master with
  // expected-parent CAS, semantic shrink guard, and full result persistence.
  // A SHA is only recorded as success after CAS lands (or dry_run with stats).
  private async exportContextPack(
    instanceId: string,
    dcsAllowed: boolean,
    shrinkOverride: boolean,
  ): Promise<ContextPackStepResult> {
    const cfg = await getProjectConfig(this.env);
    const owner = contextRepoOwner(this.env, cfg);
    const resultId = await insertContextExportQueued(this.env, { instanceId, owner });

    const empty = (status: string, reason: string | null): ContextPackStepResult => ({
      status,
      commitSha: null,
      contentFiles: 0,
      terms: 0,
      examplesTn: 0,
      examplesTq: 0,
      failureReason: reason,
    });

    if (!cfg.translationSource) {
      await finalizeContextExport(this.env, resultId, {
        status: "failed",
        failureReason: "not_a_gl_project",
      });
      return empty("failed", "not_a_gl_project");
    }

    // Load prefs / terms / validated rows from D1.
    const prefsRow = await this.env.DB.prepare(
      `SELECT audience, purpose, register, script_notes, instructions_md, common_issues_md
         FROM translation_prefs WHERE id = 1`,
    ).first<TranslationPrefsForRender>();
    const prefs: TranslationPrefsForRender = prefsRow ?? {
      audience: null,
      purpose: null,
      register: "default",
      script_notes: null,
      instructions_md: null,
      common_issues_md: null,
    };

    const termRs = await this.env.DB.prepare(
      `SELECT concept_id, source_term, target_term, status, replacement, comment, tw_link
         FROM terminology WHERE deleted_at IS NULL
         ORDER BY concept_id, source_term, status`,
    ).all<TermImport>();
    const terms = termRs.results ?? [];

    const tnRs = await this.env.DB.prepare(
      `SELECT id, book, ref_raw, support_reference, quote, note, updated_at
         FROM tn_rows
        WHERE translation_state = 'validated' AND deleted_at IS NULL AND trashed_at IS NULL`,
    ).all<ValidatedTnRow>();
    const tqRs = await this.env.DB.prepare(
      `SELECT id, book, ref_raw, question, response, updated_at
         FROM tq_rows
        WHERE translation_state = 'validated' AND deleted_at IS NULL`,
    ).all<ValidatedTqRow>();
    const tnRows = tnRs.results ?? [];
    const tqRows = tqRs.results ?? [];

    const sourceFetch = await fetchEnSourceMaps(this.env, cfg, tnRows, tqRows);
    // A resource whose translationSource repo was left blank in Setup has NO
    // upstream source: fetchEnSourceMaps SKIPS it (empty map) and still fetches
    // the sourced resources, returning ok with `skipped`. That must NOT fail the
    // whole context export — prefs, terms, and the resources that DO have a
    // source still publish. Only genuine fetch failures (en_fetch_failed /
    // truncation / network) land in the !ok branch and hard-fail as before.
    if (!sourceFetch.ok) {
      await finalizeContextExport(this.env, resultId, {
        status: "failed",
        failureReason: sourceFetch.reason,
      });
          await this.recordSnapshot("CONTEXT", "ctx", null, null, 0, sourceFetch.reason);
      return empty("failed", sourceFetch.reason);
    }
    if (sourceFetch.skipped.length > 0) {
      console.log(
        `context export: no upstream source for [${sourceFetch.skipped.join(", ")}] — exporting without those examples`,
      );
    }

    // CAS retry loop: re-render from D1 on parent conflict (max 3).
    const maxAttempts = 3;
    let lastReason: string | null = null;
    // Repo existence is invariant across CAS retries — probe/create at most once.
    let repoEnsured = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const rendered = renderContextPack({
        cfg,
        prefs,
        terms,
        tnRows,
        tqRows,
        sources: sourceFetch.sources,
        skipped: sourceFetch.skipped,
      });
      if (!rendered.ok) {
        await finalizeContextExport(this.env, resultId, {
          status: "failed",
          failureReason: rendered.reason,
        });
        await this.recordSnapshot("CONTEXT", "ctx" , null, null, 0, rendered.reason);
        return empty("failed", rendered.reason);
      }

      const { files, stats } = rendered;
      const prevStats = await getLatestContextExportStats(this.env);
      const semantic = hasSemanticContent({
        prefs,
        terms: stats.terms,
        examplesTn: stats.examplesTn,
        examplesTq: stats.examplesTq,
      });
      // Scaffold-only (brief.md alone — + Register: default) with NO prior
      // successful export is a genuine first-time-empty pack: nothing to
      // publish and no repo to create. But scaffold-only AFTER a prior export
      // is an intentional CLEAR — it must flow through the commit below so the
      // stale instructions.md/terms.csv are deleted from master AND a new SHA
      // is recorded, otherwise getLatestSuccessfulContextExport keeps returning
      // the old SHA and the bot keeps injecting the content the user cleared.
      // (A large clear still trips the shrink guard → admin confirms via
      // shrinkOverride; a small clear commits straight through.)
      if (!semantic && !prevStats) {
        await finalizeContextExport(this.env, resultId, {
          status: "no_content",
          stats,
          failureReason: "scaffold_only",
        });
        await this.recordSnapshot("CONTEXT", "ctx", null, null, 0, "scaffold_only");
        return empty("no_content", "scaffold_only");
      }

      const shrink = contextShrinkRefused(stats, prevStats);
      if (shrink && !shrinkOverride) {
        const code = shrinkDetailCode(shrink);
        await finalizeContextExport(this.env, resultId, {
          status: "shrink_refused",
          stats,
          failureReason: code,
        });
        await this.recordContextShrinkAlert(owner, code);
        await this.recordSnapshot("CONTEXT", "ctx" , null, null, stats.contentFiles, code);
        return {
          status: "shrink_refused",
          commitSha: null,
          contentFiles: stats.contentFiles,
          terms: stats.terms,
          examplesTn: stats.examplesTn,
          examplesTq: stats.examplesTq,
          failureReason: code,
        };
      }

      const r2Key = `exports/${instanceId}/context-pack.json`;
      await this.env.BLOBS.put(
        r2Key,
        JSON.stringify({ files, stats, owner, renderedAt: new Date().toISOString() }),
        { httpMetadata: { contentType: "application/json" } },
      );

      if (!dcsAllowed) {
        const status = this.env.DCS_SERVICE_TOKEN ? "dry_run" : "dry_run";
        await finalizeContextExport(this.env, resultId, {
          status: "dry_run",
          stats,
          r2Key,
          failureReason: this.env.DCS_SERVICE_TOKEN ? "dry_run" : "no_service_token",
        });
        await this.recordSnapshot(
          "CONTEXT",
          "ctx" ,
          "master",
          null,
          stats.contentFiles,
          this.env.DCS_SERVICE_TOKEN ? "dry_run" : "no_service_token",
        );
        return {
          status,
          commitSha: null,
          contentFiles: stats.contentFiles,
          terms: stats.terms,
          examplesTn: stats.examplesTn,
          examplesTq: stats.examplesTq,
          failureReason: this.env.DCS_SERVICE_TOKEN ? "dry_run" : "no_service_token",
        };
      }

      try {
        const dcsCfg = {
          baseUrl: this.env.DCS_BASE_URL,
          token: this.env.DCS_SERVICE_TOKEN!,
          owner,
          repo: contextRepoName(),
        };
        // Tip-first: on the steady-state path (repo + master exist) this is the
        // only pre-commit read. Only a null tip triggers the repo probe/create —
        // first-ever export for this org creates the context repo silently so
        // the translator never has to provision anything on DCS themselves.
        let tip = await getBranchTipSha(dcsCfg, "master");
        if (tip == null && !repoEnsured) {
          const ensured = await ensureContextRepoExists(dcsCfg);
          repoEnsured = true;
          tip = await getBranchTipSha(dcsCfg, "master");
          if (tip == null && !ensured.created) {
            // Repo exists but has no master branch (created out-of-band without
            // auto_init) — the commit path can't self-heal that; name it.
            throw new Error(
              `context_repo_uninitialized: ${owner}/${contextRepoName()} exists but has no master branch`,
            );
          }
        }
        const commit = await commitContextPackToMaster(
          dcsCfg,
          files,
          `bible-editor context-pack export (${stats.contentFiles} files, ${stats.terms} terms) → master (${instanceId})`,
          tip,
        );
        await finalizeContextExport(this.env, resultId, {
          status: "success",
          commitSha: commit.commitSha,
          parentSha: commit.parentSha,
          stats,
          r2Key,
        });
        await this.recordSnapshot(
          "CONTEXT",
          "ctx" ,
          "master",
          commit.commitSha,
          stats.contentFiles,
          commit.changed ? null : "unchanged",
        );
        return {
          status: "success",
          commitSha: commit.commitSha,
          contentFiles: stats.contentFiles,
          terms: stats.terms,
          examplesTn: stats.examplesTn,
          examplesTq: stats.examplesTq,
          failureReason: null,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastReason = msg;
        if (msg.startsWith("context_cas_conflict") && attempt + 1 < maxAttempts) {
          console.warn("context pack CAS conflict; re-rendering", { attempt, msg });
          continue;
        }
        await finalizeContextExport(this.env, resultId, {
          status: "failed",
          stats,
          failureReason: msg.slice(0, 400),
          r2Key,
        });
        await this.recordSnapshot("CONTEXT", "ctx" , null, null, stats.contentFiles, `error:${msg.slice(0, 160)}`);
        return {
          status: "failed",
          commitSha: null,
          contentFiles: stats.contentFiles,
          terms: stats.terms,
          examplesTn: stats.examplesTn,
          examplesTq: stats.examplesTq,
          failureReason: msg.slice(0, 180),
        };
      }
    }

    await finalizeContextExport(this.env, resultId, {
      status: "failed",
      failureReason: lastReason ?? "cas_retries_exhausted",
    });
    return empty("failed", lastReason ?? "cas_retries_exhausted");
  }

  private async recordContextShrinkAlert(owner: string, detail: string): Promise<void> {
    const source = "export_context_guard";
    const message =
      `Benjamin — context-pack export BLOCKED for ${owner}/translation-context: ${detail}. ` +
      `Re-check translation prefs/terms/examples, then re-export with shrinkOverride if intentional.`;
    await this.writeAlert(source, message, `${this.env.DCS_BASE_URL}/${owner}/translation-context`);
  }

  // Lint each book's rendered scripture for footnote imbalance and raise/clear an
  // admin banner accordingly. Per-book source so a fixed book's alert clears on
  // the next run. Returns a small summary for step observability.
  private async escalateIntegrityIssues(books: string[]): Promise<{ flagged: string[] }> {
    const flagged: string[] = [];
    // Lint only the active generation of each lane. A lane mid-replacement
    // (replacement_required → null) is blocked; skip it rather than lint stale
    // or quarantined rows.
    const laneGen: Record<string, number | null> = {
      ULT: await activeGenerationForBibleVersion(this.env, "ULT"),
      UST: await activeGenerationForBibleVersion(this.env, "UST"),
    };
    // Raise a per-book admin banner when `offenders` is non-empty, else clear any
    // stale undismissed alert for that source (the issue was fixed). One source
    // per issue category so they raise/clear independently.
    const raiseOrClear = async (source: string, offenders: string[], makeMsg: (n: number, sample: string) => string): Promise<boolean> => {
      if (offenders.length === 0) {
        await this.env.DB.prepare(
          `DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
        )
          .bind(EXPORT_ALERT_USERNAME, source)
          .run();
        return false;
      }
      const more = offenders.length > 6 ? `, +${offenders.length - 6} more` : "";
      await this.writeAlert(source, makeMsg(offenders.length, offenders.slice(0, 6).join(", ") + more), await exportOwnerUrl(this.env));
      return true;
    };
    for (const book of books) {
      try {
        const footnoteOffenders: string[] = [];
        const gluedOffenders: string[] = [];
        for (const bv of ["ULT", "UST"]) {
          const gen = laneGen[bv];
          if (gen == null) continue;
          const rs = await this.env.DB.prepare(
            `SELECT * FROM verses WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3 ORDER BY chapter, verse`,
          )
            .bind(book, bv, gen)
            .all<VerseRow>();
          for (const issue of lintUsfmVerses(rs.results ?? [])) {
            if (issue.bucket !== "escalate") continue;
            if (issue.check === "Glued alignment") gluedOffenders.push(`${bv} ${issue.ref}`);
            else footnoteOffenders.push(`${bv} ${issue.ref}`);
          }
        }
        const f = await raiseOrClear(
          `export_lint:${book}`,
          footnoteOffenders,
          (n, s) => `Benjamin — ${book}: ${n} footnote integrity issue(s) the export can't auto-fix (${s}). Fix the \\f/\\f* pairing in these verses.`,
        );
        const g = await raiseOrClear(
          `export_glued:${book}`,
          gluedOffenders,
          (n, s) => `Benjamin — ${book}: ${n} alignment milestone(s) with maqqef/minus-glued source words (${s}). An AI run glued two OL words into one token; open the verse in the aligner (it re-anchors off the UHB) and save, or run the backfill.`,
        );
        if (f || g) flagged.push(book);
      } catch (e) {
        console.error("escalateIntegrityIssues book failed", { book, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { flagged };
  }

  private async exportOne(
    book: string,
    resource: Resource,
    instanceId: string,
    dcsAllowed: boolean,
  ): Promise<StepResult> {
    // Lane fencing for scripture resources (ULT/UST): check writability from
    // live D1 state (not cached project config) before doing anything.
    const lane = (resource === "ult" || resource === "ust") ? laneForBibleVersion(resource.toUpperCase()) : null;
    // Active generation to render from. ULT/UST render their own lane's active
    // generation; TWL reads ULT verses for sort ordering, so it uses ULT's.
    // tn/tq don't touch generation-scoped rows (1 is an unused sentinel).
    let scriptureGen = 1;
    // Lane export destination from live active_config_json — not projectCfg.
    let laneExport: { owner: string; repo: string; baseRef: string } | null | undefined;
    let leaseId: string | null = null;
    let fencingToken: string | null = null;
    let expectedConfigHash: string | null = null;

    if (lane) {
      const gate = await assertLaneWritable(this.env, lane, "export_lease");
      if (!gate.ok) {
        const reason = `lane_blocked:${gate.error}`;
        await this.recordSnapshot(book, resource, null, null, 0, reason);
        return {
          book, resource, rowCount: 0, bytes: 0, r2Key: null,
          branch: null, dcsCommitSha: null, dcsChanged: false,
          dcsSkippedReason: reason, prNumber: null, prReason: null,
        };
      }
      // Acquire the lease BEFORE capture/render so a replacement cannot activate
      // mid-render and leave us holding old-generation bytes for a new destination.
      if (dcsAllowed) {
        const lease = await acquireExportLease(this.env, lane, `export:${instanceId}:${book}`);
        if ("error" in lease) {
          const reason = `lease_blocked:${lease.error}`;
          await this.recordSnapshot(book, resource, null, null, 0, reason);
          return {
            book, resource, rowCount: 0, bytes: 0, r2Key: null,
            branch: null, dcsCommitSha: null, dcsChanged: false,
            dcsSkippedReason: reason, prNumber: null, prReason: null,
          };
        }
        leaseId = lease.leaseId;
        fencingToken = lease.fencingToken;
      }
      // Re-bind generation/export under the lease (or after the gate if local-only).
      const bound = await assertLaneWritable(this.env, lane, "export_lease");
      if (!bound.ok) {
        if (leaseId) await releaseExportLease(this.env, leaseId).catch(() => {});
        const reason = `lane_blocked:${bound.error}`;
        await this.recordSnapshot(book, resource, null, null, 0, reason);
        return {
          book, resource, rowCount: 0, bytes: 0, r2Key: null,
          branch: null, dcsCommitSha: null, dcsChanged: false,
          dcsSkippedReason: reason, prNumber: null, prReason: null,
        };
      }
      scriptureGen = bound.generation;
      laneExport = bound.config.export;
      expectedConfigHash = configHash(bound.config);
    } else if (resource === "twl") {
      scriptureGen = await this.activeGenerationFor("ULT");
    }

    try {
    const built = await this.buildResource(book, resource, scriptureGen);

    // After render: lease + generation/config must still match what we rendered.
    if (lane && leaseId) {
      await this.assertFencingOrThrow(lane, fencingToken);
      const still = await assertLaneWritable(this.env, lane, "export_lease");
      if (
        !still.ok ||
        still.generation !== scriptureGen ||
        configHash(still.config) !== expectedConfigHash
      ) {
        const reason = "lease_stale_after_render";
        await this.recordSnapshot(book, resource, null, null, built.rowCount, reason);
        return {
          book, resource, rowCount: built.rowCount, bytes: built.content.length, r2Key: null,
          branch: null, dcsCommitSha: null, dcsChanged: false,
          dcsSkippedReason: reason, prNumber: null, prReason: null,
        };
      }
      await renewExportLease(this.env, leaseId);
    }

    if (built.content === "") {
      await this.recordSnapshot(book, resource, null, null, built.rowCount, "no_rows");
      return {
        book,
        resource,
        rowCount: built.rowCount,
        bytes: 0,
        r2Key: null,
        branch: null,
        dcsCommitSha: null,
        dcsChanged: false,
        dcsSkippedReason: "no_rows",
        prNumber: null,
        prReason: null,
      };
    }

    // Apply TWL sort order updates computed during export. Persist the sequence
    // so future operations use the optimal ordering from the ULT alignment.
    if (built.sortOrderUpdates.length > 0) {
      await this.applyTwlSortOrderUpdates(book, built.sortOrderUpdates);
    }

    // Book-specific branch named for this resource's human contributors.
    const contributors = await this.contributorsFor(book, resource);
    const branch = buildExportBranch(book, contributors);

    // R2 is the local-only backup. Writing here first means a failed DCS
    // commit still leaves a recoverable artifact.
    const projectCfg = await getProjectConfig(this.env);
    const projectTarget = resourceTargetsFor(projectCfg)[resource];
    // Scripture lanes use active_config.export when set; export:null means
    // D1-only (R2 snapshot still written, no DCS commit). Non-scripture keeps
    // the project-config target.
    const filename = projectTarget.path(book);
    const r2Key = `exports/${instanceId}/${book}/${resource}/${filename}`;
    await this.env.BLOBS.put(r2Key, built.content, {
      httpMetadata: { contentType: filename.endsWith(".usfm") ? "text/plain" : "text/tab-separated-values" },
    });

    let dcsCommitSha: string | null = null;
    let dcsChanged = false;
    let dcsSkippedReason: string | null = null;
    let prNumber: number | null = null;
    let prReason: string | null = null;
    let prError: string | null = null;

    // Lane with export:null → local-only; never push to a project-default repo.
    if (lane && laneExport === null) {
      await this.recordSnapshot(book, resource, null, null, built.rowCount, "lane_export_disabled");
      return {
        book, resource, rowCount: built.rowCount, bytes: built.content.length, r2Key,
        branch: null, dcsCommitSha: null, dcsChanged: false,
        dcsSkippedReason: "lane_export_disabled", prNumber: null, prReason: null,
      };
    }

    const dcsOwner = lane && laneExport
      ? laneExport.owner
      : exportOwnerFor(this.env, projectCfg);
    const dcsRepo = lane && laneExport ? laneExport.repo : projectTarget.repo;

    // Freshness gate — the single guard against clobbering master. The export
    // renders from D1; if master moved past what D1 last synced (the
    // book_resource_syncs watermark), committing this render would REVERT
    // master's out-of-band edits (the exact LAM 2:17 regression: a gatewayEdit
    // alignment landed on master, the pre-export sync failed on the Cloudflare
    // subrequest cap, and the export silently reverted it). So unless we can
    // POSITIVELY confirm master == watermark, skip the commit and alert. Fail
    // CLOSED on uncertainty (can't fetch master SHA) — a one-night skip beats a
    // silent revert. A fresh book with no watermark has nothing to clobber.
    // Only meaningful when we'd actually commit (dcsAllowed); a dry run renders
    // to R2 only and can't clobber anything.
    const fresh = dcsAllowed
      ? await this.checkMasterFreshness(book, resource, {
          owner: dcsOwner,
          repo: dcsRepo,
          baseRef: laneExport?.baseRef ?? "master",
          lane,
        })
      : { ok: true as const, detail: "dry", masterSha: null, watermark: null };
    if (!fresh.ok) {
      await this.recordStaleSkipAlert(book, resource, fresh.masterSha, fresh.watermark);
      const reason = `stale_master:${fresh.detail}`;
      await this.recordSnapshot(book, resource, null, null, built.rowCount, reason);
      return {
        book,
        resource,
        rowCount: built.rowCount,
        bytes: built.content.length,
        r2Key,
        branch: null,
        dcsCommitSha: null,
        dcsChanged: false,
        dcsSkippedReason: reason,
        prNumber: null,
        prReason: null,
      };
    }

    // Shrink guard — refuse to commit a TSV render that would delete a large
    // fraction of master's rows (truncation backstop; see exportTsvShrinkRefused).
    // Only when we'd actually commit (dcsAllowed) and only for TSV resources,
    // whose row==line model makes the count exact. This is what would have
    // stopped the twl_PSA clobber (4880 rows shipped over master's 7776).
    if (dcsAllowed && (resource === "tn" || resource === "tq" || resource === "twl")) {
      const guard = await this.checkTsvShrink(
        book, resource, built.rowCount, dcsOwner, dcsRepo, "master",
      );
      if (!guard.ok) {
        await this.recordShrinkSkipAlert(book, resource, built.rowCount, guard.masterRows, guard.detail);
        const reason = `shrink_guard:${guard.detail}`;
        await this.recordSnapshot(book, resource, null, null, built.rowCount, reason);
        return {
          book,
          resource,
          rowCount: built.rowCount,
          bytes: built.content.length,
          r2Key,
          branch: null,
          dcsCommitSha: null,
          dcsChanged: false,
          dcsSkippedReason: reason,
          prNumber: null,
          prReason: null,
        };
      }
    }

    // Alignment-shrink backstop for the scripture (verse) resources. The TSV
    // shrink guard above protects row counts; this protects \zaln word
    // alignment. A verse that lost \zaln milestones on UNTOUCHED words (the
    // 1CH 4:21 / NUM 24 signature) has the same row count but fewer aligned
    // words — invisible to the TSV guard. The interactive guard now catches
    // this at write time, but a verse already regressed in D1 (landed before
    // the guard, or via an ingress path it doesn't cover) would still ship.
    // Conservative: only blocks a verse whose aligned-word count shrank while
    // its plain text is unchanged — a real text rewrite is always allowed.
    if (dcsAllowed && (resource === "ult" || resource === "ust")) {
      const guard = await this.checkUsfmAlignmentShrink(
        book, resource, built.content, dcsOwner, dcsRepo, laneExport?.baseRef ?? "master",
      );
      if (!guard.ok) {
        await this.recordAlignmentShrinkSkipAlert(book, resource, guard.detail);
        const reason = `align_shrink_guard:${guard.detail}`;
        await this.recordSnapshot(book, resource, null, null, built.rowCount, reason);
        return {
          book,
          resource,
          rowCount: built.rowCount,
          bytes: built.content.length,
          r2Key,
          branch: null,
          dcsCommitSha: null,
          dcsChanged: false,
          dcsSkippedReason: reason,
          prNumber: null,
          prReason: null,
        };
      }
    }

    // textReadOnly lanes (AVD/NAV): refuse to export if non-alignment body text
    // diverged from the destination tip. Alignment-only changes are allowed.
    if (dcsAllowed && lane && (resource === "ult" || resource === "ust")) {
      const laneRow = await getLaneState(this.env, lane);
      const laneCfg = laneRow ? activeLaneConfig(laneRow) : null;
      if (laneCfg?.textReadOnly) {
        const baseRef = laneExport?.baseRef ?? "master";
        const eq = await this.checkLockedTextEquality(
          book, resource, built.content, dcsOwner, dcsRepo, baseRef,
        );
        if (!eq.ok) {
          await this.recordLockedTextDriftAlert(book, resource, eq.detail);
          const reason = `locked_text_drift:${eq.detail}`;
          await this.recordSnapshot(book, resource, null, null, built.rowCount, reason);
          return {
            book, resource, rowCount: built.rowCount, bytes: built.content.length, r2Key,
            branch: null, dcsCommitSha: null, dcsChanged: false,
            dcsSkippedReason: reason, prNumber: null, prReason: null,
          };
        }
      }
    }

    if (!dcsAllowed) {
      dcsSkippedReason = this.env.DCS_SERVICE_TOKEN ? "dry_run" : "no_service_token";
    } else {
      const owner = dcsOwner;
      const dcsCfg = {
        baseUrl: this.env.DCS_BASE_URL,
        token: this.env.DCS_SERVICE_TOKEN!,
        owner,
        repo: dcsRepo,
        branch,
        baseRef: laneExport?.baseRef ?? "master",
        beforeMutation: fencingToken
          ? () => this.assertFencingOrThrow(lane, fencingToken)
          : undefined,
      };
      const message = `bible-editor export: ${book} ${resource} → ${branch} (${instanceId})`;

      // Fencing token must still hold before the file commit — the one mutation
      // we must never do with a stale token (it would push over a just-activated
      // replacement generation). Throws → the run() step catch records the skip;
      // nothing was committed.
      await this.assertFencingOrThrow(lane, fencingToken);

      const commit = await commitToDcs(dcsCfg, filename, built.content, message);
      if (!commit.branchTouched) {
        const lingering = await findDcsOpenPr(dcsCfg);
        if (lingering != null) {
          try {
            // Closing a stale PR mutates DCS — re-verify ownership first.
            await this.assertFencingOrThrow(lane, fencingToken);
            await closeDcsPr(dcsCfg, lingering);
          } catch (e) {
            console.error("export close-stale-PR failed", {
              book, resource, repo: dcsRepo, pr: lingering,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
      dcsCommitSha = commit.commitSha || null;
      dcsChanged = commit.changed;

      // Remember the destination tip we exported against so divergent
      // source≠export freshness checks don't re-validate the wrong repo.
      if (lane && laneExport && fresh.masterSha) {
        await this.recordExportBaseline(
          lane,
          dcsOwner,
          dcsRepo,
          laneExport.baseRef,
          book,
          fresh.masterSha,
        );
      }

      if (!commit.branchTouched) {
        dcsSkippedReason = "unchanged";
      } else {
        try {
          // Pruning superseded branches deletes refs on DCS — re-verify ownership.
          await this.assertFencingOrThrow(lane, fencingToken);
          await this.pruneSupersededBranches(book, resource, owner, dcsRepo, branch, lane, fencingToken);

          // Renew around the (potentially long) PR operations; a failed renew
          // means another Worker took the lane — treat it as lost ownership and
          // abort the remaining mutations rather than racing them.
          if (leaseId && !(await renewExportLease(this.env, leaseId))) {
            throw new Error("fencing_token_superseded");
          }
          await this.assertFencingOrThrow(lane, fencingToken);

          const pr = await ensureDcsPr(
            dcsCfg,
            `bible-editor: ${book} ${resource} → master`,
            `Auto-opened by the bible-editor nightly export so the DCS validate-and-merge workflow can process \`${branch}\`. Holds the latest ${resource.toUpperCase()} edits for ${book}.`,
          );
          prNumber = pr.number;
          prReason = pr.reason;
          if (pr.number != null) {
            try {
              // Renew + re-verify before update-branch (another mutating call).
              if (leaseId && !(await renewExportLease(this.env, leaseId))) {
                throw new Error("fencing_token_superseded");
              }
              await this.assertFencingOrThrow(lane, fencingToken);
              const upd = await updateDcsPrBranch(
                { baseUrl: dcsCfg.baseUrl, token: dcsCfg.token, owner, repo: dcsRepo },
                pr.number,
              );
              if (!upd.ok) {
                console.log("export PR update-branch skipped", {
                  book, resource, repo: dcsRepo, pr: pr.number, status: upd.status, detail: upd.detail,
                });
                if (upd.status === 409) {
                  // Recovery deletes + recommits the branch — renew + re-verify.
                  if (leaseId && !(await renewExportLease(this.env, leaseId))) {
                    throw new Error("fencing_token_superseded");
                  }
                  await this.assertFencingOrThrow(lane, fencingToken);
                  const recovered = await this.recoverConflictedBranch(
                    book, resource, owner, dcsRepo, branch, dcsCfg, filename, built.content, message,
                    lane, fencingToken,
                  );
                  if (recovered) {
                    prNumber = recovered.prNumber;
                    prReason = recovered.prReason;
                    if (recovered.commitSha) dcsCommitSha = recovered.commitSha;
                  }
                }
              }
            } catch (e) {
              console.error("export PR update-branch failed", {
                book, resource, repo: dcsRepo, pr: pr.number,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
        } catch (e) {
          prReason = "error";
          prError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
          console.error("export ensure-PR failed", {
            book,
            resource,
            repo: dcsRepo,
            branch,
            error: prError,
          });
          await this.recordPrFailureAlert(book, resource, dcsRepo, branch, prError);
        }
      }
    }

    await this.recordSnapshot(book, resource, branch, dcsCommitSha, built.rowCount, dcsSkippedReason, prNumber, prError);

    return {
      book,
      resource,
      rowCount: built.rowCount,
      bytes: built.content.length,
      r2Key,
      branch,
      dcsCommitSha,
      dcsChanged,
      dcsSkippedReason,
      prNumber,
      prReason,
    };
    } finally {
      if (leaseId) await releaseExportLease(this.env, leaseId).catch(() => {});
    }
  }

  // Export one (resource × top-level dir) of tW/tA articles. The article
  // analogue of exportOne: render target_md files from D1 → R2 backup →
  // safety-rail guards → single batch commit → PR → snapshot. See
  // docs/design/tw-ta-translation-modules.md §5.
  private async exportArticleDir(
    resource: ArticleResource,
    topDir: string,
    instanceId: string,
    dcsAllowed: boolean,
  ): Promise<ArticleStepResult> {
    const label = articleStepLabel(resource, topDir);
    const { files, count } = await renderArticleFiles(this.env, resource, topDir);

    if (count === 0) {
      await this.recordSnapshot(label, resource, null, null, 0, "no_units");
      return {
        label, resource, topDir,
        fileCount: 0, committedCount: 0,
        branch: null, dcsCommitSha: null, dcsSkippedReason: "no_units", prNumber: null,
      };
    }

    const cfg = await getProjectConfig(this.env);
    const repo = resource === "tw" ? cfg.repos.tw : cfg.repos.ta;
    const owner = exportOwnerFor(this.env, cfg);
    const branch = buildExportBranch(label, []);

    // R2 backup: one JSON bundle of {path: content} for the whole dir (not one
    // object per file — that would be hundreds of R2 puts). Recoverable if the
    // DCS commit later fails, same role as the verse path's per-file R2 write.
    const r2Key = `exports/${instanceId}/articles/${label}.json`;
    await this.env.BLOBS.put(
      r2Key,
      JSON.stringify({ resource, topDir, files }),
      { httpMetadata: { contentType: "application/json" } },
    );

    let dcsCommitSha: string | null = null;
    let dcsSkippedReason: string | null = null;
    let committedCount = 0;
    let prNumber: number | null = null;
    let prError: string | null = null;
    // The branch reported in the result: null until we either commit to it or
    // do a dry run (which reports the would-be branch, for parity with the verse
    // exportOne). A guard skip leaves it null — nothing was committed there.
    let resultBranch: string | null = null;

    const done = (): ArticleStepResult => ({
      label, resource, topDir,
      fileCount: count, committedCount,
      branch: resultBranch,
      dcsCommitSha, dcsSkippedReason, prNumber,
    });

    if (!dcsAllowed) {
      dcsSkippedReason = this.env.DCS_SERVICE_TOKEN ? "dry_run" : "no_service_token";
      resultBranch = branch; // report the would-be branch (matches exportOne's dry return)
      await this.recordSnapshot(label, resource, branch, null, count, dcsSkippedReason, null, null);
      return done();
    }

    // Safety rail — the article carry-over of the verse export's shrink guard:
    // the backstop against a truncated / partial D1 read shipping a destructive
    // shrink (the twl_PSA clobber signature). Baseline = the file count THIS
    // export system last successfully committed for this (label, resource),
    // from export_snapshots — NOT the target repo's current .md count. Two
    // reasons this is the right baseline: (1) the intent is "don't drop
    // PREVIOUSLY-EXPORTED files," which our own last export count measures
    // exactly; (2) a GL target repo may be provisioned by seeding the full
    // English article set, so its live .md count is NOT what we exported —
    // comparing against it would false-block every early export (a handful
    // translated vs ~1,000 English files). The verse path's SHA-watermark
    // freshness gate has no article analogue: there is no article DCS→D1
    // reimport loop (import-articles.mjs only seeds source_md) and the target
    // has no out-of-band writer (only this export writes it, via a PR). First
    // export (no prior successful snapshot) → nothing to protect → allowed.
    const prevExported = await this.lastArticleExportCount(label, resource);
    if (prevExported != null && shrinkRefused(count, prevExported)) {
      const detail = `shrink_${prevExported - count}_of_${prevExported}`;
      await this.recordArticleGuardAlert(label, resource, repo, detail);
      dcsSkippedReason = `shrink_guard:${detail}`;
      await this.recordSnapshot(label, resource, null, null, count, dcsSkippedReason);
      return done();
    }

    const dcsCfg = { baseUrl: this.env.DCS_BASE_URL, token: this.env.DCS_SERVICE_TOKEN!, owner, repo, branch };
    resultBranch = branch; // committing to it now
    const message = `bible-editor export: ${label} (${count} files) → ${branch} (${instanceId})`;
    const commit = await commitFilesToDcs(dcsCfg, files, message);
    dcsCommitSha = commit.commitSha || null;
    committedCount = commit.committedCount;
    if (!commit.changed) dcsSkippedReason = "unchanged"; // render already on the branch

    // PR maintenance — runs whether or not THIS run changed the branch. Since
    // count > 0 here, `commitFilesToDcs` always reset/created the branch
    // (branchTouched), and the branch carries unmerged article translations
    // either way. door43's frozen-merge-base bug means resetExportBranchToMaster
    // can't actually re-base a long-lived branch (it 409s and only confirms the
    // ref exists), so a PR that isn't periodically "update-branch"ed drifts to
    // mergeable:false — hence we ensure + update on unchanged runs too, not just
    // when the content changed. Unlike the verse path we do NOT close on
    // unchanged: an article "unchanged" PR is NOT empty — it still holds the
    // translations awaiting the publisher (only merging it lands them on master).
    // No auto-merge: articles have no post-export validator; release-gating on
    // completeness belongs to the future gl-publisher (design §5). Best-effort —
    // the commit already landed, so a PR failure must not fail the step.
    if (commit.branchTouched) {
      try {
        const pr = await ensureDcsPr(
          dcsCfg,
          `bible-editor: ${resource.toUpperCase()} ${topDir} → master`,
          `Auto-opened by the bible-editor nightly export. Holds the latest ${resource.toUpperCase()} ` +
            `article translations under \`${topDir}\`. Release-gating on completeness / checking level ` +
            `is left to the publisher.`,
        );
        prNumber = pr.number;
        if (pr.number != null) {
          try {
            const upd = await updateDcsPrBranch(dcsCfg, pr.number);
            if (!upd.ok) {
              console.log("export article PR update-branch skipped", {
                label, repo, pr: pr.number, status: upd.status, detail: upd.detail,
              });
            }
          } catch (e) {
            console.error("export article PR update-branch failed", {
              label, repo, pr: pr.number, error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      } catch (e) {
        prError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        console.error("export article ensure-PR failed", { label, repo, branch, error: prError });
        await this.recordPrFailureAlert(label, resource, repo, branch, prError);
      }
    }

    await this.recordSnapshot(label, resource, branch, dcsCommitSha, count, dcsSkippedReason, prNumber, prError);
    return done();
  }

  // The file count THIS export system last SUCCESSFULLY committed for a
  // (label, resource) — the shrink guard's baseline. `commit_sha IS NOT NULL`
  // is the success predicate (same one contributorsFor uses). null when there's
  // no prior successful export (first run → nothing to protect). Using our own
  // export history, not the target repo's live file count, is what keeps the
  // guard from false-blocking when the target was seeded with English articles.
  private async lastArticleExportCount(
    label: string,
    resource: ArticleResource,
  ): Promise<number | null> {
    const row = await this.env.DB.prepare(
      `SELECT rows_exported FROM export_snapshots
        WHERE book = ?1 AND resource = ?2 AND commit_sha IS NOT NULL
        ORDER BY committed_at DESC LIMIT 1`,
    )
      .bind(label, resource)
      .first<{ rows_exported: number | null }>();
    return row?.rows_exported ?? null;
  }

  // Banner alert when an article export step is blocked by the shrink guard (a
  // render that would drop a large fraction of the files we last exported — the
  // truncated/partial-D1 signature). Same replace-undismissed shape as
  // recordShrinkSkipAlert.
  private async recordArticleGuardAlert(
    label: string,
    resource: ArticleResource,
    repo: string,
    detail: string,
  ): Promise<void> {
    const source = `export_article_guard:${label}`;
    const message =
      `Benjamin — nightly export BLOCKED ${resource.toUpperCase()} articles (\`${label}\` → ${repo}): ${detail}. ` +
      `The render has far fewer files than the last successful export of this set (truncated/partial D1 read) — ` +
      `refusing to shrink it. Re-check the article_units data, then re-export.`;
    await this.writeAlert(source, message, await exportOwnerUrl(this.env));
  }

  // Live active generation for a bible version (lit→ULT, sim→UST); 1 for OL /
  // unknown. Reads uncached D1 lane state — never the project-config isolate
  // cache — so a concurrent replacement activation is seen immediately.
  private async activeGenerationFor(bibleVersion: string): Promise<number> {
    const lane = laneForBibleVersion(bibleVersion);
    if (!lane) return 1;
    const st = await getLaneState(this.env, lane);
    return st?.active_generation ?? 1;
  }

  // Re-check the export fencing token before a mutating DCS call and throw if it
  // no longer holds (lease released/expired/abandoned, superseding lease, or the
  // lane became exports_blocked by a replacement). Non-scripture resources have
  // no lane/lease, so they short-circuit as always-valid.
  private async assertFencingOrThrow(lane: LaneKey | null, token: string | null): Promise<void> {
    if (!lane || !token) return;
    const valid = await verifyExportFencingToken(this.env, lane, token);
    if (!valid) throw new Error("fencing_token_superseded");
  }

  private async buildResource(
    book: string,
    resource: Resource,
    scriptureGen: number,
  ): Promise<{ content: string; rowCount: number; sortOrderUpdates: Array<{ id: string; sort_order: number }> }> {
    const db = this.env.DB;
    if (resource === "tn") {
      // trashed_at IS NULL excludes notes pending deletion. The nightly cron
      // promotes trash -> deleted_at before this Workflow's steps read, but
      // this guard also covers anything trashed mid-run (after finalize, before
      // this book's export step).
      const rs = await db
        .prepare(
          `SELECT * FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL AND trashed_at IS NULL
           ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
        )
        .bind(book)
        .all<TnRow>();
      // Export gate (migration 0049): a non-validated AI draft must never reach
      // DCS — emit the pre-draft snapshot instead. Row count is unchanged, so
      // the shrink guard is unaffected.
      const gated = rs.results.map((r) => {
        const { row, legacy } = gateTsvRowForExport(r, ["note", "tags"]);
        if (legacy) {
          console.log(`export gate: tn ${book}/${r.id} is ${r.translation_state} with no pre-draft snapshot (legacy) — exporting current content`);
        }
        return row;
      });
      return { content: gated.length === 0 ? "" : buildTnTsv(gated), rowCount: gated.length, sortOrderUpdates: [] };
    }
    if (resource === "tq") {
      const rs = await db
        .prepare(
          `SELECT * FROM tq_rows WHERE book = ?1 AND deleted_at IS NULL
           ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
        )
        .bind(book)
        .all<TqRow>();
      // Same non-validated-draft export gate as tn above.
      const gated = rs.results.map((r) => {
        const { row, legacy } = gateTsvRowForExport(r, ["question", "response"]);
        if (legacy) {
          console.log(`export gate: tq ${book}/${r.id} is ${r.translation_state} with no pre-draft snapshot (legacy) — exporting current content`);
        }
        return row;
      });
      return { content: gated.length === 0 ? "" : buildTqTsv(gated), rowCount: gated.length, sortOrderUpdates: [] };
    }
    if (resource === "twl") {
      const rs = await db
        .prepare(
          `SELECT * FROM twl_rows WHERE book = ?1 AND deleted_at IS NULL
           ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
        )
        .bind(book)
        .all<TwlRow>();
      const ultVerses = await db
        .prepare(
          `SELECT * FROM verses WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3
           ORDER BY chapter, verse`,
        )
        .bind(book, "ULT", scriptureGen)
        .all<VerseRow>();
      if (rs.results.length === 0) {
        return { content: "", rowCount: 0, sortOrderUpdates: [] };
      }
      const result = buildTwlTsv(rs.results, {
        book,
        bibleVersion: "ULT",
        headers: null,
        verses: ultVerses.results,
      });
      return {
        content: result.tsv,
        rowCount: rs.results.length,
        sortOrderUpdates: result.sortOrderUpdates,
      };
    }
    // ult / ust
    const bibleVersion = resource.toUpperCase();
    const rs = await db
      .prepare(
        `SELECT * FROM verses WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3
         ORDER BY chapter, verse`,
      )
      .bind(book, bibleVersion, scriptureGen)
      .all<VerseRow>();
    if (rs.results.length === 0) return { content: "", rowCount: 0, sortOrderUpdates: [] };
    const headersRow = await db
      .prepare(`SELECT headers_json FROM book_usfm_meta WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3`)
      .bind(book, bibleVersion, scriptureGen)
      .first<{ headers_json: string }>();
    let headers: unknown[] | null = null;
    if (headersRow) {
      try {
        const parsed = JSON.parse(headersRow.headers_json);
        if (Array.isArray(parsed)) headers = parsed;
      } catch {
        headers = null;
      }
    }
    return {
      content: buildUsfm({ book, bibleVersion, headers, verses: rs.results }),
      rowCount: rs.results.length,
      sortOrderUpdates: [],
    };
  }

  // Human contributors to one resource of one book, in first-edit order.
  // Drives the export branch name. `source IS NULL` excludes AI-pipeline edits
  // (the only non-null source today is 'ai_pipeline'; see migration 0010).
  //
  //   tn/tq/twl → edit_log.kind matches the resource directly.
  //   ult/ust   → kind='verse'; the bible version lives in the last segment of
  //               row_key ('{book}/{ch}/{v}/{VERSION}'), so match by suffix.
  private async contributorsFor(book: string, resource: Resource): Promise<string[]> {
    const isBible = resource === "ult" || resource === "ust";
    // Only include editors who touched this resource since the last successful
    // export (commit_sha IS NOT NULL). Using COALESCE(..., 0) means "include
    // all edits" when no successful export exists yet.
    const sql = isBible
      ? `SELECT u.dcs_username AS username, MIN(e.created_at) AS first_at
           FROM edit_log e JOIN users u ON u.id = e.user_id
          WHERE e.kind = 'verse' AND e.book = ?1 AND e.source IS NULL
            AND e.row_key LIKE ?2
            AND e.created_at > COALESCE(
              (SELECT committed_at FROM export_snapshots
                WHERE book = ?1 AND resource = ?3 AND commit_sha IS NOT NULL
                ORDER BY committed_at DESC LIMIT 1),
              0
            )
          GROUP BY u.id
          ORDER BY first_at ASC, u.dcs_username ASC`
      : `SELECT u.dcs_username AS username, MIN(e.created_at) AS first_at
           FROM edit_log e JOIN users u ON u.id = e.user_id
          WHERE e.kind = ?1 AND e.book = ?2 AND e.source IS NULL
            AND e.created_at > COALESCE(
              (SELECT committed_at FROM export_snapshots
                WHERE book = ?2 AND resource = ?1 AND commit_sha IS NOT NULL
                ORDER BY committed_at DESC LIMIT 1),
              0
            )
          GROUP BY u.id
          ORDER BY first_at ASC, u.dcs_username ASC`;
    const stmt = isBible
      ? this.env.DB.prepare(sql).bind(book, `${book}/%/${resource.toUpperCase()}`, resource)
      : this.env.DB.prepare(sql).bind(resource, book);
    const rs = await stmt.all<{ username: string; first_at: number }>();
    return rs.results.map((r) => r.username);
  }

  // Apply TWL sort order updates computed during export. Updates only rows in
  // verses where reordering happened, preserving the alignment-based sequence
  // in the database for future operations. This is idempotent: multiple calls
  // with the same updates produce the same result.
  private async applyTwlSortOrderUpdates(
    book: string,
    updates: Array<{ id: string; sort_order: number }>,
  ): Promise<void> {
    // Delegates to the shared helper (twlSortOrderApply.ts) so the export and the
    // reimport canonical post-pass write sort_order identically.
    await applyTwlSortOrderUpdates(this.env.DB, book, updates);
  }

  // Delete branches this export's branch replaces. Sources:
  //   1. export_snapshots history — any prior branch we recorded for this
  //      (book, resource) that differs from the current one (a contributor
  //      joined/left and the name changed).
  //   2. The legacy live-snapshot branch.
  // Best-effort: per-branch errors are logged and swallowed so a prune failure
  // never fails the export step (which would also retry the commit).
  private async pruneSupersededBranches(
    book: string,
    resource: Resource,
    owner: string,
    repo: string,
    keepBranch: string,
    lane: LaneKey | null = null,
    fencingToken: string | null = null,
  ): Promise<void> {
    // Steady-state short-circuit: when the most recent snapshot already
    // recorded this same branch, any superseded branches were already pruned
    // (or 403ed — the service token lacks branch-delete) on a previous night.
    // Skipping stops the per-step DELETE calls that fail forever.
    try {
      const last = await this.env.DB.prepare(
        `SELECT branch FROM export_snapshots
          WHERE book = ?1 AND resource = ?2 AND branch IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
      )
        .bind(book, resource)
        .first<{ branch: string }>();
      if (last?.branch === keepBranch) return;
    } catch (e) {
      console.error("prune: last-snapshot query failed", { book, resource, error: e instanceof Error ? e.message : String(e) });
    }
    let stale: string[] = [];
    try {
      const rs = await this.env.DB.prepare(
        `SELECT DISTINCT branch FROM export_snapshots
          WHERE book = ?1 AND resource = ?2 AND branch IS NOT NULL AND branch <> ?3`,
      )
        .bind(book, resource, keepBranch)
        .all<{ branch: string }>();
      stale = rs.results.map((r) => r.branch);
    } catch (e) {
      console.error("prune: history query failed", { book, resource, error: e instanceof Error ? e.message : String(e) });
    }
    const targets = [...new Set([...stale, LEGACY_EXPORT_BRANCH])].filter((b) => b && b !== keepBranch);
    for (const b of targets) {
      try {
        // Re-verify fencing before every branch DELETE — a mid-loop activation
        // must not let us keep mutating DCS under a superseded token.
        await this.assertFencingOrThrow(lane, fencingToken);
        await deleteDcsBranch(
          { baseUrl: this.env.DCS_BASE_URL, token: this.env.DCS_SERVICE_TOKEN!, owner, repo },
          b,
        );
      } catch (e) {
        if (e instanceof Error && e.message === "fencing_token_superseded") throw e;
        console.error("prune: branch delete failed", { repo, branch: b, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // Recover a conflicted export PR (updateDcsPrBranch 409). D1 is authoritative,
  // so rebuild the drifted branch as a clean child of CURRENT master carrying
  // the same already-rendered file, then re-open the PR. Reuses `content`
  // (already past the freshness + shrink gates in exportOne — never re-renders),
  // so this can't smuggle a stale/partial render past those guards. Gated on the
  // admin token (DCS_TOKEN); without it we can't delete the branch, so we just
  // alert and leave the conflicted PR for a human (today's behavior). Best-effort
  // throughout: any failure alerts rather than failing the export step (the
  // commit + snapshot already succeeded). Returns the new PR info to record, or
  // null when nothing changed. See docs/export-rebase-fix.md.
  private async recoverConflictedBranch(
    book: string,
    resource: Resource,
    owner: string,
    repo: string,
    branch: string,
    dcsCfg: { baseUrl: string; token: string; owner: string; repo: string; branch: string; baseRef?: string },
    filename: string,
    content: string,
    message: string,
    lane: LaneKey | null = null,
    fencingToken: string | null = null,
  ): Promise<{ prNumber: number | null; prReason: string; commitSha: string | null } | null> {
    const adminToken = this.env.DCS_TOKEN;
    if (!adminToken) {
      await this.recordPrConflictAlert(book, resource, repo, branch, "no_admin_token");
      return null;
    }
    try {
      await this.assertFencingOrThrow(lane, fencingToken);
      const res = await recreateExportBranchFromMaster({
        baseUrl: dcsCfg.baseUrl,
        token: adminToken,
        owner,
        repo,
        branch,
        baseRef: dcsCfg.baseRef,
        beforeMutation: fencingToken
          ? () => this.assertFencingOrThrow(lane, fencingToken)
          : undefined,
      });
      if (!res.rebuilt) {
        await this.recordPrConflictAlert(book, resource, repo, branch, res.detail);
        return null;
      }
      // Branch is now master HEAD. Re-commit the rendered D1 file (forceBranch:
      // we know it differs from master — that's what conflicted) → one commit,
      // child of master. The delete auto-closed the old PR, so ensureDcsPr mints
      // a fresh one whose diff is exactly the D1 delta.
      await this.assertFencingOrThrow(lane, fencingToken);
      const recommit = await commitToDcs(
        {
          ...dcsCfg,
          beforeMutation: fencingToken
            ? () => this.assertFencingOrThrow(lane, fencingToken)
            : undefined,
        },
        filename,
        content,
        message,
        { forceBranch: true },
      );
      await this.assertFencingOrThrow(lane, fencingToken);
      const pr = await ensureDcsPr(
        dcsCfg,
        `bible-editor: ${book} ${resource} → master`,
        `Rebuilt by the bible-editor nightly export: \`${branch}\` had drifted into a merge ` +
          `conflict with master, so it was recreated as a clean child of current master carrying ` +
          `the authoritative D1 render of ${book} ${resource.toUpperCase()}. Any rows present only on ` +
          `master (not in D1) are intentionally dropped — D1 is authoritative.`,
      );
      await this.recordBranchRebuiltAlert(book, resource, repo, branch, pr.number);
      return { prNumber: pr.number, prReason: `rebuilt:${pr.reason}`, commitSha: recommit.commitSha || null };
    } catch (e) {
      if (e instanceof Error && e.message === "fencing_token_superseded") throw e;
      const detail = e instanceof Error ? e.message : String(e);
      console.error("export conflict-recovery failed", { book, resource, repo, branch, error: detail });
      await this.recordPrConflictAlert(book, resource, repo, branch, detail.slice(0, 120));
      return null;
    }
  }

  private async recordSnapshot(
    book: string,
    resource: string,
    branch: string | null,
    commitSha: string | null,
    rowsExported: number,
    skippedReason: string | null,
    prNumber: number | null = null,
    prError: string | null = null,
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO export_snapshots (book, resource, branch, commit_sha, rows_exported, error, pr_number, pr_error)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(book, resource, branch, commitSha, rowsExported, skippedReason, prNumber, prError)
      .run();
  }

  // Banner alert when the freshness gate skips an export to avoid clobbering
  // master. Same replace-undismissed shape as recordPrFailureAlert.
  private async recordStaleSkipAlert(
    book: string,
    resource: Resource,
    masterSha: string | null,
    watermark: string | null,
  ): Promise<void> {
    const source = `export_stale:${book}:${resource}`;
    const message =
      `Benjamin — nightly export skipped ${book} ${resource.toUpperCase()} to avoid reverting master ` +
      `(D1 is behind: master ${(masterSha ?? "unknown").slice(0, 8)} vs synced ${(watermark ?? "none").slice(0, 8)}). ` +
      `The pre-export sync didn't catch up; re-run the sync for ${book}, then re-export.`;
    await this.writeAlert(source, message, await exportOwnerUrl(this.env));
  }

  // Fetch destination master's current TSV row count and decide whether this
  // render would shrink it dangerously (see export.ts exportTsvShrinkRefused).
  // Always reads the SAME owner/repo the commit will target.
  private async checkTsvShrink(
    book: string,
    resource: Resource,
    renderedRows: number,
    destOwner: string,
    destRepo: string,
    baseRef = "master",
  ): Promise<{ ok: boolean; detail: string; masterRows: number | null }> {
    const cfg = await getProjectConfig(this.env);
    const file = dcsResourceFile(cfg, book, resource as ReimportResource);
    if (!file) return { ok: true, detail: "no_file", masterRows: null };
    const raw = await fetchText(dcsRawUrl(this.env, destOwner, destRepo, file.path, baseRef));
    if (raw == null) return { ok: false, detail: "master_unreadable", masterRows: null };
    // Data rows = non-empty lines minus the header (mirrors parseTsv's model).
    const masterRows = Math.max(0, raw.split(/\r?\n/).filter((l) => l.length > 0).length - 1);
    if (exportTsvShrinkRefused(renderedRows, masterRows)) {
      return { ok: false, detail: `shrink_${masterRows - renderedRows}_of_${masterRows}`, masterRows };
    }
    return { ok: true, detail: "ok", masterRows };
  }

  // Fetch destination master's current USFM and decide whether this ULT/UST
  // render would silently drop \zaln word alignment. Always reads the SAME
  // owner/repo/ref the commit will target.
  private async checkUsfmAlignmentShrink(
    book: string,
    resource: Resource,
    renderedUsfm: string,
    destOwner: string,
    destRepo: string,
    baseRef = "master",
  ): Promise<{ ok: boolean; detail: string }> {
    const cfg = await getProjectConfig(this.env);
    const file = dcsResourceFile(cfg, book, resource as ReimportResource);
    if (!file) return { ok: true, detail: "no_file" };
    const masterUsfm = await fetchText(dcsRawUrl(this.env, destOwner, destRepo, file.path, baseRef));
    if (masterUsfm == null) return { ok: false, detail: "master_unreadable" };
    const result = usfmAlignmentShrinkRefused(renderedUsfm, masterUsfm);
    if (result.refused) {
      const sample = result.offenders
        .slice(0, 5)
        .map((o) => {
          const shown = o.lostWords.slice(0, 3).map((w) => `"${w}"`).join(",");
          const extra = o.lostWords.length - 3;
          const more = extra > 0 ? ` (+${extra} more)` : "";
          return `${o.ref}: lost alignment on ${shown}${more}`;
        })
        .join("; ");
      return { ok: false, detail: `align_loss_${result.offenders.length}:${sample}` };
    }
    return { ok: true, detail: "ok" };
  }

  /** Non-alignment body must match destination for textReadOnly lanes. */
  private async checkLockedTextEquality(
    book: string,
    resource: Resource,
    renderedUsfm: string,
    destOwner: string,
    destRepo: string,
    baseRef: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const cfg = await getProjectConfig(this.env);
    const file = dcsResourceFile(cfg, book, resource as ReimportResource);
    if (!file) return { ok: true, detail: "no_file" };
    const destUsfm = await fetchText(dcsRawUrl(this.env, destOwner, destRepo, file.path, baseRef));
    if (destUsfm == null) {
      // Fail closed: without a readable destination we cannot prove body equality.
      return { ok: false, detail: "dest_unreadable" };
    }
    return nonAlignmentUsfmEqual(renderedUsfm, destUsfm);
  }

  private async recordLockedTextDriftAlert(
    book: string,
    resource: Resource,
    detail: string,
  ): Promise<void> {
    const source = `export_locked_text:${book}:${resource}`;
    const message =
      `Benjamin — nightly export blocked ${book} ${resource.toUpperCase()}: textReadOnly lane ` +
      `body drifted from destination (${detail}). Alignment-only changes are fine; text rewrites are not.`;
    await this.writeAlert(source, message, await exportOwnerUrl(this.env));
  }

  // Freshness against the repo we will commit to. When source == export, use
  // book_resource_syncs watermarks. When they diverge, use
  // scripture_export_baselines for the export destination tip.
  private async checkMasterFreshness(
    book: string,
    resource: Resource,
    dest?: {
      owner: string;
      repo: string;
      baseRef?: string;
      lane?: LaneKey | null;
    },
  ): Promise<{ ok: boolean; detail: string; masterSha: string | null; watermark: string | null }> {
    const cfg = await getProjectConfig(this.env);
    const src = await resourceSourceRef(this.env, resource as ReimportResource, cfg);
    const file = dcsResourceFile(cfg, book, resource as ReimportResource);
    if (!file) return { ok: true, detail: "no_file", masterSha: null, watermark: null };
    const path = `${file.path}`;
    const destOwner = dest?.owner ?? src.owner;
    const destRepo = dest?.repo ?? src.repo;
    const baseRef = dest?.baseRef ?? src.ref;
    const sameIdentity =
      destOwner === src.owner && destRepo === src.repo && baseRef === src.ref;

    if (sameIdentity) {
      const watermark = await storedResourceSha(this.env, book, resource, src);
      if (!watermark) return { ok: true, detail: "no_watermark", masterSha: null, watermark: null };
      const masterSha = await fileCommitSha(this.env, src.owner, src.repo, path, src.ref);
      if (!masterSha) return { ok: false, detail: "master_sha_unknown", masterSha: null, watermark };
      if (masterSha === watermark) return { ok: true, detail: "current", masterSha, watermark };
      return { ok: false, detail: "master_ahead", masterSha, watermark };
    }

    // Export destination differs from source: fence on export baselines, not
    // the source watermark (which describes a different repo).
    const lane = dest?.lane ?? null;
    if (!lane) {
      // Non-scripture shouldn't hit diverge via laneExport; fail closed if it does.
      return { ok: false, detail: "export_dest_without_lane", masterSha: null, watermark: null };
    }
    const tipSha = await fileCommitSha(this.env, destOwner, destRepo, path, baseRef);
    const baseline = await this.env.DB.prepare(
      `SELECT base_sha FROM scripture_export_baselines
        WHERE lane = ?1 AND owner = ?2 AND repo = ?3 AND base_ref = ?4 AND book = ?5`,
    )
      .bind(lane, destOwner, destRepo, baseRef, book)
      .first<{ base_sha: string | null }>();
    const watermark = baseline?.base_sha ?? null;
    if (!watermark) {
      // First export: only safe when the destination file is absent. If tipSha
      // is set, the dest already has content we could clobber — refuse until a
      // baseline is explicitly recorded (or tip matches after a sync).
      if (tipSha) {
        return { ok: false, detail: "export_baseline_required", masterSha: tipSha, watermark: null };
      }
      return { ok: true, detail: "no_export_baseline", masterSha: tipSha, watermark: null };
    }
    if (!tipSha) return { ok: false, detail: "export_tip_unknown", masterSha: null, watermark };
    if (tipSha === watermark) return { ok: true, detail: "current", masterSha: tipSha, watermark };
    return { ok: false, detail: "export_ahead", masterSha: tipSha, watermark };
  }

  private async recordExportBaseline(
    lane: LaneKey,
    owner: string,
    repo: string,
    baseRef: string,
    book: string,
    baseSha: string | null,
  ): Promise<void> {
    if (!baseSha) return;
    await this.env.DB.prepare(
      `INSERT INTO scripture_export_baselines (lane, owner, repo, base_ref, book, base_sha, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch())
       ON CONFLICT(lane, owner, repo, base_ref, book) DO UPDATE SET
         base_sha = excluded.base_sha,
         updated_at = excluded.updated_at`,
    )
      .bind(lane, owner, repo, baseRef, book, baseSha)
      .run();
  }

  // Banner alert when the alignment-shrink backstop blocks an ULT/UST export to
  // avoid shipping a silent de-alignment to master. Same replace-undismissed
  // shape as recordShrinkSkipAlert.
  private async recordAlignmentShrinkSkipAlert(
    book: string,
    resource: Resource,
    detail: string,
  ): Promise<void> {
    const source = `export_align_shrink:${book}:${resource}`;
    const message =
      `Benjamin fix this — nightly export BLOCKED ${book} ${resource.toUpperCase()}: the render would drop \\zaln ` +
      `word alignment on verses whose text is UNCHANGED (${detail}). This is the 1CH 4:21 / NUM 24 collateral ` +
      `de-alignment signature — refusing to ship it to master. Re-align the affected verse(s) in the editor, then re-export.`;
    await this.writeAlert(source, message, await exportOwnerUrl(this.env));
  }

  // Banner alert when the shrink guard blocks an export to avoid mass-deleting
  // rows on master (the twl_PSA clobber signature). Same replace-undismissed
  // shape as recordStaleSkipAlert.
  private async recordShrinkSkipAlert(
    book: string,
    resource: Resource,
    renderedRows: number,
    masterRows: number | null,
    detail: string,
  ): Promise<void> {
    const source = `export_shrink:${book}:${resource}`;
    const message =
      `Benjamin — nightly export BLOCKED ${book} ${resource.toUpperCase()}: the render has ${renderedRows} rows ` +
      `but master has ${masterRows ?? "?"} (${detail}). This looks like an incomplete D1 load (truncated fetch), ` +
      `not a real deletion — refusing to shrink master. Re-sync ${book} ${resource.toUpperCase()} from master, ` +
      `verify the row count, then re-export.`;
    await this.writeAlert(source, message, await exportOwnerUrl(this.env));
  }

  // Banner alert when the pre-export sync for a book failed outright (e.g. the
  // Cloudflare subrequest cap). The export will skip any book left stale, so
  // this is the heads-up that a manual re-sync is needed.
  private async recordSyncFailureAlert(book: string, detail: string): Promise<void> {
    const source = `export_sync_fail:${book}`;
    const message =
      `Benjamin — nightly pre-export sync failed for ${book}: ${detail.slice(0, 160)}. ` +
      `Any book left behind master is skipped by the freshness gate (not reverted); re-sync ${book} and re-export.`;
    await this.writeAlert(source, message, await exportOwnerUrl(this.env));
  }

  // Replace-undismissed alert writer shared by the export-side alerts. Best
  // effort: an alert-write failure must never fail or retry the export.
  private async writeAlert(
    source: string,
    message: string,
    linkUrl: string,
    severity: "error" | "warning" | "info" = "error",
  ): Promise<void> {
    try {
      await this.env.DB.prepare(
        `DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
      )
        .bind(EXPORT_ALERT_USERNAME, source)
        .run();
      await this.env.DB.prepare(
        `INSERT INTO system_alerts (username, severity, source, message, link_url)
         VALUES (?1, ?5, ?2, ?3, ?4)`,
      )
        .bind(EXPORT_ALERT_USERNAME, source, message, linkUrl, severity)
        .run();
    } catch (e) {
      console.error("export alert write failed", { source, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Surface a PR-ensure failure as a banner alert (the SPA polls
  // GET /api/alerts/me). Same shape as postExport.recordFailureAlert: replace
  // any undismissed alert for the same source so consecutive failures don't
  // pile up. Best-effort — an alert-write failure must not fail the step.
  private async recordPrFailureAlert(
    book: string,
    resource: Resource | ArticleResource,
    repo: string,
    branch: string,
    detail: string,
  ): Promise<void> {
    const source = `export_pr:${repo}`;
    const message = `Benjamin fix this — nightly export couldn't ensure a PR for ${book} ${resource} (\`${branch}\` on ${repo}): ${detail.slice(0, 160)}`;
    const linkUrl = `${await exportOwnerUrl(this.env)}/${repo}/pulls`;
    try {
      await this.env.DB.prepare(
        `DELETE FROM system_alerts
          WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
      )
        .bind(EXPORT_ALERT_USERNAME, source)
        .run();
      await this.env.DB.prepare(
        `INSERT INTO system_alerts (username, severity, source, message, link_url)
         VALUES (?1, 'error', ?2, ?3, ?4)`,
      )
        .bind(EXPORT_ALERT_USERNAME, source, message, linkUrl)
        .run();
    } catch (e) {
      console.error("export PR alert write failed", {
        book, resource, repo, error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Error banner when an export PR conflicted but we could NOT auto-recover —
  // no admin token, the delete was forbidden, or the rebuild threw. The PR is
  // left mergeable:false for a human to reconcile (today's behavior).
  private async recordPrConflictAlert(
    book: string,
    resource: Resource,
    repo: string,
    branch: string,
    detail: string,
  ): Promise<void> {
    const source = `export_conflict:${repo}:${book}:${resource}`;
    const message =
      `Benjamin fix this — nightly export PR for ${book} ${resource.toUpperCase()} (\`${branch}\` on ${repo}) ` +
      `is in merge conflict with master and could NOT be auto-rebuilt (${detail}). Reconcile by hand ` +
      `(merge master, \`git checkout --ours\` the file = D1's render, push), or provision DCS_TOKEN so the ` +
      `export can rebuild the branch automatically.`;
    const linkUrl = `${await exportOwnerUrl(this.env)}/${repo}/pulls`;
    await this.writeAlert(source, message, linkUrl, "error");
  }

  // Informational banner when an export PR conflict WAS auto-recovered by
  // rebuilding the branch off master. Surfaces (rather than silently swallows)
  // the D1-authoritative resolution so Benjamin can eyeball the rebuilt PR diff
  // and confirm any master-only rows that got dropped were meant to go.
  private async recordBranchRebuiltAlert(
    book: string,
    resource: Resource,
    repo: string,
    branch: string,
    prNumber: number | null,
  ): Promise<void> {
    const source = `export_rebuilt:${repo}:${book}:${resource}`;
    const prRef = prNumber != null ? `#${prNumber}` : "(PR pending)";
    const message =
      `Heads up — nightly export rebuilt \`${branch}\` (${book} ${resource.toUpperCase()} on ${repo}) onto ` +
      `current master to clear a merge conflict; D1's render is authoritative. Eyeball PR ${prRef} to confirm ` +
      `any master-only rows dropped were intended.`;
    const linkUrl = `${await exportOwnerUrl(this.env)}/${repo}/pulls`;
    await this.writeAlert(source, message, linkUrl, "warning");
  }
}
