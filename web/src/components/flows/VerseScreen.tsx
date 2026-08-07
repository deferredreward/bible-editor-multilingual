// TODO(i18n) — flow screens ship English literals until the i18n sweep.
// Stub: replaced by the real port of docs/mockups/book-package/verse.html in this stack.
import { Box, Typography } from "@mui/material";
import { FlowNav } from "./FlowNav";
import type { FlowScreenContext } from "./types";

export interface VerseScreenProps extends FlowScreenContext {
  book: string;
  chapter: number;
  verse: number;
}

export default function VerseScreen({ role, book, chapter, verse }: VerseScreenProps) {
  return (
    <Box sx={{ p: 3, maxWidth: 960, marginInline: "auto" }}>
      <FlowNav current="verse" book={book} chapter={chapter} verse={verse} role={role} />
      <Typography variant="h5" sx={{ mt: 3 }}>
        Verse overview — being built
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 1 }}>
        This screen is being ported from docs/mockups/book-package/verse.html.
      </Typography>
    </Box>
  );
}
