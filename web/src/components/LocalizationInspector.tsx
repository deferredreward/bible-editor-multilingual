// Issue #77, part 2: "localization mode" — an inspect-to-edit overlay so a
// translator can fix UI copy in context instead of hunting through ~3,218
// keys in the Localization tab's list. Toggled from that tab (see
// `useLocalizationMode` in ../i18n/localizationMode); once on, this overlay
// mounts once at the app root (see App.tsx) and stays active across
// navigation back to the main Shell.
//
// How key-matching works (no source changes required elsewhere): there is no
// data-i18n-key attribute on every rendered node, so instead we build a
// reverse index of "current rendered text" -> i18n key path from the same
// flattenEn()/i18next.t() surface the Localization tab already uses, then
// match the hovered element's own text against it. This is a text-match
// heuristic, not a structural one — known gap: keys whose string contains
// {{interpolation}} tokens render with substituted values in the real UI
// (e.g. "Chapter 3") that no longer literally equal the raw template
// ("Chapter {{chapter}}"), so those don't hover-match. Static strings (the
// majority of the UI chrome — buttons, labels, headings) match fine.
import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Paper, Stack, TextField, Typography, IconButton } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { dirForLang } from "../i18n";
import { isAdmin, api } from "../sync/api";
import {
  flattenEn,
  currentValue,
  flatFromBag,
  saveOverridePatch,
} from "../i18n/overrides";
import {
  useLocalizationMode,
  setLocalizationModeEnabled,
  L10N_INSPECTOR_UI_MARKER,
} from "../i18n/localizationMode";

const UI_MARKER = L10N_INSPECTOR_UI_MARKER;

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function isInspectorUi(el: EventTarget | null): boolean {
  return !!(el instanceof Element && el.closest(`[${UI_MARKER}]`));
}

interface Match {
  el: Element;
  rect: DOMRect;
  paths: string[];
}

const rowsAll = flattenEn();

