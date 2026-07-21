# viewer-readonly-enforcement (branch pr/viewer-readonly-enforcement)

Status: PR open, awaiting review. Delete this file when the PR merges.

- Audited every state-changing route in api/src; per-route requireEditor/requireAdmin
  coverage was already complete except POST /api/project-config/lanes/:lane/validate
  (was requireAuth-only; now requireAdmin, matching its admin-only Preferences UI).
- Added global backstop `blockViewerWrites` (api/src/viewerGuard.ts), registered in
  index.ts after requireCsrf: 403s viewer-role POST/PUT/PATCH/DELETE outside the
  self-scoped allowlist (/api/auth/, /api/users/me/, /api/workspaces/, /api/alerts/).
- New suite api/src/viewerGuard.test.mjs mounts real routers (rows, verses, l10n,
  alerts, scriptureLaneRoutes); required adding .ts extensions to a handful of
  runtime relative imports so those modules load under the strip-types runner.
- Deliberately did NOT touch auth.ts role resolution, dcsTeams.ts, workspaceRoutes.ts,
  or the OAuth callback (parallel worktree owns those).
