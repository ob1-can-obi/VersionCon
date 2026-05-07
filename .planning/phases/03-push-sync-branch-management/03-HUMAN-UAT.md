---
status: deferred
phase: 03-push-sync-branch-management
source: [03-VERIFICATION.md, 03-06-PLAN.md]
started: 2026-05-06T21:18:00Z
updated: 2026-05-07T00:30:00Z
deferred_reason: "Visual UAT blocked by a Phase-2-era bug — two extension dev hosts on the same machine cannot co-host a session because both register the same Bonjour service name (Error: 'Service name is already in use on the network', confirmed in dev console). Logic is covered by 129 unit tests including the SyncTracker file-set API, the SyncCommand partition (no-local / identical / Take branch / Keep mine), and the out-of-sync gate predicate. Visual UAT will happen during natural use; surface bugs found then will be patched."
---

## Current Test

[awaiting human testing]

## Tests

### 1. PUSH-04 — Preview diff (side-by-side)
expected: Drag a workspace file into the staged pane. Right-click the staged file and choose "VersionCon: Preview Diff" (or trigger via the context menu in the workspace tree). VS Code opens a side-by-side diff editor showing branch version on the left and workspace version on the right.
result: deferred — to be verified during natural use (logic covered by 129 unit tests; visual UAT blocked by Bonjour service-name conflict on single-machine two-host setup)

### 2. PUSH-09 / PUSH-10 / PUSH-11 — Modal block + real Sync + per-file conflict prompt
expected: Have member A push a change to a file (e.g. `src/foo.ts`) on the active branch. On member B (out-of-sync), attempt each of the following — every attempt must surface a modal whose only button is **Sync**, and dismissing the modal (Esc / X) must cancel the action without proceeding:

1. Right-click a workspace file and choose "Stage for Push" — modal blocks the stage. Click Sync; confirm sync runs and the file then stages successfully on a second attempt.
2. Right-click a staged file and choose "Unstage" — modal blocks. Same flow.
3. Start any debug session (F5) — modal blocks AND clicking Sync stops the debug session before pulling.
4. Run any task — modal blocks. Clicking Sync starts the pull (the running task may continue; v1 limit).

Then trigger a real conflict: edit `src/foo.ts` locally so it differs from the branch version. Run **VersionCon: Sync**. Confirm:

5. The conflict modal appears for `src/foo.ts` with three buttons: **Keep mine**, **Take branch**, **Show diff**.
6. Clicking **Show diff** opens a side-by-side diff editor (left = branch, right = workspace) and re-prompts after the diff is open.
7. Clicking **Take branch** overwrites the workspace file with the branch version.
8. Clicking **Keep mine** leaves the workspace file unchanged AND the status-bar warning stays on (the file remains out-of-sync until the user reconciles).

Note: this entry SUPERSEDES the v1 "Mark Synced" UAT — `versioncon.markSynced` no longer exists; the only sync command is `versioncon.sync`.
result: deferred — to be verified during natural use (logic covered by 129 unit tests; visual UAT blocked by Bonjour service-name conflict on single-machine two-host setup)

### 3. SC 2 — Push confirmation shows per-file list (post-fix)
expected: Stage one or more files and run "VersionCon: Push". A modal dialog shows a confirmation with the per-file list (e.g. `+ src/foo.ts (+10 -2)`, `~ src/bar.ts (+5 -5)`) and any affected-teammate info, with a "Push" button. Clicking Push then prompts for the commit message via an input box. Cancelling the modal aborts the push.
result: deferred — to be verified during natural use (logic covered by 129 unit tests; visual UAT blocked by Bonjour service-name conflict on single-machine two-host setup)

## Summary

total: 3
passed: 0
issues: 0
pending: 0
skipped: 0
blocked: 0
deferred: 3

## Gaps

(none — known issue tracked separately)

## Known Issues Surfaced During UAT

- **Bonjour service-name collision on single-machine multi-host setup.** Two extension dev hosts running on the same machine cannot co-host a session because the Bonjour advertiser tries to register the same service name twice. Console error: `Error: Service name is already in use on the network`. This is a Phase 2 bug in the session/discovery layer, not Phase 3 scope. Track as a Phase 4 (presence + chat) input or a small dedicated phase.
