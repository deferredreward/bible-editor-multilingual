-- Context-pack export results (CONTEXT-REPO-CONTRACT.md). Authoritative record
-- for assisted-mode SHA lookup and the Preferences panel toggle gate. A SHA is
-- trustworthy only when status='success' AND commit_sha IS NOT NULL AND
-- completed_at IS NOT NULL — getLatestSuccessfulContextExport() enforces that.

CREATE TABLE context_export_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  status TEXT NOT NULL,              -- queued | success | failed | shrink_refused | no_content | dry_run
  completed_at INTEGER,              -- NULL while in-flight
  commit_sha TEXT,                   -- NULL unless status=success and CAS landed
  parent_sha TEXT,
  owner TEXT NOT NULL,
  terms_count INTEGER,
  examples_tn INTEGER,
  examples_tq INTEGER,
  content_files INTEGER,
  total_bytes INTEGER,
  failure_reason TEXT,
  r2_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX context_export_results_success
  ON context_export_results(completed_at DESC, id DESC)
  WHERE status = 'success' AND commit_sha IS NOT NULL;
