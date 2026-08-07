// TODO(i18n) — flow screens ship English literals until the i18n sweep.
// Stub: replaced by the real port of docs/flows/ui/a1-setup.html in this stack.
import { Box, Typography } from "@mui/material";
import { FlowNav } from "./FlowNav";
import type { FlowScreenContext } from "./types";

export interface SetupScreenProps extends FlowScreenContext {
}

export default function SetupScreen({ role }: SetupScreenProps) {
  return (
    <Box sx={{ p: 3, maxWidth: 960, marginInline: "auto" }}>
      <FlowNav current="setup" role={role} />
      <Typography variant="h5" sx={{ mt: 3 }}>
        Setup — being built
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 1 }}>
        This screen is being ported from docs/flows/ui/a1-setup.html.
      </Typography>
    </Box>
  );
}
