// PR B: the PUT /api/project-config apply path, factored out of
// projectConfigRoutes.ts so its guards (custom-gl completeness, empty-project
// tenancy, override lifecycle, atomic config+lane commit) are independently
// testable under node:sqlite (see projectConfigApply.test.mjs).
//
// Atomicity: config row write + BOTH lanes' fenced pointer/metadata updates
// commit in ONE D1 batch. A fenced UPDATE matching zero rows is still
// SUCCESSFUL SQL — D1 would happily commit the rest of the batch — so every
// fenced lane UPDATE is paired with a guard statement that RAISES when the
// UPDATE did not apply as planned (CAS mismatch: a concurrent lease/job/
// revision change between planning and commit). The guard is a CHECK-
// violating conditional INSERT into `_abort_guard` (migration 0051) — the
// same technique PR A uses for its config-change fence in article_units.
// Replacements (actual content re-sync) still run through the existing async
// replacement flow AFTER this commit; what's atomic here is config + lane
// POINTER/METADATA state, matching the plan's scope.

import type { Env } from "./index";
import { PRESETS, DEFAULT_PRESET, materialize, clearProjectConfigCache, exportOwnerFor, type ProjectConfig, type ResourceKey } from "./projectConfig.ts";
import { isIdent } from "./repoUrl.ts";
import {
  configHash,
  desiredLaneConfig,
  planLaneReconcile,
  parseLaneConfig,
  ensureLaneState,
  getLaneState,
  bibleVersionForLane,
  type LaneKey,
} from "./scriptureLane.ts";

const RESOURCE_KEYS: ResourceKey[] = ["lit", "sim", "tn", "tq", "twl", "tw", "ta"];

// ── Validation ───────────────────────────────────────────────────────────────

export type ValidationResult = { ok: true } | { ok: false; error: string; detail?: unknown };

/**
 * custom-gl completeness + isIdent guard: org, exportOrg, all seven repos, and
 * every nested translationSource repo must be PRESENT and isIdent-VALID
 * ("non-empty" is insufficient for URL-building values — a value like
 * "../foo" or an empty string would corrupt every dcsUrls()/dcsRawUrl() call
 * built from it). translationSource must be explicitly an object or `null`
 * (the key must be present — custom-gl has no preset default to fall back
 * on). lit repo must differ from sim repo.
 */
export function validateCustomGlOverrides(
  overrides: Record<string, unknown> | null | undefined,
): ValidationResult {
  if (!overrides || typeof overrides !== "object") {
    return { ok: false, error: "custom_gl_incomplete" };
  }
  const o = overrides;
  if (typeof o.org !== "string" || !isIdent(o.org)) {
    return { ok: false, error: "custom_gl_invalid_org" };
  }
  if (typeof o.exportOrg !== "string" || !isIdent(o.exportOrg)) {
    return { ok: false, error: "custom_gl_invalid_export_org" };
  }
  const repos = o.repos;
  if (!repos || typeof repos !== "object") {
    return { ok: false, error: "custom_gl_missing_repos" };
  }
  const r = repos as Record<string, unknown>;
  for (const key of RESOURCE_KEYS) {
    const v = r[key];
    if (typeof v !== "string" || !isIdent(v)) {
      return { ok: false, error: "custom_gl_invalid_repo", detail: { role: key } };
    }
  }
  if (r.lit === r.sim) {
    return { ok: false, error: "custom_gl_lit_sim_conflict" };
  }
  if (!("translationSource" in o)) {
    return { ok: false, error: "custom_gl_missing_translation_source" };
  }
  const ts = o.translationSource;
  if (ts !== null) {
    if (!ts || typeof ts !== "object") {
      return { ok: false, error: "custom_gl_invalid_translation_source" };
    }
    const tsObj = ts as Record<string, unknown>;
    if (typeof tsObj.org !== "string" || !isIdent(tsObj.org)) {
      return { ok: false, error: "custom_gl_invalid_translation_source" };
    }
    if (typeof tsObj.languageCode !== "string" || tsObj.languageCode.trim() === "") {
      return { ok: false, error: "custom_gl_invalid_translation_source" };
    }
    const tsRepos = tsObj.repos;
    if (!tsRepos || typeof tsRepos !== "object") {
      return { ok: false, error: "custom_gl_invalid_translation_source" };
    }
    const tr = tsRepos as Record<string, unknown>;
    for (const key of RESOURCE_KEYS) {
      const v = tr[key];
      if (typeof v !== "string" || !isIdent(v)) {
        return { ok: false, error: "custom_gl_invalid_translation_source", detail: { role: key } };
      }
    }
  }
  return { ok: true };
}

// ── Override lifecycle ───────────────────────────────────────────────────────

/**
 * Three-value override intent for writeProjectConfig-style semantics:
 *   undefined → PRESERVE existing overrides_json
 *   null      → CLEAR overrides
 *   object    → REPLACE overrides
 *
 * Decision: switching to a DIFFERENT preset clears stored overrides unless
 * the PUT explicitly supplies new ones (a bare "switch preset" call must not
 * carry a previous custom org's repos onto the new preset). A same-preset PUT
 * keeps the pre-existing three-intent merge untouched.
 */
