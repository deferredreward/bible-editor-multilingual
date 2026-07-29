-- Editor allowlist. Until this table lands, any DCS account that completes
-- OAuth could mint a JWT and write to D1. callbackDcsAuth now checks
-- user_roles BEFORE upserting into users, so unknown accounts never persist.
--
-- COLLATE NOCASE on the PK so case mismatches in DCS logins ("PJOakes" vs
-- "pjoakes") don't silently lock people out. SQLite enforces uniqueness with
-- the collation, so insert-or-ignore is safe across casings.

CREATE TABLE user_roles (
  dcs_username TEXT PRIMARY KEY COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
  added_at INTEGER NOT NULL DEFAULT (unixepoch()),
  added_by INTEGER REFERENCES users(id)
);

-- Seed: 1 admin only. Every per-org database runs this same migration set, so
-- anything seeded here lands in EVERY new org DB. Add editors via SQL per
-- database — no redeploy needed.
INSERT OR IGNORE INTO user_roles (dcs_username, role) VALUES
  ('deferredreward', 'admin');
