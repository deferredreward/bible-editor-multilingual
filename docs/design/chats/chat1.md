# Note Editing UI Options

_Started 2026-05-11 11:19 UTC_

---

## User

so, gateway edit is nice b/c you can see all the resources at once. it's big weakness is you can only see one thing, so you get no context, you can't reorder the notes, you can't see the previous verse etc. tcCreate is nice b/c you get context, kind of. (it's fast to scroll to the next note, see the screenshots, imagine just a page of 50 of those). it's still very hard to see context without losing your work place. looking for ideas of views that give context and control. so, we still need highlighting to work for the specific note or such that we're working on, so, we need a way to have 'active' verses, notes, etc, but we need to also be able to scroll around (and quickly snap back if desired). create several hybrid options.

## Assistant

_[tool: write_file]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Here are 5 hybrid wireframes exploring different ways to combine gatewayEdit's "everything at once" with tcCreate's scrollable context — all sharing a clear active state and snap-back:

- **01 Spine + Detail** — chapter ToC on left, frozen detail in center, reference rail on right
- **02 Freeze Row** — frozen active row up top, dense scrollable verse stream below
- **03 Timeline + Tabs** — book-wide scrubber + scripture with dimmed prev/next + tabbed resources
- **04 Focus Halo** — gatewayEdit grid with glowing active row + peek strips above/below
- **05 Locked Columns** — every resource is its own scrollable column with per-column lock-to-active

Each has its own 📍 snap-back, consistent blue active highlighting, and notes on tradeoffs. Tell me which threads to pull on and I'll go deeper.

## User

3 - timeline-tabs is by far the closest to my imagination. we also need to edit the quote field for the notes, and an easy way to add or remove notes, and a way to quickly (type ahead, the code end should already know about this) change the note link (but only showing the short form is GREAT, why is there a 1, 2, 3 circle on the 1:4 note 1 of 3? the other notes are clearly right there. default would be expanded notes. by default show ult and ust, and as many verses as the page will take. there's no such thing as tW Art, there's TWL (translationwords links, not too important in this interface).

show 4 options that take a path related to that of design 3.

## Assistant

_[tool: snip]_

_[tool: write_file]_

_[tool: done]_

_[tool: snip]_

_[tool: fork_verifier_agent]_

Four variations on the Timeline path are ready:

- **A Stacked Resources** — no tabs; Notes / Words / Questions / TWL stack as scrollable sections
- **B Notes-First** — wide dedicated notes column, mini-row of Words/Qs/TWL pinned at bottom
- **C Inline Notes** — notes appear indented beneath their verse; right column is reference (tA + TWL)
- **D Bottom Drawer** — full-width ULT/UST scripture up top, resources slide up from a bottom drawer

All four share: notes expanded by default · editable quote field (Hebrew/Greek inline) · short-form support reference with type-ahead picker · ＋/⌫ on every note · drag handles · TWL renamed correctly · ULT + UST shown by default.

## User

a: but, uhb on for active verse. the clickable ult/ust/uhb only apply if a new [ | ] type button is on - this button would allow users to have 1-3 columns with ult/ust/uhb, ult and ust editable as if ms word, text fields such that browser spell check works.
drop the occurrence field - if quote field is not empty, it's 1, user shouldn't ahve to mess with it or even see it. show note id field value instead of n1, n2, n3. drop 2nd support field, if could be handled in that circle field to the right of what's now n1, n2, n3. 

what's the copy looking thing next to the delete/backspace? 

deduplicate the `+ note` `+ add`.

## Assistant

_[tool: str_replace_edit]_

The ⎘ icon is **duplicate** — copies the note as a new one beside it. I'll keep it but lean on the label so it's not mysterious.

Applying the rest to option A.

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: run_script]_

_[tool: snip]_

_[tool: done]_

Option A updated:

- **[|] columns** toggle added; ULT/UST/UHB segment is disabled until it's on
- **Active verse**: ULT + UST as MS-Word-style editable text fields (browser spellcheck), UHB always shown inline
- **Note cards**: header now shows the real note ID (sb2j, ab3x, k7m9), the support reference is the clickable chip beside it (with type-ahead popover), occurrence + duplicate-Support row dropped
- **Duplicate (⎘) button removed** — new note is blank
- Deduplicated `+ note`/`+ add` → single **＋ new note** in the section header

## User

better. i liked the look of the active verses better before, depends on what's possible with editable i guess. so, get rid of the 'uhb on active: always' box. change the a-d to screens a-d and represent these things: A, more or less the current screen. B: a screen where the user has hit the column button (a real columns icon not [ | ] text), and it's showing just ult as editable like in word. c: like B but with UST & uhb as other columns, ult/ust editable. obviouisly this will require flexibility in the right panel size too. and D: a screen with the alignment box up but unlike in the photo, the current verse's ult and ust are in the box too somewhere easy to see but out of the way. (this reminds me, put the little clip icon from this next to the ult/ust in the view A, after each verse number in views b-c. Also, Words and TWL are the same... so depulicate that, but i like the layout of the words, as long as those are editable. dont worry about viewing or editing the actual words articles (which you can do in gateway edit).

## Assistant

_[tool: snip]_

_[tool: write_file]_

_[tool: done]_

_[tool: snip]_

_[tool: fork_verifier_agent]_

Screens A–D updated. Key changes:

- **A · Stacked** — restored the rounded blue card with two stacked editable lines (ULT, UST) for the active verse, UHB read-only beneath. Dropped the "UHB on active: always" toolbar control.
- **B · 1 column** — real columns SVG icon, ULT-only doc view, Word-style continuous editing.
- **C · 3 columns** — ULT + UST editable, UHB read-only as a third column; resource rail narrows.
- **D · Alignment** — modal carries a verse strip at the top showing the current verse's ULT + UST so you don't lose meaning while aligning.
- Every verse number in B/C carries a small green ⌭ clip icon for "align this verse."
- Words and TWL deduplicated — single editable Words table (Original / GL Quote / Translation Word).

## User

there's no gl quote for words, it's the original, called quote and the word column that we edit. very minor, otherwise, A we show full verses, but maybe that's just you illustrating. with those tweaks i'm happy to find a way to pass this off to opus in claude code

## Assistant

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

Words tables updated to **Quote / Word / Ref** across all three screens. Ready for handoff to Claude Code.

## User

2 things:
1) missing alignment links on A.
2) quote field in words shouuld be editable. here's all we need for twls, but a more user friendly experience for the reference.

## Assistant

_[tool: snip]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: done]_

_[tool: snip]_

Done — alignment ⌭ icons added to every verse on Screen A (active and dim), and Words tables across A/B/C now match the TWL schema: editable **Reference** · editable **Original** (Hebrew) · **TW article** chip with friendly name + path hint (instead of the raw `rc://*/tw/dict/...` URL).

