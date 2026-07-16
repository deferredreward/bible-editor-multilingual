// Authoritative per-lane scripture state: generations, freezes, permissions.
// Generation / locks / write guards ALWAYS read D1 directly — never the
// 60s project-config isolate cache.

import type { Env } from "./index";
import type { ProjectConfig } from "./projectConfig.ts";
import { getProjectConfig, PRESETS } from "./projectConfig.ts";
import type { RepoRef } from "./repoUrl.ts";

export type LaneKey = "lit" | "sim";

export interface LaneExport {
  owner: string;
  repo: string;
  baseRef: string;
  branchPolicy: "contributor_book_branch";
}

export interface ScriptureLaneConfig {
  label: string;
  source: RepoRef;
  export: LaneExport | null;
  textReadOnly: boolean;
  alignmentWritable: boolean;
}

export interface LaneStateRow {
  lane: LaneKey;
  active_generation: number;
  next_generation: number;
  active_config_json: string;
  config_revision: number;
  replacement_job_id: string | null;
  /** Mutual-exclusion token: `lease:<id>` or `job:<id>`. NULL when free. */
  exclusive_owner: string | null;
  exports_blocked: number;
  replacement_required: number;
  pending_target_json: string | null;
  updated_at: number;
}

export function bibleVersionForLane(lane: LaneKey): "ULT" | "UST" {
  return lane === "lit" ? "ULT" : "UST";
}

export function laneForBibleVersion(bv: string): LaneKey | null {
  const u = bv.toUpperCase();
  if (u === "ULT") return "lit";
  if (u === "UST") return "sim";
  return null;
}

export function defaultLaneConfig(cfg: ProjectConfig, lane: LaneKey): ScriptureLaneConfig {
  const repo = lane === "lit" ? cfg.repos.lit : cfg.repos.sim;
  const label = lane === "lit" ? cfg.litLabel : cfg.simLabel;
  const source: RepoRef = { owner: cfg.org, repo, ref: "master" };
  const textReadOnly = Boolean((cfg as ProjectConfig & { laneTextReadOnly?: Partial<Record<LaneKey, boolean>> }).laneTextReadOnly?.[lane])
    || (cfg.preset === "ar-bsoj");
  // BSOJ AVD/NAV: text locked, alignment writable. Other presets fully editable.
  const alignmentWritable = true;
  const exportTarget: LaneExport | null = {
    owner: cfg.exportOrg || cfg.org,
    repo,
    baseRef: "master",
    branchPolicy: "contributor_book_branch",
  };
  // Locked text (e.g. AVD/NAV): force export destination == source so the
  // nightly path never commits to a divergent fork without a text-equality gate.
  const exportCfg: LaneExport | null = textReadOnly
    ? {
        owner: source.owner,
        repo: source.repo,
        baseRef: source.ref,
        branchPolicy: "contributor_book_branch",
      }
    : exportTarget;
  return {
    label,
    source,
    export: exportCfg,
    textReadOnly,
    alignmentWritable: textReadOnly ? true : alignmentWritable,
  };
}

/** Correct BSOJ preset lane configs (AVD/NAV). */
export function bsojLaneConfig(lane: LaneKey): ScriptureLaneConfig {
  if (lane === "lit") {
    return {
      label: "AVD",
      source: { owner: "BSOJ", repo: "ar_avd", ref: "master" },
      export: { owner: "BSOJ", repo: "ar_avd", baseRef: "master", branchPolicy: "contributor_book_branch" },
      textReadOnly: true,
      alignmentWritable: true,
    };
  }
  return {
    label: "NAV",
    source: { owner: "BSOJ", repo: "ar_nav", ref: "master" },
    export: { owner: "BSOJ", repo: "ar_nav", baseRef: "master", branchPolicy: "contributor_book_branch" },
    textReadOnly: true,
    alignmentWritable: true,
  };
}

export function parseLaneConfig(json: string): ScriptureLaneConfig {
  return JSON.parse(json) as ScriptureLaneConfig;
}

export function configHash(cfg: ScriptureLaneConfig): string {
  return JSON.stringify({
    label: cfg.label,
    source: cfg.source,
    export: cfg.export,
    textReadOnly: cfg.textReadOnly,
    alignmentWritable: cfg.alignmentWritable,
  });
}

