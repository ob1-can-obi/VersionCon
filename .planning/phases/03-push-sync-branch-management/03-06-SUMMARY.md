---
phase: 03-push-sync-branch-management
plan: 06
type: gap_closure
status: implementation_complete
human_verify: pending
executed: 2026-05-06T23:55:00Z
supersedes: 03-04-PLAN.md (v1 markSynced semantics)
requirements_satisfied: [PUSH-09, PUSH-10, PUSH-11]
test_count_before: 116
test_count_after: 129
test_count_delta: +13
test_failures: 0
---

# Phase 3 Plan 06 — Gap Closure Summary

Closes the single open gap from `03-VERIFICATION.md`:

> When the workspace is out of sync with the latest branch state, the extension blocks staging, unstaging, debug, and run actions with a modal that points the user to the Sync command — there is no dismiss-only escape hatch.

This plan also satisfies REQUIREMENTS.md PUSH-10 (real Sync command — markSynced removed from v1) and PUSH-11 (per-file conflict prompt: Keep mine / Take branch / Show diff).

## Commits

| Task | Commit | Subject |
|------|--------|---------|
| T1 | `b917ec3` | feat(03-06): extend SyncTracker with per-file out-of-sync set (PUSH-10/11) |
| T2 | `8f9ff7a` | fix(03-06): StatusBarManager.setSyncWarning(false) now actually clears (PUSH-09) |
| T3 | `2fe4782` | feat(03-06): replace markSynced with versioncon.sync (real pull + per-file conflict prompts) |
| T4 | `2280a1e` | feat(03-06): modal block on stage/unstage/debug/task — no dismiss-only escape (PUSH-09) |
| T5 | `fb8ea11` | test(03-06): syncCommand partition tests + out-of-sync gate test (PUSH-09/10/11) |
| T6 | `b45697a` | docs(03-06): add 03-06-PLAN.md and supersede v1 markSynced UAT entry |

## What Shipped

### `versioncon.sync` (PUSH-10)

Real file pull. Walks `SyncTracker.getOutOfSyncPaths()` and partitions each path into:

| Case | Branch exists | Workspace exists | Bytes match | Action |
|------|---------------|------------------|-------------|--------|
| A | no | — | — | drop from set (deleted upstream; v1 defers workspace-deletion semantics) |
| B | yes | no | — | silent `copyFileToWorkspace` + `clearPath` |
| C | yes | yes | yes | silent `clearPath` (nothing to lose) |
| D | yes | yes | no | per-file conflict prompt — **Keep mine** / **Take branch** / **Show diff** |

After the loop, if the out-of-sync set is empty, calls `syncTracker.onSync()` and `setSyncWarning(false)`. If non-empty (Keep mine on real conflicts), the warning stays on and the user sees `synced N file(s); kept M local. K file(s) still out of sync.`

### Modal block on stage / unstage / debug / task (PUSH-09)

| Touch point | Block behavior |
|-------------|---------------|
| `versioncon.stageForPush` | async modal with single **Sync** button; dismiss = cancel; Sync runs `versioncon.sync` then re-checks `isInSync()` before staging |
| `versioncon.unstageFile` | same pattern |
| `vscode.debug.onDidStartDebugSession` | async modal; on **Sync**, calls `vscode.debug.stopDebugging(session)` before sync (VS Code has no pre-start veto) |
| `vscode.tasks.onDidStartTask` | async modal; on **Sync**, runs sync. v1 limit: no generic stop-task API, so the task continues running |

**No dismiss-only escape hatch.** The single button is **Sync**; pressing Esc / X cancels the action.

### Per-file conflict prompt (PUSH-11)

For each real conflict (workspace differs from branch):
- **Keep mine** — leaves the file unchanged AND leaves the path in the out-of-sync set so the user can resolve later
- **Take branch** — `copyFileToWorkspace` overwrites the local file, then `clearPath`
- **Show diff** — opens `vscode.diff` with branch (left, read-only) ↔ workspace (right), then re-prompts

