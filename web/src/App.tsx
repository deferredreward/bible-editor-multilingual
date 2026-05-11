import { useEffect, useState } from "react";
import { Box, Typography, Chip, Stack } from "@mui/material";

type Health = { ok: boolean; service: string; time: string };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: Health) => setHealth(data))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <Box sx={{ p: 4 }}>
      <Typography variant="h4" gutterBottom>
        Bible Editor
      </Typography>
      <Typography variant="body1" color="text.secondary" gutterBottom>
        Phase 0 scaffold — verifying the wrangler + vite dev loop.
      </Typography>
      <Stack direction="row" spacing={1} sx={{ mt: 2, alignItems: "center" }}>
        <Typography variant="body2">API:</Typography>
        {health && <Chip color="success" label={`ok · ${health.service}`} />}
        {error && <Chip color="error" label={`fail · ${error}`} />}
        {!health && !error && <Chip label="checking…" />}
      </Stack>
    </Box>
  );
}
