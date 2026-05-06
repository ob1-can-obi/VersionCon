---
phase: 03-push-sync-branch-management
plan: 05
subsystem: ui
tags: [vscode-extension, tree-view, branch-management, merge-flow, permissions]

# Dependency graph
requires:
  - phase: 02-split-pane-ui-file-system-layer
    provides: BranchManager, FileSystemLayer.collectFilePaths, BranchPermissions.canMergeToMain, BranchTreeProvider
  - phase: 03-push-sync-branch-management
    provides: permission gates + hostMemberId module-level tracker (03-02), MemberTrackingMap + permission-validated relay (03-03), SyncTracker wiring (03-04)
provides:
  - BranchListProvider tree view (BRANCH-03) listing every branch with active/locked state
  - versioncon.branchList view registration + activeBranchListProvider module-level reference for cross-scope refresh
  - Branch lifecycle refresh wiring (local create/switch/delete/lock/unlock + remote branch-created/branch-locked)
  - versioncon.quickMergeFiles command (BRANCH-07) with permission + lock gate, multi-file selection, and confirm-before-copy flow
  - versioncon.structuredMergeBranch command (BRANCH-08) with per-file walkthrough (added/modified classification, +/- line stats), optional per-file vscode.diff preview, and final confirm modal
affects: [04-presence-activity-chat]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Lazy-resolved active branch in TreeDataProvider: the provider populates activeBranchName on first getChildren call, so callers do not need to wire setActiveBranchName before first render"
    - "Module-level provider reference (activeBranchListProvider) lets the outer-scope wireClientEvents handlers refresh a provider that is constructed inside the inner async IIFE without scope plumbing"
    - "Cross-branch file copy command structure: branches.length pre-check → source pick → target pick (filtering source) → permission gate (canMergeToMain when target=main) → lock gate (lockedPushers + hostMemberId bypass) → enumerate files → multi-select QuickPick → modal confirm → fs.copyFile loop → refresh providers"
    - "Structured merge walkthrough builds an in-memory Walk[] of {path, status, addedLines, removedLines} before showing the QuickPick — identical files are skipped at build time so the user only sees real changes"

key-files:
  created:
    - src/ui/BranchListProvider.ts
    - src/test/suite/branchListProvider.test.ts
    - src/test/suite/mergeFlow.test.ts
  modified:
    - src/extension.ts
    - package.json

key-decisions:
  - "BranchListProvider lazily resolves activeBranchName on first getChildren if setActiveBranchName has not been called, so test setup is minimal and the provider is fully constructible without async wiring"
  - "Use description='active' (not a label suffix) for the active marker so getTreeItem(item).label remains the exact branch name — keeps automation-friendly grep matches for tree contents stable"
  - "Refresh fan-out across createBranch / switchBranch / deleteBranch / lockBranch / unlockBranch / remote branch-created / remote branch-locked keeps the all-branches view live without subscribing to a separate event source — every code path that mutates branch metadata explicitly refreshes"
  - "Lock gate in both new merge commands mirrors the existing push command: lockedPushers.includes(currentMemberId) || currentMemberId === hostMemberId. Same expression, same semantics, no behavioral surprises"
  - "Structured merge writes nothing during the walkthrough phase — every fs.copyFile is gated behind the final 'Merge' modal confirm, matching the plan's intent that 'the walkthrough itself does not write to disk'"

patterns-established:
  - "BranchListProvider.setActiveBranchName(name) is also a refresh signal (calls refresh() internally) — a single setter both updates state and triggers re-render, removing the need for a separate refresh call after switchBranch"
  - "Walk[] in-memory representation: classify before render, render before write — every command that mutates multiple files first builds the change set, then asks the user to confirm, then writes"
  - "Module-level reference pattern (activeBranchListProvider) follows the same pattern as activeHost / activePermissions / activePushHistory: declared at module scope, set inside the inner IIFE after construction, read by outer-scope handlers via null-check"

requirements-completed: [BRANCH-03, BRANCH-07, BRANCH-08]

# Metrics
duration: 5min
completed: 2026-05-06
---

