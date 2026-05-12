import { useEffect, useRef, useState } from "react";
import { Paper, Stack, Chip, IconButton, Typography, Box, TextField, Tooltip } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AddIcon from "@mui/icons-material/Add";
import type { TnRow } from "../sync/api";
import { useCatalogs } from "../hooks/useCatalogs";
import { CatalogPicker } from "./CatalogPicker";

interface Props {
  row: TnRow;
  active: boolean;
  onChange: (patch: Partial<TnRow>) => void;
  onDelete: () => void;
  onInsertAfter: () => void;
  onFocus?: () => void;
}

// Notes coming from TSV imports use literal "\n" (two characters) as the
// line-break marker. tcCreate renders those as real newlines; we do the same
// on read, and on save we write back whatever the user typed verbatim. The
// data in D1 transitions to true newlines as users edit.
function tsvToDisplay(s: string | null): string {
  return (s ?? "").replace(/\\n/g, "\n");
}

export function NoteCard({ row, active, onChange, onDelete, onInsertAfter, onFocus }: Props) {
  const [quote, setQuote] = useState(tsvToDisplay(row.quote));
  const [note, setNote] = useState(tsvToDisplay(row.note));
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const catalogs = useCatalogs();

  // Re-sync when the row changes from outside (e.g. server-confirmed update).
  useEffect(() => {
    setQuote(tsvToDisplay(row.quote));
  }, [row.id, row.version, row.quote]);
  useEffect(() => {
    setNote(tsvToDisplay(row.note));
  }, [row.id, row.version, row.note]);

  const queue = (patch: Partial<TnRow>) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onChange(patch);
      debounceRef.current = null;
    }, 300);
  };

  return (
    <Paper
      elevation={0}
      variant="outlined"
      onFocus={onFocus}
      sx={{
        my: 1,
        border: active ? "1.5px solid" : "1px solid",
        borderColor: active ? "primary.main" : "divider",
        bgcolor: active ? "primary.50" : "background.paper",
        overflow: "hidden",
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{
          px: 1,
          py: 0.5,
          borderBottom: "1px dashed",
          borderColor: "divider",
          bgcolor: "rgba(0,0,0,0.02)",
          flexWrap: "wrap",
        }}
      >
        <Box sx={{ cursor: "grab", color: "text.disabled", fontFamily: "monospace", fontSize: 13 }}>⋮⋮</Box>
        <Chip
          label={row.id}
          size="small"
          variant="outlined"
          sx={{ fontFamily: "monospace", fontSize: 11, height: 22 }}
        />
        <CatalogPicker
          value={row.support_reference}
          options={catalogs.supportReferences}
          display={(v) => (v ? shortSupport(v) : "+ support ref")}
          placeholder="figs-, translate-, writing-, …"
          color="primary"
          variant={active ? "filled" : "outlined"}
          onChange={(next) => onChange({ support_reference: next })}
        />
        <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: "monospace" }}>
          {row.ref_raw}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip
          title={`v${row.version} — row was saved ${row.version - 1} time${row.version - 1 === 1 ? "" : "s"}; last update ${new Date(row.updated_at * 1000).toLocaleString()}`}
        >
          <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: "monospace", cursor: "help" }}>
            v{row.version}
          </Typography>
        </Tooltip>
        <Tooltip title="add a new note after this one">
          <IconButton size="small" onClick={onInsertAfter} color="success" sx={{ p: 0.25 }}>
            <AddIcon fontSize="inherit" />
          </IconButton>
        </Tooltip>
        <Tooltip title="delete this note">
          <IconButton size="small" onClick={onDelete} color="error" sx={{ p: 0.25 }}>
            <DeleteOutlineIcon fontSize="inherit" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Box sx={{ p: 1 }}>
        <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mb: 0.5 }}>
          <Typography
            variant="caption"
            sx={{
              fontFamily: "monospace",
              color: "text.secondary",
              textTransform: "uppercase",
              minWidth: 54,
              textAlign: "right",
              pt: 1.25,
              flexShrink: 0,
            }}
          >
            Quote
          </Typography>
          <TextField
            value={quote}
            onChange={(e) => {
              setQuote(e.target.value);
              queue({ quote: e.target.value });
            }}
            multiline
            fullWidth
            size="small"
            spellCheck={false}
            onFocus={onFocus}
            inputProps={{
              dir: "rtl",
              style: {
                fontFamily: '"Times New Roman","SBL Hebrew","Cardo",serif',
                fontSize: 16,
                textAlign: "right",
                lineHeight: 1.5,
              },
            }}
          />
        </Stack>
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <Typography
            variant="caption"
            sx={{
              fontFamily: "monospace",
              color: "text.secondary",
              textTransform: "uppercase",
              minWidth: 54,
              textAlign: "right",
              pt: 1.25,
              flexShrink: 0,
            }}
          >
            Note
          </Typography>
          <TextField
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              queue({ note: e.target.value });
            }}
            multiline
            fullWidth
            minRows={2}
            size="small"
            spellCheck
            onFocus={onFocus}
            inputProps={{ style: { fontSize: 13, lineHeight: 1.5, fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif' } }}
          />
        </Stack>
      </Box>
    </Paper>
  );
}

function shortSupport(s: string): string {
  // 'rc://*/ta/man/translate/figs-explicit' -> 'figs-explicit'
  const m = s.match(/\/([^/]+)$/);
  return m ? m[1] : s;
}
