// Find/replace overlay used by ScriptureColumn's book mode. Scope is the
// loaded chapter cache from useBook — chapters that haven't been pulled in
// by IntersectionObserver yet are invisible to the search until they load,
// which we surface in the result count.
//
// The regex builder escapes special characters when not in regex mode so
// "1:1" finds "1:1" literally; in regex mode we trust the user. Invalid
// patterns produce no matches and a red border on the input.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Stack,
  TextField,
  IconButton,
  Tooltip,
  Typography,
  ToggleButton,
  Button,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import type { ChapterState } from "../hooks/useBook";
import type { VerseDto } from "../sync/api";
import { smartReplaceVerse } from "../lib/replace";

export interface FindMatch {
  chapter: number;
  verse: number;
  bibleVersion: string;
  startIndex: number;
  endIndex: number;
  matchText: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  chapters: Map<number, ChapterState>;
  enabledVersions: string[];
  // Replace target: caller persists the rewritten content. The overlay
  // builds the new verseObjects + plain text via smartReplaceVerse so
  // alignment is preserved whenever the find/replace word counts line up.
  onReplaceVerse: (
    chapter: number,
    verse: number,
    bibleVersion: string,
    newContent: unknown,
    newPlainText: string,
    base: VerseDto,
  ) => void;
  // Active-match callback so the caller can scroll the right cell into view.
  onActiveMatchChange: (match: FindMatch | null) => void;
  // Lift the query state up so VerseCell can paint inline marks alongside the
  // existing note-quote highlights.
  onQueryChange: (query: { find: string; regex: boolean; caseSensitive: boolean } | null) => void;
}

export function FindReplaceOverlay({
  open,
  onClose,
  chapters,
  enabledVersions,
  onReplaceVerse,
  onActiveMatchChange,
  onQueryChange,
}: Props) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const findInputRef = useRef<HTMLInputElement | null>(null);

  // Focus the find input when the overlay opens (Ctrl/Cmd+F flow).
  useEffect(() => {
    if (open) {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }
  }, [open]);

  // Push query down to the caller so verse cells can paint match marks.
  useEffect(() => {
    if (!open || !find) {
      onQueryChange(null);
      return;
    }
    onQueryChange({ find, regex, caseSensitive });
  }, [open, find, regex, caseSensitive, onQueryChange]);

  const compiled = useMemo(() => buildSearchRegex(find, regex, caseSensitive), [find, regex, caseSensitive]);
  const regexInvalid = !!find && compiled.error;

  const matches = useMemo<FindMatch[]>(() => {
    if (!open || !compiled.re) return [];
    return collectMatches(chapters, enabledVersions, compiled.re);
  }, [open, compiled.re, chapters, enabledVersions]);

  // Clamp activeIdx whenever the match list reshapes.
  useEffect(() => {
    if (matches.length === 0) {
      setActiveIdx(0);
      onActiveMatchChange(null);
      return;
    }
    const idx = Math.min(activeIdx, matches.length - 1);
    setActiveIdx(idx);
    onActiveMatchChange(matches[idx]);
  }, [matches, activeIdx, onActiveMatchChange]);

  const goPrev = () => {
    if (matches.length === 0) return;
    setActiveIdx((i) => (i - 1 + matches.length) % matches.length);
  };
  const goNext = () => {
    if (matches.length === 0) return;
    setActiveIdx((i) => (i + 1) % matches.length);
  };

  const doReplaceMatch = (m: FindMatch) => {
    const state = chapters.get(m.chapter);
    if (!state || state.kind !== "ready") return;
    const verse = state.data.verses[m.bibleVersion]?.[m.verse];
    if (!verse) return;
    if (!compiled.re) return;
    const text = verse.plain_text ?? "";
    const result = smartReplaceVerse(
      verse.content,
      text,
      compiled.re,
      m.startIndex,
      m.endIndex - m.startIndex,
      replace,
    );
    if (result.plainText === text) return;
    onReplaceVerse(m.chapter, m.verse, m.bibleVersion, result.content, result.plainText, verse);
  };

  const doReplaceAll = () => {
    if (!compiled.re || matches.length === 0) return;
    // Sort matches per-verse from end → start so each rewrite doesn't
    // invalidate the indices of later ones; we still ship one PATCH per
    // verse by collapsing the intermediate results.
    const byVerse = new Map<string, FindMatch[]>();
    for (const m of matches) {
      const key = `${m.chapter}|${m.verse}|${m.bibleVersion}`;
      const list = byVerse.get(key) ?? [];
      list.push(m);
      byVerse.set(key, list);
    }
    for (const [key, list] of byVerse) {
      const [chStr, vStr, bv] = key.split("|");
      const ch = parseInt(chStr, 10);
      const v = parseInt(vStr, 10);
      const state = chapters.get(ch);
      if (!state || state.kind !== "ready") continue;
      const verse = state.data.verses[bv]?.[v];
      if (!verse) continue;
      // Apply replacements in reverse plain-text order so the earlier
      // matches' indices stay valid as we mutate.
      const ordered = [...list].sort((a, b) => b.startIndex - a.startIndex);
      let content: unknown = verse.content;
      let plainText = verse.plain_text ?? "";
      for (const mm of ordered) {
        const result = smartReplaceVerse(
          content,
          plainText,
          compiled.re,
          mm.startIndex,
          mm.endIndex - mm.startIndex,
          replace,
        );
        content = result.content;
        plainText = result.plainText;
      }
      if (plainText === verse.plain_text) continue;
      onReplaceVerse(ch, v, bv, content, plainText, verse);
    }
  };

  if (!open) return null;

  const counts = countChapterStates(chapters);

  return (
    <Box
      sx={{
        position: "sticky",
        top: 0,
        zIndex: 10,
        bgcolor: "background.paper",
        borderBottom: "1px solid",
        borderColor: "divider",
        boxShadow: "0 2px 6px rgba(0,0,0,0.06)",
        px: 1.5,
        py: 1,
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1}>
        <TextField
          inputRef={findInputRef}
          value={find}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) goPrev();
              else goNext();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          size="small"
          placeholder="find"
          error={regexInvalid}
          helperText={regexInvalid ? "invalid regex" : undefined}
          sx={{ minWidth: 240, "& .MuiFormHelperText-root": { m: 0, lineHeight: 1.2 } }}
          inputProps={{ style: { fontFamily: "monospace", fontSize: 13 } }}
        />
        <Tooltip title="use the input as a JavaScript regex">
          <ToggleButton
            value="regex"
            size="small"
            selected={regex}
            onChange={() => setRegex((r) => !r)}
            sx={{ px: 1, fontFamily: "monospace", fontSize: 12, textTransform: "none" }}
          >
            .*
          </ToggleButton>
        </Tooltip>
        <Tooltip title="case-sensitive">
          <ToggleButton
            value="case"
            size="small"
            selected={caseSensitive}
            onChange={() => setCaseSensitive((c) => !c)}
            sx={{ px: 1, fontFamily: "monospace", fontSize: 12, textTransform: "none" }}
          >
            Aa
          </ToggleButton>
        </Tooltip>
        <Typography
          variant="caption"
          sx={{ fontFamily: "monospace", minWidth: 72, textAlign: "center", color: "text.secondary" }}
        >
          {matches.length === 0 ? "no results" : `${activeIdx + 1} / ${matches.length}`}
        </Typography>
        <Tooltip title="previous match (Shift+Enter)">
          <span>
            <IconButton size="small" onClick={goPrev} disabled={matches.length === 0}>
              <ArrowUpwardIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="next match (Enter)">
          <span>
            <IconButton size="small" onClick={goNext} disabled={matches.length === 0}>
              <ArrowDownwardIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: "monospace" }}>
          scope: {counts.ready}/{counts.total} ch loaded
        </Typography>
        <Tooltip title="close (Esc)">
          <IconButton size="small" onClick={onClose}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.75 }}>
        <TextField
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
          size="small"
          placeholder="replace"
          sx={{ minWidth: 240 }}
          inputProps={{ style: { fontFamily: "monospace", fontSize: 13 } }}
        />
        <Tooltip title="replace the active match (this verse only, overwrites alignment for it)">
          <span>
            <Button
              size="small"
              variant="outlined"
              onClick={() => {
                const m = matches[activeIdx];
                if (m) doReplaceMatch(m);
              }}
              disabled={matches.length === 0}
              sx={{ textTransform: "none" }}
            >
              replace
            </Button>
          </span>
        </Tooltip>
        <Tooltip title="replace every match in every loaded chapter (one PATCH per affected verse; alignment is overwritten where it lands)">
          <span>
            <Button
              size="small"
              variant="contained"
              color="warning"
              onClick={doReplaceAll}
              disabled={matches.length === 0}
              sx={{ textTransform: "none" }}
            >
              replace all
            </Button>
          </span>
        </Tooltip>
      </Stack>
    </Box>
  );
}

