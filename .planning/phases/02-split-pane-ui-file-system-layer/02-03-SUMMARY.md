---
phase: 02-split-pane-ui-file-system-layer
plan: 03
subsystem: extension-wiring
tags: [split-pane, command-registration, file-watcher, integration-tests]
dependency_graph:
  requires: [02-01, 02-02]
  provides: [versioncon.openWorkspace command, FileSystemWatcher auto-refresh, end-to-end integration verification]
  affects: [src/extension.ts, package.json]
tech_stack:
  added: []
  patterns: [FileSystemWatcher with debounce, command guard clause]
key_files:
  created: []
  modified:
    - src/extension.ts
    - package.json
decisions:
  - Used simple '**/*' glob for FileSystemWatcher instead of excluding .versioncon/ — the currentPanel null check already prevents unnecessary refreshes when panel is closed, and refresh is idempotent
  - Kept 50ms debounce per RESEARCH.md recommendation for batching rapid filesystem events
metrics:
  duration: 128s
  completed: 2026-05-05T17:04:42Z
  tasks_completed: 2
  tasks_total: 2
  files_modified: 2
---

# Phase 02 Plan 03: Extension Wiring + FileSystemWatcher + Integration Tests Summary

Wired SplitPanePanel into extension entry point with openWorkspace command, 50ms-debounced FileSystemWatcher for live workspace auto-refresh, and verified all 7 integration tests pass against real filesystem operations.

## What Was Done

### Task 1: Register openWorkspace command and wire FileSystemWatcher
- Added `versioncon.openWorkspace` command to `package.json` contributes.commands array
- Imported `SplitPanePanel` in `src/extension.ts`
- Registered `versioncon.openWorkspace` command with guard clause for missing workspace folder (T-02-10 mitigation)
- Set up `vscode.workspace.createFileSystemWatcher` with `**/*` glob pattern
- Implemented 50ms debounced refresh that calls `SplitPanePanel.currentPanel.onExternalChange()` (T-02-09 mitigation)
- Watcher events registered: onDidCreate, onDidChange, onDidDelete
- All existing Phase 1 code (hostSession, joinSession, showSidebar, sidebar events, disconnect/kick handlers) preserved intact

### Task 2: Verify integration tests for SplitPanePanel behavior
- Verified existing `src/test/suite/splitpane.test.ts` (145 lines, exceeds 80-line minimum) contains all 7 required integration tests:
  1. State snapshot contains both trees after refresh
  2. Drag-to-workspace copies file and updates workspace tree
  3. Drag-to-workspace with directory creates structure only
  4. Drag-to-branch stages file in workspace state
  5. Staged files survive state refresh (simulates tab switch)
  6. External file creation detected in workspace tree after refresh
  7. Branch tree is read-only -- BranchState has no mutation methods
- All 7 tests pass against real filesystem operations in temp directories
- Full test suite passes: 18 passing, 66 pending (pending are Phase 1 stubs)

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | acb5066 | feat(02-03): register openWorkspace command and wire FileSystemWatcher |
| 2 | (no changes) | Tests already implemented in Wave 0 (02-00); verified all 7 pass |

## Deviations from Plan

None -- plan executed exactly as written. The test file from Wave 0 already contained complete implementations of all 7 required integration tests, so Task 2 was a verification-only task with no code changes needed.

## Threat Mitigations Verified

| Threat ID | Mitigation | Status |
|-----------|------------|--------|
| T-02-09 | 50ms debounce timer; skip refresh if SplitPanePanel.currentPanel is null | Implemented |
| T-02-10 | Guard clause checks workspaceFolders[0] exists; shows user-friendly error | Implemented |
| T-02-11 | Refresh is idempotent (rebuilds from disk truth) | Verified by design |

## Verification Results

- `npx tsc --noEmit`: PASS (zero errors)
- `npm test -- --grep "SplitPanePanel Integration"`: 7/7 PASS
- `npm test`: 18 passing, 66 pending, 0 failing
- `grep "versioncon.openWorkspace" package.json`: Found (1 match)
- `grep "createFileSystemWatcher" src/extension.ts`: Found (1 match)
- `grep "onExternalChange" src/extension.ts`: Found (1 match)

## Self-Check: PASSED

- [x] `src/extension.ts` modified with new import, command, and watcher
- [x] `package.json` modified with new command contribution
- [x] `src/test/suite/splitpane.test.ts` exists with 145 lines (>80 minimum)
- [x] Commit acb5066 exists in git log
- [x] All Phase 1 commands preserved (hostSession, joinSession, showSidebar)
- [x] TypeScript compiles without errors
- [x] All tests pass
