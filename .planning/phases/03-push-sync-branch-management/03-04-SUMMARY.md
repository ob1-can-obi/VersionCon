---
phase: 03-push-sync-branch-management
plan: 04
subsystem: api
tags: [sync-tracking, vscode-extension, sync-before-run, push-09]

# Dependency graph
requires:
  - phase: 03-push-sync-branch-management
    provides: SyncTracker (03-01), latestPushId on SyncResponse + EnhancedPushSummary types (03-02), real computeAffectedMembers + sync-request handler (03-03)
  - phase: 02-split-pane-ui-file-system-layer
    provides: PushService, PushHistory, BranchTreeProvider, WorkspaceTreeProvider
provides:
  - SessionClient.getMemberId() public accessor
  - Module-level SyncTracker wired through extension lifecycle (push, push-received, push-reverted, connection-changed, sync-response)
  - versioncon.markSynced command with v1 sync-state-only semantics
  - Sync-before-run warning UI on vscode.debug.onDidStartDebugSession and vscode.tasks.onDidStartTask
  - 'sync-response' event added to SessionEventMap (forward-compatible scaffold)
affects: [04-presence-activity-chat, future workspace-pull-semantics plan]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Sync-state-only command (versioncon.markSynced): clears SyncTracker flag and refreshes the branch tree but does NOT copy files into the workspace -- the user-facing label says 'Mark Synced' (not 'Pull Now') so the operation matches what it does"
    - "Non-blocking sync warning on debug/task start: warning toast with 'Mark Synced' / 'Ignore' choices, never blocks the run (per D-12/SAFE-02)"
    - "Forward-compatible event scaffolding: extension.ts subscribes to 'sync-response' even though SessionClient does not currently emit it; the typed handler is harmless when never fired and is ready for a later plan that wires sync-request/response end-to-end"

key-files:
  created: []
  modified:
    - src/client/SessionClient.ts
    - src/extension.ts
    - src/types/events.ts
    - package.json

key-decisions:
  - "Mark Synced (not Pull Now) -- the v1 semantic is sync-state-only; renaming the button to 'Mark Synced' avoids the misleading impression that files are being pulled. Full file-pull (copying branch files into the workspace) is deferred to a later phase because workspace reconciliation semantics (which files override which? overwrite uncommitted work?) need their own design."
  - "Adding 'sync-response' to SessionEventMap is preferable to a per-listener type cast. The plan flagged that SessionClient does not currently emit this event, but the listener is harmless if never fired. Extending the event map keeps strict typing across the extension and removes the need for an inline ad-hoc cast."
  - "Both push-received and push-reverted call onRemotePush. A revert changes the branch state just like a push does, so the user is prompted to acknowledge in both cases."

patterns-established:
  - "Module-level SyncTracker access pattern: a single shared instance lives at module scope so wireClientEvents (outer scope) and the workspaceFolder async IIFE both reference it without scope plumbing"
  - "Non-blocking warning + post-warning sync action pattern: showWarningMessage with 'Mark Synced' / 'Ignore' choices, then route 'Mark Synced' through the registered command so the same logic also services the View > Command Palette > 'VersionCon: Mark Synced' entry"

requirements-completed: [PUSH-09]

# Metrics
duration: 4min
completed: 2026-05-06
---

# Phase 3 Plan 04: Sync-Before-Run Enforcement (PUSH-09) Summary

