-- Article population (PR A): populate the tW/tA translate areas from a book's
-- imported notes instead of a manual whole-corpus script run.
--
-- 1. Source-identity columns on article_units. The reconciler must know which
--    org/repo a row's source_md was fetched from — a sha-only staleness guard
--    breaks when the source ORG changes but the bytes happen to match (identity
--    change with identical content must still re-stamp the row so it stops being
--    perpetually "mismatched"). NULL for pre-existing rows (script-imported from
--    unfoldingWord/en_tw|en_ta) — treated as identity-unknown, refetched once.
ALTER TABLE article_units ADD COLUMN source_org TEXT;
ALTER TABLE article_units ADD COLUMN source_repo TEXT;

-- 2. Per-path fetch outcome memory, scoped to the source it was observed against.
--    A 'not_found' from org A must not block the path after an admin switches the
--    project's translationSource to org B — a state row whose source_org/repo
--    differ from the current source is VOID (deleted on read, path treated fresh).
--    'not_found' is terminal for its source until manually reset; 'error' retries
--    with an attempt cap, then requires a manual reset (retryFailed).
--
--    The two allowed statuses are enforced by a CHECK. This is load-bearing for
--    the write-time config fence: the driver prepends to every write batch a guard
--    INSERT that sets status='abort_config_changed' (which VIOLATES this CHECK)
--    gated on a config-snapshot mismatch — so a config change between plan and
--    write rolls back the ENTIRE batch (same RAISE-on-abort technique as the
--    triggers in migration 0042). Do not widen this CHECK.
CREATE TABLE article_fetch_state (
  resource TEXT NOT NULL CHECK (resource IN ('tw','ta')),
  path TEXT NOT NULL,
  source_org TEXT NOT NULL,
  source_repo TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('not_found','error')),
  attempts INTEGER NOT NULL DEFAULT 1,
  last_http_status INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (resource, path)
);
