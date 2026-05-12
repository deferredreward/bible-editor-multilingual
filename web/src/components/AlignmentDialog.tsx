import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  Stack,
  Chip,
  IconButton,
  Paper,
  Tooltip,
} from "@mui/material";
import LinkIcon from "@mui/icons-material/Link";
import CloseIcon from "@mui/icons-material/Close";
import {
  alignmentPlainText,
  clearGroup,
  moveSource,
  moveTarget,
  parseAlignment,
  serializeAlignment,
  type AlignmentState,
} from "../lib/alignment";
import type { VerseDto } from "../sync/api";

interface Props {
  open: boolean;
  book: string;
  chapter: number;
  verseNum: number;
  bibleVersion: string;
  verse: VerseDto | null;
  contextOther: VerseDto | null; // the "other" gateway translation (UST when editing ULT, etc.)
  onClose: () => void;
  onSave: (newContent: unknown, plainText: string, expectedVersion: number) => void;
}

export function AlignmentDialog({
  open,
  book,
  chapter,
  verseNum,
  bibleVersion,
  verse,
  contextOther,
  onClose,
  onSave,
}: Props) {
  const initial = useMemo<AlignmentState | null>(() => {
    if (!verse?.content) return null;
    const verseObjects = (verse.content as { verseObjects?: unknown[] }).verseObjects;
    if (!Array.isArray(verseObjects)) return null;
    return parseAlignment(verseObjects);
  }, [verse]);

  const [state, setState] = useState<AlignmentState | null>(initial);
  useEffect(() => {
    setState(initial);
  }, [initial]);

  const handleTargetDrop = (dest: string, wordId: string) => {
    if (!state) return;
    setState(moveTarget(state, wordId, dest));
  };

  const handleSourceDrop = (destGroupId: string, sourceId: string) => {
    if (!state) return;
    setState(moveSource(state, sourceId, destGroupId));
  };

  const handleClearGroup = (groupId: string) => {
    if (!state) return;
    setState(clearGroup(state, groupId));
  };

  const handleReset = () => setState(initial);
  const handleSave = () => {
    if (!state || !verse) return;
    const newVerseObjects = serializeAlignment(state);
    const newContent = { verseObjects: newVerseObjects };
    const plain = alignmentPlainText(state);
    onSave(newContent, plain, verse.version);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <LinkIcon sx={{ color: "success.main" }} />
        <Box>
          Aligning {book} {chapter}:{verseNum} · {bibleVersion}
        </Box>
        <Box sx={{ flex: 1 }} />
        <IconButton size="small" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        {!state && (
          <Box sx={{ p: 3 }}>
            <Typography variant="body2" color="text.secondary">
              no alignment data for this verse — either the source has no `\zaln-s` markers,
              or the verse was recently edited and alignment was cleared.
            </Typography>
          </Box>
        )}
        {state && (
          <>
            <VerseStrip verse={verse} other={contextOther} bibleVersion={bibleVersion} chapter={chapter} verseNum={verseNum} />
            <Box sx={{ display: "grid", gridTemplateColumns: "220px 1fr", height: 480, overflow: "hidden" }}>
              <UnalignedBag state={state} onDrop={(wordId) => handleTargetDrop("u", wordId)} />
              <AlignmentGrid
                state={state}
                onTargetDrop={handleTargetDrop}
                onSourceDrop={handleSourceDrop}
                onClearGroup={handleClearGroup}
              />
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1, gap: 1 }}>
        <Box sx={{ flex: 1 }} />
        <Button onClick={handleReset} disabled={!state}>
          reset
        </Button>
        <Button onClick={onClose}>cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={!state}>
          save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function VerseStrip({
  verse,
  other,
  bibleVersion,
  chapter,
  verseNum,
}: {
  verse: VerseDto | null;
  other: VerseDto | null;
  bibleVersion: string;
  chapter: number;
  verseNum: number;
}) {
  const otherLabel = bibleVersion === "ULT" ? "UST" : bibleVersion === "UST" ? "ULT" : "UST";
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: "54px 1fr 1fr",
        gap: 2,
        px: 3,
        py: 1.5,
        bgcolor: "primary.50",
        borderBottom: "1px dashed",
        borderColor: "divider",
        fontSize: 13.5,
        lineHeight: 1.4,
      }}
    >
      <Box sx={{ fontFamily: "monospace", color: "primary.main", fontWeight: 700 }}>
        {chapter}:{verseNum}
      </Box>
      <Box>
        <Chip label={bibleVersion} size="small" sx={{ mr: 1, fontFamily: "monospace", height: 18 }} />
        {verse?.plain_text}
      </Box>
      <Box>
        <Chip label={otherLabel} size="small" sx={{ mr: 1, fontFamily: "monospace", height: 18 }} />
        {other?.plain_text}
      </Box>
    </Box>
  );
}

