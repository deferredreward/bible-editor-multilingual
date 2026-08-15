# Aesthetic & Minimalist Notes — design parking lot

**Status:** mockups only — **do not implement in `web/` yet.**  
**Branch:** `docs/aesthetic-minimal-notes-mockups`  
**Heuristic:** Nielsen Norman Group — *Aesthetic and Minimalist Design* (remove chrome that doesn’t serve the task; keep what’s needed for resource translation).  
**Primary user:** resource translator (tN / notes first).

## Open this first

Interactive prototype (3 concepts, shared in-memory state):

[`aesthetic-minimal-notes.html`](./aesthetic-minimal-notes.html)

Open in a browser. Top dark bar switches concepts. Click verses, notes, Save / Approve, and `···` menus.

## Direction decided (2026-07-30)

| Concept | Verdict | Target form factor |
|--------|---------|-------------------|
| **1 · Focus Theater** | Keep exploring | **Mobile** — one note is the job; scripture is a quiet reference strip; Save + Approve are the only primary CTAs |
| **2 · Translation Desk** | Keep exploring | **Tablet** — familiar 3-zone shape, but notes are the hero (~55%); scripture ~35% as a tool; inactive notes collapse to quote + one-line draft |
| **3 · Prose Continuum** | Interesting, not chosen for next pass | Manuscript / left-border state; tools only on the open note. Parked unless we revisit reading-first desktop |

Spelling note: UI copy in chat said “Translation Deck”; the mockup name is **Translation Desk**.

## What “done” looks like when we resume

1. Re-open the HTML; confirm Theater (phone width) and Desk (tablet width) still feel right.
2. Optionally add responsive breakpoints *inside the mockup* (Theater layout under ~600px, Desk ~600–1100px) before any React work.
3. Map chrome that moves to overflow vs stays visible (see inventory below).
4. Only then plan a real PR — likely layout/CSS + NoteCard density, not a rewrite of save/draft semantics.

## Task essentials to protect

- Verse / note navigation  
- Quote ↔ scripture highlight link  
- Source + draft editing  
- Explicit **Save** and **Approve** (notes still save only on Save click; drafts stay in IndexedDB)  
- Secondary: quote builder, template, AI suggest, history, delete — overflow / shortcuts, not permanent chrome  

## Current product clutter this is reacting to

Classic shell: TopBar density · ResourceColumn tabs · Notes “translation mode” / progress strip · **NoteCard** header chip cluster + Preserve/Hint/TCM/SH footer.  
Code anchors (read-only for now): `Shell.tsx`, `ResourceColumn.tsx`, `NotesPanel.tsx`, `NoteCard.tsx`, `TimelineRail.tsx`, `theme.ts` (Inspire `#31ADE3`, Ocean `#014263`, Source Serif for reading).

## Out of scope for this branch

- No changes under `web/` or `api/`.  
- No PR required until someone picks implementation.  
- Unrelated local WIP (e.g. `NoteCard.tsx` edits on main) must stay off this branch.

## Resume prompt (paste for any agent)

> Read `docs/mockups/aesthetic-minimal-notes.md` and open `docs/mockups/aesthetic-minimal-notes.html`. We parked NN/g minimalist notes UI ideas: Focus Theater → mobile, Translation Desk → tablet. Mockups only so far — no app code. Continue from the handoff; don’t implement React until asked.
