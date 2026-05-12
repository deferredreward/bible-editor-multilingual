import { Hono } from "hono";
import type { Env } from "./index";

export const catalogs = new Hono<{ Bindings: Env }>();

// Bootstrap catalogs from whatever's already in D1 so the typeaheads have
// realistic suggestions on day 1. A future enhancement is to pull the
// canonical lists from the ta/tw repos (`unfoldingWord/en_ta`, `en_tw`) and
// keep them in their own tables.
catalogs.get("/", async (c) => {
  const supportRefs = await c.env.DB.prepare(
    `SELECT support_reference AS value, COUNT(*) AS n
     FROM tn_rows
     WHERE support_reference IS NOT NULL AND deleted_at IS NULL
     GROUP BY support_reference
     ORDER BY n DESC
     LIMIT 500`,
  ).all<{ value: string; n: number }>();

  const twLinks = await c.env.DB.prepare(
    `SELECT tw_link AS value, COUNT(*) AS n
     FROM twl_rows
     WHERE tw_link IS NOT NULL AND deleted_at IS NULL
     GROUP BY tw_link
     ORDER BY n DESC
     LIMIT 500`,
  ).all<{ value: string; n: number }>();

  return c.json({
    supportReferences: supportRefs.results.map((r) => r.value),
    twLinks: twLinks.results.map((r) => r.value),
  });
});
