# Simple mobile + admin concept mockups

Clickable HTML sketches only — no app wiring. Fake EN→ES data for Zacarías.

## Run

```powershell
npx --yes serve -l 5177 docs/mockups/simple-mobile
```

Open http://localhost:5177/

Or open `index.html` / any page directly from disk.

## What’s here

| File | Role |
|------|------|
| `index.html` | Hub linking all sketches |
| `t1-home.html` | Translator: choose workstream |
| `t4-scripture.html` | Translator: ULT→GLT + UST→GST per verse |
| `t2-note.html` | Translator: note review (ULT + UST + EN + AI ES) |
| `t3-article.html` | Translator: questions / key terms / articles |
| `a1-workflow.html` | Admin: Render-style stage rail |
| `a2-people.html` | Admin: people & roles |
| `a3-sections.html` | Admin: section assignment + project |
| `styles.css` / `shell.js` | Shared chrome |

**Translator intent:** Steve Jobs / iPhone — one job per screen. Approve, regenerate AI, mark not needed / reject / keep draft. No real sync.

**Scripture lanes:** In many gateway projects both styles matter — **ULT → GLT** (literal) and **UST → GST** (simplified) so downstream mother-tongue teams get a matching pair. `t4-scripture.html` keeps both on one focused verse screen (no tab bar).

**Admin intent:** Heavier desks inspired by [Render workflow config](https://renderpartners.freshdesk.com/en/support/solutions/articles/47001264410-configure-workflow-introduction) (locked Draft + Consultant Approval; optional Peer / Community / Consultant Check) plus people and section assignment.

## Feedback to act on next (2026-07-30)

- **`t3-article.html` tabs are too busy.** Prefer the same focused orientation as the note screen (`t2-note.html`): one workstream per visit, entered from home (`t1-home.html`), not tab-switching across Questions / Key terms / Articles on one phone.
- Next pass: split t3 into three focused phones (or deep-link from home with no tab bar), keep the source / target / AI / approve pattern.

## Resume checklist for a future agent

1. Read this README and skim the HTML files.
2. Re-serve and click through before changing anything.
3. Address the t3 focus feedback above before expanding scope.
4. Do **not** mix these sketches into production `web/` / `api/` unless explicitly asked — keep concepts under `docs/mockups/`.
5. Scripture mockup lives at `t4-scripture.html` (ULT→GLT / UST→GST).