# Phase 3 Plan 05: All-Branches View + Quick Merge + Structured Merge Walkthrough Summary

**Adds a dedicated VS Code tree view of every branch (BRANCH-03), a file-level quick-merge command for copying selected files between branches (BRANCH-07), and a structured-merge command with per-file diff preview and final-confirm walkthrough (BRANCH-08).**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-05-06T20:50:08Z
- **Completed:** 2026-05-06T20:54:59Z
- **Tasks:** 3 (all `type="auto"`; Task 1 with TDD)
- **Files created:** 3
- **Files modified:** 2
- **Tests:** 116 passing, 0 failing (was 105; +11 new tests: 6 BranchListProvider + 5 MergeFlow)

## Accomplishments

- **`BranchListProvider`** (new) implements `vscode.TreeDataProvider<BranchInfo>` returning every branch from `branchManager.listBranches()`. Active branch is marked via `description='active'`. Locked branches use `contextValue='branchListItem-locked'` and the `lock` themed icon; unlocked branches use `contextValue='branchListItem-unlocked'` and the `git-branch` icon. Tooltip shows creator and lock state. `setActiveBranchName(name)` doubles as a refresh signal (calls `refresh()` internally).
- **6 BranchListProvider unit tests** cover: getChildren count, label matching, active-marker description, locked/unlocked contextValue, refresh event firing, and post-create refresh inclusion.
- **`activeBranchListProvider` module-level reference** added so the outer-scope `wireClientEvents` handlers can refresh the provider that is constructed inside the inner async IIFE.
- **Branch lifecycle refresh wiring**: every code path that mutates branch metadata calls `branchListProvider.refresh()` (or `setActiveBranchName(...)` for switch). 6 paths wired: local createBranch, switchBranch, deleteBranch, lockBranch, unlockBranch, plus the `client.on('branch-created')` and `client.on('branch-locked')` handlers for remote events. `grep -c "branchListProvider\.refresh\|activeBranchListProvider\.refresh"` returns 6 (criterion ≥ 4).
- **`versioncon.branchList` view** registered in `package.json` with name `'All Branches'` and ordered last in the views array.
- **`versioncon.quickMergeFiles` command** (BRANCH-07) — full flow: branches.length pre-check, source QuickPick, target QuickPick (excluding source), `permissions.canMergeToMain(currentMemberId)` gate when target is `'main'`, lock gate via `branchManager.getBranch(target).locked` + `lockedPushers.includes(currentMemberId)` (host bypass via `currentMemberId === hostMemberId`), file enumeration via `fsLayer.collectFilePaths(sourceDir, '')`, multi-select QuickPick of file paths, modal `'Copy'` confirm, then `fs.copyFile` loop. Refreshes both `branchProvider` and `activeBranchListProvider` on success. Success message: `Quick-merged N file(s) from "X" into "Y".`
- **`versioncon.structuredMergeBranch` command** (BRANCH-08) — full flow: same source/target picks + same permission/lock gates as quickMergeFiles, then builds a `Walk[]` of `{path, status: 'added'|'modified', addedLines, removedLines}` (identical files are skipped at build time, so the walkthrough only shows real changes). Renders walkthrough as multi-select QuickPick with `placeHolder: 'Merge preview: N file(s) will change. Select files to preview diff (multi-select), or press Esc to skip preview.'`. Selected items open `vscode.diff` (target ↔ source) for visual review. Final `'Merge'` modal confirms before any `fs.copyFile`. Refreshes both providers on success.
- **`versioncon.quickMergeFiles` + `versioncon.structuredMergeBranch` registered in `package.json`** — both commands appear in the command palette with full titles `VersionCon: Quick Merge Files Across Branches` and `VersionCon: Merge Branch (Structured Walkthrough)`.
- **5 MergeFlow integration tests** cover the file-copy primitives both commands rely on: single-file copy, unselected-file exclusion, walkthrough classification (added vs modified), identical-file skip, full structured-merge application across multiple files.

## Task Commits

Each task was committed atomically:

