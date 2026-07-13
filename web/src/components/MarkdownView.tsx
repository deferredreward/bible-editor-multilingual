// Read-only markdown renderer shared by the TW article viewer and the tW/tA
// translation editor's source + preview panes. Extracted verbatim from
// TwArticleDialog so the XSS-safety constraint travels with every use.

import type { ReactNode } from "react";
import { Box, Link, Typography } from "@mui/material";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Articles link to siblings via relative paths (../kt/god.md) and to other
// resources via rc:// URIs. Resolve relative paths against a base URL (the
// Door43 source page); render non-navigable rc:// references as plain text.
function mdLink(baseUrl: string | undefined) {
  return function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
    if (!href) return <>{children}</>;
    let resolved: string | null = null;
    if (/^https?:\/\//.test(href)) {
      resolved = href;
    } else if (baseUrl && (/\.md(#.*)?$/.test(href) || href.startsWith("./") || href.startsWith("../"))) {
      try {
        resolved = new URL(href, baseUrl).href;
      } catch {
        resolved = null;
      }
    }
    if (!resolved) {
      return (
        <Typography component="span" sx={{ color: "text.secondary" }}>
          {children}
        </Typography>
      );
    }
    return (
      <Link href={resolved} target="_blank" rel="noopener noreferrer">
        {children}
      </Link>
    );
  };
}

interface Props {
  markdown: string;
  /** Base URL for resolving relative links (the source article's Door43 page). */
  baseUrl?: string;
  dir?: "ltr" | "rtl";
}

export function MarkdownView({ markdown, baseUrl, dir }: Props) {
  return (
    <Box
      dir={dir}
      sx={{
        "& h1": { typography: "h5", mt: 0, mb: 1.5 },
        "& h2": { typography: "h6", mt: 2.5, mb: 1 },
        "& h3": { typography: "subtitle1", fontWeight: 600, mt: 2, mb: 0.5 },
        "& p": { typography: "body1", my: 1 },
        "& ul, & ol": { pl: 3, my: 1 },
        "& li": { typography: "body1", my: 0.5 },
        "& a": { color: "primary.main" },
        "& blockquote": { borderInlineStart: "3px solid", borderColor: "divider", pl: 1.5, my: 1, color: "text.secondary" },
        "& code": { fontFamily: "monospace", fontSize: "0.9em", bgcolor: "action.hover", px: 0.5, borderRadius: 0.5 },
      }}
    >
      {/* `markdown` may be untrusted (fetched over CORS from an external,
          unauthenticated Door43 repo, or an unreviewed AI draft). This render is
          XSS-safe ONLY because there is no `rehype-raw`/`allowDangerousHtml`
          (embedded raw HTML stays inert) and `mdLink` drops non-http(s) link
          schemes. Do NOT add rehype-raw or skipHtml:false here without a
          sanitizer (e.g. rehype-sanitize) — doing so turns a Door43 compromise
          (or a poisoned AI draft) into stored XSS in the editor. */}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: mdLink(baseUrl) }}>
        {markdown}
      </ReactMarkdown>
    </Box>
  );
}