**Wires SyncTracker (03-01) into the extension's push and connection lifecycle, registers a non-blocking sync-warning UI on debug/task start, and ships the v1 'Mark Synced' command with explicit sync-state-only semantics.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-05-06T20:40:34Z
- **Completed:** 2026-05-06T20:44:29Z
- **Tasks:** 3 (2 auto + 1 human-verify checkpoint -- pending)
- **Files modified:** 4
- **Files created:** 0
- **Tests:** 105 passing, 0 failing (no new tests; PUSH-09 unit coverage already added by Plan 03-01's syncTracker.test.ts)

## Accomplishments

- **SessionClient.getMemberId()** -- new public accessor returning the server-assigned `memberId`, or null if not yet authenticated. Enables identity-aware features in extension.ts.
- **Module-level SyncTracker instance** in extension.ts (`const syncTracker = new SyncTracker()`), accessible to both the outer-scope `wireClientEvents` handlers and the inner async IIFE that owns `branchProvider`.
- **Local-push tracking** -- after a successful `pushService.executePush(...)` the push command calls `syncTracker.onLocalPush(record.id)`. The local user is by definition synced after their own push.
- **Remote-push tracking** -- the `push-received` handler calls `syncTracker.onRemotePush(data.pushId)` ahead of the existing PUSH-03 overlap message; the workspace is now potentially out of sync.
- **Revert tracking** -- the `push-reverted` handler also calls `syncTracker.onRemotePush(data.pushId)`. A revert changes branch state, so the user should be prompted to acknowledge.
- **Disconnect reset** -- the `connection-changed` handler calls `syncTracker.reset()` when status transitions to `'disconnected'`. The next session starts from a clean state; on reconnect, `sync-response` reseeds `latestPushId`.
- **Reconnect seeding** -- new `client.on('sync-response', ...)` listener calls `syncTracker.onRemotePush(data.latestPushId)` if non-null. The listener is forward-compatible scaffolding (SessionClient does not currently emit `sync-response`); the new event entry in `SessionEventMap` makes this a typed, no-op-by-default contract until a later plan wires sync-request/response end-to-end.
- **versioncon.markSynced** command -- v1 sync-state-only operation. Refreshes the branch tree (`branchProvider.refresh()`), clears the SyncTracker out-of-sync flag (`syncTracker.onSync()`), hides the status-bar sync warning (`statusBarManager.setSyncWarning(false)`), and shows an information toast with the literal text `Workspace files unchanged -- drag from branch to workspace to pull file contents.` so the user understands no files were modified.
- **Sync-before-run enforcement** -- two new disposables register `vscode.debug.onDidStartDebugSession` and `vscode.tasks.onDidStartTask`. When `!syncTracker.isInSync()`, both show a non-blocking warning toast with two choices: `Mark Synced` (executes `versioncon.markSynced`) and `Ignore` (no action). The warnings never block the run, satisfying D-12 / SAFE-02.
- **package.json** registers `versioncon.markSynced` as a contributed command titled `VersionCon: Mark Synced`.
- **SessionEventMap** extended with `'sync-response': { latestPushId: string | null }` so the new listener compiles with strict types.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add SessionClient.getMemberId() accessor** -- `fce27d4` (feat)
2. **Task 2: Wire SyncTracker into extension lifecycle (PUSH-09)** -- `cfe4499` (feat)
3. **Task 3: Confirm v1 'Mark Synced' semantics** -- *checkpoint, pending human verification* (no commit -- the orchestrator should request developer confirmation post-merge per the plan's `<how-to-verify>` steps).

## Files Created/Modified

- `src/client/SessionClient.ts` -- added `getMemberId(): string | null` public accessor returning `this.memberId`. Plumbing-only addition; the field already existed and is set during `auth-response` handling.
- `src/extension.ts` -- added `SyncTracker` import, module-level `syncTracker` instance, `syncTracker.onLocalPush(record.id)` after successful push, `syncTracker.onRemotePush(...)` in `push-received` and `push-reverted` handlers, `syncTracker.reset()` on disconnect, `client.on('sync-response', ...)` listener, `versioncon.markSynced` command registration, `vscode.debug.onDidStartDebugSession` and `vscode.tasks.onDidStartTask` listeners with non-blocking warning UI.
- `src/types/events.ts` -- added `'sync-response': { latestPushId: string | null }` to `SessionEventMap` so the new listener type-checks under `--strict`.
- `package.json` -- added `versioncon.markSynced` to `contributes.commands` with title `VersionCon: Mark Synced`.

## Decisions Made

- **'Mark Synced' label, not 'Pull Now'.** The plan's checker flagged the original label as misleading -- the v1 command does NOT copy files. Renaming the button matches what the operation actually does, and the information toast explicitly says "Workspace files unchanged" to remove any remaining ambiguity. Full file-pull (copying branch files into the workspace) is deferred to a later phase because workspace reconciliation semantics (which files override which? overwrite uncommitted work? confirmation flow?) need their own design that conflating with PUSH-09 would risk shipping wrong.
- **SessionEventMap extended with 'sync-response' rather than per-listener type cast.** The plan flagged that SessionClient doesn't currently emit `sync-response`. The cleanest fix to make the listener compile under strict types is adding the event to the map. The event is documented as forward-compatible scaffolding -- a no-op by default until a later plan wires sync-request/response end-to-end on the client side. (The host side already emits `sync-response`, plumbed in 03-03.)
- **Both push-received and push-reverted call onRemotePush.** A revert changes the branch state just like a push does. A user who pushed to a branch, then sees the team revert that push, is now out of sync with the post-revert branch. Treating both message types uniformly through `onRemotePush` keeps the protocol-side handling and the UI prompt symmetric.
- **`activeBranchListProvider` reference in the plan was not implemented.** The plan's markSynced handler suggested `if (activeBranchListProvider) activeBranchListProvider.refresh();` but no such provider exists in extension.ts (only `branchProvider` does). I omitted the conditional rather than introduce dead state -- if a follow-up plan adds an active-branch list provider, it can extend `markSynced` then. Documented as a deviation below.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] 'sync-response' was not in SessionEventMap so client.on('sync-response', ...) failed to type-check**
- **Found during:** Task 2 (running `npm run lint` after wiring the sync-response listener).
- **Issue:** `tsc --noEmit` reported `error TS2345: Argument of type '"sync-response"' is not assignable to parameter of type 'keyof SessionEventMap'.` The plan acknowledged that SessionClient does not currently emit `sync-response` ("the listener is harmless if never fired"), but the event was not in the typed map.
- **Fix:** Added `'sync-response': { latestPushId: string | null }` to `SessionEventMap` in `src/types/events.ts` with a comment documenting it as forward-compatible scaffolding. The host side already emits `sync-response` (plumbed in 03-03); this entry lets the client extension subscribe today and the eventual SessionClient emit will require no further extension.ts change.
- **Files modified:** src/types/events.ts
- **Verification:** `npm run lint` exits 0 after the fix.
- **Committed in:** cfe4499 (Task 2 commit).

### Other Adjustments

**2. [Plan reference omitted] `activeBranchListProvider.refresh()` skipped in markSynced handler**
- **Issue:** The plan's `versioncon.markSynced` body suggested `if (activeBranchListProvider) activeBranchListProvider.refresh();` but no such provider exists in `extension.ts` -- only `branchProvider` is defined. Adding a forward-reference would not compile.
- **Resolution:** Omitted the conditional refresh. `branchProvider.refresh()` (which exists) is still called, satisfying the plan's intent "refreshes the branch tree". If a future plan adds an active-branch list provider, it can extend the markSynced handler then.
- **Files modified:** src/extension.ts
- **Committed in:** cfe4499 (Task 2 commit).

---

**Total deviations:** 1 auto-fixed (Rule 3 -- type mismatch), 1 omitted plan reference for a non-existent symbol. Neither changes plan intent.

## Issues Encountered

- **Worktree did not have `node_modules`.** Worktrees do not auto-install npm dependencies and the worktree base commit `85fc909` predates a fresh install. Resolved by symlinking `/Users/jishnuraviprolu/Desktop/VersionCon/node_modules` into the worktree root before running `npm run lint`, `npx tsc`, and `npm test`. Environmental, not a plan issue.
- **Worktree did not have the phase-03 plan file.** `03-04-PLAN.md` exists on `main` but was missing from the worktree's `.planning/phases/03-push-sync-branch-management/` directory at start. Copied it from the main repo into the worktree before reading. The orchestrator's merge will reconcile.
- **Test compilation step required.** `npm test` globs `dist/test/**/*.test.js` produced by `tsc`, not by the `npm run build` esbuild step. Ran `npx tsc` to populate `dist/test/` before `npm test`. Pre-existing project setup, not a regression.

## Threat Flags

None. PUSH-09 mitigates T-03-07 (excessive sync warnings) by accepting non-blocking notifications -- multiple rapid pushes will trigger multiple warnings, but the user can dismiss them and the run is never blocked. T-03-08 (SyncTracker reset on disconnect) is intentional design: state is unknown after disconnect, reset to clean, reseeded from `sync-response.latestPushId` on reconnect. Both are documented as `accept` in the plan's threat register and the implementation matches the disposition.

## Known Stubs

None. The `versioncon.markSynced` command is intentionally sync-state-only by design (v1 deferral, documented in the plan and surfaced to the user via the "Workspace files unchanged" toast). It is not a placeholder -- it does what its label says. Full file-pull is deferred to a later phase as a separate, intentional roadmap item.

The `'sync-response'` listener is forward-compatible scaffolding: SessionClient does not currently emit the event, so the listener never fires today. This is intentional -- a later plan that wires sync-request/response on the client side will activate the listener without requiring any extension.ts change. Documented in the SessionEventMap entry comment.

## TDD Gate Compliance

Not applicable -- plan type is `execute`, not `tdd`.

## Pending Human Verification

**Task 3: Confirm v1 'Mark Synced' semantics** is a `checkpoint:human-verify` task. As a parallel-executor agent in a worktree, I cannot block on user input; the orchestrator should request developer confirmation post-merge per the plan's `<how-to-verify>` steps:

1. Confirm that "Mark Synced" only clears the sync state flag (does not copy files into the workspace).
2. Confirm the rationale: workspace pull semantics need their own design; conflating with PUSH-09 would risk shipping bad UX.
3. Confirm the deferral is acceptable: full file-pull is a separate later phase. PUSH-09 is satisfied by the warning + acknowledgement loop.

Code-level confirmation:
- `versioncon.markSynced` registered in `package.json` with title `VersionCon: Mark Synced`.
- Implementation in `src/extension.ts` calls `branchProvider.refresh()`, `syncTracker.onSync()`, `statusBarManager.setSyncWarning(false)`, and shows an information toast containing the literal text `Workspace files unchanged -- drag from branch to workspace to pull file contents.`
- No file-copy operation appears anywhere in the markSynced handler.
- The warning toasts on debug/task start use `'Mark Synced'` and `'Ignore'` (NOT `'Pull Now'`); `grep -c "pullLatest" src/extension.ts` returns 0.

If the developer rejects v1 semantics, a follow-up plan should design the file-pull behavior (which files to copy? overwrite confirmation? handling of user-modified workspace files?) and revise the markSynced handler accordingly.

## Next Phase / Plan Readiness

- **Plan 03-05 (merge flow / quick merge)** can rely on PUSH-09 being satisfied -- the sync-before-run warning is live, so any merge-time UX can assume the user has acknowledged or ignored the out-of-sync state.
- **Phase 4 (presence/activity/chat)** can extend the warning UX without re-architecting -- e.g., an indicator in the chat showing "out of sync since {pushId}" reads `syncTracker.getLatestPushId()` directly.
- **Future workspace-pull-semantics plan** can extend `versioncon.markSynced` to additionally copy branch files into the workspace, with the design questions (which files? overwrite? confirmation?) handled in that plan's research phase. The existing handler is the natural extension point and the toast text already prepares users for the difference between sync-state and file-state.
- **Future SessionClient sync-request/response plan** can plumb the protocol message into `handleMessage` and `emit('sync-response', { latestPushId })`. The extension.ts listener is already in place and will activate automatically.

## Self-Check: PASSED

- File `src/client/SessionClient.ts` -- modified (getMemberId added) -- FOUND
- File `src/extension.ts` -- modified (SyncTracker wiring, markSynced, debug/task listeners) -- FOUND
- File `src/types/events.ts` -- modified (sync-response event added) -- FOUND
- File `package.json` -- modified (versioncon.markSynced contribution) -- FOUND
- File `.planning/phases/03-push-sync-branch-management/03-04-SUMMARY.md` -- created -- FOUND (this file)
- Commit `fce27d4` (Task 1 - feat: SessionClient.getMemberId) -- FOUND in `git log`
- Commit `cfe4499` (Task 2 - feat: SyncTracker wiring) -- FOUND in `git log`
- Acceptance criterion `import { SyncTracker } from './filesystem/SyncTracker.js'` -- FOUND in src/extension.ts
- Acceptance criterion `const syncTracker = new SyncTracker()` -- FOUND in src/extension.ts
- Acceptance criterion `syncTracker.onLocalPush(record.id)` -- FOUND in src/extension.ts
- Acceptance criterion `syncTracker.onRemotePush(data.pushId)` -- FOUND in src/extension.ts (push-received and push-reverted)
- Acceptance criterion `vscode.debug.onDidStartDebugSession` with `syncTracker.isInSync()` -- FOUND in src/extension.ts
- Acceptance criterion `vscode.tasks.onDidStartTask` with `syncTracker.isInSync()` -- FOUND in src/extension.ts
- Acceptance criterion `'Mark Synced'` and `'Ignore'` in warning options -- FOUND in src/extension.ts
- Acceptance criterion `versioncon.markSynced` command registration -- FOUND in src/extension.ts
- Acceptance criterion `pullLatest` count is 0 -- VERIFIED (`grep -c` returns 0)
- Acceptance criterion `syncTracker.reset()` in disconnect handler -- FOUND in src/extension.ts
- Acceptance criterion `Workspace files unchanged` literal -- FOUND in src/extension.ts (markSynced toast)
- Acceptance criterion `versioncon.markSynced` in package.json -- VERIFIED via `node -e` check
- Lint: `tsc --noEmit` exits 0
- Tests: 105 passing, 0 failing, exit code 0 (baseline preserved -- no new tests added; PUSH-09 unit coverage was added in Plan 03-01)

---
*Phase: 03-push-sync-branch-management*
*Completed: 2026-05-06*
