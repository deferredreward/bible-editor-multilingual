// Pure renderer for the {org}/translation-context pack (CONTEXT-REPO-CONTRACT.md).
// No DCS / Hono imports — EN source maps are injected by the caller so unit
// tests stay fixture-driven. Workflow orchestration lives in exportWorkflow.

import type { ProjectConfig } from "./projectConfig.ts";
import { serializeTermsCsv, type TermImport } from "./translationMemoryLib.ts";
import {
  contentFileCount,
  hasMinimumContent,
  nfc,
  totalBytes,
  type ContextFile,
  type ContextPackStats,
} from "./contextExportLib.ts";

export type { ContextFile, ContextPackStats };
export { contentFileCount, hasMinimumContent, totalBytes };

export type TranslationPrefsForRender = {
  audience: string | null;
  purpose: string | null;
  register: string;
  script_notes: string | null;
  instructions_md: string | null;
};

export type ValidatedTnRow = {
  id: string;
  book: string;
  ref_raw: string | null;
  support_reference: string | null;
  quote: string | null;
  note: string | null;
  updated_at: number;
};

export type ValidatedTqRow = {
  id: string;
  book: string;
  ref_raw: string | null;
  question: string | null;
  response: string | null;
  updated_at: number;
};

/** EN source text already resolved by row id (book-batched upstream). */
export type EnSourceMaps = {
  tn: Map<string, { note: string; quote: string | null }>;
  tq: Map<string, { question: string; response: string }>;
};

export type ContextPackRenderOk = {
  ok: true;
  files: ContextFile[];
  stats: ContextPackStats;
};

export type ContextPackRenderErr = {
  ok: false;
  reason: string;
};

export type ContextPackRender = ContextPackRenderOk | ContextPackRenderErr;

export function renderManifestYaml(opts: {
  languageCode: string;
  direction: "ltr" | "rtl";
  exportedAt: Date;
}): string {
  const exported_at = opts.exportedAt.toISOString().replace(/\.\d{3}Z$/, "Z");
  return [
    "format: 1",
    `language: ${opts.languageCode}`,
    `direction: ${opts.direction}`,
    `exported_at: ${exported_at}`,
    "exported_by: bible-editor",
    "",
  ].join("\n");
}

export function renderBriefMd(
  prefs: TranslationPrefsForRender,
  languageTitle: string,
  languageCode: string,
): string {
  const register = prefs.register || "default";
  return [
    `# Translation brief — ${languageTitle} (${languageCode})`,
    "",
    `**Audience:** ${prefs.audience?.trim() || "—"}`,
    `**Purpose:** ${prefs.purpose?.trim() || "—"}`,
    `**Register:** ${register}`,
    `**Script / direction notes:** ${prefs.script_notes?.trim() || "—"}`,
    "",
  ].join("\n");
}

export type JsonlExample = {
  resource: "tn" | "tq";
  rowId: string;
  book: string;
  ref: string;
  supportReference: string | null;
  source: string;
  target: string;
  validated_at: number;
};

/**
 * Build validated.jsonl lines. Fail-closed: any validated row without a
 * matching EN source aborts the whole pack (never publish partial English).
 */