1. **Task 1: Create BranchListProvider tree view + tests** — `5cec92f` (feat) — TDD: RED (failing tests) → GREEN (provider) → ALL GREEN (6/6).
2. **Task 2: Register BranchListProvider in extension + wire branch-created refresh + add view contribution** — `b6ed120` (feat) — Lint + tests still green; refresh count = 6.
3. **Task 3: Add quickMergeFiles + structuredMergeBranch commands with integration tests** — `e283b1d` (feat) — Lint + tests still green; 5 new MergeFlow tests pass.

## Files Created/Modified

- `src/ui/BranchListProvider.ts` (new) — TreeDataProvider implementation as described above.
- `src/test/suite/branchListProvider.test.ts` (new) — 6 unit tests with tmpDir + BranchManager + provider setup, covering all behaviors in the plan's `<behavior>` section.
- `src/test/suite/mergeFlow.test.ts` (new) — 5 integration tests covering both commands' file-copy logic without going through VS Code QuickPick (host-process-only).
- `src/extension.ts` — Added `BranchListProvider` import; module-level `activeBranchListProvider` declaration; refresh in `client.on('branch-created')` + `client.on('branch-locked')` (both also got an `activeBranchListProvider.refresh()` call); `branch-created` toast extended to include `createdBy` for clearer team awareness; `branchListProvider` construction + `versioncon.branchList` view registration inside async IIFE; refresh in createBranch/switchBranch/deleteBranch/lockBranch/unlockBranch; new `versioncon.quickMergeFiles` and `versioncon.structuredMergeBranch` commands inserted between the existing `mergeBranch` and `manageBranchPermissions` registrations.
- `package.json` — Added `versioncon.branchList` view to `contributes.views.versioncon` (4th entry); added `versioncon.quickMergeFiles` and `versioncon.structuredMergeBranch` to `contributes.commands` (immediately after `versioncon.mergeBranch`).

## Decisions Made

- **Lazy-resolved activeBranchName in BranchListProvider.** The provider's first `getChildren` call resolves `branchManager.getActiveBranch()` if `setActiveBranchName` was not called. This keeps the test setup minimal (no need to await `getActiveBranch` before constructing the provider) and removes a wiring requirement on callers. The extension still calls `setActiveBranchName(activeBranchName)` at construction for clarity, but the provider is robust to forgetting.
- **`description='active'` instead of label suffix.** The plan's `<behavior>` allowed either; description keeps the label exact-match clean (helpful for any automation that greps for branch names in the tree).
- **Refresh fan-out via explicit calls, not a single subscription.** I considered subscribing the provider to a `branchManager` event, but `BranchManager` does not currently emit events. Adding an event emitter to `BranchManager` would expand the surface for one consumer; instead, every code path that mutates branch metadata explicitly calls `branchListProvider.refresh()`. Same pattern as the existing `branchProvider.refresh()` calls. If multiple consumers ever need branch-mutation events, refactor to an emitter then.
- **Setter doubles as refresh.** `BranchListProvider.setActiveBranchName(name)` calls `this.refresh()` internally, so callers do not need a separate refresh after switching. This matches the plan's example code and is consistent with VS Code TreeView idioms (state mutation triggers re-render).
- **Structured merge does not write during walkthrough.** Every `fs.copyFile` is behind the final modal `'Merge'` confirm. The walkthrough phase only opens read-only `vscode.diff` previews, so a user who walks through changes and presses Esc/Cancel never modifies any branch. This is the explicit T-03-10 mitigation in the plan's threat register.
- **`branches.length < 2` short-circuit.** Both new commands return an info message if there are fewer than 2 branches. The plan implies this implicitly ("Source branch (copy files FROM)" / "Target branch (copy files TO)") but a user with only `main` would otherwise see an empty source pick. The `< 2` check is friendlier and matches the existing `mergeBranch` UX (which silently exits on cancel of the empty target pick).
- **Walk[] uses line-count delta for stats, not real diff.** A real word/line diff (`+X -Y` from a Myers diff) is out of scope for this plan and would require pulling in a diff library. Line count delta (`Math.max(0, srcLines - tgtLines)`) gives a usable approximation: a file that grew shows `+N -0`, a file that shrank shows `+0 -N`, a file that swapped equally-sized lines shows `+0 -0` (still listed as 'modified' since content differs). Real diff stats can be added in a future plan; the protocol of the QuickPick item descriptions (`+N -M`) is forward-compatible.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Plan-suggested code referenced `currentMemberId !== hostMemberId` in lock gate which requires `hostMemberId` to be visible in the IIFE scope**
- **Found during:** Task 3 (writing the lock-gate clause in both new merge commands)
- **Issue:** The plan's lock-gate snippet uses `currentMemberId !== hostMemberId`. In `extension.ts`, `currentMemberId` is declared inside the async IIFE (line 302) and `hostMemberId` is declared at module scope (line 35). Both are in scope inside the IIFE, so the expression compiles cleanly. No change needed.
- **Fix:** None — verified expression compiles via `npm run lint` (exits 0) and that the same pattern is already used by the existing `versioncon.push` command at lines 466-467 and `versioncon.createBranch` at line 659.
- **Files modified:** None (verification only).
- **Verification:** Lint clean.

