-- Free-form markdown list of recurring translation problems for this
-- language (false friends, grammar traps, formatting habits to avoid).
-- Rendered into the exported context pack's instructions.md alongside
-- instructions_md so it reaches the AI drafting prompt.
ALTER TABLE translation_prefs ADD COLUMN common_issues_md TEXT;
