---
phase: 03-push-sync-branch-management
plan: 03
subsystem: api
tags: [push-impact, member-tracking, websocket-protocol, permissions, sync-reconnect]

# Dependency graph
requires:
  - phase: 02-split-pane-ui-file-system-layer
    provides: PushService, PushHistory, BranchPermissions, WorkspaceTreeProvider, SessionHost, SessionClient
  - phase: 03-push-sync-branch-management
    provides: SyncTracker (03-01), permission gates + EnhancedPushSummary + TrackedPathsUpdate + SyncResponse.latestPushId types (03-02)
provides:
  - Real PUSH-03 file-level affected-member computation (PushService.computeAffectedMembers)
  - SessionHost.memberTracking accumulator + tracked-paths-update message handler
  - WorkspaceTreeProvider.onTrackedPathsChanged event
  - Permission-validated push-notification relay (T-03-05 mitigation)
  - Partial revert broadcast (PUSH-08, SAFE-04 parity with full revert)
  - SyncResponse.latestPushId populated from PushHistory.getLatestRecord (PUSH-09 reconnect path)
  - SessionHost.buildLatestPushId static helper for unit testing
  - SessionClient.sendMessage public wrapper for protocol broadcast
affects: [03-04 (smart push summary -- can now read EnhancedPushSummary.affectedMembers from real data), 03-05 (merge flow), 04-presence-activity-chat (chat layer can render affected-members + revert events)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Module-level service references (activePermissions, activePushHistory) so wireHostEvents and the workspace IIFE can wire late-arriving services into the SessionHost without tight ordering coupling"
    - "Authenticated-memberId-over-message-body: tracked-paths-update and push-notification handlers ignore the message's memberId field and use the WebSocket connection's authenticated memberId, mitigating T-03-05 / T-03-14 spoofing"
    - "Pure-logic static helper (SessionHost.buildLatestPushId) extracted from message handler so unit tests can cover empty/null/populated transitions without standing up a WebSocket server"

key-files:
  created:
    - src/test/suite/sessionHostSync.test.ts
  modified:
    - src/filesystem/PushService.ts
    - src/filesystem/PushHistory.ts
    - src/host/SessionHost.ts
    - src/extension.ts
    - src/ui/WorkspaceTreeProvider.ts
    - src/client/SessionClient.ts
    - src/test/suite/pushService.test.ts

key-decisions:
  - "computeAffectedMembers excludes the pusher even when they appear in the MemberTrackingMap -- a pusher is by definition not surprised by their own changes"
  - "Permission-validated relay returns PERMISSION_DENIED to the offending sender via a unicast error message (sendMessage to the offender's socket) rather than silently dropping -- gives the client clear feedback that they cannot push"
  - "buildLatestPushId returns the latest record id regardless of revert state -- the client uses it only to reseed its sync tracker; per-record revert handling remains the existing push-reverted notification path"
  - "Partial revert broadcasts the full PushRecord (not just the subset of reverted files) to keep the protocol message shape identical to full-revert -- receivers handle revert intent uniformly"

patterns-established:
  - "Stub-free in this plan: every protocol message added in 03-02 (tracked-paths-update, latestPushId) is now produced and consumed by real handlers"
  - "Static helper pattern for pure-logic extraction (SessionHost.buildLatestPushId) -- usable in tests without standing up a server"
  - "EventEmitter dispose() pattern in WorkspaceTreeProvider mirrors the standard VS Code disposable pattern"

requirements-completed: [PUSH-03, PUSH-08, SAFE-04]

# Metrics
duration: 6min
completed: 2026-05-06
---

# Phase 3 Plan 03: Real Affected-Member Tracking + Partial Revert Broadcast + sync-request Plumbing Summary

**Replaces the PUSH-03 placeholder with a real file-level overlap computation fed by tracked-paths-update messages, fixes the partial revert broadcast to match full-revert behavior, hardens the host's push-notification relay with permission validation (T-03-05), and populates SyncResponse.latestPushId from PushHistory.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-05-06T20:30:12Z
- **Completed:** 2026-05-06T20:36:11Z
- **Tasks:** 3 (all `type="auto"`)
- **Files created:** 1
- **Files modified:** 7

## Accomplishments

- `WorkspaceTreeProvider` fires a new `onTrackedPathsChanged` event whenever `trackFile`, `trackFiles`, or `untrackFile` mutate the tracked-paths set, plus a `dispose()` method that cleans up both event emitters
- `SessionHost` gains a `memberTracking: Map<string, string[]>` populated by `tracked-paths-update` messages (uses authenticated WebSocket memberId, not the message body) and seeded by the host via `setHostTrackedPaths`. Exposed as `getMemberTracking()` (snapshot copy) and `getMemberNames()` (memberId -> displayName from the live member roster). Cleared on member disconnect.
- `PushService.computeAffectedMembers(stagedPaths, memberTracking, memberNames, excludeMemberId?)` returns named members with their overlapping files. The pusher is excluded; an unknown displayName falls back to `'Unknown'`.
- `extension.ts` push command now reads the host's live MemberTrackingMap and renders `May affect:\n  - <name>: <files>` in the InputBox prompt. Client-side `push-received` handler shows `-- affects your files: <files>` when the receiving member's tracked workspace overlaps the pushed files.
- `SessionClient.sendMessage(msg)` public wrapper added for the tracked-paths broadcast.
- `SessionHost.handleConnection` now routes `push-notification` through a permission gate (`canPushToBranch` if `setPermissions` is wired) and sends `PERMISSION_DENIED` errors to unauthorized senders (T-03-05). Other broadcast types (`push-reverted`, `branch-created`, `branch-locked`, `permission-changed`) follow their existing relay path.
- `SessionHost.handleConnection` also handles `sync-request` by responding with a `sync-response` carrying `latestPushId` from the wired `PushHistory`. Falls back to `null` when no pushes exist or when no PushHistory is wired.
- `SessionHost.buildLatestPushId(pushHistory)` static helper extracts the pure-logic derivation, enabling 5 unit tests (empty / null / single / multiple / reverted-still-latest).
- `PushHistory.getLatestRecord()` returns the most recent record (used by `buildLatestPushId`).
- `extension.ts` partial-revert command (`versioncon.revertPushFiles`) now broadcasts via `activeHost.broadcastRevert(fullRecord)` after a successful revert, matching the full-revert pre-existing behavior (PUSH-08, SAFE-04).
- Module-level `activePermissions` and `activePushHistory` references let `wireHostEvents` and the workspace IIFE wire services into the SessionHost regardless of construction order.

## Task Commits

Each task was committed atomically (see `git log` on branch `worktree-agent-a2667e71c1bf4baa4`):

1. **Task 1: Wire real MemberTrackingMap into PushService.computeAffectedMembers and the push summary** -- `61deaec` (feat)
2. **Task 2: Broadcast partial reverts to team (PUSH-08, SAFE-04)** -- `d7fc9c7` (feat)
3. **Task 3: Add SessionHost sync-request unit tests (PUSH-09)** -- `2db34c2` (test)

Note: Tasks 2 and 3's host-side infrastructure (`setPermissions` field/method, permission-checked relay branch, `setPushHistory` field/method, `sync-request` handler, `buildLatestPushId` helper, `getLatestRecord` on PushHistory) was bundled into the Task 1 commit because all three tasks modify `SessionHost.ts` together and the plan's interfaces require those scaffolds before the wiring can compile. Task 2's commit therefore covers only the partial-revert broadcast (the user-visible Task 2 deliverable), and Task 3's commit covers only the test file (the deliverable specifically called out by the plan). Both subsequent commits compile and pass tests in isolation.

## Files Created/Modified

- `src/filesystem/PushService.ts` -- Added `computeAffectedMembers(stagedPaths, memberTracking, memberNames, excludeMemberId?)` performing file-level overlap; returns array of `{ memberId, displayName, overlappingFiles }`.
- `src/filesystem/PushHistory.ts` -- Added `getLatestRecord()` returning the most recent record (or undefined for empty history).
- `src/host/SessionHost.ts` -- Added `memberTracking` map + `permissions` + `pushHistory` references; `setHostTrackedPaths` / `getMemberTracking` / `getMemberNames` / `setPermissions` / `setPushHistory` methods; static `buildLatestPushId` helper; new message-routing branches for `tracked-paths-update`, `sync-request`, and a permission-gated `push-notification` relay; `memberTracking.delete(memberId)` cleanup in `removeMember`.
- `src/ui/WorkspaceTreeProvider.ts` -- Added `_onTrackedPathsChanged` EventEmitter, `readonly onTrackedPathsChanged` event, `dispose()` method; fires the event on `trackFile`, `trackFiles`, `untrackFile`.
- `src/extension.ts` -- Added `createTimestamp` import, `activePermissions` + `activePushHistory` module vars; wires `host.setPermissions` and `host.setPushHistory` in both `wireHostEvents` and the workspace IIFE; subscribes to `workspaceProvider.onTrackedPathsChanged` to mirror paths into the host map (host) and broadcast `tracked-paths-update` (client); seeds initial tracked paths on startup; updates push command to compute `pushService.computeAffectedMembers` from the live host map and render `'May affect:'` lines; updates `push-received` handler to show file overlap with the receiving member's tracked workspace; adds `activeHost.broadcastRevert(fullRecord)` to the partial-revert command.
- `src/client/SessionClient.ts` -- Added public `sendMessage(msg)` wrapper that delegates to `sendMessage(send, msg)` when the WebSocket is open.
- `src/test/suite/pushService.test.ts` -- Added 5 unit tests for `computeAffectedMembers` (no overlap, single overlap with displayName + files, pusher excluded, multiple affected members, unknown displayName fallback).
- `src/test/suite/sessionHostSync.test.ts` (new) -- 5 unit tests for `SessionHost.buildLatestPushId` (empty history, null reference, single record, multiple records, reverted-still-latest).

Total tests went from 95 -> 105 passing (+10 new tests, all green; 0 failing).

## Decisions Made

- **`computeAffectedMembers` excludes the pusher.** A pusher cannot be surprised by their own change, so listing themselves in `May affect` is noise. The `excludeMemberId` parameter cleanly handles this without a separate filter step at the caller. Default behavior (no exclude) still matches "compute overlap for every tracked member."
- **Permission-validated relay sends PERMISSION_DENIED unicast.** The plan instructs returning an error to the offending sender; we do so via `sendMessage((d) => ws.send(d), { type: 'error', code: 'PERMISSION_DENIED', ... })`. This gives the client immediate feedback that the relay was refused, which is more debuggable than silent drop.
- **`buildLatestPushId` returns the latest record id regardless of revert state.** Reverted pushes still have an id and are still part of the host's history; the client uses `latestPushId` only to seed its sync tracker. Per-record revert handling continues to flow via the existing `push-reverted` notification.
- **Partial revert broadcasts the full PushRecord, not the partial-list subset.** `broadcastRevert(record)` sends `{ type: 'push-reverted', files: record.files.map(f => f.relativePath), ... }` -- receivers handle revert intent uniformly without distinguishing partial/full at the protocol layer. The protocol layer's `revertedFiles` field on PushRecord (added in earlier plan) carries the partial subset for local display.
- **Bundle some Task 2/3 infrastructure into the Task 1 commit.** Because all three tasks modify `SessionHost.ts` and `extension.ts` together, splitting them required either circular dependency or stub interfaces. Bundling the host-side scaffolds (setPermissions/setPushHistory + the message-handler branches) into Task 1's commit keeps the diff coherent and the build green at every commit. Tasks 2 and 3 commits cover only their user-visible deliverables (partial revert broadcast for Task 2, test file for Task 3).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Plan referenced `pushHistory.getLatestRecord()` but PushHistory did not have this method**
- **Found during:** Task 1 (compiling the SessionHost sync-request handler that calls `this.pushHistory?.getLatestRecord()?.id`)
- **Issue:** Plan task 3 step 1 declares the type `{ getLatestRecord: () => { id: string } | undefined }` and uses it in the sync-response, but the existing `PushHistory.ts` only had `getRecord(id)` (lookup by id) -- no method that returns the most recent record.
- **Fix:** Added `getLatestRecord(): PushRecord | undefined` to `PushHistory.ts` returning the last element of the records array (newest pushes are appended to the end via `records.push(record)`).
- **Files modified:** `src/filesystem/PushHistory.ts`
- **Verification:** `npm run lint` passes; new method is covered by 5 unit tests in `sessionHostSync.test.ts`.
- **Committed in:** 61deaec (Task 1 commit)

**2. [Rule 3 - Blocking] Plan referenced `SessionClient.sendMessage(...)` but SessionClient did not have a public `sendMessage`**
- **Found during:** Task 1 step C (extension.ts wiring of tracked-paths-update from client to host)
- **Issue:** SessionClient had only an internal `sendMessage(send, msg)` helper imported from the protocol module. The plan's wiring code calls `activeClient.sendMessage({ type: 'tracked-paths-update', ... })` which would not compile.
- **Fix:** Added a public `sendMessage(msg: ProtocolMessage): void` method that delegates to the protocol-module `sendMessage(send, msg)` only when `this.ws.readyState === WebSocket.OPEN`. No-op when the socket is closed or not yet open -- caller's responsibility to gate on `connection-changed` if delivery matters.
- **Files modified:** `src/client/SessionClient.ts`
- **Verification:** `npm run lint` passes; manual code review confirms the new method matches the existing private message-sending pattern used inside `connect()`.
- **Committed in:** 61deaec (Task 1 commit)

**3. [Rule 1 - Bug] memberId could legitimately be the empty string `''` when relaying push-notification with permissions wired**
- **Found during:** Task 2 (writing the permission-gate)
- **Issue:** The plan suggested `(msg as any).branch` to extract the branch from the discriminated union, but TypeScript already knows `msg.type === 'push-notification'` narrows to PushNotification which has `branch: string`. Using `as any` is a code smell and bypasses the type checker.
- **Fix:** Used `msg.branch` directly in the permission check after the `if (msg.type === 'push-notification')` narrow. TypeScript's discriminated-union narrowing keeps this type-safe.
- **Files modified:** `src/host/SessionHost.ts`
- **Verification:** `npm run lint` passes with strict types.
- **Committed in:** 61deaec (Task 1 commit)

**4. [Rule 2 - Missing Critical] WorkspaceTreeProvider had no `dispose()` method to clean up event emitters**
- **Found during:** Task 1 step A (adding `_onTrackedPathsChanged` emitter)
- **Issue:** The plan called for adding `dispose()` "if a `dispose()` method exists; if not, add one". WorkspaceTreeProvider had no dispose. Without one, the new event emitter would leak when the provider is disposed (currently only at extension deactivation, but still a future-proofing concern).
- **Fix:** Added `dispose()` that calls `this._onDidChangeTreeData.dispose()` and `this._onTrackedPathsChanged.dispose()`.
- **Files modified:** `src/ui/WorkspaceTreeProvider.ts`
- **Verification:** Lint passes.
- **Committed in:** 61deaec (Task 1 commit)

---

**Total deviations:** 4 auto-fixed (2 blocking missing-API, 1 type-safety bug, 1 missing critical disposable). All resolve plan instructions that referenced public methods that did not yet exist on the dependency surface; none change the plan's intent.

## Issues Encountered

- **Worktree did not have `node_modules`.** Worktrees do not auto-install npm dependencies and the worktree base commit predates the `node_modules` install. Resolved by symlinking `/Users/jishnuraviprolu/Desktop/VersionCon/node_modules` into the worktree root before running `npm run lint` and `npm test`. This is environmental, not a plan issue.
- **Worktree did not have the phase-03 plan file.** The plan file `03-03-PLAN.md` exists on `main` but was missing from the worktree's `.planning/phases/03-push-sync-branch-management/` directory. Copied it (and 03-02-PLAN.md, also missing) from the main repo into the worktree before reading. This will be reconciled by the orchestrator's merge.
- **Acceptance criterion grep mismatch (`latestPushId,`).** The plan's acceptance criterion specifies `src/host/SessionHost.ts contains 'latestPushId,'` (with trailing comma). The actual code emits `latestPushId: SessionHost.buildLatestPushId(this.pushHistory),` -- the `latestPushId` token has a colon after it, not a comma. The criterion's intent is clearly "latestPushId appears as a field of the sync-response" which is satisfied; the comma was probably a copy/paste artifact in the criterion text. No behavioral deviation.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| (none new) | -- | All Phase 3 threats from the plan's threat register are mitigated as designed: T-03-05 (push-relay bypass) is mitigated via the permission-gated relay; T-03-14 (forged memberId in tracked-paths-update) is mitigated by using the authenticated WebSocket memberId rather than the message body's memberId field; T-03-06 (affected-members info disclosure) and T-03-15 (latestPushId leakage) are explicitly `accept` per the plan |

## Known Stubs

None. The TrackedPathsUpdate and SyncResponse.latestPushId protocol messages, defined as type-only surface in plan 03-02, are now produced and consumed by real handlers in this plan. PushService.computeAffectedMembers returns real overlap data sourced from the live MemberTrackingMap. No placeholder strings, no hardcoded empty arrays, no TODO/FIXME comments added.

## TDD Gate Compliance

Not applicable -- plan type is `execute`, not `tdd`.

## Pending Human Verification

None -- all three tasks are `type="auto"` with automated verification (`npm run lint` + `npm test`).

## Next Phase / Plan Readiness

- **Plan 03-04 (smart push summary)** can now consume `EnhancedPushSummary.affectedMembers` populated from `pushService.computeAffectedMembers(...)`. The push command in `extension.ts` already shows `May affect: <name>: <files>` in the prompt; 03-04 can extend the on-success notification and the chat-side rendering with the same data.
- **Plan 03-05 (merge flow)** can rely on the permission-validated relay being live -- merges that flow through push-notification relay are already gated.
- **Phase 4 (presence/activity/chat)** can render `push-reverted` notifications uniformly for full and partial reverts (the partial-revert broadcast added in this plan emits the same protocol shape as the full-revert path).
- **Reconnection sync-state seeding (PUSH-09)** is now plumbed end-to-end on the host side. The client-side handler for `sync-response` (consuming `latestPushId` to call `syncTracker.onSync(latestPushId)`) is the next plumbing step -- left for whichever plan owns reconnect-on-drop integration tests.

## Self-Check: PASSED

- File `src/filesystem/PushService.ts` -- modified (computeAffectedMembers added) -- FOUND
- File `src/filesystem/PushHistory.ts` -- modified (getLatestRecord added) -- FOUND
- File `src/host/SessionHost.ts` -- modified (memberTracking, handlers, sync-request, buildLatestPushId) -- FOUND
- File `src/extension.ts` -- modified (wiring, push command, push-received, partial revert broadcast) -- FOUND
- File `src/ui/WorkspaceTreeProvider.ts` -- modified (onTrackedPathsChanged event, dispose) -- FOUND
- File `src/client/SessionClient.ts` -- modified (sendMessage public wrapper) -- FOUND
- File `src/test/suite/pushService.test.ts` -- modified (5 new tests for computeAffectedMembers) -- FOUND
- File `src/test/suite/sessionHostSync.test.ts` -- created (5 tests for buildLatestPushId) -- FOUND
- Commit `61deaec` (Task 1 - feat) -- FOUND in `git log`
- Commit `d7fc9c7` (Task 2 - feat) -- FOUND in `git log`
- Commit `2db34c2` (Task 3 - test) -- FOUND in `git log`
- Lint: `tsc --noEmit` exits 0
- Tests: 105 passing, 0 failing, exit code 0 (was 95; +10 new tests)

---
*Phase: 03-push-sync-branch-management*
*Completed: 2026-05-06*
