// Translation Words (TW) article helpers — id parsing, Door43 URLs, and a
// session-cached raw-markdown fetch for the in-app article viewer.
//
// Accepts both the short form ("kt/god") the catalog/matcher use and the long
// rc:// link form ("rc://*/tw/dict/bible/kt/god") stored on TWL rows.

const DCS_HOST = "https://git.door43.org";
const DEFAULT_SOURCE = { org: "unfoldingWord", repo: "en_tw" } as const;

// The repo base for tW articles. Defaults to unfoldingWord/en_tw; a GL project
// passes its translationSource (or its own org/repo) so the viewer fetches the
// article from the project's source repo rather than always English.
export interface TwArticleSource {
  org: string;
  repo: string;
}
function twBase(source?: TwArticleSource): string {
  const { org, repo } = source ?? DEFAULT_SOURCE;
  return `${DCS_HOST}/${org}/${repo}`;
}

export interface TwArticleRef {
  cat: string; // "kt" | "names" | "other"
  art: string; // "god", "moab", …
}

export function parseTwId(idOrLink: string | null | undefined): TwArticleRef | null {
  if (!idOrLink) return null;
  const m =
    idOrLink.match(/\/bible\/([^/]+)\/([^/]+?)(?:\.md)?$/) ??
    idOrLink.match(/^([^/]+)\/([^/]+?)(?:\.md)?$/);
  if (!m) return null;
  // Real cat/art values are plain slugs ("kt", "names", "god", "melchizedek").
  // tw_link is a shared, editor-writable TWL field, so reject anything else —
  // a "..", "%2F", "?" or "#" segment would otherwise steer the built DCS URL
  // to a different path than the one the dialog labels it as.
  const slug = /^[A-Za-z0-9_-]+$/;
  if (!slug.test(m[1]) || !slug.test(m[2])) return null;
  return { cat: m[1], art: m[2] };
}

// rc://*/tw/dict/bible/names/moab → names/moab; bare id passes through.
export function twShort(idOrLink: string | null | undefined): string {
  const ref = parseTwId(idOrLink);
  return ref ? `${ref.cat}/${ref.art}` : idOrLink || "";
}

// Rendered Gitea preview page — the "View on DCS" link target (human-facing).
// cat/art come from shared, editor-writable TWL rows: percent-encode them so
// a crafted tw_link (embedded %2F, ?, #, ..) can't steer the URL to a
// different path or repo on DCS than the one the dialog labels it as.
export function twArticleDcsUrl(idOrLink: string | null | undefined, source?: TwArticleSource): string {
  const ref = parseTwId(idOrLink);
  return ref
    ? `${twBase(source)}/src/branch/master/bible/${encodeURIComponent(ref.cat)}/${encodeURIComponent(ref.art)}.md`
    : "";
}

// Raw markdown — what the in-app viewer fetches and renders.
export function twArticleRawUrl(idOrLink: string | null | undefined, source?: TwArticleSource): string {
  const ref = parseTwId(idOrLink);
  return ref
    ? `${twBase(source)}/raw/branch/master/bible/${encodeURIComponent(ref.cat)}/${encodeURIComponent(ref.art)}.md`
    : "";
}

// Door43 serves raw .md with permissive CORS (node-twl-generator relies on the
// same), so the browser can fetch articles directly. Cache per session — the
// articles are immutable for the life of a tab.
const cache = new Map<string, Promise<string>>();

export function fetchTwArticle(idOrLink: string, source?: TwArticleSource): Promise<string> {
  const url = twArticleRawUrl(idOrLink, source);
  if (!url) return Promise.reject(new Error("unrecognized TW article id"));
  let pending = cache.get(url);
  if (!pending) {
    pending = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .catch((err) => {
        cache.delete(url); // don't cache failures — allow retry on reopen
        throw err;
      });
    cache.set(url, pending);
  }
  return pending;
}