**2. [Rule 3 - Blocking] Worktree did not have `node_modules` and was missing the `03-05-PLAN.md` file**
- **Found during:** Worktree initialization
- **Issue:** Worktrees do not auto-install npm dependencies, and the worktree base commit predates the phase-03 plan-file copy. `npm run lint` and `npm test` would fail without `node_modules`, and the executor cannot run without the plan file.
- **Fix:** Symlinked `/Users/jishnuraviprolu/Desktop/VersionCon/node_modules` into the worktree root; copied `03-05-PLAN.md` from the main repo into the worktree's `.planning/phases/03-push-sync-branch-management/` directory.
- **Files modified:** None in source tree (environmental). Plan file copy is in the worktree's `.planning/` and will be reconciled by the orchestrator's merge.

---

**Total deviations:** 1 environmental (worktree setup), 0 source-tree deviations. Plan executed exactly as written.

## Issues Encountered

- **Worktree did not have `node_modules`.** Documented above; resolved by symlink.
- **Worktree did not have `03-05-PLAN.md`.** Documented above; resolved by copying from main.

No code-level issues encountered.

## Threat Flags

None new. Plan threat register entries T-03-09 (quick-merge into locked branch) and T-03-10 (structured-merge into locked branch) are mitigated as designed:

- Both `versioncon.quickMergeFiles` and `versioncon.structuredMergeBranch` perform `permissions.canMergeToMain(currentMemberId)` when target is `main` AND `branchManager.getBranch(target).locked` + `lockedPushers.includes(currentMemberId)` checks BEFORE any file copy.
- `grep -c "permissions\.canMergeToMain(currentMemberId)" src/extension.ts` returns 3 (mergeBranch + quickMergeFiles + structuredMergeBranch), satisfying the plan's acceptance criterion ≥ 3.
- Structured-merge specifically does not write to disk during the walkthrough phase — `fs.copyFile` is only invoked after the final `'Merge'` modal confirm, so a user who lacks permission and somehow bypasses the early gate (e.g., via a future code path) would still not be able to mutate the target branch.

T-03-11 (path traversal via branch name) is `accept` per plan: branch names are validated by `BranchManager.createBranch` regex and file paths from `FileSystemLayer.collectFilePaths` already enforce traversal protection. T-03-12 (branch list visible to all members) is the BRANCH-03 requirement itself, `accept`. T-03-13 (concurrent quick-merge race) is `accept` per plan.

## Known Stubs

None. Both new commands are fully wired:

- `versioncon.quickMergeFiles` performs real file copies after permission/lock gates and a multi-select pick + confirm modal.
- `versioncon.structuredMergeBranch` performs real walkthrough construction, real `vscode.diff` invocations for selected files, and real file copies after the final modal.
- `BranchListProvider` returns real `BranchInfo` data sourced from `branchManager.listBranches()`.
- All refresh wiring is real: 6 explicit refresh call sites + 2 remote-event handlers all fire `branchListProvider.refresh()` or `activeBranchListProvider.refresh()`.