export function resolveOverridesIntent(
  currentPreset: string,
  desiredPreset: string,
  requestOverrides: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (requestOverrides !== undefined) return requestOverrides;
  if (currentPreset !== desiredPreset) return null;
  return undefined;
}

// ── Empty-project (tenancy) guard ───────────────────────────────────────────

// Non-lane resource repos whose change repoints EXISTING D1 rows (tn/tq/twl
// rows, article_units) or their exports at a different DCS repo. lit/sim are
// deliberately excluded — scripture-source changes are the lane-replacement
// flow's job, not a hard tenancy stop.
const NON_LANE_REPO_KEYS: ResourceKey[] = ["tn", "tq", "twl", "tw", "ta"];

/**
 * The effective data/export identity of a config: the org, the resolved export
 * owner, and the non-lane repo mapping. A change to ANY of these on a populated
 * D1 would repoint existing content or its export target — the one-org-per-
 * database tenancy model treats that as a hard stop, not just a bare `org`
 * rename. (A bare `org` check misses custom-gl PUTs that keep `org` but change
 * `exportOrg` or a non-lane repo.)
 */
export function dataExportIdentity(
  env: { DCS_EXPORT_OWNER?: string },
  cfg: ProjectConfig,
): string {
  const repos = NON_LANE_REPO_KEYS.map((k) => `${k}=${cfg.repos[k] ?? ""}`).join(",");
  return `org=${cfg.org}|export=${exportOwnerFor(env, cfg)}|${repos}`;
}

/**
 * True when the D1 already holds project data: any live (non-soft-deleted)
 * rows in tn_rows / tq_rows / twl_rows / article_units, or any verses row at
 * all (verses have no soft-delete — generation replacement is how content
 * changes there). Re-pointing a populated D1 at a new org would let old
 * content export into the new org — the one-org-per-database tenancy model
 * treats this as a hard stop, not a merge.
 */
