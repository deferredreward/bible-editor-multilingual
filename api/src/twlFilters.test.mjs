// twlFilters.test.mjs — executable node:sqlite regression test for the
// workspace cache-leak fix.
//
// twlFilters.ts caches its unlinked/deleted deny-lists at module scope,
// signature-keyed. The Worker isolate is shared across every workspace this
// deployment serves, so the cache must ALSO be keyed by workspace slug — this
// reproduces the live bug: workspace A's deny-list must never leak into
// workspace B's response, even for the same book.
//
// Run: node --experimental-strip-types --no-warnings --test src/twlFilters.test.mjs

import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import test from "node:test";

import { twlFilters } from "./twlFilters.ts";

// Minimal D1 adapter over node:sqlite — only the subset twlFilters.ts uses
// (prepare().first()/bind().all()), mirroring articlePopulate.test.mjs.
function makeEnv(db, workspaceSlug) {
  const DB = {
    prepare(sql) {
      return {
        first() {
          return db.prepare(sql).get() ?? null;
        },
        all() {
          return { results: db.prepare(sql).all() };
        },
        bind(...params) {
          return {
            all() {
              return { results: db.prepare(sql).all(...params) };
            },
          };
        },
      };
    },
  };
  return { DB, WORKSPACE_SLUG: workspaceSlug };
}

function seededDb(unlinked, deleted) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE twl_unlinked_words (
      norm_orig_words TEXT NOT NULL, tw_link TEXT NOT NULL,
      last_synced INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE twl_deleted_rows (
      book TEXT NOT NULL, reference TEXT NOT NULL, norm_orig_words TEXT NOT NULL,
      last_synced INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  const insU = db.prepare(
    `INSERT INTO twl_unlinked_words (norm_orig_words, tw_link, last_synced) VALUES (?, ?, ?)`,
  );
  for (const [norm, link, ts] of unlinked) insU.run(norm, link, ts);
  const insD = db.prepare(
    `INSERT INTO twl_deleted_rows (book, reference, norm_orig_words, last_synced) VALUES (?, ?, ?, ?)`,
  );
  for (const [book, ref, norm, ts] of deleted) insD.run(book, ref, norm, ts);
  return db;
}

test("twlFilters deny-lists are isolated per workspace, not leaked via the shared isolate cache", async () => {
  // Workspace A and B each have a DIFFERENT deny-list for the SAME book/ref,
  // with the SAME signature shape (1 row, one last_synced timestamp each) so
  // a workspace-blind cache key would collide and serve one org's data to
  // the other.
  const dbA = seededDb(
    [["orig-a", "rc://*/tw/dict/bible/kt/a", 100]],
    [["GEN", "1:1", "orig-a-deleted", 100]],
  );
  const dbB = seededDb(
    [["orig-b", "rc://*/tw/dict/bible/kt/b", 100]],
    [["GEN", "1:1", "orig-b-deleted", 100]],
  );
  const envA = makeEnv(dbA, "a");
  const envB = makeEnv(dbB, "b");

  const resA = await twlFilters.request("/GEN", {}, envA);
  const bodyA = await resA.json();
  assert.deepEqual(bodyA.unlinked, [{ normOrigWords: "orig-a", twLink: "rc://*/tw/dict/bible/kt/a" }]);
  assert.deepEqual(bodyA.deleted, [{ reference: "1:1", normOrigWords: "orig-a-deleted" }]);

  // Immediately after A, B's request for the SAME book must get B's rows —
  // this is the exact live failure (a shared, unkeyed module cache serving
  // the previous workspace's data).
  const resB = await twlFilters.request("/GEN", {}, envB);
  const bodyB = await resB.json();
  assert.deepEqual(bodyB.unlinked, [{ normOrigWords: "orig-b", twLink: "rc://*/tw/dict/bible/kt/b" }]);
  assert.deepEqual(bodyB.deleted, [{ reference: "1:1", normOrigWords: "orig-b-deleted" }]);

  // And a repeat request for A must still see A's data, not B's (proves the
  // cache holds two live entries, not just "last writer wins").
  const resA2 = await twlFilters.request("/GEN", {}, envA);
  const bodyA2 = await resA2.json();
  assert.deepEqual(bodyA2.unlinked, [{ normOrigWords: "orig-a", twLink: "rc://*/tw/dict/bible/kt/a" }]);
});
