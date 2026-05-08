---
phase: 04-presence-chat-file-level-conflict-notifications
plan: 14
subsystem: ui
tags: [chat-panel, lifecycle, refactor, cr-04, gap-closure, refs-bundle, disposable]

requires:
  - phase: 04-presence-chat-file-level-conflict-notifications
    provides: ChatPanel WebviewPanel singleton (Plan 04-10), ChatPanelRefs interface (Plan 04-10), versioncon.openChat command (Plan 04-10)
provides:
  - ChatPanelRefs.onPanelActivated optional callback — invoked by panel's own onDidChangeViewState Disposable
  - Panel-bound lifecycle for the unread-clear handler (no orphan callbacks after dispose)
  - Removal of public ChatPanel.onDidChangeViewState setter API (was a misleading single-handler overwrite, not a Disposable)
affects: []

tech-stack:
  added: []
  patterns:
    - "Refs-bundle dependency injection via optional callbacks — extension.ts wires lifecycle-bound side effects through the same refs interface as data-getters; the panel binds the callback to its own Disposable instead of exposing a public setter that bypasses lifecycle management"

key-files:
  created:
    - src/test/suite/chatPanelLifecycle.test.ts
  modified:
    - src/ui/ChatPanel.ts
    - src/extension.ts

key-decisions:
  - "Replaced public ChatPanel.onDidChangeViewState(handler) setter with ChatPanelRefs.onPanelActivated optional callback. The setter was a misleading API — it overwrote a single stored field with no Disposable return value, so callers couldn't lifecycle-manage the registration. Refactor binds the callback to the panel's existing inner this.panel.onDidChangeViewState Disposable (already pushed to this.disposables), so it auto-disposes when the panel disposes. CR-04 closed."
  - "Tests use private constructor + fake WebviewPanel pattern — vscode.window.createWebviewPanel returns a real panel where view-state events fire only on user focus changes. Constructing ChatPanel directly (cast through unknown) with a fake panel exposing a controllable EventEmitter lets the suite drive view-state events synchronously and deterministically. Cleaner than waiting on async focus changes via vscode.window APIs."
  - "Both active=true and active=false transitions invoke onPanelActivated — the callback contains both the chatPanelIsActive flag-flip (which must run on both transitions so the unread counter at extension.ts:848 works correctly) AND the unread-clear branch (which only fires on active=true). Same semantics as the removed standalone setter call."
  - "Updated stale comment at extension.ts:62 referencing the old onDidChangeViewState setter — now references onPanelActivated. Documentation drift would otherwise mislead future readers."

requirements-completed: []

duration: 5min
completed: 2026-05-08
---

# Phase 4 Plan 14: ChatPanel Lifecycle Refactor Summary

**Closed CR-04 (WARNING) by replacing the public ChatPanel.onDidChangeViewState setter with ChatPanelRefs.onPanelActivated — a panel-bound Disposable that auto-cleans on dispose, eliminating the orphan-handler risk on extension reactivation.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-05-08T05:20:54Z
- **Completed:** 2026-05-08T05:26:50Z
- **Tasks:** 3/3 completed
- **Files modified:** 3 (1 created + 2 modified)

## Accomplishments

- Removed `ChatPanel.viewStateHandler` private field and the public `onDidChangeViewState(handler)` setter — the previous single-handler-overwrite API was structurally incompatible with VS Code Disposable lifecycle.
- Added `ChatPanelRefs.onPanelActivated?: (active: boolean) => void` — receives both true/false transitions so the consumer's chatPanelIsActive flag-flip stays in sync with the panel's actual visibility.
- Wired the constructor's existing `this.panel.onDidChangeViewState(...)` Disposable (already pushed to `this.disposables`) to invoke `this.refs.onPanelActivated?.(...)` — handler is now lifecycle-bound to the panel itself, not to a static class field.
- Moved the unread-clear handler body (chatPanelIsActive flag + unreadChatCount=0 + setUnreadCount(0) + setUnread(0)) from the standalone `ChatPanel.currentPanel?.onDidChangeViewState(...)` call into `ChatPanel.createOrShow` refs literal as `onPanelActivated` callback.
- Removed the standalone setter call from `versioncon.openChat`'s command body.
- Added 4 new tests in `src/test/suite/chatPanelLifecycle.test.ts` covering: activation invocation, deactivation invocation, dispose cleanup (no orphan callback), and verification that the public setter is removed (instance + prototype check).
- 284 → 288 total tests passing, zero regressions across the existing Plan 04-10 chat panel tests, Plan 04-11 manage-chat tests, and all other Phase 1/3/4 suites.

