import { Hono } from "hono";
import type { Env } from "./index";

export const lexicon = new Hono<{ Bindings: Env }>();

// Cap on the bulk `?strongs=` list. This route is UNAUTHENTICATED, and each
// key can fan out to a D1 query chunk (CHUNK below), so an unbounded list lets
// one HTTP request trigger hundreds of D1 subrequests. The largest legitimate
// batch is the unique Strong's numbers in one loaded chapter (a few hundred),
// so 2000 leaves generous headroom while turning "unbounded" into "bounded".
// Over the cap is a clean 400 rather than a silent truncation (which would
// return wrong/partial results the client can't detect).
export const MAX_STRONGS = 2000;

export interface LexiconEntry {
  strong: string;
  resource: "uhal" | "ugl";
  lemma: string | null;
  part_of_speech: string | null;
  gloss: string | null;
  definition: string | null;
}

// USFM source words carry Strong's in shapes like "b:H2320", "H2148a",
// or "d:H8066" — strip prefix particles and any sense-suffix letter. We
// return both the exact normalized form and the alpha-stripped fallback so
// the caller can take the first hit.
function strongLookupKeys(raw: string): string[] {
  if (!raw) return [];
  const m = raw.match(/[HG]\d+[a-z]?/i);
  if (!m) return [];
  const exact = m[0].toUpperCase().replace(/^([HG])0+/, "$1");
  const base = exact.replace(/[A-Z]$/, "");
  return exact === base ? [exact] : [exact, base];
}

lexicon.get("/:strong", async (c) => {
  const raw = c.req.param("strong");
  const candidates = strongLookupKeys(raw);
  for (const k of candidates) {
    const row = await c.env.DB.prepare(
      `SELECT * FROM lexicon_entries WHERE strong = ?1`,
    )
      .bind(k)
      .first<LexiconEntry>();
    if (row) return c.json(row);
  }
  return c.json({ error: "not_found", strong: raw }, 404);
});

lexicon.get("/", async (c) => {
  // Bulk: GET /api/lexicon?strongs=b:H2320,d:H8066,H2148a
  const raw = c.req.query("strongs") ?? "";
  const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (requested.length === 0) return c.json({ entries: [] });
  if (requested.length > MAX_STRONGS) {
    return c.json({ error: "too_many_keys", max: MAX_STRONGS, got: requested.length }, 400);
  }

  // Collect unique lookup keys with the request key they came from so the
  // client can match each returned entry back to the original raw strong.
  const keyToRaws = new Map<string, string[]>();
  for (const r of requested) {
    for (const k of strongLookupKeys(r)) {
      if (!keyToRaws.has(k)) keyToRaws.set(k, []);
      keyToRaws.get(k)!.push(r);
    }
  }
  const uniqueKeys = [...keyToRaws.keys()];
  if (uniqueKeys.length === 0) return c.json({ entries: [] });

  // D1 caps prepared statements at 100 bind variables; a chapter can easily
  // exceed that, so chunk the IN-list and concat the results.
  const CHUNK = 100;
  const entries: LexiconEntry[] = [];
  for (let i = 0; i < uniqueKeys.length; i += CHUNK) {
    const chunk = uniqueKeys.slice(i, i + CHUNK);
    const placeholders = chunk.map((_v, j) => `?${j + 1}`).join(",");
    const rs = await c.env.DB.prepare(
      `SELECT * FROM lexicon_entries WHERE strong IN (${placeholders})`,
    )
      .bind(...chunk)
      .all<LexiconEntry>();
    if (rs.results) entries.push(...rs.results);
  }
  return c.json({ entries });
});
