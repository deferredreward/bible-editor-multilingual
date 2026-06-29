// The pinned lexical box: double-clicking a Hebrew/Greek source word opens this
// interactive Popover with the same lexical info as the hover Tooltip, but with
// selectable/copyable text (the hover Tooltip is pointerEvents:none and can't
// be). A copy button lifts the lexical form (lemma) to the clipboard; an X
// closes it. Shared by the scripture-column source line (HebrewLine) and the
// aligner's UHB strip (UhbStrip).

import { useState } from "react";
import { Popover, IconButton, Tooltip } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import type { SourceWord } from "../lib/alignment";
import type { LexiconEntry } from "../hooks/useLexicon";
import { SourceTooltipBody } from "./SourceTooltipBody";

export function PinnedLexBox({
  anchorEl,
  source,
  lex,
  twHint,
  onClose,
}: {
  anchorEl: HTMLElement;
  source: SourceWord;
  lex: LexiconEntry | null;
  twHint: string | null;
  onClose: () => void;
}) {
  const lemma = lex?.lemma || source.lemma || "";
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!lemma) return;
    try {
      await navigator.clipboard.writeText(lemma);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard blocked (insecure context / permissions) — no-op
    }
  };
  return (
    <Popover
      open
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      transformOrigin={{ vertical: "top", horizontal: "center" }}
      slotProps={{
        paper: {
          sx: {
            bgcolor: "rgba(33,33,33,0.97)",
            color: "#fff",
            maxWidth: 360,
            p: 1,
            pt: 3,
            position: "relative",
            overflow: "visible",
          },
        },
      }}
    >
      {lemma && (
        <Tooltip title={copied ? "copied" : "copy lexical form"}>
          <IconButton
            size="small"
            aria-label="copy lexical form"
            onClick={copy}
            sx={{ position: "absolute", top: 2, left: 2, color: "rgba(255,255,255,0.7)" }}
          >
            {copied ? (
              <CheckIcon sx={{ fontSize: 15 }} />
            ) : (
              <ContentCopyIcon sx={{ fontSize: 15 }} />
            )}
          </IconButton>
        </Tooltip>
      )}
      <IconButton
        size="small"
        aria-label="close"
        onClick={onClose}
        sx={{ position: "absolute", top: 2, right: 2, color: "rgba(255,255,255,0.7)" }}
      >
        <CloseIcon sx={{ fontSize: 16 }} />
      </IconButton>
      <SourceTooltipBody source={source} lex={lex} twHint={twHint} />
    </Popover>
  );
}