## Task Commits

Each task was committed atomically:

1. **Task 1: ChatPanel.ts — remove viewStateHandler + setter, add refs.onPanelActivated invocation** — `6c42ea6` (refactor)
2. **Task 2: extension.ts — wire onPanelActivated, remove standalone setter call** — `65f0bc1` (refactor)
3. **Task 3: chatPanelLifecycle.test.ts — 4 lifecycle tests** — `ae15e4d` (test)

**Plan metadata commit:** _(see final commit after this SUMMARY)_

## Files Created/Modified

- `src/ui/ChatPanel.ts` — removed `viewStateHandler` field, removed public `onDidChangeViewState(handler)` setter, added `onPanelActivated?: (active: boolean) => void` to `ChatPanelRefs`, updated constructor's existing inner Disposable to invoke `this.refs.onPanelActivated?.(...)` (MODIFIED — net +5 lines after removing 11 lines and adding 16 lines of interface + comment + invocation)
- `src/extension.ts` — added `onPanelActivated` callback to `ChatPanel.createOrShow` refs literal in `versioncon.openChat`, removed standalone `ChatPanel.currentPanel?.onDidChangeViewState(...)` setter call (8 lines), updated stale comment at line 62 referencing the old setter (MODIFIED — net +3 lines)
- `src/test/suite/chatPanelLifecycle.test.ts` — 4 unit tests verifying activation invocation, deactivation invocation, dispose cleanup, and no-public-setter (CREATED — 204 lines)

## Decisions Made

