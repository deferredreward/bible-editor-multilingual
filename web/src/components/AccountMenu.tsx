// Account menu for the new-UI (flow screen) chrome strip.
//
// The flow screens replaced the classic Shell/TopBar, and with it the whole
// account cluster: identity, sign out, dark mode and reading text size. Sign
// out in particular had no replacement anywhere in the new UI, so a user could
// not leave the session without clearing storage by hand. This is the same set
// of controls TopBar's avatar menu carries, minus the ones the new UI already
// hosts elsewhere (workspace switcher and interface language sit beside this
// button in the strip; editor/translator mode lives on the Style screen).
import { useContext, useState } from "react";
import {
  Box,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import FormatSizeIcon from "@mui/icons-material/FormatSize";
import LogoutIcon from "@mui/icons-material/Logout";
import RemoveIcon from "@mui/icons-material/Remove";
import { useTranslation } from "react-i18next";
import { useProjectConfig } from "../hooks/useProjectConfig";
import {
  FontScaleContext,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  ThemeModeContext,
} from "../theme";

type Props = {
  username?: string | null;
  onLogout?: () => void;
};

export function AccountMenu({ username, onLogout }: Props) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const { mode: themeMode, toggle: toggleTheme } = useContext(ThemeModeContext);
  const { scale, setScale } = useContext(FontScaleContext);
  const projectConfig = useProjectConfig();
  const orgLanguageLabel = projectConfig
    ? projectConfig.languageTitle || projectConfig.languageName || projectConfig.languageCode
    : null;

  return (
    <>
      <Tooltip title={username ? `@${username}` : t("shell.signOut")}>
        <IconButton
          size="small"
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{
            width: 32,
            height: 32,
            flexShrink: 0,
            bgcolor: "#014263",
            color: "#fff",
            fontSize: 13,
            fontWeight: 700,
            "&:hover": { bgcolor: "#014263", opacity: 0.9 },
          }}
        >
          {(username?.[0] ?? "?").toUpperCase()}
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { minWidth: 260 } } }}
      >
        {(username || orgLanguageLabel) && (
          <Box sx={{ px: 1.75, pt: 1.25, pb: 1 }}>
            {username && <Typography variant="subtitle2">{`@${username}`}</Typography>}
            {orgLanguageLabel && (
              <Typography variant="caption" color="text.secondary">
                {projectConfig?.org} ({orgLanguageLabel})
              </Typography>
            )}
          </Box>
        )}
        {(username || orgLanguageLabel) && <Divider />}

        <MenuItem onClick={toggleTheme}>
          <ListItemIcon>
            <DarkModeIcon fontSize="small" sx={{ color: "text.secondary" }} />
          </ListItemIcon>
          <ListItemText primary={t(themeMode === "dark" ? "topbar.switchToLight" : "topbar.switchToDark")} />
          <Switch size="small" checked={themeMode === "dark"} sx={{ pointerEvents: "none" }} />
        </MenuItem>

        <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 0.75 }}>
          <FormatSizeIcon fontSize="small" sx={{ color: "text.secondary" }} />
          <Typography variant="body2" sx={{ flex: 1 }}>
            {t("topbar.readingTextSize")}
          </Typography>
          <Stack
            direction="row"
            alignItems="center"
            sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1 }}
          >
            <IconButton
              size="small"
              onClick={() => setScale(scale - FONT_SCALE_STEP)}
              disabled={scale <= FONT_SCALE_MIN + 1e-6}
              aria-label={t("topbar.decreaseReadingTextSize")}
            >
              <RemoveIcon sx={{ fontSize: 14 }} />
            </IconButton>
            <Typography
              variant="caption"
              sx={{ px: 0.5, fontFamily: "monospace", minWidth: 34, textAlign: "center" }}
            >
              {Math.round(scale * 100)}%
            </Typography>
            <IconButton
              size="small"
              onClick={() => setScale(scale + FONT_SCALE_STEP)}
              disabled={scale >= FONT_SCALE_MAX - 1e-6}
              aria-label={t("topbar.increaseReadingTextSize")}
            >
              <AddIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Stack>
        </Box>

        <Divider />
        <MenuItem
          onClick={() => {
            setAnchor(null);
            onLogout?.();
          }}
        >
          <ListItemIcon>
            <LogoutIcon fontSize="small" sx={{ color: "#B4462B" }} />
          </ListItemIcon>
          <ListItemText primary={t("shell.signOut")} sx={{ color: "#B4462B" }} />
        </MenuItem>
      </Menu>
    </>
  );
}