// ---------- helpers ----------

function buildSearchRegex(
  query: string,
  regex: boolean,
  caseSensitive: boolean,
): { re: RegExp | null; error: boolean } {
  if (!query) return { re: null, error: false };
  try {
    const pattern = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = caseSensitive ? "g" : "gi";
    return { re: new RegExp(pattern, flags), error: false };
  } catch {
    return { re: null, error: true };
  }
}

function collectMatches(
  chapters: Map<number, ChapterState>,
  enabledVersions: string[],
  re: RegExp,
): FindMatch[] {
  const out: FindMatch[] = [];
  const chList = [...chapters.keys()].sort((a, b) => a - b);
  for (const ch of chList) {
    const state = chapters.get(ch);
    if (!state || state.kind !== "ready") continue;
    for (const bv of enabledVersions) {
      const byVerse = state.data.verses[bv];
      if (!byVerse) continue;
      const verseNums = Object.keys(byVerse)
        .map(Number)
        .sort((a, b) => a - b);
      for (const v of verseNums) {
        const text = byVerse[v].plain_text ?? "";
        if (!text) continue;
        // Use a fresh regex per verse so lastIndex doesn't bleed.
        const localRe = new RegExp(re.source, re.flags);
        let m: RegExpExecArray | null;
        while ((m = localRe.exec(text)) !== null) {
          out.push({
            chapter: ch,
            verse: v,
            bibleVersion: bv,
            startIndex: m.index,
            endIndex: m.index + m[0].length,
            matchText: m[0],
          });
          if (m[0].length === 0) localRe.lastIndex++;
        }
      }
    }
  }
  return out;
}

function countChapterStates(chapters: Map<number, ChapterState>): {
  ready: number;
  total: number;
} {
  let ready = 0;
  for (const s of chapters.values()) if (s.kind === "ready") ready++;
  return { ready, total: chapters.size };
}