export async function getLaneState(env: Env, lane: LaneKey): Promise<LaneStateRow | null> {
  try {
    return await env.DB
      .prepare(`SELECT * FROM scripture_lane_state WHERE lane = ?1`)
      .bind(lane)
      .first<LaneStateRow>();
  } catch {
    return null;
  }
}

/**
 * Ensure both lanes have rows. For ar-bsoj with existing ULT/UST verses,
 * sets replacement_required and stores mandatory AVD/NAV pending target;
 * active_config stays as provenance for quarantined gen-1 and reads are blocked.
 */
/** Canonical active config for a lane under the given project preset. */
export function desiredLaneConfig(cfg: ProjectConfig, lane: LaneKey): ScriptureLaneConfig {
  return cfg.preset === "ar-bsoj" ? bsojLaneConfig(lane) : defaultLaneConfig(cfg, lane);
}

export function sameLaneSource(a: ScriptureLaneConfig, b: ScriptureLaneConfig): boolean {
  return (
    a.source.owner === b.source.owner &&
    a.source.repo === b.source.repo &&
    (a.source.ref || "master") === (b.source.ref || "master")
  );
}

export type LaneReconcilePlan =
  | { action: "install"; config: ScriptureLaneConfig }
  | { action: "quarantine"; provenance: ScriptureLaneConfig; pending: ScriptureLaneConfig };

/**
 * Decide how an existing lane row should look after a project-preset change.
 * Content under a mismatched source identity must not silently keep serving
 * (or advertise) the previous org's repos — force replacement into `desired`.
 */
export function planLaneReconcile(
  current: ScriptureLaneConfig,
  desired: ScriptureLaneConfig,
  verseCount: number,
): LaneReconcilePlan {
  if (verseCount === 0 || sameLaneSource(current, desired)) {
    return { action: "install", config: desired };
  }
  return {
    action: "quarantine",
    provenance: {
      label: "LEGACY",
      source: current.source,
      export: null,
      textReadOnly: true,
      alignmentWritable: false,
    },
    pending: desired,
  };
}

