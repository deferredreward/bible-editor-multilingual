# template-ai-draft (branch pr/template-ai-draft)

Status: PR #89 open (https://github.com/deferredreward/bible-editor-multilingual/pull/89),
awaiting review. Delete this file when the PR merges.

- Implements issue #76: AI-assisted drafting for note-template translations
  (`template_units`), which previously had manual translation only.
- New `POST /api/templates/unit/draft?id=...` (api/src/templates.ts): mirrors
  tnQuick.ts's dumb-proxy shape (BT_API_TOKEN gate, forward, return) but ALSO
  persists the result in the same request — templates have no separate apply
  step. Stamps target_md + translation_state='ai_draft' + pre_draft_json
  exactly like applyTranslateArticle does for article_units (pipelineImport.ts),
  reusing nextPreDraftJson (preDraftSnapshot.ts) for the export-gate snapshot.
  If-Match CAS like PATCH /unit.
- New env var TEMPLATE_QUICK_URL (api/src/index.ts Env), default
  https://uw-bt-bot.fly.dev/api/template-quick — same override pattern as
  TN_QUICK_URL. This is an ASSUMED bot-side contract (not yet implemented
  upstream on uw-bt-bot.fly.dev, a separate service/repo) — same situation
  tn-quick.ts itself is in.
- Frontend: "Draft with AI" button in TemplateWorkspace.tsx next to Save, new
  hook web/src/hooks/useTemplateAiDraft.ts (useAiDrafts.ts pattern, simplified
  — only one TemplateEditor mounts at a time so no notification stack needed).
  Button disables while dirty (unsaved edit) or validated, so a draft can
  never silently clobber unsaved work or an approved translation.
- Verified: typecheck clean, `npm --workspace web run test` 15/15 pass, build
  succeeds, and browser-driven (chrome-devtools MCP) click-through against a
  wrangler dev instance seeded via POST /api/templates/sync — button renders,
  fires the right request with If-Match, 503-disabled path surfaces correctly
  in the UI, dirty-state disable guard works.
- NOT verified: the actual successful AI-generation round trip, since
  BT_API_TOKEN is empty in dev.vars locally and there's no live
  /api/template-quick endpoint yet to call.
