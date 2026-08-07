// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// Dense English-authoring grid for translationQuestions, after #questionsGrid
// in docs/flows/ui/t2-review.html (F.3 QuestionsTable). Authoring mode only —
// a translator reviewing drafts works one card at a time; a question author
// wants to see and fix twenty rows at once.
//
// Each row carries its own id + version. The mockup calls this out explicitly:
// with real deletes wired, a shared page-level "current row" id would let a
// click on row 3 act on whichever row happened to be selected.

import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { TqRow } from "../../sync/api";

export interface ReviewQuestionsGridProps {
  rows: TqRow[];
  refFor: (row: TqRow) => string;
  /**
   * Unsaved cell edits, keyed by row id. Owned by ReviewQueue, NOT by this
   * component: these are persisted to the drafts store under the same key the
   * card editor uses for the selected row (rowKey("tq", book, id)), so one
   * owner has to reconcile the two before writing. Only the cells the user
   * actually touched appear here; every other cell renders straight from the
   * row so a peer's change isn't masked by a stale local copy.
   */
  edits: Record<string, { question?: string; response?: string }>;
  onEditCell: (id: string, field: "question" | "response", value: string) => void;
  onSaveRow: (row: TqRow, patch: { question: string; response: string }) => void;
  onDeleteRow: (row: TqRow) => void;
  /** True while an AI pipeline holds the chapter — tq writes and deletes are both locked. */
  locked: boolean;
}

const cellSx = { paddingBlock: 0.5, paddingInline: 1, verticalAlign: "top" } as const;

export function ReviewQuestionsGrid({
  rows,
  refFor,
  edits,
  onEditCell,
  onSaveRow,
  onDeleteRow,
  locked,
}: ReviewQuestionsGridProps) {
  const valueOf = (row: TqRow, field: "question" | "response") =>
    edits[row.id]?.[field] ?? row[field] ?? "";

  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        mb: 1.5,
        overflowX: "auto",
        bgcolor: "background.paper",
      }}
    >
      <Box sx={{ p: 1.5, borderBlockEnd: "1px solid", borderColor: "divider" }}>
        <Typography
          variant="caption"
          component="h2"
          color="text.secondary"
          sx={{ fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}
        >
          Questions — dense grid (English authoring)
        </Typography>
      </Box>
      <Box component="table" sx={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
        <Box component="thead">
          <Box component="tr" sx={{ textAlign: "start", color: "text.secondary" }}>
            <Box component="th" sx={{ ...cellSx, textAlign: "start", width: 110 }}>
              Ref
            </Box>
            <Box component="th" sx={{ ...cellSx, textAlign: "start" }}>
              Question
            </Box>
            <Box component="th" sx={{ ...cellSx, textAlign: "start" }}>
              Response
            </Box>
            <Box component="th" sx={{ ...cellSx, width: 96 }} />
          </Box>
        </Box>
        <Box component="tbody">
          {rows.map((row) => {
            const dirty =
              valueOf(row, "question") !== (row.question ?? "") ||
              valueOf(row, "response") !== (row.response ?? "");
            return (
              <Box
                component="tr"
                key={row.id}
                sx={{ borderBlockEnd: "1px solid", borderColor: "divider" }}
              >
                <Box component="td" sx={cellSx}>
                  <Typography variant="caption">{refFor(row)}</Typography>
                </Box>
                <Box component="td" sx={cellSx}>
                  <TextField
                    fullWidth
                    size="small"
                    variant="standard"
                    value={valueOf(row, "question")}
                    onChange={(e) => onEditCell(row.id, "question", e.target.value)}
                    inputProps={{ "aria-label": `Question for ${refFor(row)}` }}
                  />
                </Box>
                <Box component="td" sx={cellSx}>
                  <TextField
                    fullWidth
                    size="small"
                    variant="standard"
                    value={valueOf(row, "response")}
                    onChange={(e) => onEditCell(row.id, "response", e.target.value)}
                    inputProps={{ "aria-label": `Response for ${refFor(row)}` }}
                  />
                </Box>
                <Box component="td" sx={{ ...cellSx, whiteSpace: "nowrap" }}>
                  <Tooltip
                    title={
                      locked
                        ? "Chapter is locked by an AI run — question edits are rejected"
                        : "Save"
                    }
                  >
                    <span>
                      <IconButton
                        size="small"
                        aria-label={`Save ${refFor(row)}`}
                        disabled={locked || !dirty}
                        onClick={() =>
                          // No local reset here: the owner applies the patch to
                          // its row copy, which makes this entry clean, and it
                          // then drops the entry and clears the draft.
                          onSaveRow(row, {
                            question: valueOf(row, "question"),
                            response: valueOf(row, "response"),
                          })
                        }
                      >
                        💾
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip
                    title={
                      locked
                        ? "Chapter is locked by an AI run — deletes are rejected for every kind"
                        : "Delete"
                    }
                  >
                    <span>
                      <IconButton
                        size="small"
                        aria-label={`Delete ${refFor(row)}`}
                        disabled={locked}
                        onClick={() => onDeleteRow(row)}
                      >
                        🗑
                      </IconButton>
                    </span>
                  </Tooltip>
                </Box>
              </Box>
            );
          })}
        </Box>
      </Box>
      {rows.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "start" }}>
          No questions for this chapter.
        </Typography>
      )}
    </Box>
  );
}