function UnalignedBag({
  state,
  onDrop,
}: {
  state: AlignmentState;
  onDrop: (wordId: string) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <Box
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const wordId = e.dataTransfer.getData("text/word-id");
        if (wordId) onDrop(wordId);
      }}
      sx={{
        bgcolor: over ? "primary.50" : "grey.50",
        borderRight: "1px solid",
        borderColor: "divider",
        p: 1.5,
        overflowY: "auto",
      }}
    >
      <Typography
        variant="caption"
        sx={{
          fontFamily: "monospace",
          color: "text.disabled",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          display: "block",
          mb: 1,
        }}
      >
        unaligned GL words ({state.unaligned.length})
      </Typography>
      {state.unaligned.length === 0 && (
        <Typography variant="caption" color="text.disabled">
          drag a word here to detach it from its source
        </Typography>
      )}
      <Stack spacing={0.5}>
        {state.unaligned.map((w) => (
          <DraggableChip key={w.id} wordId={w.id} text={w.text} />
        ))}
      </Stack>
    </Box>
  );
}

function AlignmentGrid({
  state,
  onTargetDrop,
  onSourceDrop,
  onClearGroup,
}: {
  state: AlignmentState;
  onTargetDrop: (dest: string, wordId: string) => void;
  onSourceDrop: (destGroupId: string, sourceId: string) => void;
  onClearGroup: (groupId: string) => void;
}) {
  // Hebrew/Greek reads RTL, so order the alignment cards right-to-left to
  // match how the user reads the source verse. Card internals (the GL target
  // chips) stay LTR via `direction: ltr` on the card itself.
  return (
    <Box
      sx={{
        p: 1.5,
        overflowY: "auto",
        display: "flex",
        flexWrap: "wrap",
        gap: 1.5,
        alignContent: "flex-start",
        direction: "rtl",
      }}
    >
      {state.groups.map((g) => (
        <DropTargetBox
          key={g.id}
          groupId={g.id}
          onTargetDrop={(wordId) => onTargetDrop(`g:${g.id}`, wordId)}
          onSourceDrop={(sourceId) => onSourceDrop(g.id, sourceId)}
        >
          <Stack direction="row" alignItems="flex-start" sx={{ mb: 0.5, direction: "ltr" }}>
            <Stack direction="column" spacing={0.25} sx={{ flex: 1 }}>
              {g.source.map((s) => (
                <Tooltip
                  key={s.id}
                  title={
                    <Box>
                      <div>{s.strong}</div>
                      <div>{s.lemma}</div>
                      <div>{s.morph}</div>
                    </Box>
                  }
                >
                  <Paper
                    elevation={0}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/source-id", s.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    sx={{
                      bgcolor: "grey.900",
                      color: "grey.50",
                      px: 1.2,
                      py: 0.5,
                      fontFamily: '"Times New Roman", "SBL Hebrew", "Cardo", serif',
                      fontSize: 20,
                      textAlign: "center",
                      direction: "rtl",
                      borderRadius: 0.5,
                      cursor: "grab",
                      "&:active": { cursor: "grabbing" },
                    }}
                  >
                    {s.content}
                  </Paper>
                </Tooltip>
              ))}
            </Stack>
            <Tooltip title="clear alignment for this block (sends GL words back to the unaligned bag and splits compound source)">
              <IconButton
                size="small"
                onClick={() => onClearGroup(g.id)}
                sx={{ ml: 0.5, p: 0.25, color: "text.disabled", "&:hover": { color: "error.main" } }}
              >
                <CloseIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </Stack>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" rowGap={0.5} sx={{ direction: "ltr" }}>
            {g.targets.length === 0 ? (
              <Typography
                variant="caption"
                sx={{ color: "text.disabled", fontStyle: "italic", px: 0.5 }}
              >
                drop here
              </Typography>
            ) : (
              g.targets.map((t) => <DraggableChip key={t.id} wordId={t.id} text={t.text} />)
            )}
          </Stack>
        </DropTargetBox>
      ))}
    </Box>
  );
}

function DropTargetBox({
  groupId,
  onTargetDrop,
  onSourceDrop,
  children,
}: {
  groupId: string;
  onTargetDrop: (wordId: string) => void;
  onSourceDrop: (sourceId: string) => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <Paper
      variant="outlined"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const wordId = e.dataTransfer.getData("text/word-id");
        if (wordId) {
          onTargetDrop(wordId);
          return;
        }
        const sourceId = e.dataTransfer.getData("text/source-id");
        if (sourceId) onSourceDrop(sourceId);
      }}
      data-group-id={groupId}
      sx={{
        minWidth: 110,
        p: 0.75,
        bgcolor: over ? "primary.50" : "background.paper",
        borderColor: over ? "primary.main" : "divider",
        borderWidth: over ? 1.5 : 1,
        borderStyle: "solid",
        display: "flex",
        flexDirection: "column",
        direction: "ltr",
      }}
    >
      {children}
    </Paper>
  );
}

function DraggableChip({ wordId, text }: { wordId: string; text: string }) {
  return (
    <Chip
      label={text}
      size="small"
      variant="outlined"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/word-id", wordId);
        e.dataTransfer.effectAllowed = "move";
      }}
      sx={{
        cursor: "grab",
        fontFamily: '"Roboto","Helvetica",sans-serif',
        borderLeft: "3px solid",
        borderLeftColor: "primary.main",
        bgcolor: "background.paper",
      }}
    />
  );
}
