-- Per-verse "done" flag so editors can tick verses off as they finish them.
-- Single-team scope for v1; per-user state will come with auth.

CREATE TABLE verse_statuses (
  book TEXT NOT NULL,
  chapter INTEGER NOT NULL,
  verse INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (book, chapter, verse)
);
CREATE INDEX verse_statuses_chapter ON verse_statuses(book, chapter);
