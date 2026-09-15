// resourceTypes.ts — the registry that turns a `resourceType` into everything
// the translate runner needs to handle it: which family it belongs to, the TSV
// column schema (for tsv resources), which prompt translates it, and the
// published source file naming.
//
// Ported from bp-assistant src/lib/resource-types.js (issue #445, design
// docs/translate-internal-runner.md §A). Dropped: the Zulip ROUTE_* maps,
// `pushType`, `defaultRepo`, `configRepoKey` (the editor resolves repos in
// translateOptions.ts) and `articleScopeBook` (bot job-id scoping).
//
// Two families:
//   - 'tsv'     tN, tQ : row-batched TSV; pass-through columns byte-identical,
//               only the translate columns are localized; chapter-range/by-id merge.
//   - 'article' tW, tA : markdown file(s) resolved from a name or Door43 URL;
//               whole-body translation with structure/link preservation; per-file merge.
//
// Column facts verified live 2026-07-13:
//   en_tn tn_OBA.tsv : Reference ID Tags SupportReference Quote Occurrence Note
//   en_tq tq_OBA.tsv : Reference ID Tags Quote Occurrence Question Response
// Note tQ has NO SupportReference and Quote is column 4 (not 5).

export const TN_COLUMNS: readonly string[] = ["Reference", "ID", "Tags", "SupportReference", "Quote", "Occurrence", "Note"];
export const TQ_COLUMNS: readonly string[] = ["Reference", "ID", "Tags", "Quote", "Occurrence", "Question", "Response"];

export type ResourceTypeKey = "tn" | "tq" | "tw" | "ta";
export type ResourceFamily = "tsv" | "article";
export type SkillName = "translate-tn" | "translate-tq" | "translate-article";

export type TsvResourceType = {
  family: "tsv";
  columns: readonly string[];
  passThroughColumns: readonly string[];
  translateColumns: readonly string[];
  supportRefColumn: string | null;
  file: (book: string) => string;
  skill: SkillName;
  defaultSourceRepo: string;
  label: string;
};

export type ArticleResourceType = {
  family: "article";
  skill: SkillName;
  defaultSourceRepo: string;
  layout: "tw" | "ta";
  label: string;
};

export type ResourceType = TsvResourceType | ArticleResourceType;

export const RESOURCE_TYPES: Record<ResourceTypeKey, ResourceType> = {
  tn: {
    family: "tsv",
    columns: TN_COLUMNS,
    passThroughColumns: ["Reference", "ID", "Tags", "SupportReference", "Quote", "Occurrence"],
    translateColumns: ["Note"],
    supportRefColumn: "SupportReference",
    file: (book) => `tn_${book.toUpperCase()}.tsv`,
    skill: "translate-tn",
    defaultSourceRepo: "en_tn",
    label: "translationNotes",
  },
  tq: {
    family: "tsv",
    columns: TQ_COLUMNS,
    passThroughColumns: ["Reference", "ID", "Tags", "Quote", "Occurrence"],
    translateColumns: ["Question", "Response"],
    supportRefColumn: null,
    file: (book) => `tq_${book.toUpperCase()}.tsv`,
    skill: "translate-tq",
    defaultSourceRepo: "en_tq",
    label: "translationQuestions",
  },
  tw: {
    family: "article",
    skill: "translate-article",
    defaultSourceRepo: "en_tw",
    layout: "tw", // bible/{kt,names,other}/{term}.md
    label: "translationWords",
  },
  ta: {
    family: "article",
    skill: "translate-article",
    defaultSourceRepo: "en_ta",
    layout: "ta", // {translate,checking,process,intro}/{article}/*.md
    label: "translationAcademy",
  },
};

export const RESOURCE_TYPE_KEYS = Object.keys(RESOURCE_TYPES) as ResourceTypeKey[];

function lookup(resourceType: string): ResourceType | undefined {
  return Object.prototype.hasOwnProperty.call(RESOURCE_TYPES, resourceType)
    ? RESOURCE_TYPES[resourceType as ResourceTypeKey]
    : undefined;
}

export function getResourceType(resourceType: string): ResourceType {
  const rt = lookup(resourceType);
  if (!rt) {
    throw new Error(`unknown resourceType "${resourceType}" (expected one of: ${RESOURCE_TYPE_KEYS.join(", ")})`);
  }
  return rt;
}

/** Narrowing accessor for callers that already know they hold a TSV resource. */
export function getTsvResourceType(resourceType: string): TsvResourceType {
  const rt = getResourceType(resourceType);
  if (rt.family !== "tsv") throw new Error(`resourceType "${resourceType}" is not a TSV resource`);
  return rt;
}

export function isTsvResource(resourceType: string): boolean {
  return lookup(resourceType)?.family === "tsv";
}

export function isArticleResource(resourceType: string): boolean {
  return lookup(resourceType)?.family === "article";
}
