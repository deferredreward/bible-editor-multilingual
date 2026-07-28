# gallant-lichterman-e4729c — region hide/restore in the Flexible layout

Status: PR open against `main` (fork `deferredreward/bible-editor-multilingual`).
Delete this file when that PR merges.

Scope: the last unbuilt piece of round 6 of the flexible-layouts design — close a
whole region and reopen it, panels intact. Flexible-only; Classic untouched.

Nothing is mid-flight. The reasoning, decisions and verification record live in the
commit messages and the PR description; the durable design notes were added to
`docs/flexible-layouts-handoff.md`.

One gap deliberately left open (stated in the PR): the dirty-gate branch on
close — closing a region while the alignment panel holds unsaved drags should
prompt save/discard — is verified by reading, not by driving. It reuses the exact
`runWithDirtyGate` helper `selectLayout` already uses, and the non-dirty path is
verified live. Driving it needs a real word-drag in the aligner.
