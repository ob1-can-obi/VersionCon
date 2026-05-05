---
phase: 02-split-pane-ui-file-system-layer
plan: 00
subsystem: test-infrastructure
tags: [tdd, red-tests, filesystem, split-pane, wave-0]
dependency_graph:
  requires: []
  provides:
    - "RED test stubs for FileSystemLayer unit tests"
    - "RED test stubs for SplitPanePanel integration tests"
  affects:
    - "02-01-PLAN.md (Wave 1 implementation must make these tests GREEN)"
    - "02-02-PLAN.md (SplitPanePanel integration behavior)"
    - "02-03-PLAN.md (Extension wiring and FileSystemWatcher)"
tech_stack:
  added: []
  patterns:
    - "mocha suite/test TDD-style test structure"
    - "Temp directory per suite with setup/teardown cleanup"
    - "Real filesystem assertions (fs.stat, fs.access) for file I/O tests"
key_files:
  created:
    - src/test/suite/filesystem.test.ts
    - src/test/suite/splitpane.test.ts
  modified: []
decisions:
  - "Used suite/test (TDD-style) instead of describe/it (BDD-style) as specified in the plan, consistent with the TDD RED/GREEN/REFACTOR methodology"
  - "Test assertions use concrete value checks (strictEqual, stat, access) rather than trivial assert.ok(true)"
metrics:
  duration: "~3 minutes"
  completed: "2026-05-05T16:43:01Z"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 0
---

# Phase 02 Plan 00: Wave 0 TDD Test Stubs Summary

RED test stubs for Phase 2 filesystem layer and split-pane integration -- 18 test cases across 2 files importing from non-existent modules to establish TDD RED state before any implementation begins.

## What Was Done

### Task 1: filesystem.test.ts (11 test cases)

Created `src/test/suite/filesystem.test.ts` with three test suites:

**FileSystemLayer suite (7 tests):**
- `copyFileToWorkspace copies a file and creates parent dirs` (UI-04, UI-06)
- `copyFileToWorkspace throws on path traversal` (security)
- `copyStructureOnly creates nested directories without copying files` (UI-05)
- `copyStructureOnly throws on path traversal` (security)
- `buildTreeData returns correct TreeNode structure (dirs first, sorted alpha)` (UI-08)
- `buildTreeData uses correct icons for file types` (UI-08)
- `operates on real filesystem (not virtual)` (UI-08)

**BranchState suite (1 test):**
- `getTree returns TreeNode array from branch directory` (UI-02)

**WorkspaceState suite (3 tests):**
- `stageFile adds file path to staged list` (UI-07)
- `unstageFile removes file path from staged list` (UI-07)
- `getStagedFiles returns all staged paths` (UI-07)

### Task 2: splitpane.test.ts (7 test cases)

Created `src/test/suite/splitpane.test.ts` with one integration suite:

**SplitPanePanel Integration suite (7 tests):**
- `state snapshot contains both trees after refresh` (UI-01)
- `drag-to-workspace copies file and updates workspace tree` (UI-04)
- `drag-to-workspace with directory creates structure only` (UI-05)
- `drag-to-branch stages file in workspace state` (UI-07)
- `staged files survive state refresh (simulates tab switch)` (UI-03)
- `external file creation detected in workspace tree after refresh` (UI-03)
- `branch tree is read-only -- BranchState has no mutation methods` (UI-02)

## RED State Confirmation

All tests import from modules that do not yet exist:
- `../../filesystem/FileSystemLayer.js` -- does NOT exist
- `../../filesystem/BranchState.js` -- does NOT exist
- `../../filesystem/WorkspaceState.js` -- does NOT exist

Tests will fail at import/compile time until Wave 1+ implementation creates these modules.

## Requirement Coverage

| Req ID | Description | Test File | Test Count |
|--------|-------------|-----------|------------|
| UI-01 | Split pane with two trees | splitpane.test.ts | 1 |
| UI-02 | Branch tree read-only | filesystem.test.ts, splitpane.test.ts | 2 |
| UI-03 | Workspace reflects filesystem changes | splitpane.test.ts | 2 |
| UI-04 | Drag file from branch to workspace | filesystem.test.ts, splitpane.test.ts | 2 |
| UI-05 | Folder drag = structure only | filesystem.test.ts, splitpane.test.ts | 2 |
| UI-06 | File drag = file + parent dirs | filesystem.test.ts | 1 |
| UI-07 | Drag to branch stages files | filesystem.test.ts, splitpane.test.ts | 4 |
| UI-08 | Real filesystem operations | filesystem.test.ts | 3 |

## Deviations from Plan

None -- plan executed exactly as written.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | aeaee98 | test(02-00): add RED test stubs for FileSystemLayer, BranchState, WorkspaceState |
| 2 | 42b6e20 | test(02-00): add RED integration test stubs for SplitPanePanel |

## Known Stubs

None -- test files contain concrete assertions, not placeholder `assert.ok(true)` stubs.

## Self-Check: PASSED

- FOUND: src/test/suite/filesystem.test.ts
- FOUND: src/test/suite/splitpane.test.ts
- FOUND: 02-00-SUMMARY.md
- FOUND: commit aeaee98
- FOUND: commit 42b6e20
