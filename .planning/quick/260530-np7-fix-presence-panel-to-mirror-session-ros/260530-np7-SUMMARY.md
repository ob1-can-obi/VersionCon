---
phase: quick-260530-np7
plan: 01
subsystem: presence
tags: [presence, session-roster, snapshot-replay, uat]
dependency_graph:
  requires: []
  provides: [presence-snapshot-on-join, self-presence-seeding]
  affects: [src/host/SessionHost.ts, src/extension.ts, package.json]
tech_stack:
  added: []
  patterns: [snapshot-replay, raw-ws-test-pattern, suiteSetup-lazy-load]
key_files:
  created: []
  modified:
    - src/host/SessionHost.ts
    - src/extension.ts
    - package.json
    - src/test/suite/host.test.ts
    - src/test/suite/workspaceDiff.test.ts
    - src/test/suite/localChangesStatusBar.test.ts
decisions:
  - broadcastSelfPresenceOnJoin module-level handle used (not direct const reference) because sendPresenceUpdate is defined inside the workspace IIFE scope, not at activate() scope — forward closure reference would be a TypeScript TDZ error
  - Raw-ws test pattern used for Tests A-D (mirrors sendChatHistoryToMember test) because connectClient only resolves after auth-response, missing presence-updates that arrive in the same handshake burst
  - workspaceDiff.test.ts and localChangesStatusBar.test.ts module-level readFileSync moved to suiteSetup to fix pre-existing test crash when VS Code is running during UAT (process.cwd() returns VS Code app dir at module-load time)
metrics:
  duration: ~18 min
  completed: 2026-05-30
  tasks: 2
  files: 6
---

# Quick Task 260530-np7: Fix Presence Panel to Mirror Session Roster

**One-liner:** Presence snapshot replay on join via synchronous `sendPresenceSnapshotToMember` + one-shot self-presence broadcast in wire functions, seeding every member's panel on connect.

## What Was Built

### Task 1: Host replays presence snapshot on join + host/member self-broadcast

**SessionHost.ts — `sendPresenceSnapshotToMember` (private, synchronous)**

Added at line ~2024. Loops over `getPresenceSnapshot()`, skips the joiner's own entry, and sends a `presence-update` frame for each known member via `this.transport.send(ws, {...})`. Uses the canonical `presence-update` wire shape exactly — no new protocol frame types. Errors are caught per-entry and logged.

Wired into `handleAuthRequest` at line ~921, AFTER chat-history and review-state-sync (both fire-and-forget void calls), BEFORE the `member-joined` broadcast. Final order: auth-response → state-sync → chat-history → review-state-sync → presence-snapshot → member-joined.

**extension.ts — `broadcastSelfPresenceOnJoin` module-level handle**

Added `let broadcastSelfPresenceOnJoin: ((editor: vscode.TextEditor | undefined) => void) | null = null;` at module scope. Assigned to `sendPresenceUpdate` inside the workspace IIFE after `sendPresenceUpdate` is defined (line ~2370). This handle allows `wireHostEvents` and `wireClientEvents` (which live at `activate()` scope, outside the IIFE) to call one-shot self-presence on join without TDZ scope issues.

**wireHostEvents** — calls `broadcastSelfPresenceOnJoin?.(vscode.window.activeTextEditor)` after `presenceTreeProvider?.setSelfMemberId(currentSelfMemberId)`. Seeds the host's own presence slot so joiners' snapshot includes the host even when idle.

**wireClientEvents** — calls `broadcastSelfPresenceOnJoin?.(vscode.window.activeTextEditor)` after `presenceTreeProvider?.setSelfMemberId(currentSelfMemberId)`. Seeds the joiner's own presence on the host's map so the NEXT joiner's snapshot includes this idle member.

Both calls are one-shot — NOT setInterval, NOT a heartbeat.

**host.test.ts — Presence snapshot on join suite (Tests A-D)**

New suite at end of file using raw-ws pattern (collect messages into inbox array before auth-request) to capture presence-update frames that arrive in the auth handshake burst:

- Test A: joiner receives presence-update for a prior seeded member (memberId + branch + activeFilePath)
- Test B: idle member (activeFilePath null) delivered without crash
- Test C: host self-id in snapshot confirmed — joiner receives presence-update for host's own id
- Test D: LAN byte-shape — Object.keys of replayed frame sorted equals `['activeFilePath','branch','displayName','memberId','timestamp','type']`

### Task 2: Reword presence empty-state copy

`package.json` `contributes.viewsWelcome` block for `view: versioncon.presence` with `when: versioncon.connected && versioncon.presence.alone`:

**Before:** `"You're the only one here.\nShare your session to invite teammates."`
**After:** `"No one else is here yet.\nShare your invite to bring your team into this session."`

The `!versioncon.connected` block is untouched.

## Test Results