export async function ensureLaneState(env: Env): Promise<void> {
  const cfg = await getProjectConfig(env);
  for (const lane of ["lit", "sim"] as LaneKey[]) {
    const existing = await getLaneState(env, lane);
    if (existing) continue;

    const bv = bibleVersionForLane(lane);
    let verseCount = 0;
    try {
      const row = await env.DB
        .prepare(
          `SELECT COUNT(*) AS n FROM verses
            WHERE bible_version = ?1 AND source_generation = 1`,
        )
        .bind(bv)
        .first<{ n: number }>();
      verseCount = row?.n ?? 0;
    } catch {
      // pre-migration / empty
    }

    let activeCfg: ScriptureLaneConfig;
    let replacementRequired = 0;
    let pendingTarget: string | null = null;
    let exportsBlocked = 0;

    if (cfg.preset === "ar-bsoj") {
      const correct = bsojLaneConfig(lane);
      if (verseCount > 0) {
        // Populated under wrong glt/gst: quarantine gen-1; do not activate AVD/NAV yet.
        activeCfg = {
          label: "LEGACY",
          source: { owner: "BSOJ", repo: lane === "lit" ? "ar_glt" : "ar_gst", ref: "master" },
          export: null,
          textReadOnly: true,
          alignmentWritable: false,
        };
        replacementRequired = 1;
        pendingTarget = JSON.stringify(correct);
        exportsBlocked = 1;
      } else {
        activeCfg = correct;
      }
    } else {
      activeCfg = defaultLaneConfig(cfg, lane);
    }

    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO scripture_lane_state (
           lane, active_generation, next_generation, active_config_json,
           config_revision, replacement_job_id, exports_blocked,
           replacement_required, pending_target_json, updated_at
         ) VALUES (?1, 1, 2, ?2, 1, NULL, ?3, ?4, ?5, unixepoch())`,
      )
      .bind(lane, JSON.stringify(activeCfg), exportsBlocked, replacementRequired, pendingTarget)
      .run();
  }
}

/**
 * Rewrite both lane rows to match `cfg` after an admin project-mode switch.
 * `ensureLaneState` only INSERT OR IGNOREs — without this, the first preset's
 * quarantine (e.g. BSOJ LEGACY glt/gst + AVD/NAV pending) sticks forever and
 * surfaces under every later preset.
 *
 * Throws `lane_busy:<lane>` when a replacement job or exclusive lease is held.
 */
export async function reconcileLaneStateForPreset(env: Env, cfg: ProjectConfig): Promise<void> {
  await ensureLaneState(env);
  for (const lane of ["lit", "sim"] as LaneKey[]) {
    const row = await getLaneState(env, lane);
    if (!row) throw new Error(`lane_state_missing:${lane}`);
    if (row.replacement_job_id || row.exclusive_owner) {
      throw new Error(`lane_busy:${lane}`);
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

    const current = parseLaneConfig(row.active_config_json);
    const desired = desiredLaneConfig(cfg, lane);
    const plan = planLaneReconcile(current, desired, verseCount);

    if (plan.action === "install") {
      await env.DB
        .prepare(
          `UPDATE scripture_lane_state SET
             active_config_json = ?2,
             config_revision = config_revision + 1,
             replacement_required = 0,
             pending_target_json = NULL,
             exports_blocked = 0,
             updated_at = unixepoch()
           WHERE lane = ?1
             AND replacement_job_id IS NULL
             AND exclusive_owner IS NULL`,
        )
        .bind(lane, JSON.stringify(plan.config))
        .run();
    } else {
      await env.DB
        .prepare(
          `UPDATE scripture_lane_state SET
             active_config_json = ?2,
             config_revision = config_revision + 1,
             replacement_required = 1,
             pending_target_json = ?3,
             exports_blocked = 1,
             updated_at = unixepoch()
           WHERE lane = ?1
             AND replacement_job_id IS NULL
             AND exclusive_owner IS NULL`,
        )
        .bind(lane, JSON.stringify(plan.provenance), JSON.stringify(plan.pending))
        .run();
    }

    const after = await getLaneState(env, lane);
    if (
      !after ||
      after.replacement_job_id ||
      after.exclusive_owner ||
      (plan.action === "install" && after.replacement_required) ||
      (plan.action === "quarantine" && !after.replacement_required)
    ) {
      // Lost the race to a lease/job, or UPDATE matched 0 rows.
      throw new Error(`lane_busy:${lane}`);
    }
  }
}

export async function requireLaneState(env: Env, lane: LaneKey): Promise<LaneStateRow> {
  await ensureLaneState(env);
  const row = await getLaneState(env, lane);
  if (!row) throw new Error(`lane_state_missing:${lane}`);
  return row;
}

/**
 * Clear a lane freeze whose replacement_job_id points at a missing
 * scripture_lane_replacement row (Worker died between CAS freeze and job
 * INSERT). Only reclaim after a grace window so a live startReplacement that
 * has frozen but not yet inserted its job row is not cleared mid-flight.
 * Returns true when an orphan was cleared.
 */
export const ORPHAN_RESERVATION_GRACE_SECONDS = 60;

export async function recoverOrphanedReservation(
  env: Env,
  lane: LaneKey,
): Promise<boolean> {
  const row = await getLaneState(env, lane);
  if (!row?.replacement_job_id) return false;
  const job = await env.DB.prepare(
    `SELECT 1 AS ok FROM scripture_lane_replacement WHERE job_id = ?1`,
  )
    .bind(row.replacement_job_id)
    .first();
  if (job) return false;
  // Grace: freeze bumps updated_at; do not reclaim during the legitimate
  // gap between CAS freeze and job INSERT.
  const age = Math.floor(Date.now() / 1000) - (row.updated_at ?? 0);
  if (age < ORPHAN_RESERVATION_GRACE_SECONDS) return false;
  await env.DB.prepare(
    `UPDATE scripture_lane_state
        SET replacement_job_id = NULL,
            exclusive_owner = NULL,
            exports_blocked = CASE WHEN replacement_required = 1 THEN 1 ELSE 0 END,
            updated_at = unixepoch()
      WHERE lane = ?1 AND replacement_job_id = ?2
        AND updated_at <= unixepoch() - ?3`,
  )
    .bind(lane, row.replacement_job_id, ORPHAN_RESERVATION_GRACE_SECONDS)
    .run();
  return true;
}

export function activeLaneConfig(row: LaneStateRow): ScriptureLaneConfig {
  return parseLaneConfig(row.active_config_json);
}

export type LaneWriteGate = {
  ok: true;
  generation: number;
  config: ScriptureLaneConfig;
  configRevision: number;
} | {
  ok: false;
  error: string;
  status: 403 | 409;
  detail?: Record<string, unknown>;
}

/** Uncached D1 write guard for verse / pipeline / import / export mutation. */
export async function assertLaneWritable(
  env: Env,
  lane: LaneKey,
  purpose: "verse_edit" | "alignment_edit" | "import" | "reimport" | "pipeline" | "export_lease" | "config_patch",
): Promise<LaneWriteGate> {
  // Heal an orphan freeze before treating the lane as frozen.
  await recoverOrphanedReservation(env, lane);

  const row = await requireLaneState(env, lane);
  const config = activeLaneConfig(row);

  if (row.replacement_required && purpose !== "config_patch") {
    // Only the replacement workflow may proceed; block normal mutations/reads side-channels.
    if (purpose !== "import") {
      return {
        ok: false,
        error: "lane_replacement_required",
        status: 409,
        detail: { lane, pendingTarget: row.pending_target_json },
      };
    }
  }

  if (row.replacement_job_id) {
    return {
      ok: false,
      error: "lane_replacement_in_progress",
      status: 409,
      detail: { lane, jobId: row.replacement_job_id },
    };
  }

  if (row.exports_blocked && purpose === "export_lease") {
    return { ok: false, error: "exports_blocked", status: 409, detail: { lane } };
  }

  // Interactive text edits AND AI pipeline writes that change verse content both
  // honor textReadOnly. Pipelines that would rewrite AVD/NAV body text must not
  // bypass the lock matrix (alignment-only lanes stay alignmentWritable-gated).
  if ((purpose === "verse_edit" || purpose === "pipeline") && config.textReadOnly) {
    return { ok: false, error: "scripture_text_read_only", status: 403, detail: { lane, repo: repoRefKey(config) } };
  }
  if (purpose === "alignment_edit" && !config.alignmentWritable) {
    return { ok: false, error: "scripture_alignment_read_only", status: 403, detail: { lane } };
  }
  if ((purpose === "verse_edit" || purpose === "alignment_edit") && config.textReadOnly && !config.alignmentWritable) {
    return { ok: false, error: "scripture_fully_locked", status: 403, detail: { lane } };
  }

  return {
    ok: true,
    generation: row.active_generation,
    config,
    configRevision: row.config_revision,
  };
}

function repoRefKey(cfg: ScriptureLaneConfig): string {
  return `${cfg.source.owner}/${cfg.source.repo}`;
}

/** Permission matrix check for a PATCH intent. */
export function allowVersePatch(
  config: ScriptureLaneConfig,
  intent: "text_edit" | "find_replace" | "section_edit" | "alignment_edit",
): { ok: true } | { ok: false; error: string } {
  const { textReadOnly, alignmentWritable } = config;
  if (!textReadOnly && alignmentWritable) return { ok: true };
  if (textReadOnly && alignmentWritable) {
    if (intent === "alignment_edit") return { ok: true };
    return { ok: false, error: "scripture_text_read_only" };
  }
  if (!textReadOnly && !alignmentWritable) {
    if (intent === "alignment_edit") return { ok: false, error: "scripture_alignment_read_only" };
    return { ok: true };
  }
  // text locked + alignment locked
  return { ok: false, error: "scripture_fully_locked" };
}

/**
 * SQL fragment helper: verses for active generation of a lane bible_version.
 * Caller must bind bible_version and generation.
 */
export function activeVersesWhere(alias = "v"): string {
  return `${alias}.source_generation = ?`;
}

export async function activeGenerationForBibleVersion(
  env: Env,
  bibleVersion: string,
): Promise<number | null> {
  const lane = laneForBibleVersion(bibleVersion);
  if (!lane) return null; // UHB/UGNT — no lane generation (use 1 sentinel for OL)
  const row = await requireLaneState(env, lane);
  if (row.replacement_required) return null; // blocked reads
  return row.active_generation;
}

/** For OL (UHB/UGNT) we store generation 1 always. */
export function origSourceGeneration(): number {
  return 1;
}

export async function allocateGeneration(env: Env, lane: LaneKey): Promise<number> {
  // next_generation = next FREE. Increment and return the previous value in a
  // single atomic statement — a separate UPDATE + SELECT can race two callers
  // onto the same generation. D1/SQLite (>=3.35) supports UPDATE … RETURNING.
  const row = await env.DB
    .prepare(
      `UPDATE scripture_lane_state
          SET next_generation = next_generation + 1, updated_at = unixepoch()
        WHERE lane = ?1
        RETURNING next_generation`,
    )
    .bind(lane)
    .first<{ next_generation: number }>();
  if (!row) throw new Error(`lane_state_missing:${lane}`);
  return row.next_generation - 1;
}

export async function snapshotRequiredBooks(
  env: Env,
  bibleVersion: string,
  generation: number,
): Promise<{ books: string[] }> {
  const verses = await env.DB
    .prepare(
      `SELECT DISTINCT book FROM verses
        WHERE bible_version = ?1 AND source_generation = ?2
        ORDER BY book`,
    )
    .bind(bibleVersion, generation)
    .all<{ book: string }>();
  const meta = await env.DB
    .prepare(
      `SELECT DISTINCT book FROM book_usfm_meta
        WHERE bible_version = ?1 AND source_generation = ?2
        ORDER BY book`,
    )
    .bind(bibleVersion, generation)
    .all<{ book: string }>();

  const vSet = new Set(verses.results.map((r) => r.book));
  const mSet = new Set(meta.results.map((r) => r.book));
  // Required books = anything present in either table for the generation being replaced.
  // A verses/meta mismatch here is NOT a reason to block the replacement — that would
  // deadlock the very workflow meant to fix inconsistent content (the new source rewrites
  // both verses and meta for the incoming generation). Books absent from the new source
  // surface later as retryable/waivable per-book staging errors.
  const books = [...new Set([...vSet, ...mSet])].sort();
  return { books };
}

/** DTO fields published with every lane-aware response. */
export function lanePublicState(row: LaneStateRow): Record<string, unknown> {
  return {
    lane: row.lane,
    activeGeneration: row.active_generation,
    configRevision: row.config_revision,
    replacementJobId: row.replacement_job_id,
    exportsBlocked: !!row.exports_blocked,
    replacementRequired: !!row.replacement_required,
    config: parseLaneConfig(row.active_config_json),
    pendingTarget: row.pending_target_json ? JSON.parse(row.pending_target_json) : null,
  };
}

/**
 * Older Workers never rewrote lane rows on preset switch, so a BSOJ quarantine
 * can stick under English presets. Heal when pending/active identity disagrees
 * with the current preset and no job/lease is held.
 */
export async function maybeHealLaneStateForPreset(env: Env, cfg: ProjectConfig): Promise<void> {
  await ensureLaneState(env);
  for (const lane of ["lit", "sim"] as LaneKey[]) {
    const row = await getLaneState(env, lane);
    if (!row || row.replacement_job_id || row.exclusive_owner) return;
    const desired = desiredLaneConfig(cfg, lane);
    const reference = row.replacement_required && row.pending_target_json
      ? (JSON.parse(row.pending_target_json) as ScriptureLaneConfig)
      : parseLaneConfig(row.active_config_json);
    if (!sameLaneSource(reference, desired)) {
      await reconcileLaneStateForPreset(env, cfg);
      return;
    }
  }
}

/** Materialize labels into ProjectConfig from active lane state (presentation). */
export async function overlayLaneLabels(env: Env, cfg: ProjectConfig): Promise<ProjectConfig> {
  await ensureLaneState(env);
  try {
    await maybeHealLaneStateForPreset(env, cfg);
  } catch {
    // Busy lanes: leave sticky state; admin must finish the job first.
  }
  const lit = await getLaneState(env, "lit");
  const sim = await getLaneState(env, "sim");
  if (!lit || !sim) return cfg;
  // Per-lane: while a lane is under BSOJ transitional freeze, do NOT publish
  // AVD/NAV as its presentation label (that would brand quarantined gen-1).
  // An already-activated sibling lane keeps its real label.
  const litCfg = parseLaneConfig(lit.active_config_json);
  const simCfg = parseLaneConfig(sim.active_config_json);
  return {
    ...cfg,
    litLabel: lit.replacement_required ? "…" : litCfg.label,
    simLabel: sim.replacement_required ? "…" : simCfg.label,
    repos: {
      ...cfg.repos,
      lit: litCfg.source.repo,
      sim: simCfg.source.repo,
    },
    org: litCfg.source.owner || cfg.org,
    laneState: {
      lit: lanePublicState(lit),
      sim: lanePublicState(sim),
    },
  } as ProjectConfig;
}

// Re-export PRESETS touch for tests that seed BSOJ
void PRESETS;
