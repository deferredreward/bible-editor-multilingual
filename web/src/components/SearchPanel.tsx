import { useTranslation } from "react-i18next";
import { Box } from "@mui/material";

// External search tool embedded in the Search panel. Allow-listed in the API's
// CSP frame-src (api/src/index.ts) — adding a different host requires updating
// both.
export const SEARCH_IFRAME_URL = "https://swunrow.pythonanywhere.com/";

// Content-only body for the Flexible layout's "search" panel. Unlike the
// Search tab in ResourceColumn (which toggles display:none to survive tab
// switching), a panel placed in a Flexible region simply stays mounted while
// it remains placed, so no searchVisited / display-toggle trick is needed
// here — don't "restore" one later thinking it was lost.
export function SearchPanel() {
  const { t } = useTranslation();
  return (
    <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <iframe
        src={SEARCH_IFRAME_URL}
        title={t("shell.search")}
        // sandbox grants only what a search tool needs (its own scripts,
        // storage, forms, and opening result links in a new tab);
        // referrerPolicy keeps our URL out of the external site's logs.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        referrerPolicy="no-referrer"
        style={{ width: "100%", height: "100%", border: 0 }}
      />
    </Box>
  );
}
