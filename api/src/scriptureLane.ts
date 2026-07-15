// Authoritative per-lane scripture state: generations, freezes, permissions.
// Generation / locks / write guards ALWAYS read D1 directly — never the
// 60s project-config isolate cache.

import type { Env } from "./index";
import type { ProjectConfig } from "./projectConfig.ts";
import { getProjectConfig, PRESETS } from "./projectConfig.ts";
import type { RepoRef } from "./repoUrl.ts";
import { repoRefEquals } from "./repoUrl.ts";

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
  // v1: locked alignment export requires source == export base
  if (textReadOnly && exportTarget && !repoRefEquals(source, { owner: exportTarget.owner, repo: exportTarget.repo, ref: exportTarget.baseRef })) {
    // Prefer same-repo export when we forced equality
  }
  return {
    label,
    source,
    export: exportTarget,
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
          label: lane === "lit" ? "LEGACY" : "LEGACY",
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

export async function requireLaneState(env: Env, lane: LaneKey): Promise<LaneStateRow> {
  await ensureLaneState(env);
  const row = await getLaneState(env, lane);
  if (!row) throw new Error(`lane_state_missing:${lane}`);
  return row;
}

/**
 * Clear a lane freeze whose replacement_job_id points at a missing
 * scripture_lane_replacement row (Worker died between CAS freeze and job
 * INSERT). Returns true when an orphan was cleared. Safe to call anytime —
 * no-op when the job exists or the lane is not frozen.
 */
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
  await env.DB.prepare(
    `UPDATE scripture_lane_state
        SET replacement_job_id = NULL,
            exports_blocked = CASE WHEN replacement_required = 1 THEN 1 ELSE 0 END,
            updated_at = unixepoch()
      WHERE lane = ?1 AND replacement_job_id = ?2`,
  )
    .bind(lane, row.replacement_job_id)
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
): Promise<{ books: string[] } | { error: string }> {
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
  // Meta without verses (or vice versa) is a validation failure — except empty both.
  for (const b of vSet) {
    if (mSet.size > 0 && !mSet.has(b)) {
      return { error: `meta_missing_for_book:${b}` };
    }
  }
  for (const b of mSet) {
    if (!vSet.has(b)) {
      return { error: `verses_missing_for_book:${b}` };
    }
  }
  return { books: [...vSet].sort() };
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

/** Materialize labels into ProjectConfig from active lane state (presentation). */
export async function overlayLaneLabels(env: Env, cfg: ProjectConfig): Promise<ProjectConfig> {
  await ensureLaneState(env);
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
