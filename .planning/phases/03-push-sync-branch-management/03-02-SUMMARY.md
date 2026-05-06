---
phase: 03-push-sync-branch-management
plan: 02
subsystem: api
tags: [vscode-extension, permissions, websocket-protocol, branch-management]

# Dependency graph
requires:
  - phase: 02-split-pane-ui-file-system-layer
    provides: BranchManager, BranchPermissions, PushService, BranchTreeProvider, WorkspaceTreeProvider, previewDiff command
provides:
  - Permission gates on push command (locked branch + branch restriction checks)
  - Permission gate on createBranch command
  - Admin UI for grant/revoke branch creation and restrict/clear branch access
  - hostMemberId module-level tracker initialized on session start
  - EnhancedPushSummary type carrying affectedMembers metadata for PUSH-03
  - latestPushId field on SyncResponse for reconnection sync seeding
  - tracked-paths-update protocol message for PUSH-03 affected-members data
affects: [03-03, 03-04, 03-05, 04-presence-activity-chat]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Permission-gated commands: branch lock check + canPushToBranch / canCreateBranch invoked before service-layer call"
    - "Admin permission UI: extend manageBranchPermissions QuickPick with grant/revoke/restrict/clear options, member selection from activeHost.getMembers() with InputBox CSV fallback"
    - "Discriminated protocol union extension: add to MessageType, ProtocolMessage union, and VALID_TYPES set together"

key-files:
  created: []
  modified:
    - src/extension.ts
    - src/types/push.ts
    - src/network/protocol.ts

key-decisions:
  - "hostMemberId is module-level (alongside activeHost) defaulting to 'local-user' so single-user mode and host commands always pass canCreateBranch / canPushToBranch host-bypass without needing to thread it through inner-scope variables"
  - "Restrict-branch member selection prefers QuickPick over active session members when available, falls back to InputBox CSV for offline/local use -- avoids forcing the admin to know member IDs verbatim"
  - "PUSH-04 (side-by-side diff) is satisfied by the existing previewDiff command (vscode.diff invocation, registered both as a contributed command and as a workspaceFileStaged context-menu entry); no new code required for this plan, only confirmation"

patterns-established:
  - "Permission-check pattern: locked-branch + lockedPushers gate before canPushToBranch service call before push execution"
  - "Module-level role identity tracker: hostMemberId set in wireHostEvents to match the host's local memberId default"
  - "Protocol message addition: union type + interface + VALID_TYPES set update kept colocated in src/network/protocol.ts"

requirements-completed: [PUSH-01, PUSH-02, PUSH-04, PUSH-05, PUSH-06, PUSH-07, BRANCH-01, BRANCH-02, BRANCH-04, BRANCH-05, BRANCH-06, BRANCH-09, SAFE-03]

# Metrics
duration: 5min
completed: 2026-05-06
---

# Phase 3 Plan 02: Push Workflow + Permissions + Side-by-Side Diff Summary

**Permission-gated push and createBranch commands plus admin grant/revoke/restrict QuickPick UI, with EnhancedPushSummary and latestPushId protocol fields seeding Plans 03-03 onward.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-05-06T20:17:56Z
- **Completed:** 2026-05-06T20:22:03Z
- **Tasks:** 3 (2 code tasks + 1 verification checkpoint)
- **Files modified:** 3

## Accomplishments

- Push command now refuses pushes to locked branches the user is not in `lockedPushers` for, and refuses pushes when `permissions.canPushToBranch(currentMemberId, branch)` returns false (BRANCH-04, BRANCH-05)
- CreateBranch command now refuses non-permitted members with an "ask the admin" message (BRANCH-02)
- Admin permission management UI gained four new QuickPick options: grant branch creation, revoke branch creation, restrict branch access (multi-select members or InputBox CSV fallback), clear branch restrictions (BRANCH-01, BRANCH-05)
- `EnhancedPushSummary` type added to `src/types/push.ts` carrying `affectedMembers` with `memberId`, `displayName`, and `overlappingFiles[]` for PUSH-03 wiring in Plan 03-03
- `SyncResponse` protocol message extended with `latestPushId: string | null` so reconnecting clients can seed sync state correctly
- `TrackedPathsUpdate` protocol message added (with `'tracked-paths-update'` registered in `MessageType`, `ProtocolMessage` union, and `VALID_TYPES` set) so members can broadcast their tracked workspace paths to the host
- `hostMemberId` module-level tracker added and refreshed in `wireHostEvents` so permission host-bypass behaves correctly without threading state through inner scopes