export function buildValidatedExamples(
  tnRows: readonly ValidatedTnRow[],
  tqRows: readonly ValidatedTqRow[],
  sources: EnSourceMaps,
): { ok: true; lines: JsonlExample[] } | { ok: false; reason: string } {
  const lines: JsonlExample[] = [];
  for (const r of tnRows) {
    const src = sources.tn.get(r.id);
    if (!src) return { ok: false, reason: `missing_en_source:tn:${r.id}` };
    if (!src.note.trim()) return { ok: false, reason: `empty_en_source:tn:${r.id}` };
    const target = (r.note ?? "").trim();
    if (!target) return { ok: false, reason: `empty_target:tn:${r.id}` };
    lines.push({
      resource: "tn",
      rowId: r.id,
      book: r.book,
      ref: r.ref_raw ?? "",
      supportReference: r.support_reference,
      source: nfc(src.note),
      target: nfc(target),
      validated_at: r.updated_at,
    });
  }
  for (const r of tqRows) {
    const src = sources.tq.get(r.id);
    if (!src) return { ok: false, reason: `missing_en_source:tq:${r.id}` };
    const srcQ = src.question.trim();
    const srcR = src.response.trim();
    if (!srcQ && !srcR) return { ok: false, reason: `empty_en_source:tq:${r.id}` };
    const target = `${(r.question ?? "").trim()}\t${(r.response ?? "").trim()}`;
    if (!target.trim()) return { ok: false, reason: `empty_target:tq:${r.id}` };
    lines.push({
      resource: "tq",
      rowId: r.id,
      book: r.book,
      ref: r.ref_raw ?? "",
      supportReference: null,
      source: nfc(`${srcQ}\t${srcR}`),
      target: nfc(target),
      validated_at: r.updated_at,
    });
  }
  // Append-ordered by validation time (most recent last) per contract §3.4.
  lines.sort((a, b) => a.validated_at - b.validated_at);
  return { ok: true, lines };
}

export function renderValidatedJsonl(lines: readonly JsonlExample[]): string {
  if (lines.length === 0) return "";
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/**
 * Assemble the full pack from pre-fetched prefs/terms/rows + EN source maps.
 * Omits optional empty files (instructions, examples). Always writes manifest.
 */
export function renderContextPack(input: {
  cfg: ProjectConfig;
  prefs: TranslationPrefsForRender;
  terms: readonly TermImport[];
  tnRows: readonly ValidatedTnRow[];
  tqRows: readonly ValidatedTqRow[];
  sources: EnSourceMaps;
  exportedAt?: Date;
}): ContextPackRender {
  const exportedAt = input.exportedAt ?? new Date();
  const examples = buildValidatedExamples(input.tnRows, input.tqRows, input.sources);
  if (!examples.ok) return { ok: false, reason: examples.reason };

  const files: ContextFile[] = [];
  files.push({
    path: "manifest.yaml",
    content: renderManifestYaml({
      languageCode: input.cfg.languageCode,
      direction: input.cfg.direction,
      exportedAt,
    }),
  });

  // brief.md always present when we have prefs fields or as scaffold — the
  // register line is machine-readable even with empty prose. Always emit.
  files.push({
    path: "brief.md",
    content: renderBriefMd(
      input.prefs,
      input.cfg.languageTitle || input.cfg.languageName,
      input.cfg.languageCode,
    ),
  });

  const instructions = input.prefs.instructions_md?.trim();
  if (instructions) {
    files.push({ path: "instructions.md", content: instructions.endsWith("\n") ? instructions : `${instructions}\n` });
  }

  if (input.terms.length > 0) {
    files.push({ path: "terminology/terms.csv", content: serializeTermsCsv([...input.terms]) });
  }

  if (examples.lines.length > 0) {
    files.push({ path: "examples/validated.jsonl", content: renderValidatedJsonl(examples.lines) });
  }

  const stats: ContextPackStats = {
    terms: input.terms.length,
    examplesTn: examples.lines.filter((l) => l.resource === "tn").length,
    examplesTq: examples.lines.filter((l) => l.resource === "tq").length,
    contentFiles: contentFileCount(files),
    totalBytes: totalBytes(files),
  };

  return { ok: true, files, stats };
}

/** Owner for the context repo and contextRef — mirrors article export. */
export function contextRepoOwner(env: { DCS_EXPORT_OWNER?: string }, cfg: ProjectConfig): string {
  return env.DCS_EXPORT_OWNER ?? cfg.exportOrg;
}

export function contextRepoName(): string {
  return "translation-context";
}

export function buildContextRef(owner: string, sha: string): string {
  return `${owner}/${contextRepoName()}@${sha}`;
}
