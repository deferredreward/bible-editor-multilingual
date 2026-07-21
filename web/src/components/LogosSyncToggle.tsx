import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
} from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import CheckIcon from "@mui/icons-material/Check";
import { useTranslation } from "react-i18next";

// USFM 3-letter code (lowercase) → Logos Bible abbreviation.
// Matches the table from the upstream Logos-sync bookmarklet.
const LOGOS_MAP: Record<string, string> = {
  gen: "Ge", exo: "Ex", lev: "Le", num: "Nu", deu: "Dt",
  jos: "Jos", jdg: "Jdg", rut: "Ru",
  "1sa": "1Sa", "2sa": "2Sa", "1ki": "1Ki", "2ki": "2Ki",
  "1ch": "1Ch", "2ch": "2Ch",
  ezr: "Ezr", neh: "Ne", est: "Es",
  job: "Job", psa: "Ps", pro: "Pr", ecc: "Ec", sng: "So",
  isa: "Is", jer: "Je", lam: "La", ezk: "Eze", dan: "Da",
  hos: "Ho", jol: "Joe", amo: "Am", oba: "Ob", jon: "Jon",
  mic: "Mic", nam: "Na", hab: "Hab", zep: "Zep", hag: "Hag",
  zec: "Zec", mal: "Mal",
  mat: "Mt", mrk: "Mk", luk: "Lk", jhn: "Jn", act: "Ac",
  rom: "Ro", "1co": "1Co", "2co": "2Co", gal: "Ga", eph: "Eph",
  php: "Php", col: "Col", "1th": "1Th", "2th": "2Th",
  "1ti": "1Ti", "2ti": "2Ti", tit: "Ti", phm: "Phm",
  heb: "Heb", jas: "Jas", "1pe": "1Pe", "2pe": "2Pe",
  "1jn": "1Jn", "2jn": "2Jn", "3jn": "3Jn", jud: "Jude", rev: "Re",
};

function toLogosAbbr(book: string): string {
  const key = book.toLowerCase();
  return LOGOS_MAP[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

function fireLogos(book: string, chapter: number, verse: number) {
  if (chapter <= 0 || verse <= 0) return;
  const abbr = toLogosAbbr(book);
  window.location.href = `logosref:Bible.${abbr}${chapter}.${verse}`;
}

const STORAGE_KEY = "be:logosSyncEnabled";
const WARNING_HIDDEN_KEY = "be:logosSyncWarningHidden";
const LOGOS_HIDDEN_KEY = "be:logosHidden";

interface Props {
  book: string;
  chapter: number;
  verse: number;
}

export function LogosSyncToggle({ book, chapter, verse }: Props) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [warnOpen, setWarnOpen] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [hidden, setHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LOGOS_HIDDEN_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  // Debounced auto-follow when enabled. Custom-scheme navigation hands off
  // to the OS — the page itself does not navigate. Note: Logos has no
  // no-focus mode, so each fire raises its window. Suppressed while the
  // widget is hidden so a hidden clicker never steals OS focus.
  useEffect(() => {
    if (!enabled || hidden) return;
    const timer = window.setTimeout(() => fireLogos(book, chapter, verse), 400);
    return () => window.clearTimeout(timer);
  }, [enabled, hidden, book, chapter, verse]);

  const persistHidden = (v: boolean) => {
    setHidden(v);
    try {
      localStorage.setItem(LOGOS_HIDDEN_KEY, String(v));
    } catch {
      /* ignore */
    }
  };

  const persistEnabled = (v: boolean) => {
    setEnabled(v);
    try {
      localStorage.setItem(STORAGE_KEY, String(v));
    } catch {
      /* ignore */
    }
  };

  const handleCheckboxChange = (next: boolean) => {
    if (!next) {
      persistEnabled(false);
      return;
    }
    let hidden = false;
    try {
      hidden = localStorage.getItem(WARNING_HIDDEN_KEY) === "true";
    } catch {
      /* ignore */
    }
    if (hidden) {
      persistEnabled(true);
      return;
    }
    setDontShowAgain(false);
    setWarnOpen(true);
  };

  const handleConfirm = () => {
    if (dontShowAgain) {
      try {
        localStorage.setItem(WARNING_HIDDEN_KEY, "true");
      } catch {
        /* ignore */
      }
    }
    persistEnabled(true);
    setWarnOpen(false);
  };

  // Shared settings menu: houses the "Hide Logos button" toggle so the widget
  // can be dismissed — and recovered — without opening Preferences.
  const settingsMenu = (
    <Menu
      anchorEl={menuAnchor}
      open={Boolean(menuAnchor)}
      onClose={() => setMenuAnchor(null)}
    >
      <MenuItem
        onClick={() => {
          persistHidden(!hidden);
          setMenuAnchor(null);
        }}
      >
        <ListItemIcon sx={{ visibility: hidden ? "visible" : "hidden" }}>
          <CheckIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t("logos.hideButton")}</ListItemText>
      </MenuItem>
    </Menu>
  );

  // Hidden: collapse to a tiny, low-opacity kebab so the user can bring the
  // clicker back. Auto-follow is already suppressed by the effect guard above.
  if (hidden) {
    return (
      <>
        <Tooltip title={t("logos.settingsTooltip")}>
          <IconButton
            size="small"
            onClick={(e) => setMenuAnchor(e.currentTarget)}
            aria-label={t("logos.settingsTooltip")}
            sx={{ opacity: 0.35, "&:hover": { opacity: 0.8 } }}
          >
            <MoreVertIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        {settingsMenu}
      </>
    );
  }

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={0.25}
      sx={{
        px: 1,
        py: 0.25,
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        bgcolor: "background.paper",
      }}
    >
      <Box
        component="span"
        sx={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          color: "text.secondary",
          mr: 0.5,
        }}
      >
        Logos
      </Box>
      <Tooltip title={t("logos.openVerse")}>
        <IconButton size="small" onClick={() => fireLogos(book, chapter, verse)}>
          <OpenInNewIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title={t("logos.autoFollowTooltip")}>
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={enabled || warnOpen}
              onChange={(e) => handleCheckboxChange(e.target.checked)}
            />
          }
          label={t("logos.autoFollow")}
          sx={{
            mr: 0,
            "& .MuiFormControlLabel-label": { fontSize: 13 },
          }}
        />
      </Tooltip>
      <Tooltip title={t("logos.settingsTooltip")}>
        <IconButton
          size="small"
          onClick={(e) => setMenuAnchor(e.currentTarget)}
          aria-label={t("logos.settingsTooltip")}
          sx={{ opacity: 0.6, "&:hover": { opacity: 1 } }}
        >
          <MoreVertIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {settingsMenu}
      <Dialog open={warnOpen} onClose={() => setWarnOpen(false)}>
        <DialogTitle>{t("logos.enableTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t("logos.enableBody")}</DialogContentText>
          <FormControlLabel
            sx={{ mt: 2 }}
            control={
              <Checkbox
                checked={dontShowAgain}
                onChange={(e) => setDontShowAgain(e.target.checked)}
              />
            }
            label={t("logos.dontShowAgain")}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setWarnOpen(false)}>{t("common.cancel")}</Button>
          <Button onClick={handleConfirm} variant="contained">
            {t("logos.ok")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
