<#
.SYNOPSIS
  Forwarder to the canonical worktrees.ps1 in dotfiles. NEW to this repo.

.WHY
  This repo never had a listing tool -- only bible-editor did -- so "which worktree
  is this?" was a question you could only answer from inside the other repo. Since
  the implementation is now shared and takes -RepoPath, this repo gets it for free.

  It matters here specifically: this checkout's worktree folder names are unusually
  misleading (folders named for a session's first task, sitting on unrelated
  word-pair branches, plus several detached HEADs). This lists each worktree by
  what it actually CONTAINS -- branch, open/merged PR, .claude/state headline,
  commit state -- rather than by its folder name.

  Read-only; it never deletes. For teardown use worktree-cleanup.ps1.
#>
#requires -Version 7
[CmdletBinding()]
param(
  [switch]$Json,
  [switch]$NoPr
)

$ErrorActionPreference = 'Stop'

$canonical = 'C:\GH\dotfiles\windows\worktrees.ps1'
if (-not (Test-Path -LiteralPath $canonical)) {
  throw @"
Canonical worktrees.ps1 not found at:
  $canonical

This is a thin forwarder. Make sure the dotfiles repo is cloned at C:\GH\dotfiles
and its checkout includes windows/ (added 2026-07):
  git -C C:\GH\dotfiles status
"@
}

# $PSScriptRoot is inside this repo -- or inside whichever worktree this was
# invoked from -- which is all `git -C` needs to resolve the right repository.
# No `exit $LASTEXITCODE` here. $LASTEXITCODE is set only by NATIVE commands, and
# the canonical script is PowerShell -- so after this call it holds the result of
# whichever `git` subcommand happened to run last anywhere in the call graph, not
# whether the operation succeeded. Exiting on that would make the exit code
# meaningless (and reorderings inside the canonical script could flip it).
# Letting the script end naturally yields 0, and a genuine failure still
# propagates: the canonical script runs with $ErrorActionPreference = 'Stop' and
# throws, which surfaces as a nonzero process exit on its own.
& $canonical -RepoPath $PSScriptRoot @PSBoundParameters
