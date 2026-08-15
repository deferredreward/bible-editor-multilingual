# Mobile alignment — tap-to-pair interaction design

**Status:** decision record, amends 02-architecture.md (which originally gave
mobile a "needs a larger screen" fallback for bundle H). Benjamin asked for a
real mobile answer (2026-08-03): "tapping words to select, tapping a word in
another language will align it… a way to tap checks or something to combine
words."

## Why this works here

Alignment operations in the real app (custom HTML5 DnD aligner over the
per-verse usfm-js tree) reduce to four verbs: **attach** target word(s) to a
source word/group, **detach**, **group** source words (many-to-one), and
**accept a suggestion** (`GET /api/align/suggest` exists today). Drag is only
one possible gesture binding for those verbs — tap sequences bind them just
as completely, and tap has no hover/hit-testing traps and is inherently
accessible (every step is a discrete, focusable button press, so the same
mode is also the keyboard-accessible mode on desktop).

## The model: select side A, commit on side B

Layout (phone, one verse at a time): **source ribbon** pinned at top —
original-language words as group cards (`dir` set per language, RTL for
Hebrew); **target words** as wrapping chips below; aligned chips render
inside their source group card with a small badge; a bottom **action bar**
appears only when a selection exists.

1. **Tap-to-pair (attach).** Tap one or more target chips — they lift into a
   selection tray (multi-select is just more taps). Tap a source group →
   every selected word attaches there; selection clears; progress counter
   ("14 of 22 words aligned") ticks. Order-forgiving: if you tap a source
   word first, the selection side flips — whichever side you tap second
   commits.
2. **Combine source words (group).** Select two or more source words (tap,
   tap) → the action bar offers **⧉ Combine** → they become one group card;
   subsequent attaches land on the combined group. **Split** appears on any
   combined group's card. This is the "tap checks to combine" idea, as an
   explicit action-bar verb rather than implicit — merging data must never
   be a side effect of a mis-tap.
3. **Detach / move.** Tap an aligned chip — it lifts back into the tray
   (action bar: **Unalign**); tapping a different source group instead moves
   it there in one step.
4. **Suggestions first (the mobile-native part).** On entry, unreviewed
   suggestions from `/api/align/suggest` render as confirm cards — proposed
   pairing shown as source phrase ↔ target phrase, tap **✓ Accept** / **✗
   Skip**, card-at-a-time like every other queue in the app. Manual
   tap-to-pair is the fallback below the suggestion queue, not the entry
   point. This makes bundle H queue-shaped on phone, consistent with D1.

Selection state is visual-only until commit; the commit writes through the
same verse-PATCH family as the drag aligner (`If-Match` +
`X-Source-Generation`), one save per explicit **Save alignment** — no
per-tap network chatter, consistent with the app's explicit-save invariant.

## Form-factor policy (revised)

- **Phone (<560):** tap mode only, suggestions-first.
- **Tablet (560–899):** tap mode default, drag available.
- **Desktop (≥900):** drag canvas default, tap mode toggleable — and it
  doubles as the keyboard/switch-access mode.

## Risks / open questions

- Long verses: source ribbon scrolls horizontally inside its own container;
  a "jump to unaligned" pill keeps orientation. Needs testing with real
  Hebrew verse lengths (Psalms).
- Combining across non-adjacent source words is allowed by the data model;
  the UI should render a combined group's members with their original
  indices visible so a wrong combine is spottable.
- Fat-finger risk on dense chips: minimum 44px touch targets, and Unalign is
  always a two-step (select, then action bar) — never a single destructive
  tap.
