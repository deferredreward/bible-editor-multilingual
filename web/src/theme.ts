import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#1976d2" },
  },
  shape: { borderRadius: 6 },
  typography: {
    fontFamily:
      '"Roboto","Helvetica","Arial",sans-serif,"Apple Color Emoji","Segoe UI Emoji"',
  },
});
