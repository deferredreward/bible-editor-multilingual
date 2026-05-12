import { Hono } from "hono";
import type { Env } from "./index";

export const lexicon = new Hono<{ Bindings: Env }>();

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

  const placeholders = uniqueKeys.map((_v, i) => `?${i + 1}`).join(",");
  const rs = await c.env.DB.prepare(
    `SELECT * FROM lexicon_entries WHERE strong IN (${placeholders})`,
  )
    .bind(...uniqueKeys)
    .all<LexiconEntry>();
  return c.json({ entries: rs.results });
});
