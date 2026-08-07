// TODO(i18n) — flow screens ship English literals until the i18n sweep.
// Stub: replaced by the real port of docs/flows/ui/l2-style.html in this stack.
import { Box, Typography } from "@mui/material";
import { FlowNav } from "./FlowNav";
import type { FlowScreenContext } from "./types";

export interface StyleScreenProps extends FlowScreenContext {
}

export default function StyleScreen({ role }: StyleScreenProps) {
  return (
    <Box sx={{ p: 3, maxWidth: 960, marginInline: "auto" }}>
      <FlowNav current="style" role={role} />
      <Typography variant="h5" sx={{ mt: 3 }}>
        Style — being built
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 1 }}>
        This screen is being ported from docs/flows/ui/l2-style.html.
      </Typography>
    </Box>
  );
}