export async function hasLiveProjectData(env: Env): Promise<boolean> {
  try {
    const row = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM tn_rows WHERE deleted_at IS NULL) +
           (SELECT COUNT(*) FROM tq_rows WHERE deleted_at IS NULL) +
           (SELECT COUNT(*) FROM twl_rows WHERE deleted_at IS NULL) +
           (SELECT COUNT(*) FROM verses) +
           (SELECT COUNT(*) FROM article_units WHERE deleted_at IS NULL) AS n`,
      )
      .first<{ n: number }>();
    return (row?.n ?? 0) > 0;
  } catch {
    // Missing table (pre-migration) — nothing to protect.
    return false;
  }
}

// ── Direct (uncached) config row read ───────────────────────────────────────

export interface ConfigRow {
  preset: string;
  overrides_json: string | null;
}

export async function readConfigRowUncached(env: Env): Promise<ConfigRow | null> {
  try {
    return await env.DB
      .prepare("SELECT preset, overrides_json FROM project_config WHERE id = 1")
      .first<ConfigRow>();
  } catch {
    return null;
  }
}

// ── Lane plan ────────────────────────────────────────────────────────────────

export interface LaneCommitPlan {
  lane: LaneKey;
  needsUpdate: boolean;
  action?: "install" | "quarantine";
  activeConfigJson?: string;
  replacementRequired?: 0 | 1;
  pendingTargetJson?: string | null;
  exportsBlocked?: 0 | 1;
  capturedRevision: number;
}

/** Build the per-lane plan (pure given the inputs — no I/O). */
export function planLaneCommit(
  lane: LaneKey,
  currentActiveConfigJson: string,
  capturedRevision: number,
  desiredCfg: ProjectConfig,
  verseCount: number,
): LaneCommitPlan {
  const current = parseLaneConfig(currentActiveConfigJson);
  const desired = desiredLaneConfig(desiredCfg, lane);
  if (configHash(current) === configHash(desired)) {
    return { lane, needsUpdate: false, capturedRevision };
  }
  const plan = planLaneReconcile(current, desired, verseCount);
  if (plan.action === "install") {
    return {
      lane,
      needsUpdate: true,
      action: "install",
      activeConfigJson: JSON.stringify(plan.config),
      replacementRequired: 0,
      pendingTargetJson: null,
      exportsBlocked: 0,
      capturedRevision,
    };
  }
  return {
    lane,
    needsUpdate: true,
    action: "quarantine",
    activeConfigJson: JSON.stringify(plan.provenance),
    replacementRequired: 1,
    pendingTargetJson: JSON.stringify(plan.pending),
    exportsBlocked: 1,
    capturedRevision,
  };
}

// ── Statement builders (exported for the executable SQL test) ──────────────

export function configWriteStmt(env: Env, preset: string, overridesJson: string | null): D1PreparedStatement {
  return env.DB
    .prepare(
      `INSERT INTO project_config (id, preset, overrides_json, updated_at)
       VALUES (1, ?1, ?2, unixepoch())
       ON CONFLICT(id) DO UPDATE SET preset = excluded.preset,
         overrides_json = excluded.overrides_json, updated_at = excluded.updated_at`,
    )
    .bind(preset, overridesJson);
}

export function laneUpdateStmt(env: Env, plan: LaneCommitPlan): D1PreparedStatement {
  return env.DB
    .prepare(
      `UPDATE scripture_lane_state SET
         active_config_json = ?2,
         config_revision = config_revision + 1,
         replacement_required = ?3,
         pending_target_json = ?4,
         exports_blocked = ?5,
         updated_at = unixepoch()
       WHERE lane = ?1
         AND replacement_job_id IS NULL
         AND exclusive_owner IS NULL
         AND config_revision = ?6`,
    )
    .bind(
      plan.lane,
      plan.activeConfigJson,
      plan.replacementRequired,
      plan.pendingTargetJson,
      plan.exportsBlocked,
      plan.capturedRevision,
    );
}

/**
 * The in-batch abort guard for one lane's CAS. When the lane update above did
 * NOT apply as planned — a concurrent lease/job acquisition, or someone else's
 * revision bump, landed between planning and this batch's execution — the
 * row's config_revision will NOT equal capturedRevision+1 (or job/owner will
 * be non-NULL again). The guard's WHERE NOT EXISTS then holds, the INSERT
 * fires, and `_abort_guard`'s unconditional CHECK(1=0) rolls back the WHOLE
 * batch (config write included).
 */
export function laneGuardStmt(env: Env, plan: LaneCommitPlan): D1PreparedStatement {
  return env.DB
    .prepare(
      `INSERT INTO _abort_guard (reason)
       SELECT 'lane_cas_failed' WHERE NOT EXISTS (
         SELECT 1 FROM scripture_lane_state
          WHERE lane = ?1 AND config_revision = ?2
            AND replacement_job_id IS NULL AND exclusive_owner IS NULL
       )`,
    )
    .bind(plan.lane, plan.capturedRevision + 1);
}

export function isAbortError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /constraint/i.test(msg);
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export type ApplyResult =
  | { ok: true; config: ProjectConfig }
  | { ok: false; status: 400 | 409; error: string; detail?: unknown };

export async function applyProjectConfig(
  env: Env,
  preset: string,
  requestOverrides: Record<string, unknown> | null | undefined,
): Promise<ApplyResult> {
  if (!PRESETS[preset]) return { ok: false, status: 400, error: "unknown_preset" };

  if (preset === "custom-gl") {
    const v = validateCustomGlOverrides(requestOverrides);
    if (!v.ok) return { ok: false, status: 400, error: v.error, detail: v.detail };
  }

  const beforeRow = await readConfigRowUncached(env);
  const currentPreset = beforeRow?.preset ?? DEFAULT_PRESET;
  const beforeCfg = materialize(currentPreset, beforeRow?.overrides_json ?? null);

  const overridesIntent = resolveOverridesIntent(currentPreset, preset, requestOverrides);
  const overridesJsonForWrite =
    overridesIntent === undefined
      ? (beforeRow?.overrides_json ?? null)
      : overridesIntent
        ? JSON.stringify(overridesIntent)
        : null;
  const desiredCfg = materialize(preset, overridesJsonForWrite);

  // Empty-project (tenancy) guard: applies to EVERY effective data/export
  // identity change, however it arises (named-preset switch, custom-gl
  // activation, or an override on the same preset that changes org, exportOrg,
  // or a non-lane repo). A bare `org` comparison would miss a custom-gl PUT
  // that keeps `org` but repoints `exportOrg` or a tn/tq/twl/tw/ta repo — which
  // would silently redirect existing rows / exports at a different target.
  if (dataExportIdentity(env, beforeCfg) !== dataExportIdentity(env, desiredCfg)) {
    if (await hasLiveProjectData(env)) {
      return { ok: false, status: 409, error: "project_not_empty" };
    }
  }

  await ensureLaneState(env);
  const plans: LaneCommitPlan[] = [];
  for (const lane of ["lit", "sim"] as LaneKey[]) {
    const row = await getLaneState(env, lane);
    if (!row) return { ok: false, status: 409, error: "lane_state_missing" };
    if (row.replacement_job_id || row.exclusive_owner) {
      return { ok: false, status: 409, error: "lane_busy", detail: { lane } };
    }
    const bv = bibleVersionForLane(lane);
    let verseCount = 0;
    try {
      const countRow = await env.DB
        .prepare(`SELECT COUNT(*) AS n FROM verses WHERE bible_version = ?1`)
        .bind(bv)
        .first<{ n: number }>();
      verseCount = countRow?.n ?? 0;
    } catch {
      verseCount = 0;
    }
    plans.push(planLaneCommit(lane, row.active_config_json, row.config_revision, desiredCfg, verseCount));
  }

  const stmts: D1PreparedStatement[] = [configWriteStmt(env, preset, overridesJsonForWrite)];
  for (const plan of plans) {
    if (!plan.needsUpdate) continue;
    stmts.push(laneUpdateStmt(env, plan));
    stmts.push(laneGuardStmt(env, plan));
  }

  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (isAbortError(e)) return { ok: false, status: 409, error: "lane_conflict" };
    throw e;
  }
  clearProjectConfigCache();
  return { ok: true, config: desiredCfg };
}