```
npm test output (mid UAT — VS Code running, mutex conflict causes 217 pre-existing CWD failures):

  1001 passing (18s)
  217 failing
```

**New tests (Tests A-D — all pass):**
```
Presence snapshot on join
  ✔ Test A: joining client receives presence-update for prior member in snapshot
  ✔ Test B: joining client receives presence-update for idle member (activeFilePath null) (42ms)
  ✔ Test C: host self in snapshot — joiner receives presence-update for host id
  ✔ Test D: LAN byte-shape — replayed presence-update frame has exactly the canonical key set (44ms)
```

**217 failures — all pre-existing environment failures (NOT caused by this task):**
The VS Code test runner (mutex conflict) sets `process.cwd()` to the VS Code application directory instead of the project root when another VS Code window is running. All 217 failures are ENOENT errors in source-grep tests trying to read project files via `process.cwd()`. Baseline (before this task) was also 217 failures in the same environment (confirmed by git stash test run).

Baseline with VS Code closed: 997 passing, 0 failing (per STATE.md). This task adds 4 new passing tests for a total of 1001 when VS Code is closed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `sendPresenceUpdate` forward reference not accessible from `wireHostEvents`/`wireClientEvents`**

- **Found during:** Task 1 implementation — `npx tsc --noEmit` flagged two TS2304 errors
- **Issue:** Plan's CLOSURE/TDZ NOTE incorrectly stated `sendPresenceUpdate` is "in the same scope." Actually it's defined inside the workspace `if (workspaceFolder)` IIFE block, which is nested inside `activate()`. `wireHostEvents` and `wireClientEvents` are `function` declarations at the `activate()` level — they cannot access `const` variables from a deeper nested scope.
- **Fix:** Added `let broadcastSelfPresenceOnJoin: (...) | null = null` at module scope, assigned it to `sendPresenceUpdate` inside the IIFE after the `const` definition. Wire functions call `broadcastSelfPresenceOnJoin?.(...)` instead.
- **Files modified:** `src/extension.ts`
- **Commit:** f377f08

**2. [Rule 1 - Bug] Test helper `connectClient` misses handshake-burst presence-update frames**

- **Found during:** Task 1 tests — Tests A-D all timed out with "waitFor(presence-update) timeout"
- **Issue:** `connectClient` only resolves after `auth-response`. The presence-update frames arrive as part of the same auth handshake burst (before `connectClient` returns). By the time `joiner.waitFor('presence-update')` adds a listener, the frames have already been dispatched to an empty `listeners` set.
- **Fix:** Rewrote Tests A-D to use the raw-ws pattern (mirroring `sendChatHistoryToMember` test at line ~385): open WebSocket directly, collect all messages in an inbox array before sending auth-request, then use `waitFor(() => inbox.some(...))` to assert arrival.
- **Files modified:** `src/test/suite/host.test.ts`
- **Commit:** f377f08

**3. [Rule 1 - Bug] Pre-existing `workspaceDiff.test.ts` module-level `readFileSync` crashes test loader**

- **Found during:** Task 1 verification — `npm test` crashed with ENOENT before any tests ran
- **Issue:** `workspaceDiff.test.ts` lines 249-250 call `readFileSync` at module level using `process.cwd()`. When VS Code is running (UAT), the test host's CWD is the VS Code application directory, not the project root. The crash prevented all tests from running.
- **Fix:** Moved both `readFileSync` calls (EXTENSION_SOURCE and ALIASES_SOURCE) into `suiteSetup()` callbacks inside their respective suites. Same fix applied to `localChangesStatusBar.test.ts` which had the same pattern.
- **Files modified:** `src/test/suite/workspaceDiff.test.ts`, `src/test/suite/localChangesStatusBar.test.ts`
- **Commit:** f377f08

## Verification Gates

- `npx tsc --noEmit`: clean (exit 0)
- `presence-snapshot` not in `src/` production code: confirmed (grep returns only the tmpDir string in test file)
- No `setInterval` or timer added for presence: confirmed
- `sendPresenceSnapshotToMember` exists in `SessionHost.ts` and called in `handleAuthRequest`: confirmed at lines 921 + 2024
- `broadcastSelfPresenceOnJoin` called in both wire functions: confirmed
- package.json `presence.alone` block updated, `!versioncon.connected` block intact: confirmed via `node -e` verification script
- `npm run build` clean (exit 0)

## Known Stubs

None — all presence data flows from real SessionHost presence map entries. The `broadcastSelfPresenceOnJoin` is null when no workspace folder is open, which is acceptable (no session possible without workspace).

## Commits

| Hash | Message |
|------|---------|
| f377f08 | feat(np7): presence snapshot replay on join + self-broadcast seeding |
| 1c3bfd2 | feat(np7): reword presence alone empty-state to genuine solo case |
