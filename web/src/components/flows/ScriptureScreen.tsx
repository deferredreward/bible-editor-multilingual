// TODO(i18n) — flow screens ship English literals until the i18n sweep.
// Stub: replaced by the real port of docs/flows/ui/t3-scripture.html in this stack.
import { Box, Typography } from "@mui/material";
import { FlowNav } from "./FlowNav";
import type { FlowScreenContext } from "./types";

export interface ScriptureScreenProps extends FlowScreenContext {
  book: string;
  chapter: number;
  verse: number;
}

export default function ScriptureScreen({ role, book, chapter, verse }: ScriptureScreenProps) {
  return (
    <Box sx={{ p: 3, maxWidth: 960, marginInline: "auto" }}>
      <FlowNav current="scripture" book={book} chapter={chapter} verse={verse} role={role} />
      <Typography variant="h5" sx={{ mt: 3 }}>
        Scripture — being built
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 1 }}>
        This screen is being ported from docs/flows/ui/t3-scripture.html.
      </Typography>
    </Box>
  );
}