## Task Commits

1. **Task 1: Add permission gates to push and createBranch commands** - `626cfea` (feat)
2. **Task 2: Enhance type system and protocol for Phase 3 features** - `93cab83` (feat)
3. **Task 3: Confirm PUSH-04 (side-by-side diff) works as required** - code-verified, awaiting human visual verification (no commit -- verification-only checkpoint)

## Files Created/Modified

- `src/extension.ts` - Added module-level `hostMemberId`, set it in `wireHostEvents`, added permission checks to `versioncon.push` (locked branch + canPushToBranch), added permission check to `versioncon.createBranch`, expanded `versioncon.manageBranchPermissions` QuickPick with grant / revoke branch creation, restrict / clear branch access actions
- `src/types/push.ts` - Added `EnhancedPushSummary` interface extending `PushSummary` with `affectedMembers: Array<{ memberId, displayName, overlappingFiles[] }>`
- `src/network/protocol.ts` - Added `'tracked-paths-update'` to `MessageType`, added `latestPushId: string | null` to `SyncResponse`, added `TrackedPathsUpdate` interface, added `TrackedPathsUpdate` to `ProtocolMessage` union, added `'tracked-paths-update'` to `VALID_TYPES` set

## Decisions Made

- **`hostMemberId` is module-level, not threaded into the inner workspaceFolder scope.** The plan suggested setting `hostMemberId = currentMemberId` inside `wireHostEvents`, but `currentMemberId` is declared inside the inner workspaceFolder block and is not visible to `wireHostEvents`. The simpler equivalent is: declare `hostMemberId` at module scope with default `'local-user'` (matching `currentMemberId`'s default), and set it explicitly in `wireHostEvents` to the same `'local-user'` constant. This preserves the host-always-allowed semantic without requiring scope refactoring.
- **`Restrict branch access` falls back to InputBox CSV when no remote members are connected.** Pure-QuickPick member selection would block local/offline admins from setting up restrictions in advance. CSV fallback keeps the admin productive when not yet hosting.
- **Task 3 (PUSH-04 verification) is code-verified, not human-verified, in this parallel-executor pass.** The orchestrator should request human visual verification post-merge per the plan's `how-to-verify` steps.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Scoping mismatch in plan instructions for `hostMemberId`**
- **Found during:** Task 1 (Add permission gates to push and createBranch commands)
- **Issue:** Plan instructed adding `hostMemberId` "near line 246, alongside `currentMemberId`" inside the workspaceFolder block, then setting it in `wireHostEvents` (which is in the outer `activate` scope). `currentMemberId` is not visible to `wireHostEvents`, so the literal instructions would not compile.
- **Fix:** Declared `hostMemberId` at module scope (alongside `activeHost`) with default `'local-user'`, and set it explicitly to `'local-user'` in `wireHostEvents`. Both push and createBranch commands run with `currentMemberId = 'local-user'` on the host, so `currentMemberId === hostMemberId` is correctly true for the host and the plan's intended semantic is preserved.
- **Files modified:** src/extension.ts
- **Verification:** `npm run lint` (tsc --noEmit) passes; permission-check expressions reference `hostMemberId` correctly.
- **Committed in:** 626cfea (Task 1 commit)

**2. [Rule 2 - Missing Critical] Wrap manageBranchPermissions try/catch around new admin actions**
- **Found during:** Task 1 (Expand manageBranchPermissions)
- **Issue:** The plan describes the existing manageBranchPermissions structure (no try/catch) and asks for new admin actions (grant/revoke/restrict/clear) that perform persistence (BranchPermissions.save() writes to disk). A failure during disk I/O would surface as an uncaught Promise rejection.
- **Fix:** Wrapped the entire if/else action chain in a try/catch following the existing error-handling pattern (`VersionCon: ${msg}`). Existing locked/unlocked branches share the same handler, with consistent UX.
- **Files modified:** src/extension.ts
- **Verification:** Lint passes; error handler matches the pattern used elsewhere in extension.ts (lines 394-397, 460-462, 518-520).
- **Committed in:** 626cfea (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking scoping fix, 1 missing critical error-handling)
**Impact on plan:** Both deviations preserve the plan's intent without scope creep. Lint and test exit codes remain 0.

## Issues Encountered

- **Phase 03 directory did not exist in the worktree at start.** The worktree branch was based on commit `16afd5c` (pre-Phase 03 plan creation), so `.planning/phases/03-push-sync-branch-management/` was missing in the worktree even though it exists on the main branch. Created the directory and wrote SUMMARY.md into it. The orchestrator's merge will reconcile this with the existing main-branch directory.
- **`npm test` shows 0 passing.** The `dist/test/` directory does not exist in the fresh worktree (no test compilation script exists in package.json). Tests glob `dist/test/**/*.test.js` and find nothing, so the test runner exits 0 with 0 passing. This matches the pre-plan baseline; no regression. Lint (`tsc --noEmit`) is the actual code-correctness gate and passes cleanly.

## Threat Flags

None -- threat register entries T-03-02 (push to locked branch), T-03-03 (unauthorized branch creation) are mitigated as designed; T-03-04 (locally-set memberId spoofing) is documented as `accept` in the plan and was not changed in this work.

## Known Stubs

None. The two protocol additions (`latestPushId`, `TrackedPathsUpdate`) are intentional surface-area for Plans 03-03 and 03-04 to wire up; they are typed but not yet sent or received. The plan explicitly defers wiring to those follow-up plans.

## TDD Gate Compliance

Not applicable -- plan type is `execute`, not `tdd`.

## Pending Human Verification

**Task 3: PUSH-04 side-by-side diff confirmation** is a `checkpoint:human-verify` task that requires launching the extension development host in VS Code and visually confirming `versioncon.previewDiff` opens a two-pane diff editor with green/red highlighting. The orchestrator should request this verification after the worktree merges. Code-level confirmation:

- Command `versioncon.previewDiff` is registered in `package.json` (line 81) with title "Preview Diff"
- Command is bound to the workspaceFileStaged context menu (`when: view == versioncon.workspaceTree && viewItem == workspaceFileStaged`)
- Implementation in `src/extension.ts` (lines 351-356) invokes `vscode.diff` with `branchUri`, `workspaceUri`, and a descriptive title `${entry.relativePath} (Branch ↔ Workspace)`
- VS Code's built-in `vscode.diff` command renders a side-by-side editor with green-add / red-delete line highlighting per the VS Code API documentation

If the human verification fails, follow-up plan should investigate `previewDiff` UX (e.g., whether the menu item appears, whether the URIs resolve correctly when the branch file does not exist).

## Next Phase / Plan Readiness

- Plan 03-03 can now wire the host's `sync-request` handler to populate `latestPushId` from `pushHistory.getLatestRecord()?.id ?? null` and emit `TrackedPathsUpdate` from members on workspace-tracking changes
- Plan 03-04 (smart push summary) can extend `PushService` to compute `EnhancedPushSummary` using the host-side `MemberTrackingMap` accumulated from `tracked-paths-update` messages
- Plans 03-05 (quick merge / dedicated merge flow) can rely on the new admin UI patterns for any additional permission UX needed
- Permission enforcement is now defense-in-depth-friendly: local commands enforce, but Plan 03-03's host relay validation is still required to prevent malicious clients from bypassing local checks

## Self-Check: PASSED

- FOUND: src/extension.ts
- FOUND: src/types/push.ts
- FOUND: src/network/protocol.ts
- FOUND: .planning/phases/03-push-sync-branch-management/03-02-SUMMARY.md
- FOUND: commit 626cfea (Task 1)
- FOUND: commit 93cab83 (Task 2)

---
*Phase: 03-push-sync-branch-management*
*Completed: 2026-05-06*
