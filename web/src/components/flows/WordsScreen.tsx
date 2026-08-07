// TODO(i18n) — flow screens ship English literals until the i18n sweep.
// Stub: replaced by the real port of docs/flows/ui/t6-words.html in this stack.
import { Box, Typography } from "@mui/material";
import { FlowNav } from "./FlowNav";
import type { FlowScreenContext } from "./types";

export interface WordsScreenProps extends FlowScreenContext {
  book: string;
  chapter: number;
  verse: number;
}

export default function WordsScreen({ role, book, chapter, verse }: WordsScreenProps) {
  return (
    <Box sx={{ p: 3, maxWidth: 960, marginInline: "auto" }}>
      <FlowNav current="words" book={book} chapter={chapter} verse={verse} role={role} />
      <Typography variant="h5" sx={{ mt: 3 }}>
        Word links — being built
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 1 }}>
        This screen is being ported from docs/flows/ui/t6-words.html.
      </Typography>
    </Box>
  );
}
