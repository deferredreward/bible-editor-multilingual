// TODO(i18n) — flow screens ship English literals until the i18n sweep.
// Stub: replaced by the real port of docs/flows/ui/t5-articles.html in this stack.
import { Box, Typography } from "@mui/material";
import { FlowNav } from "./FlowNav";
import type { FlowScreenContext } from "./types";

export interface ArticlesScreenProps extends FlowScreenContext {
}

export default function ArticlesScreen({ role }: ArticlesScreenProps) {
  return (
    <Box sx={{ p: 3, maxWidth: 960, marginInline: "auto" }}>
      <FlowNav current="articles" role={role} />
      <Typography variant="h5" sx={{ mt: 3 }}>
        Articles — being built
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 1 }}>
        This screen is being ported from docs/flows/ui/t5-articles.html.
      </Typography>
    </Box>
  );
}
