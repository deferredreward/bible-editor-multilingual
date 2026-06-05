-- "Trash" state for translation notes: a visible, restorable soft-delete that
-- sits between live and the permanent `deleted_at` tombstone. The delete button
-- sets `trashed_at` (note grays out, drops to the bottom of the verse, gains a
-- Restore button); the 06:00 UTC nightly job promotes `trashed_at` -> deleted_at
-- so trash is finalized once per day. Distinct from deleted_at on purpose:
-- deleted_at rows are hidden + export-excluded + reimport-skipped (resurrection
-- proof), while trashed_at rows stay visible and restorable until finalized.
-- NULL (the default for every existing row) means "not trashed".

ALTER TABLE tn_rows ADD COLUMN trashed_at INTEGER;