Dismissing the conflict modal is treated as Keep mine (the path stays in the set).

### `SyncTracker` extended

New private `outOfSyncPaths: Set<string>` plus three methods:
- `recordRemoteFiles(paths: string[])` — accumulates union (deduped)
- `getOutOfSyncPaths()` — returns a fresh array snapshot
- `clearPath(path: string)` — removes one path

`onSync()` and `reset()` now also clear the set. Wired into `push-received` and `push-reverted` handlers in `extension.ts` so the set fills up automatically as broadcasts arrive.

### `StatusBarManager.setSyncWarning(false)` no longer a no-op

Caches the most recent `currentStatus` / `currentSessionName` so the false branch re-applies `setStatus(currentStatus, currentSessionName)`. The user sees the warning text disappear immediately after a successful sync, not just on the next connection change.

### Tests

- `src/test/suite/syncTracker.test.ts`: +6 tests for the new file-set API (set semantics, dedupe, snapshot copy, onSync/reset clearing)
- `src/test/suite/syncCommand.test.ts` (NEW): 6 tests covering the four partition branches plus a mixed run and a full-drain sequence (real fs in tmpDir + `FileSystemLayer.copyFileToWorkspace`)
- `src/test/suite/permissionEnforcement.test.ts`: +1 out-of-sync gate test asserting the predicate that drives the modal block

Total: 116 → 129 passing, 0 failing.

## Acceptance Verification (grep)

| Check | Required | Actual |
|-------|----------|--------|
| `versioncon.markSynced` references in `src/extension.ts` | 0 | 0 |
| `versioncon.markSynced` references in `package.json` | 0 | 0 |
| `Mark Synced` label refs in `src/extension.ts` | 0 | 0 |
| `'Ignore'` button refs in `src/extension.ts` | 0 | 0 |
| `{ modal: true` blocks in `src/extension.ts` | ≥5 | 12 |
| `executeCommand('versioncon.sync')` refs | ≥4 | 4 |
| `vscode.debug.stopDebugging` refs | ≥1 | 1 |
| `Workspace files unchanged` refs | 0 | 0 |
| `Keep mine` / `Take branch` / `Show diff` refs | ≥3 each | 5 / 4 / 4 |
| `npm run lint` (`tsc --noEmit`) | exit 0 | exit 0 |
| `npm test` | ≥123 passing, 0 failing | 129 passing, 0 failing |

## Deviations from the Plan

1. **Sync-response file seeding (Task 3 step 1c):** the plan suggested seeding `recordRemoteFiles` from `client.on('sync-response', data => ...)`. The typed event payload SessionClient exposes is `{ latestPushId: string | null }` only — `files` is not on the typed event today, and the host always sends `files: []` for v1 (`SessionHost.ts:288`). Removed the seed and left a TODO comment so a later phase can wire it when the host starts populating files. No functional change — the live `push-received` and `push-reverted` handlers already feed the set in real time.

2. **Combined commits:** Tasks 3 and 4 were originally split across two commits (markSynced removal vs. modal blocks). Kept that split; both commits passed individually.

## Status & Next Steps

- **Implementation:** complete (all 6 implementation tasks shipped)
- **Programmatic verification:** all green (`tsc --noEmit` exit 0; 129 tests passing, 0 failing; every grep-verifiable acceptance criterion satisfied)
- **Human verification (Plan Task 7):** pending — requires:
  - Two extension hosts simulating two members on a LAN session
  - Triggering a real conflict and clicking through Keep mine / Take branch / Show diff
  - Verifying VS Code modal dialog rendering and `vscode.diff` editor

This SUPERSEDES the human-verify checkpoint in `03-04-PLAN.md` — the v1 `Mark Synced` semantics no longer ship.

After human verification passes, re-run `/gsd-verify-work 3` so `03-VERIFICATION.md` re-checks the gap and flips status to `passed`.
