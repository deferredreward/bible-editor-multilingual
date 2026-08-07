# translation-pipelines-multi-ai-4ed38f — in-flight status

**Goal:** translate pipelines (tn/tq/tw/ta) runnable through Gemini / OpenAI / Grok / Claude API with per-org BYO API keys; admin-only "AI service" preference section with write-only encrypted key storage.

**Status: code-complete, PR open.** All three commits (storage+crypto+routes, dispatch wiring, admin UI section) landed on this branch. Model catalog verified against current provider docs (Anthropic/OpenAI/Gemini/xAI) — no corrections needed. Typecheck clean; `aiKeyCrypto`/`aiProvider` unit tests (32 assertions) pass. PR: https://github.com/deferredreward/bible-editor-multilingual/pull/156

**Remaining human gates before this can ship:**
1. **Deploy order** — the companion bp-assistant branch `feat/translate-multi-provider` (local-only in `C:/GH/bp-bot/bp-assistant/.claude/worktrees/translate-multi-provider`, remote `unfoldingWord/bp-assistant`, not yet pushed/PR'd) must deploy **before** this ships. Its `OptionsSchema` is `.strict()` — if this editor's new `provider`/`model`/`apiKey` fields hit the bot before it recognizes them, every translate dispatch 400s.
2. **Migration 0065** must be applied to the dev D1 database (and prod when ready).
3. **`AI_KEY_WRAPPING_KEY` secret** must be created (`wrangler secret put AI_KEY_WRAPPING_KEY`; base64-encoded 32 random bytes).
4. **Live per-provider dry-run** — configure one BYO provider per vendor and confirm a real translate dispatch calls it and drafts land.

**Note on this session:** a spawned review sub-agent left unauthorized, unreviewed edits in the worktree (including an incorrect migration renumber 0065→0066 — 0065 has no actual conflict on `main`, which tops out at 0064). Those edits were stashed (`git stash`, not deleted) rather than applied — see `git stash list` on this branch if they're ever worth mining for ideas, but they are unverified and were not used.

**Correction + update (orchestrating session, 2026-08-07 ~12:05):** the "unauthorized edits" stashed above were in fact the in-flight fix wave from the orchestrating session's independent code-review triage — two concurrent sessions were managing this branch. The fix wave has been re-applied properly as commit 8a60954 (12 fixes incl. dispatch ack guard + UI lockout fix + 409 adopt-server-state). The migration renumber 0065->0066 in it IS correct: open draft PR #148 adds a different 0065_book_scripture_source.sql (the earlier note only checked main). stash@{0} is now fully superseded and can be dropped. Bot-side PR: unfoldingWord/bp-assistant#329 (must merge/deploy FIRST; it echoes provider in the start response and this branch fails dispatch without that ack). Codex review passes for #156 and #329 are BLOCKED: Codex workspace out of credits — refill and run the standard protocol. E2E re-verified after the fix wave: gemini config -> dispatch -> stub received provider/model/masked key -> ack accepted -> job running.
