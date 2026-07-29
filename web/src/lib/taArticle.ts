// Translation Academy (tA) article helpers — ref parsing, Door43 URLs, and a
// session-cached raw-markdown + title fetch for the in-app article viewer.
//
// Accepts both the short "manual/slug" form and the rc:// link form
// ("rc://*/ta/man/translate/figs-metaphor") stored on tN support_reference.

const DCS_HOST = "https://git.door43.org";
const DEFAULT_SOURCE = { org: "unfoldingWord", repo: "en_ta" } as const;

// The repo base for tA articles. Defaults to unfoldingWord/en_ta; a GL project
// passes its translationSource (or its own org/repo) so the viewer fetches the
// article from the project's source repo rather than always English.
export interface TaArticleSource {
  org: string;
  repo: string;
}
function taBase(source?: TaArticleSource): string {
  const { org, repo } = source ?? DEFAULT_SOURCE;
  return `${DCS_HOST}/${org}/${repo}`;
}

export interface TaRef {
  manual: string;
  slug: string;
}

// tA manuals are a closed, known set — anything else is a malformed reference
// and is dropped rather than fetched.
const TA_MANUALS = new Set(["translate", "checking", "process", "intro"]);
const SLUG_RE = /^[a-z0-9-]{1,80}$/;

function stripMd(seg: string): string {
  return seg.replace(/\.md$/, "");
}

// Mirrors api/src/articlePopulate.ts parseTaRef EXACTLY — closed manual set,
// bare 1-seg (defaults manual "translate"), bare 2-seg, and rc:// forms with an
// optional "man" segment. Pinned by a shared test table (see
// taArticle.test.mjs and the API's own tests) — keep the two in lockstep.
export function parseTaRef(ref: string | null | undefined): TaRef | null {
  if (!ref) return null;
  const raw = ref.trim();
  if (!raw) return null;
  let segs: string[];
  if (raw.startsWith("rc://")) {
    segs = raw.slice("rc://".length).split("/").filter(Boolean);
    const ti = segs.indexOf("ta");
    if (ti === -1) return null;
    segs = segs.slice(ti + 1);
    if (segs[0] === "man") segs = segs.slice(1);
  } else {
    segs = raw.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  }
  segs = segs.map(stripMd).filter(Boolean);
  let manual: string;
  let slug: string;
  if (segs.length === 1) {
    manual = "translate";
    slug = segs[0];
  } else if (segs.length === 2) {
    [manual, slug] = segs;
  } else {
    return null;
  }
  if (!TA_MANUALS.has(manual) || !SLUG_RE.test(slug)) return null;
  return { manual, slug };
}

// rc://*/ta/man/translate/figs-metaphor → translate/figs-metaphor; bare id
// passes through unparseable.
export function taShort(ref: string | null | undefined): string {
  const parsed = parseTaRef(ref);
  return parsed ? `${parsed.manual}/${parsed.slug}` : ref || "";
}

// Rendered Gitea preview page — the "View on DCS" link target (human-facing).
// manual/slug come from a shared, editor-writable tN field, so percent-encode
// them: a crafted support_reference (embedded %2F, ?, #, ..) can't steer the
// URL to a different path or repo on DCS than the one the panel labels it as.
export function taArticleDcsUrl(ref: string | null | undefined, source?: TaArticleSource): string {
  const parsed = parseTaRef(ref);
  return parsed
    ? `${taBase(source)}/src/branch/master/${encodeURIComponent(parsed.manual)}/${encodeURIComponent(parsed.slug)}/01.md`
    : "";
}

function taArticleRawUrl(ref: string | null | undefined, source?: TaArticleSource): string {
  const parsed = parseTaRef(ref);
  return parsed
    ? `${taBase(source)}/raw/branch/master/${encodeURIComponent(parsed.manual)}/${encodeURIComponent(parsed.slug)}/01.md`
    : "";
}

function taArticleTitleUrl(ref: string | null | undefined, source?: TaArticleSource): string {
  const parsed = parseTaRef(ref);
  return parsed
    ? `${taBase(source)}/raw/branch/master/${encodeURIComponent(parsed.manual)}/${encodeURIComponent(parsed.slug)}/title.md`
    : "";
}

export interface TaArticle {
  title: string | null;
  body: string;
}

// Door43 serves raw .md with permissive CORS (node-twl-generator relies on the
// same), so the browser can fetch articles directly. Cache per session — the
// articles are immutable for the life of a tab. title.md is optional — many
// tA articles have no separate title file, and a 404 there must never fail the
// whole fetch.
const cache = new Map<string, Promise<TaArticle>>();

export function fetchTaArticle(ref: string, source?: TaArticleSource): Promise<TaArticle> {
  const bodyUrl = taArticleRawUrl(ref, source);
  if (!bodyUrl) return Promise.reject(new Error("unrecognized tA article ref"));
  const titleUrl = taArticleTitleUrl(ref, source);
  let pending = cache.get(bodyUrl);
  if (!pending) {
    const bodyPromise = fetch(bodyUrl).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });
    const titlePromise = fetch(titleUrl)
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null);
    pending = Promise.all([bodyPromise, titlePromise])
      .then(([body, title]) => ({ body, title: title ? title.trim() : null }))
      .catch((err) => {
        cache.delete(bodyUrl); // don't cache failures — allow retry on reopen
        throw err;
      });
    cache.set(bodyUrl, pending);
  }
  return pending;
}
