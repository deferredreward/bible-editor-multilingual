// TopBar "download USFM" control. Exports the current chapter or the whole book
// for any enabled bible version, in an aligned (\zaln/\w kept) or plain
// (alignment stripped) variant. Chapter export renders from data already in
// hand; book export fetches every chapter for the chosen version client-side
// (no export API endpoint). See web/src/lib/exportUsfm.ts for the renderer.

import { useState } from "react";
import {
  Alert,
  CircularProgress,
  Divider,
  IconButton,
  ListSubheader,
  Menu,
  MenuItem,
  Snackbar,
  Tooltip,
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import { useTranslation } from "react-i18next";
import { api, type VerseDto } from "../sync/api";
import { buildUsfmFromVerses } from "../lib/exportUsfm";

interface Props {
  book: string;
  chapter: number;
  enabledVersions: string[];
  // Verses for the current chapter, keyed by version. Sourced from useChapter in
  // Shell so chapter export needs no fetch.
  chapterVersesFor: (version: string) => VerseDto[];
}

type Scope = "chapter" | "book";

// Original-language source texts are not offered for USFM export — they're
// upstream, read-only resources, not translation output the user edits here.
const SOURCE_VERSIONS = new Set(["UHB", "UGNT"]);

// Cap on concurrent chapter fetches for a whole-book export so a large book
// (e.g. Psalms, 150 chapters) doesn't dispatch every request in one burst.
const FETCH_CONCURRENCY = 6;

function download(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Run `task` over `items` with a bounded number in flight at once, preserving
// input order in the results.
async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let aborted = false;
  async function worker(): Promise<void> {
    // Stop pulling new work once any task has failed — otherwise the sibling
    // workers keep fetching the rest of the book after the export already failed.
    while (next < items.length && !aborted) {
      const i = next++;
      try {
        results[i] = await task(items[i]);
      } catch (e) {
        aborted = true;
        throw e;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export function ExportUsfmButton({ book, chapter, enabledVersions, chapterVersesFor }: Props) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = Boolean(anchor);

  // Exclude original-language source texts (Hebrew/Greek) from export.
  const exportableVersions = enabledVersions.filter((v) => !SOURCE_VERSIONS.has(v.toUpperCase()));

  const close = () => setAnchor(null);

  async function versesFor(scope: Scope, version: string): Promise<VerseDto[]> {
    if (scope === "chapter") return chapterVersesFor(version);
    const summary = await api.getBookSummary(book);
    // The summary can list chapter 0 (book-intro notes live there), but the
    // verses table has no chapter-0 scripture, so skip it — no verse rows to
    // fetch and it would never contribute to the export.
    const chapters = summary.chapters.filter((c) => c.chapter > 0);
    const payloads = await mapLimit(chapters, FETCH_CONCURRENCY, (c) => api.getChapter(book, c.chapter));
    const out: VerseDto[] = [];
    for (const p of payloads) {
      const byVerse = p.verses[version];
      if (byVerse) out.push(...Object.values(byVerse));
    }
    return out;
  }

  async function handleExport(scope: Scope, version: string, aligned: boolean): Promise<void> {
    close();
    setBusy(true);
    try {
      const verses = await versesFor(scope, version);
      if (verses.length === 0) {
        setError(t("export.noText", { version, target: scope === "chapter" ? `${book} ${chapter}` : book }));
        return;
      }
      const usfm = buildUsfmFromVerses(book, version, verses, { aligned });
      const suffix = aligned ? "" : "-unaligned";
      const name =
        scope === "chapter"
          ? `${book}-${version}-${chapter}${suffix}.usfm`
          : `${book}-${version}${suffix}.usfm`;
      download(name, usfm);
    } catch (e) {
      setError(t("export.exportFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }

  const scopes: Array<{ scope: Scope; label: string }> = [
    { scope: "chapter", label: t("export.chapterScope", { chapter }) },
    { scope: "book", label: t("export.wholeBook", { book }) },
  ];

  return (
    <>
      <Tooltip title={t("export.downloadUsfm")}>
        <span>
          <IconButton
            size="small"
            onClick={(e) => setAnchor(e.currentTarget)}
            disabled={busy || exportableVersions.length === 0}
          >
            {busy ? <CircularProgress size={18} /> : <DownloadIcon fontSize="small" />}
          </IconButton>
        </span>
      </Tooltip>
      <Menu anchorEl={anchor} open={open} onClose={close}>
        {scopes.flatMap(({ scope, label }, si) => {
          const items = [
            <ListSubheader key={`${scope}-h`} sx={{ lineHeight: "2em", bgcolor: "transparent" }}>
              {label}
            </ListSubheader>,
            ...exportableVersions.flatMap((v) => [
              <MenuItem key={`${scope}-${v}-a`} onClick={() => void handleExport(scope, v, true)}>
                {t("export.aligned", { version: v })}
              </MenuItem>,
              <MenuItem key={`${scope}-${v}-u`} onClick={() => void handleExport(scope, v, false)}>
                {t("export.plainText", { version: v })}
              </MenuItem>,
            ]),
          ];
          if (si < scopes.length - 1) items.push(<Divider key={`${scope}-d`} />);
          return items;
        })}
      </Menu>
      <Snackbar
        open={error !== null}
        autoHideDuration={6000}
        onClose={() => setError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      </Snackbar>
    </>
  );
}