export function LocalizationInspector() {
  const { t } = useTranslation();
  const enabled = useLocalizationMode();
  const admin = isAdmin();
  const lang = i18n.language;
  const [reindex, setReindex] = useState(0); // bump after a save to refresh matches
  const [hover, setHover] = useState<Match | null>(null);
  const [editor, setEditor] = useState<Match | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const active = enabled && admin;
  const rafRef = useRef(0);

  // Rebuild the reverse index whenever ANY override save touches i18next's
  // resource store — not just this component's own onSave. The Localization
  // tab (PreferencesWorkspace) has its own separate save path that also
  // calls applyOverrides()/addResourceBundle() directly; without this, an
  // edit made there leaves the inspector's cached index pointing at
  // pre-edit rendered text until an unrelated language switch happens to
  // force a rebuild.
  useEffect(() => {
    const bump = () => setReindex((v) => v + 1);
    i18n.on("added", bump);
    return () => {
      i18n.off("added", bump);
    };
  }, []);

  // text -> key path(s), built from the currently-rendered (post-override)
  // strings so an already-localized UI still matches on re-hover.
  const reverseIndex = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const row of rowsAll) {
      const rendered = i18n.t(row.path);
      if (typeof rendered !== "string") continue;
      const key = normalize(rendered);
      if (!key) continue;
      const list = map.get(key);
      if (list) list.push(row.path);
      else map.set(key, [row.path]);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, reindex]);

  function findMatch(start: Element): Match | null {
    let el: Element | null = start;
    for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
      const text = normalize(el.textContent ?? "");
      if (text) {
        const paths = reverseIndex.get(text);
        if (paths && paths.length > 0) {
          return { el, rect: el.getBoundingClientRect(), paths };
        }
      }
    }
    return null;
  }

  useEffect(() => {
    if (!active) {
      setHover(null);
      setEditor(null);
      setDraft({});
      setErr(null);
      return;
    }
    const onMove = (e: MouseEvent) => {
      if (editor) return; // freeze highlight while the editor is open
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const target = e.target;
        if (isInspectorUi(target) || !(target instanceof Element)) {
          setHover(null);
          return;
        }
        setHover(findMatch(target));
      });
    };
    document.addEventListener("mousemove", onMove);
    return () => {
      document.removeEventListener("mousemove", onMove);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, editor, reverseIndex]);

  useEffect(() => {
    if (!active) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target;
      if (isInspectorUi(target)) return; // let the editor's own controls work
      e.preventDefault();
      e.stopPropagation();
      if (editor) {
        // Editor already open — a click elsewhere just closes it.
        setEditor(null);
        setDraft({});
        setErr(null);
        return;
      }
      if (!(target instanceof Element)) return;
      const match = findMatch(target);
      if (!match) return;
      setHover(null);
      setEditor(match);
      const seed: Record<string, string> = {};
      for (const p of match.paths) seed[p] = currentValue(lang, p) ?? i18n.t(p);
      setDraft(seed);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, editor, reverseIndex, lang]);

  const onSave = async () => {
    if (!editor) return;
    setSaving(true);
    setErr(null);
    try {
      const { overrides, versions } = await api.getL10nOverrides();
      const storedFlat = flatFromBag(overrides[lang] ?? {});
      // saveOverridePatch's applyOverrides() call triggers the i18n "added"
      // listener above, which rebuilds reverseIndex.
      const outcome = await saveOverridePatch(lang, versions[lang] ?? 0, storedFlat, draft);
      if (outcome.ok) {
        setEditor(null);
        setDraft({});
      } else if (outcome.kind === "conflict") {
        setErr(t("preferences.conflict"));
      } else if (outcome.kind === "forbidden") {
        setErr(t("preferences.saveForbidden"));
      } else {
        setErr(t("preferences.saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  if (!active) return null;

  const box = editor ?? hover;

  return (
    <Box {...{ [UI_MARKER]: true }} sx={{ position: "fixed", inset: 0, zIndex: (theme) => theme.zIndex.tooltip + 10, pointerEvents: "none" }}>
      {box && (
        <Box
          sx={{
            position: "fixed",
            top: box.rect.top,
            left: box.rect.left,
            width: box.rect.width,
            height: box.rect.height,
            border: "2px solid",
            borderColor: editor ? "success.main" : "primary.main",
            borderRadius: 0.5,
            boxShadow: (theme) => `0 0 0 2px ${theme.palette.background.paper}`,
          }}
        />
      )}

      <Paper
        {...{ [UI_MARKER]: true }}
        elevation={4}
        sx={{
          position: "fixed",
          top: 8,
          left: "50%",
          transform: "translateX(-50%)",
          px: 1.5,
          py: 0.5,
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          gap: 1,
        }}
      >
        <Typography variant="caption">{t("preferences.localization.inspectHint")}</Typography>
        <IconButton size="small" onClick={() => setLocalizationModeEnabled(false)}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Paper>

      {editor && (
        <Paper
          {...{ [UI_MARKER]: true }}
          elevation={6}
          sx={{
            position: "fixed",
            top: Math.min(editor.rect.bottom + 8, window.innerHeight - 260),
            // On viewports narrower than the popup + margins (e.g. phones),
            // `window.innerWidth - 420` goes negative and would push the
            // popup off-screen; clamp the lower bound at 8 too so it never
            // goes below the left margin.
            left: Math.min(Math.max(editor.rect.left, 8), Math.max(8, window.innerWidth - 420)),
            width: 400,
            maxWidth: "calc(100vw - 16px)",
            p: 2,
            pointerEvents: "auto",
          }}
        >
          <Stack spacing={1.5}>
            {editor.paths.map((p) => (
              <Box key={p}>
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace", display: "block" }}>
                  {p}
                </Typography>
                <TextField
                  id={`l10n-inspector-${lang}-${p}`}
                  name={`l10n-inspector-${lang}-${p}`}
                  size="small"
                  fullWidth
                  multiline
                  maxRows={6}
                  dir={dirForLang(lang)}
                  value={draft[p] ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [p]: e.target.value }))}
                />
              </Box>
            ))}
            {err && (
              <Typography variant="caption" color="error">
                {err}
              </Typography>
            )}
            {editor.paths.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                {t("preferences.localization.inspectNoKey")}
              </Typography>
            )}
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button
                size="small"
                onClick={() => {
                  setEditor(null);
                  setDraft({});
                  setErr(null);
                }}
              >
                {t("preferences.localization.inspectCancel")}
              </Button>
              <Button size="small" variant="contained" disabled={saving} onClick={onSave}>
                {t("preferences.localization.inspectSave")}
              </Button>
            </Stack>
          </Stack>
        </Paper>
      )}
    </Box>
  );
}
