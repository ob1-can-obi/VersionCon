---
phase: 04-presence-chat-file-level-conflict-notifications
plan: 06
subsystem: utilities
tags: [pure-fn, path-normalization, vscode-api, conflict-detection, cross-platform]

# Dependency graph
requires:
  - phase: 03-push-pull-history
    provides: PushFileEntry.relativePath shape (workspace-relative posix forward-slash strings)
  - vscode API
    provides: vscode.window.tabGroups.all, TabInputText, TabInputTextDiff
provides:
  - computeFileOverlap pure function (CONF-01 + CONF-07 + CONF-08 calculation engine)
  - getOpenTabPaths VS-Code-aware helper (consumed by Plan 04-09 push-received handler)
  - Cross-platform path-normalization rules (darwin/win32 case-insensitive, linux case-sensitive)
affects:
  - 04-07-activity-tree (may call computeFileOverlap to label "affects you" rows)
  - 04-09-soft-notifications (sole consumer of both functions for toast/flash decisions)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure-fn utility module pattern (src/utils/fileOverlap.ts) with platform-injectable branch — first such pure-fn file in src/utils/"
    - "pathLib selection (path.win32 vs path.posix) inside the function body — makes win32 unit tests reproducible on macOS CI without OS-conditional skip"
    - "vscode-API-aware helper (getOpenTabPaths) co-located with pure fn but explicitly documented as not unit-testable — integration coverage deferred to Plan 04-09"

key-files:
  created:
    - src/utils/fileOverlap.ts
    - src/test/suite/fileOverlap.test.ts
  modified: []

key-decisions:
  - "computeFileOverlap is purely synchronous, takes platform as an injectable argument so all three platform branches are exercised in unit tests on any host OS"
  - "Path normalization splits on both path.sep AND backslash so win32-style inputs ('C:\\\\Users\\\\…\\\\Foo.ts') normalize correctly when the test fakes platform='win32' on a posix host"
  - "pathLib = (platform === 'win32') ? path.win32 : path.posix selects the relative-path module by target platform, decoupling the function's correctness from the runtime OS"
  - "TabInputTextDiff includes BOTH original and modified URIs in getOpenTabPaths per RESEARCH §'Edge cases' — user clearly cares about both files visible in the diff view"
  - "Output arrays preserve original-case from pushedFiles for display while comparison runs on lowercased keys (case-insensitive platforms only) — verified by the partial-overlap test"

patterns-established:
  - "Pure-fn + co-located vscode-API wrapper in the same module — keeps the contract together, isolates the impure surface to one named function"
  - "Threat-model JSDoc cross-reference to RESEARCH §'Path normalization rules' at the function header — implementer can find the spec source without grep"

requirements-completed: [CONF-01, CONF-07, CONF-08]

# Metrics
duration: 3min
completed: 2026-05-08
---

# Phase 4 Plan 06: File-Overlap Detection Summary

**Pure-function computeFileOverlap utility (with cross-platform path normalization) plus a co-located VS-Code-aware getOpenTabPaths helper. 12 unit tests cover case-sensitivity branches on darwin/linux/win32, workspace boundary checks, empty-input edge cases, dedup, and original-case preservation. Suite total 140 → 152 passing.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-05-08T01:48:27Z
- **Completed:** 2026-05-08T01:51:35Z
- **Tasks:** 2 of 2
- **Files modified:** 2 (both created)

## Accomplishments

