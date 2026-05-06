---
status: partial
phase: 03-push-sync-branch-management
source: [03-VERIFICATION.md]
started: 2026-05-06T21:18:00Z
updated: 2026-05-06T21:18:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. PUSH-04 — Preview diff (side-by-side)
expected: Drag a workspace file into the staged pane. Right-click the staged file and choose "VersionCon: Preview Diff" (or trigger via the context menu in the workspace tree). VS Code opens a side-by-side diff editor showing branch version on the left and workspace version on the right.
result: [pending]

### 2. PUSH-09 — Mark Synced v1 semantics
expected: With the workspace marked out-of-sync (e.g. after receiving a remote push), run the `versioncon.markSynced` command. The status-bar sync warning clears, but no workspace files are modified or pulled. Confirm this v1 sync-state-only behavior is acceptable for shipping; file-pull will land in a later phase.
result: [pending]

### 3. SC 2 — Push confirmation shows per-file list (post-fix)
expected: Stage one or more files and run "VersionCon: Push". A modal dialog shows a confirmation with the per-file list (e.g. `+ src/foo.ts (+10 -2)`, `~ src/bar.ts (+5 -5)`) and any affected-teammate info, with a "Push" button. Clicking Push then prompts for the commit message via an input box. Cancelling the modal aborts the push.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
