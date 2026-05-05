---
phase: 02-split-pane-ui-file-system-layer
plan: 01
subsystem: filesystem
tags: [filesystem, types, tdd, drag-drop, path-validation]
dependency_graph:
  requires: [02-00]
  provides: [FileSystemLayer, BranchState, WorkspaceState, TreeNode, StagedFile, SplitPaneState]
  affects: [02-02, 02-03]
tech_stack:
  added: []
  patterns: [path-traversal-validation, dirs-first-tree-sort, stateless-webview-types]
key_files:
  created:
    - src/types/filesystem.ts
    - src/filesystem/FileSystemLayer.ts
    - src/filesystem/BranchState.ts
    - src/filesystem/WorkspaceState.ts
  modified:
    - tsconfig.json
    - .vscode-test.mjs
    - src/test/suite/client.test.ts
    - src/test/suite/discovery.test.ts
    - src/test/suite/host.test.ts
    - src/test/suite/protocol.test.ts
    - src/test/suite/splitpane.test.ts
    - src/test/suite/storage.test.ts
decisions:
  - "StagedFile uses `path` field instead of `relativePath` to match Wave 0 test expectations"
  - "Mocha UI set to `tdd` (suite/test) as canonical test interface for the project"
  - "Phase 1 test stubs converted from BDD (describe/it) to TDD (suite/test) for consistency"
metrics:
  duration: 459s
  completed: 2026-05-05T16:52:39Z
  tasks_completed: 2
  tasks_total: 2
  files_created: 4
  files_modified: 8
  tests_passing: 18
  tests_pending: 66
---

# Phase 02 Plan 01: Filesystem Types and FileSystemLayer Summary

FileSystemLayer with path-traversal-guarded copy/structure operations, tree builder with dirs-first sorting and codicon icons, BranchState read-only cache, and WorkspaceState with deduplicating staged file tracking -- all driven GREEN from Wave 0 tests.

## What Was Built

### Types (`src/types/filesystem.ts`)
Seven type exports defining the contract between filesystem layer, extension host, and webview:
- `TreeNode` -- matches `@vscode-elements/elements` tree data shape with label, value (relative path), icons (branch/open/leaf codicon names), and optional subItems
- `DragToWorkspacePayload` / `DragToBranchPayload` -- webview-to-host drag messages
- `StagedFile` -- path + timestamp for files staged for push
- `SplitPaneState` -- full state snapshot (workspace tree, branch tree, staged files)
- `WebviewMessage` / `HostMessage` -- discriminated unions for the postMessage protocol

### FileSystemLayer (`src/filesystem/FileSystemLayer.ts`)
Core file operations for drag-and-drop:
- `copyFileToWorkspace(relativePath)` -- resolves against branchDir, validates path, creates parent dirs, copies file (UI-04, UI-06)
- `copyStructureOnly(relativeDirPath)` -- recursively creates directory structure without copying files (UI-05)
- `buildTreeData(rootDir)` -- reads directory, sorts dirs-first then alphabetical, maps to TreeNode[] with codicon icons by extension
- Path traversal validation: `path.resolve` + normalized `startsWith` check (T-02-01, T-02-02)
- File icon mapping: 15 extensions mapped to codicon names (ts, js, json, md, html, css, py, java, yml, xml, svg, images)

### BranchState (`src/filesystem/BranchState.ts`)
Read-only branch tree manager:
- Wraps `FileSystemLayer.buildTreeData` for the branch directory
- Caches tree in memory; `refresh()` rebuilds from disk
- Intentionally has NO mutation methods (no `stageFile`, no `copyTo`) -- enforces read-only branch pane

### WorkspaceState (`src/filesystem/WorkspaceState.ts`)
Workspace tree + staged files:
- `refresh()` rebuilds tree from disk; staged files survive refresh (in-memory, not on disk)
- `stageFile(path)` adds to staged list with deduplication by path
- `unstageFile(path)` removes from staged list
- `getStagedFiles()` returns shallow copy of staged array
- `clearStaged()` empties staged list (for Phase 3 push consumption)