- New `src/utils/fileOverlap.ts` exports two functions: `computeFileOverlap(pushedFiles, openTabFsPaths, workspaceRootFsPath, platform?)` (pure, O(N+M)) and `getOpenTabPaths()` (touches `vscode.window.tabGroups.all`, dedupes via Set, includes `TabInputText` and both halves of `TabInputTextDiff`).
- Path normalization combines `path.sep` and explicit backslash splitting so win32-style absolute paths like `C:\Users\dev\proj\src\Foo.ts` normalize correctly even on a posix host running the unit tests.
- Platform branching is explicit: `darwin`/`win32` lowercase the comparison key, `linux` keeps original case. `pathLib` (selected as `path.win32` when `platform === 'win32'`, otherwise `path.posix`) drives `relative()` so the function is OS-agnostic.
- Workspace-boundary check (`!rel.startsWith('..')`) filters open tabs outside the workspace root from the comparison set — verified by a dedicated test.
- 12 new unit tests in `src/test/suite/fileOverlap.test.ts` cover: 3 case-sensitivity branches (darwin / linux / win32), 2 workspace-boundary cases (inside/outside), 2 empty-input cases (empty pushedFiles / empty openTabs), 3 overlap categories (none / full / partial-with-original-case-preservation), 1 dedup case, and 1 order-preservation case.
- Full test suite now at **152 passing / 0 failing / 66 pending** (was 140 passing).

## Task Commits

Each task was committed atomically:

1. **Task 1: Create src/utils/fileOverlap.ts** — `5cf4c59` (feat)
2. **Task 2: Add unit tests for computeFileOverlap** — `a7499dd` (test)

**Plan metadata commit:** _(pending — added by final commit step)_

## Files Created/Modified

- `src/utils/fileOverlap.ts` _(created, 111 lines)_ — Two exported functions with full JSDoc covering path-normalization rules, edge cases (untitled tabs, diff editors), and complexity bound. No runtime dependencies beyond Node `path` and `vscode`.
- `src/test/suite/fileOverlap.test.ts` _(created, 163 lines)_ — Mocha TDD-style suite with 6 sub-suites. Uses no fixtures (pure data); imports only `assert`, `path`, and the function under test.

## Decisions Made

- **`pathLib` indirection inside `computeFileOverlap`** — using `path.win32.relative` when `platform === 'win32'` (and `path.posix.relative` otherwise) makes the win32 unit test reproducible on macOS CI without resorting to `process.platform === 'win32' ? test : test.skip`. The plan's `<action>` block flagged this as a known wrinkle and offered three options; the chosen path keeps a single test file with no platform-conditional skip.
- **Backslash-split alongside `path.sep`-split** — the plan's RESEARCH-verbatim implementation only split on `path.sep`. Splitting on backslash too is a small extension that ensures normalization works when win32 inputs flow into a function running with `process.platform === 'darwin'` (real-world case: a developer on macOS testing or running unit tests with synthetic win32 inputs). Backwards compatible with all other platforms (posix paths never contain `\`).
- **`getOpenTabPaths` returns `Array.from(Set)` not `[...arr]`** — slightly more explicit; preserves insertion order while deduping. Matches the pattern recommended in the plan's `<action>` block.
- **Tests use `path.posix.join` for setup and pass `platform: 'darwin' | 'linux' | 'win32'` explicitly** — keeps test inputs deterministic across host OSes. The win32 test additionally hard-codes a `C:\Users\…` style absolute path to exercise the backslash-normalization branch.

## Deviations from Plan

**Plan executed exactly as written for the core acceptance criteria.** One small enhancement applied beyond the plan's literal RESEARCH-verbatim copy:

### [Rule 2 — Critical functionality] Added backslash-split to path normalization