The line-count `addedLines` / `removedLines` in the structured-merge `Walk[]` is an approximation (delta of total line counts, not real Myers diff) — documented as a Decision Made above. The QuickPick description format (`+N -M`) is forward-compatible with a real diff implementation in a later plan.

## TDD Gate Compliance

Task 1 followed RED → GREEN cycle:

- **RED:** Wrote `src/test/suite/branchListProvider.test.ts` (6 tests) before creating `src/ui/BranchListProvider.ts`. `npm run lint` reported `Cannot find module '../../ui/BranchListProvider.js'` — verified RED gate.
- **GREEN:** Created `src/ui/BranchListProvider.ts` with the implementation described in the plan's `<action>` GREEN section. `npm run lint` passed (exits 0); `npm test` showed 6/6 BranchListProvider tests passing.
- **REFACTOR:** None needed — implementation matches the plan's GREEN code verbatim with one minor decision (lazy-resolve activeBranchName, documented above) that simplifies test setup.

Both RED and GREEN happened in a single commit (5cec92f) since Task 1 specified `tdd="true"` for a new file pair (test + impl). The git log preserves the test file and impl file as a single feat commit, matching the plan's `tdd-execution` rule for new-file TDD.

Tasks 2 and 3 are `type="auto"` (not `type="auto" tdd="true"`); the existing tests verify they don't regress.

## Pending Human Verification

None — all three tasks are `type="auto"` with automated verification (`npm run lint` + `npm test`).

The plan's `<output>` section asks for a SUMMARY documenting the BranchListProvider implementation and the file paths it touches; the quick-merge command flow; the structured-merge command flow; and test counts mapped to requirements. All four are covered above.

## Test → Requirement Mapping

| Test | Requirement | Behavior verified |
|------|-------------|-------------------|
| `BranchListProvider › getChildren returns one TreeItem per branch from listBranches` | BRANCH-03 | Tree view sources from branchManager.listBranches() |
| `BranchListProvider › each TreeItem label equals the branch name` | BRANCH-03 | Tree items show branch names |
| `BranchListProvider › active branch TreeItem has description set to "active"` | BRANCH-03 | Active branch is visually distinct |
| `BranchListProvider › locked branches have contextValue branchListItem-locked, unlocked have branchListItem-unlocked` | BRANCH-03 | Lock state surfaces via contextValue (enables menu wiring) |
| `BranchListProvider › refresh fires onDidChangeTreeData event` | BRANCH-03 | Refresh re-renders the tree |
| `BranchListProvider › after createBranch + refresh, getChildren includes the new branch` | BRANCH-03 | New branches appear after refresh |
| `MergeFlow › quick merge copies a single file from source to target` | BRANCH-07 | Single-file copy works |
| `MergeFlow › quick merge does not copy unselected files` | BRANCH-07 | Multi-select honors selection |
| `MergeFlow › structured merge walkthrough classifies added vs modified files` | BRANCH-08 | Classification is correct |
| `MergeFlow › structured merge walkthrough skips identical files` | BRANCH-08 | No-op files are filtered before render |
| `MergeFlow › full structured merge applies every changed file to target` | BRANCH-08 | End-to-end merge writes all changes |

## Phase 3 Coverage After Plan 05

Phase 3 requirement coverage now stands at 20/20 across plans 01-05:

- **PUSH-01..09** — covered in plans 03-01 (SyncTracker), 03-02 (permission gates + types), 03-03 (real affected-members + sync-request), 03-04 (sync-before-run)
- **BRANCH-01, BRANCH-02, BRANCH-04, BRANCH-05, BRANCH-06, BRANCH-09** — covered in plan 03-02
- **BRANCH-03, BRANCH-07, BRANCH-08** — covered in this plan (03-05)
- **SAFE-03** — covered in plan 03-02
- **SAFE-04** — covered in plan 03-03

## Next Phase / Plan Readiness

