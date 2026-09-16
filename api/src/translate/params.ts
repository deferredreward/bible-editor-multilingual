// params.ts — resolve a translate job's stored options into the full parameter
// set the runner needs (language names, direction, source/target refs,
// merge mode, column sets, prompt name).
//
// Ported from bp-assistant src/translate-pipeline.js:61-68, 83-217 (issue
// #445). Dropped: the Zulip command regexes (the editor's job row already
// carries book/chapter/verse/rowIds explicitly), the bot's
// translate-targets.json per-language config (the editor resolves targetOrg /
// repos from its project config in translateOptions.ts), `delivery`,
// `branchOnly`, `writeContextBack`, `pushType`, and the non-enumerable
// `apiKey` (the Workflow decrypts the key inside each step and never puts it
// on params).
//
// Defaults deliberately mirror the bot's fallbacks so a job the editor
// dispatched to the proxy and the same job run internally resolve the same
// refs when the editor sends the same options.

import { getResourceType, type ResourceFamily, type SkillName } from "./resourceTypes.ts";

export const LANG_NAMES: Record<string, string> = {
  ar: "Arabic", "es-419": "Latin American Spanish", es: "Spanish", ru: "Russian",
  fr: "French", hi: "Hindi", sw: "Swahili", pt: "Portuguese", id: "Indonesian",
  zh: "Chinese", vi: "Vietnamese", bn: "Bengali", ur: "Urdu", fa: "Persian",
  he: "Hebrew", am: "Amharic", ne: "Nepali", my: "Burmese", th: "Thai",
  en: "English", ka: "Georgian",
};
export const RTL_LANGS = new Set(["ar", "he", "fa", "ur", "ps", "sd", "ug", "yi", "dv", "ckb", "arc", "syr", "prs"]);

export function langName(code: string): string {
  return Object.prototype.hasOwnProperty.call(LANG_NAMES, code) ? LANG_NAMES[code] : code;
}

/** What a stored translate job carries (options_json + the job row's scope). */
export type TranslateJobInput = {
  resourceType?: string | null;
  // tsv scope
  book?: string | null;
  startChapter?: number | null;
  endChapter?: number | null;
  verseStart?: number | null;
  verseEnd?: number | null;
  rowIds?: readonly string[] | null;
  // article scope
  articleId?: string | null;
  articleUrl?: string | null;
  // common
  targetLang: string;
  targetOrg?: string | null;
  repoName?: string | null;
  sourceLang?: string | null;
  sourceRef?: string | null;
  contextRef?: string | null;
  sourceLiteralRef?: string | null;
  sourceSimplifiedRef?: string | null;
  literalRef?: string | null;
  simplifiedRef?: string | null;
  direction?: "ltr" | "rtl" | null;
  jobId?: string | null;
  provider?: string | null;
  model?: string | null;
};

export type TranslateParams = {
  resourceType: string;
  family: ResourceFamily;
  resourceLabel: string;
  skill: SkillName;
  passThroughColumns: readonly string[] | undefined;
  translateColumns: readonly string[] | undefined;
  // tsv scope
  book: string | null;
  startChapter: number | null;
  endChapter: number | null;
  verseStart: number | null;
  verseEnd: number | null;
  rowIds: readonly string[] | null;
  mergeMode: "range" | "by-id";
  // article scope
  articleId: string | null;
  articleUrl: string | null;
  // common
  targetLang: string;
  targetLangName: string;
  sourceLang: string;
  sourceLangName: string;
  direction: "ltr" | "rtl";
  targetOrg: string;
  repoName: string;
  sourceRef: string;
  sourceLiteralRef: string;
  sourceSimplifiedRef: string;
  targetLiteralRef: string;
  targetSimplifiedRef: string;
  contextRef: string;
  contextRefExplicit: boolean;
  jobId: string | null;
  provider: string | null;
  model: string | null;
  thinking: "medium";
};

export function resolveParams(opts: TranslateJobInput): TranslateParams {
  const resourceType = opts.resourceType || "tn";
  const rt = getResourceType(resourceType);
  const family = rt.family;

  let book: string | null = null;
  let startChapter: number | null = null;
  let endChapter: number | null = null;
  let verseStart: number | null = null;
  let verseEnd: number | null = null;
  let rowIds: readonly string[] | null = null;
  let articleId: string | null = null;
  let articleUrl: string | null = null;

  if (family === "article") {
    articleId = opts.articleId || null;
    articleUrl = opts.articleUrl || null;
    if (!articleId && !articleUrl) throw new Error("translate: articleId or articleUrl is required for tw/ta");
  } else {
    if (!opts.book || opts.startChapter == null) {
      throw new Error(`translate: book and startChapter are required for ${resourceType}`);
    }
    book = opts.book;
    startChapter = opts.startChapter;
    endChapter = opts.endChapter ?? startChapter;
    verseStart = opts.verseStart ?? null;
    verseEnd = opts.verseEnd ?? null; // selectRows treats a null end as start
    rowIds = Array.isArray(opts.rowIds) && opts.rowIds.length ? opts.rowIds : null;
  }

  const targetLang = opts.targetLang;
  if (!targetLang) throw new Error("translate: targetLang is required");

  const hasSubset = (rowIds && rowIds.length > 0) || verseStart != null;
  const mergeMode: "range" | "by-id" = hasSubset ? "by-id" : "range";

  const targetOrg = opts.targetOrg || `${targetLang}_gl`;
  const repoName = opts.repoName || `${targetLang}_${resourceType}`;
  const sourceLang = opts.sourceLang || "en";
  const sourceRef = opts.sourceRef || `unfoldingWord/${rt.defaultSourceRepo}@master`;
  const sourceLiteralRef = opts.sourceLiteralRef || "unfoldingWord/en_ult@master";
  const sourceSimplifiedRef = opts.sourceSimplifiedRef || "unfoldingWord/en_ust@master";
  const targetLiteralRef = opts.literalRef || `${targetOrg}/${targetLang}_glt@master`;
  const targetSimplifiedRef = opts.simplifiedRef || `${targetOrg}/${targetLang}_gst@master`;
  const contextRef = opts.contextRef || `${targetOrg}/translation-context@master`;
  const contextRefExplicit = !!opts.contextRef;

  return {
    resourceType,
    family,
    resourceLabel: rt.label,
    skill: rt.skill,
    passThroughColumns: rt.family === "tsv" ? rt.passThroughColumns : undefined,
    translateColumns: rt.family === "tsv" ? rt.translateColumns : undefined,
    book: book ? book.toUpperCase() : null,
    startChapter,
    endChapter,
    verseStart,
    verseEnd,
    rowIds,
    mergeMode,
    articleId,
    articleUrl,
    targetLang,
    targetLangName: langName(targetLang),
    sourceLang,
    sourceLangName: langName(sourceLang),
    direction: opts.direction || (RTL_LANGS.has(targetLang.split("-")[0]) ? "rtl" : "ltr"),
    targetOrg,
    repoName,
    sourceRef,
    sourceLiteralRef,
    sourceSimplifiedRef,
    targetLiteralRef,
    targetSimplifiedRef,
    contextRef,
    contextRefExplicit,
    jobId: opts.jobId || null,
    provider: opts.provider || null,
    model: opts.model || null,
    // The provider adapters read params.thinking; equal to the effort the
    // bot's agentic runClaude calls hardcode.
    thinking: "medium",
  };
}
