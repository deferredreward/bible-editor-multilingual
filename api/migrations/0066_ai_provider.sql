-- Per-organization AI provider config (one row per workspace D1, like
-- project_config / translation_prefs). Selects which model drafts this org's
-- AI output, and holds that org's own API key when they bring one.
--
-- provider='default' — the shared unfoldingWord subscription, i.e. today's
-- behavior. Semantically identical to the row being absent, which is why the
-- routes treat "no row" and "provider=default" as the same state.
--
-- The key is WRITE-ONLY from the client's point of view: plaintext exists only
-- inside one request body and is never persisted, logged, or read back. What
-- lands in D1 is AES-256-GCM ciphertext plus its per-write IV (api/src/
-- aiKeyCrypto.ts); the wrapping key is the AI_KEY_WRAPPING_KEY Worker secret,
-- which lives outside the database, so a D1 dump alone can't recover a key.
-- key_hint is the last 4 characters only — enough for an admin to recognize
-- which key is stored, useless as a credential.
--
-- Clearing a key NULLs the three key columns but KEEPS the row, so `version`
-- stays monotonic and the If-Match CAS a concurrent admin is holding still
-- resolves correctly (deleting the row would reset version to 0 and let a
-- stale writer's If-Match:0 silently win).

CREATE TABLE ai_provider_config (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  provider       TEXT NOT NULL DEFAULT 'default',  -- default|claude|openai|gemini|xai
  model          TEXT,                             -- NULL iff provider='default'
  key_ciphertext TEXT,                             -- base64 AES-256-GCM ciphertext; NULL = no key stored
  key_iv         TEXT,                             -- base64 12-byte IV, fresh per write (GCM requires it)
  key_hint       TEXT,                             -- last 4 chars of the key, for display only
  version        INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by     INTEGER REFERENCES users(id)
);