- **Refs-bundle callback over public setter** — the alternative fix from the code review (push the setter return value to context.subscriptions) literally cannot be applied because the setter returns `void`, not a `Disposable`. Changing the setter to return a Disposable would mean the abstraction itself was wrong. The refs-bundle approach binds the callback to the panel's own inner `this.panel.onDidChangeViewState` Disposable (already in `this.disposables`), so lifecycle is implicit — when the panel disposes, the callback is unreachable. Smaller diff, cleaner result.
- **Boolean argument on onPanelActivated** — passes the new active state instead of having two separate callbacks. The original code at extension.ts:303-310 needed both transitions: flag-flip on both, unread-clear only on `active === true`. Single-callback-with-bool preserves this without expanding the refs interface.
- **Test pattern: private constructor + fake WebviewPanel** — `vscode.window.createWebviewPanel` returns a real panel where `onDidChangeViewState` fires only on actual user focus changes (driven by VS Code's window manager). To test deterministically, the test file casts `ChatPanel` to its private constructor signature via `unknown` and constructs an instance directly with a fake `WebviewPanel` that exposes a controllable `EventEmitter<WebviewPanelOnDidChangeViewStateEvent>`. This is the same shape the existing Phase 1 wizard tests use to keep dispatch logic unit-testable. Enables synchronous verification of "fire after dispose → no callback".
- **Stale-comment update at extension.ts:62** — original comment referenced "Plan 04-10 (chat panel) flips `chatPanelIsActive` on its onDidChangeViewState". After this plan, the wiring is via `onPanelActivated`. Updated the comment to reference Plan 04-14 so future readers don't search for a now-removed API. Documentation correctness is part of the contract — Rule 3 minor adjustment, no behavior change.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Documentation drift] Stale comment at extension.ts:62 referencing removed onDidChangeViewState setter**
- **Found during:** Task 2 (extension.ts wiring)
- **Issue:** Line 62 comment said "Plan 04-10 (chat panel) flips `chatPanelIsActive` on its onDidChangeViewState; until then this stays false". The setter is removed in this plan, so the comment is wrong as soon as Task 1 lands.
- **Fix:** Updated to "Plan 04-14 wires the `onPanelActivated` callback through ChatPanelRefs to flip `chatPanelIsActive`; until that fires this stays false so chat-received events always increment unread."
- **Files modified:** `src/extension.ts`
- **Verification:** Comment now matches the actual wiring.
- **Committed in:** `65f0bc1` (Task 2)

**Total deviations:** 1 auto-fixed (Rule 3 — documentation drift, no behavior change)
**Impact on plan:** None. The plan's success criteria are unaffected; the comment update is purely a correctness fix to prevent future readers from being misled by stale documentation.

## Issues Encountered

- **node_modules absent in fresh worktree** — first `npm run build` failed with `ENOENT: no such file or directory, copyfile 'node_modules/@vscode/codicons/dist/codicon.css'`. Resolved by running `npm install` once. Standard worktree setup; not a plan deviation.

## User Setup Required

None — pure internal refactor. The `versioncon.openChat` command + chat panel UX is unchanged from the user's perspective; the unread-clear behavior continues to work identically. The fix is structural (handler is now lifecycle-bound to the panel rather than living on a class field that outlives the panel).

## Next Phase Readiness

- **Phase 4 close-out:** CR-04 gap from `04-VERIFICATION.md` is now closed. The verifier's grep `grep -c "ChatPanel.currentPanel?.onDidChangeViewState" src/extension.ts` now returns 0. Combined with the other Wave 7 gap-closure plans (04-12, 04-13, 04-15), Phase 4 should re-run the verifier to confirm gaps_found → verified.
- **Future panels:** The `onPanelActivated` pattern through the refs bundle is reusable for any future webview panel that needs a lifecycle-bound view-state callback. Plan 02-XX (Split-Pane UI) and Phase 6 (review threads) should adopt this shape from the start instead of re-introducing the setter pattern.

## Self-Check: PASSED

Verification of claimed artifacts:

**Files created:**
- FOUND: src/test/suite/chatPanelLifecycle.test.ts

**Files modified (verified via git log):**
- FOUND modifications in: src/ui/ChatPanel.ts (commit 6c42ea6)
- FOUND modifications in: src/extension.ts (commit 65f0bc1)

**Commits:**
- FOUND: 6c42ea6 (Task 1 — ChatPanel.ts refactor)
- FOUND: 65f0bc1 (Task 2 — extension.ts wiring)
- FOUND: ae15e4d (Task 3 — lifecycle tests)

**Build verification:**
- `npx tsc --noEmit` exits 0 — full repo type-clean
- `npm run build` exits 0 — esbuild bundles successfully
- `npm test -- --grep "Phase 4 chat panel lifecycle"` — 4 passing
- `npm test` — 288 passing total (was 284; +4 new lifecycle tests; zero regressions)

**Plan-level verification (per plan's <verification> section):**
- `grep "viewStateHandler" src/ui/ChatPanel.ts` returns NO match — field + setter both removed
- `grep "ChatPanel.currentPanel?.onDidChangeViewState" src/extension.ts` returns 0 — standalone setter call fully removed
- `grep "onPanelActivated" src/ui/ChatPanel.ts` returns 4 lines (interface declaration + invocation + 2 doc comments) — interface + invocation present
- `grep "onPanelActivated" src/extension.ts` returns 2 lines (comment + property) — refs property wired
- `grep "this.panel.onDidChangeViewState" src/ui/ChatPanel.ts` returns 1 — VS Code API call inside constructor preserved
- Plan 04-11 manage-chat code does NOT depend on removed setter — verified via `grep "onDidChangeViewState\|viewStateHandler" src/test/suite/manageChat.test.ts` returning 0

---
*Phase: 04-presence-chat-file-level-conflict-notifications*
*Completed: 2026-05-08*