## Test Results

18 tests passing, 66 pending (Phase 1 stubs):

| Suite | Tests | Status |
|-------|-------|--------|
| FileSystemLayer | 7 | All passing |
| BranchState | 1 | Passing |
| WorkspaceState | 3 | All passing |
| SplitPanePanel Integration | 7 | All passing |
| Phase 1 stubs (6 suites) | 0 | 66 pending |

## TDD Gate Compliance

- RED gate: `test(02-01)` commit `8817818` -- types created, tests confirmed failing (Cannot find module errors)
- GREEN gate: `feat(02-01)` commit `5401bf7` -- all implementations created, 18 tests passing

Both gates present in correct order. TDD compliance verified.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] StagedFile interface field name mismatch**
- **Found during:** Task 1
- **Issue:** Plan specified `relativePath: string` in StagedFile, but Wave 0 tests reference `staged[0].path` and `s.path`
- **Fix:** Used `path: string` instead of `relativePath: string` to match test expectations
- **Files modified:** `src/types/filesystem.ts`
- **Commit:** 8817818

**2. [Rule 3 - Blocking] Mixed mocha interface (BDD vs TDD) prevented test execution**
- **Found during:** Task 2
- **Issue:** Phase 1 test stubs used `describe`/`it` (BDD) but Phase 2 tests use `suite`/`test` (TDD). Mocha crashes when both interfaces are used simultaneously -- `describe is not defined` with TDD ui, `suite is not defined` with BDD ui.
- **Fix:** Set `.vscode-test.mjs` mocha config to `ui: 'tdd'` and converted all 5 Phase 1 test stub files from BDD to TDD syntax. Mechanical keyword replacement only (describe->suite, it->test); no test logic changed since all are empty pending stubs.
- **Files modified:** `.vscode-test.mjs`, `client.test.ts`, `discovery.test.ts`, `host.test.ts`, `protocol.test.ts`, `storage.test.ts`
- **Commit:** 5401bf7

**3. [Rule 3 - Blocking] TypeScript ES2023 lib required for Array.findLastIndex**
- **Found during:** Task 2
- **Issue:** `filesystem.test.ts` line 98 uses `Array.findLastIndex()` which requires ES2023 lib, but tsconfig only had `target: ES2022` with no explicit `lib`
- **Fix:** Added `"lib": ["ES2023"]` to tsconfig.json compilerOptions
- **Files modified:** `tsconfig.json`
- **Commit:** 5401bf7

**4. [Rule 1 - Bug] splitpane.test.ts EISDIR error on directory write**
- **Found during:** Task 2
- **Issue:** Line 80 of splitpane.test.ts called `fs.writeFile(path.join(branchDir, 'lib'), '')` which attempted to write to a directory, causing EISDIR error
- **Fix:** Removed the extraneous `writeFile` call. The test already creates the necessary files in `lib/core/engine.ts` for the structure-only copy test.
- **Files modified:** `src/test/suite/splitpane.test.ts`
- **Commit:** 5401bf7

## Decisions Made

1. **StagedFile uses `path` not `relativePath`**: Wave 0 tests are the source of truth in TDD; interface adapted to match test expectations rather than modifying tests.
2. **Mocha TDD interface as project standard**: With Phase 2 tests using `suite`/`test`, set `ui: 'tdd'` as the canonical mocha interface and converted all existing stubs for consistency.
3. **ES2023 lib addition**: Added to tsconfig to support modern array methods used in tests; does not change the compilation target (still ES2022).

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 8817818 | test(02-01): define filesystem type contracts and verify RED state |
| 2 | 5401bf7 | feat(02-01): implement FileSystemLayer, BranchState, and WorkspaceState (GREEN) |

## Self-Check: PASSED

All 4 created files verified on disk. Both commit hashes (8817818, 5401bf7) verified in git log. 7 type exports confirmed in `src/types/filesystem.ts`. TypeScript compiles cleanly (`npx tsc --noEmit` exits 0). All 18 tests pass (`npm test` exits 0).