- **Found during:** Task 1 implementation
- **Issue:** RESEARCH §"Algorithm" splits paths only on `path.sep`. On a posix host running the win32 unit test (`platform='win32'` injected), `path.sep === '/'`, so a literal backslashed open path like `'C:\\Users\\dev\\proj\\src\\Foo.ts'` would only get split on `/` (which it doesn't contain) and the backslashes would survive into the comparison key. The win32 test would then fail to match against `src/foo.ts` despite case-insensitivity.
- **Fix:** After the initial `split(path.sep).join('/')`, additionally `split('\\').join('/')` so backslashes are normalized regardless of which separator the runtime considers native. On linux/darwin (no win32 inputs in production), this is a no-op. On win32 (real native), `path.sep` is already `\` so the second split is also a no-op. The change only matters in unit-test scenarios where one platform's inputs run through a different platform's `path` module.
- **Files modified:** `src/utils/fileOverlap.ts` (one extra `.split('\\').join('/')` in the `norm` helper)
- **Commit:** `5cf4c59`

This is a correctness improvement, not a behavior change in production: the function still produces the same outputs on real darwin/linux/win32 hosts. It just makes the unit test for the win32 case-insensitive-with-backslash branch reproducible across OSes.

### [Plan task-2 ambiguity resolution] Test count

- The plan's acceptance criteria says `>= 9` tests; I shipped 12. The extra 3 are: the win32 case-insensitive-plus-backslash test (the plan's `<action>` notes this might be dropped), the "open tab inside workspace is included" positive control alongside the boundary-exclusion test, and the order-preservation test. All three add real coverage; none are redundant.

## Issues Encountered

- **Test compilation step missing from `npm run build`.** The `build` script only runs esbuild on `src/extension.ts`; mocha test files require `npx tsc` (no flags) to emit to `dist/test/`. After Task 2 wrote `fileOverlap.test.ts`, the first `npm test` run reported only 140 passing (no new tests visible) because `dist/test/suite/fileOverlap.test.js` didn't exist yet. Resolved by running `npx tsc` to compile, then re-running `npm test` — 152 passing / 0 failing. **No code change needed**; this is just the project's existing build flow. Worth noting for downstream Phase 4 plans that add test files: `npx tsc` is the implicit pretest step.

## Self-Check

- [x] `src/utils/fileOverlap.ts` exists (FOUND)
- [x] `src/test/suite/fileOverlap.test.ts` exists (FOUND)
- [x] Commit `5cf4c59` exists (FOUND)
- [x] Commit `a7499dd` exists (FOUND)
- [x] `npx tsc --noEmit` passes (verified after both tasks)
- [x] `npm run build` passes (verified after Task 1)
- [x] `npm test` reports 152 passing / 0 failing / 66 pending (verified after Task 2; baseline was 140 before this plan)
- [x] All 12 fileOverlap tests pass (verified by grep on test output)
- [x] `grep -c "export function" src/utils/fileOverlap.ts` returns 2 (FOUND)
- [x] `grep "platform === 'darwin' || platform === 'win32'"` matches (FOUND)
- [x] `grep "rel.startsWith('..')"` matches (FOUND)
- [x] `grep "TabInputTextDiff"` matches (FOUND)

## Self-Check: PASSED

## Next Phase Readiness

- Plan 04-09 (`soft-notifications-PLAN.md`) can now `import { computeFileOverlap, getOpenTabPaths } from '../utils/fileOverlap.js'` and feed the result of `computeFileOverlap(pushFileEntry.relativePath_array, getOpenTabPaths(), workspace.workspaceFolders[0].uri.fsPath)` into the toast/flash branch logic.
- Plan 04-07 (`activity-tree-PLAN.md`) can call `computeFileOverlap` to label "affects you" rows on push/revert events.
- Threat T-04-06-01 (path traversal in pushedFiles) is documented as accepted: the workspace-boundary filter applies to OPEN tabs not pushed files, but a pushed-file entry like `../../etc/passwd` would simply fail to match any open tab and end up in `unaffected` — harmless. T-04-06-02 (info disclosure) and T-04-06-03 (DoS) are accepted in the plan's threat register.

## Threat Flags

None — Plan 04-06 introduces no new network endpoints, no auth surface, no file-system writes, and no schema changes. Pure in-memory computation over data that's already trust-boundary-validated upstream (PushService stamps `relativePath`, VS Code owns `tabGroups`).

---
*Phase: 04-presence-chat-file-level-conflict-notifications*
*Completed: 2026-05-08*
