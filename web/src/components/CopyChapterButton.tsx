// Shared "copy chapter to Word" icon button used by both the columns view
// (DocColumn, one version) and the book view (BookView chapter heading, all
// enabled versions). Owns the transient copied/error cue and the clipboard
// error handling in one place. `blocks` is a thunk so the version/verse data is
// gathered at click time, not on every render.

import { useState } from "react";
import { IconButton, Tooltip } from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import { copyChapterToClipboard, type ChapterCopyBlock } from "../lib/chapterCopy";

interface Props {
  book: string;
  chapter: number;
  blocks: () => ChapterCopyBlock[];
}

export function CopyChapterButton({ book, chapter, blocks }: Props) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");

  const handle = async (): Promise<void> => {
    try {
      await copyChapterToClipboard(book, chapter, blocks());
      setState("copied");
    } catch {
      // Clipboard write can reject (permission denied, document not focused,
      // non-secure context) — surface it instead of leaking an unhandled
      // rejection with no user feedback.
      setState("error");
    }
    window.setTimeout(() => setState("idle"), 1500);
  };

  const title =
    state === "copied" ? "Copied!" : state === "error" ? "Copy failed" : "Copy chapter (for Word)";

  return (
    <Tooltip title={title}>
      <IconButton size="small" aria-label="copy chapter" onClick={() => void handle()}>
        {state === "copied" ? (
          <CheckIcon fontSize="small" color="success" />
        ) : state === "error" ? (
          <ErrorOutlineIcon fontSize="small" color="error" />
        ) : (
          <ContentCopyIcon fontSize="small" />
        )}
      </IconButton>
    </Tooltip>
  );
}