- **Phase 4 (presence/activity/chat)** can render branch lifecycle events alongside push notifications using the same UX surface. The branch-created toast already includes `createdBy` (added in Task 2), so chat-integration can mirror it directly.
- **Future enhancements** to BRANCH-08 walkthrough: integrate a real Myers diff library (e.g., `diff` npm package) to replace the line-count approximation in `Walk[].addedLines / removedLines`. The QuickPick description format (`+N -M`) is forward-compatible.
- **Future enhancements** to BranchListProvider: add a context menu (`view/item/context`) for lock/unlock/delete/switch on right-click. The contextValue distinction (`branchListItem-locked` vs `branchListItem-unlocked`) is already in place to support `when` clauses.
- **Future enhancements**: the lock gate in both new merge commands could be unified with `versioncon.mergeBranch` into a shared helper (`assertCanMergeInto(target)`) — three call sites is the threshold where extraction usually pays off. Defer until a fourth merge-style command appears.

## Self-Check: PASSED

- File `src/ui/BranchListProvider.ts` — created — FOUND
- File `src/test/suite/branchListProvider.test.ts` — created — FOUND
- File `src/test/suite/mergeFlow.test.ts` — created — FOUND
- File `src/extension.ts` — modified — FOUND
- File `package.json` — modified — FOUND
- File `.planning/phases/03-push-sync-branch-management/03-05-SUMMARY.md` — created — FOUND (this file)
- Commit `5cec92f` (Task 1 - feat: BranchListProvider) — FOUND in `git log`
- Commit `b6ed120` (Task 2 - feat: register view + lifecycle refresh) — FOUND in `git log`
- Commit `e283b1d` (Task 3 - feat: quickMergeFiles + structuredMergeBranch) — FOUND in `git log`
- Acceptance: `export class BranchListProvider implements vscode.TreeDataProvider<BranchInfo>` — FOUND in src/ui/BranchListProvider.ts
- Acceptance: `branchListItem-locked` AND `branchListItem-unlocked` — FOUND in src/ui/BranchListProvider.ts
- Acceptance: `branchManager.listBranches()` — FOUND in src/ui/BranchListProvider.ts
- Acceptance: `import { BranchListProvider } from './ui/BranchListProvider.js';` — FOUND in src/extension.ts
- Acceptance: `let activeBranchListProvider: BranchListProvider | null = null;` — FOUND in src/extension.ts
- Acceptance: `new BranchListProvider(branchManager)` — FOUND in src/extension.ts
- Acceptance: `vscode.window.registerTreeDataProvider('versioncon.branchList', branchListProvider)` — FOUND in src/extension.ts
- Acceptance: `branchListProvider.setActiveBranchName(` — FOUND in src/extension.ts
- Acceptance: `grep -c "branchListProvider\.refresh\|activeBranchListProvider\.refresh"` returns 6 (≥ 4) — VERIFIED
- Acceptance: `client.on('branch-created'` body contains `activeBranchListProvider.refresh()` — FOUND
- Acceptance: package.json view has `versioncon.branchList` / `'All Branches'` — VERIFIED via `node -e` check
- Acceptance: `versioncon.quickMergeFiles` literal — FOUND in src/extension.ts
- Acceptance: `versioncon.structuredMergeBranch` literal — FOUND in src/extension.ts
- Acceptance: `Quick-merged` literal — FOUND in src/extension.ts
- Acceptance: `Merge preview:` literal — FOUND in src/extension.ts
- Acceptance: `grep -c "permissions\.canMergeToMain(currentMemberId)"` returns 3 (≥ 3) — VERIFIED
- Acceptance: package.json commands include `versioncon.quickMergeFiles` AND `versioncon.structuredMergeBranch` — VERIFIED via `node -e` check
- Acceptance: `suite('MergeFlow'` — FOUND in src/test/suite/mergeFlow.test.ts
- Acceptance: `grep -c "  test(" src/test/suite/mergeFlow.test.ts` returns 5 (≥ 5) — VERIFIED
- Acceptance: `grep -c "  test(" src/test/suite/branchListProvider.test.ts` returns 6 (≥ 6) — VERIFIED
- Lint: `tsc --noEmit` exits 0 — VERIFIED
- Tests: 116 passing, 0 failing, exit code 0 (was 105; +11 new tests) — VERIFIED

---
*Phase: 03-push-sync-branch-management*
*Completed: 2026-05-06*
