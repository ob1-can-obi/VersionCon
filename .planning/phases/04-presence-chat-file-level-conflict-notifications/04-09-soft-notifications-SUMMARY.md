---
phase: 04-presence-chat-file-level-conflict-notifications
plan: 09
subsystem: ui-integration
tags: [soft-notifications, status-bar, file-overlap, activity-tree, presence-broadcast, chat-unread, vscode-extension, typescript]

# Dependency graph
requires:
  - phase: 04-presence-chat-file-level-conflict-notifications/01
    provides: PresenceInfo + ChatRecord types — payloads consumed by client event listeners
  - phase: 04-presence-chat-file-level-conflict-notifications/04
    provides: SessionHost.upsertHostPresence(info) + chat-history replay + setChatLog two-arg signature (latter intentionally NOT wired here — Plan 04-10 owns it)
  - phase: 04-presence-chat-file-level-conflict-notifications/05
    provides: SessionClient typed events ('presence-update', 'chat-received', 'chat-cleared', 'chat-truncated', 'chat-history', 'member-left' with memberId payload)
  - phase: 04-presence-chat-file-level-conflict-notifications/06
    provides: computeFileOverlap(pushedFiles, openTabFsPaths, workspaceRoot, platform) + getOpenTabPaths()
  - phase: 04-presence-chat-file-level-conflict-notifications/07
    provides: ActivityLogProvider with addPushEntry / addRevertEntry / addBranchCreateEntry / setUnread + versioncon.activityLog view registration + click target 'versioncon.activityLog.openEntry'
  - phase: 04-presence-chat-file-level-conflict-notifications/08
    provides: PresenceTreeProvider with upsert / removeMember / clear / setSelfMemberId / setCurrentBranch + versioncon.presence view registration
provides:
  - StatusBarManager.flashNoImpact(N, durationMs?) — CONF-08 green flash with sync-warning precedence + 1-vs-N pluralization
  - StatusBarManager.setUnreadCount(N) — chat unread badge with command-swap to versioncon.openChat + sync-warning suppression
  - StatusBarManager test helpers (getItemTextForTest, getItemCommandForTest)
  - extension.ts integration glue — providers, command registrations, client event wiring, presence broadcast on activeTextEditor change
  - formatPushToast helper — UI-SPEC §6.1 locked literal renderer
  - updateActivityContext + updatePresenceContext helpers — viewsWelcome `when` clause drivers
  - versioncon.activityLog.openEntry command handler (dispatches by ActivityKind)
  - versioncon.refreshPresence / versioncon.refreshActivityLog command handlers
  - 8 new StatusBarManager unit tests
affects:
  - 04-10-chat-panel (chat panel will flip chatPanelIsActive flag + consume chat-received / chat-cleared / chat-history / chat-truncated events)
  - 04-11-manage-chat (manage-chat QuickPick will trigger broadcastChatCleared / broadcastChatTruncated; Plan 04-09's clearing behavior on those broadcasts is already wired)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Module-level provider singletons reachable from both wireClientEvents (module scope) and the workspace IIFE — same pattern as activeBranchListProvider"
    - "Self-identity mirror fields (currentSelfMemberId / currentSelfDisplayName) captured from SessionClient.getMemberId() on join, from hostMemberId on host start; consumed by activity-log isMine flags + presence broadcasts"
    - "Active-branch mirror (currentBranchName) wired at IIFE init AND on switchBranch — switchBranch re-broadcasts presence so divergence indicator updates remote panels"
    - "100ms debounce on onDidChangeActiveTextEditor → presence-update — VS Code can fire the event multiple times during rapid tab cycling (open + focus). One outbound message per intent is the goal"
    - "Context key driver helpers: updateActivityContext / updatePresenceContext re-evaluate after every provider mutation; called from every client-event handler that mutates entries"
    - "Connection-changed → disconnected: presenceTreeProvider.clear() + setSelfMemberId(null) + setCurrentBranch(null) + setContext(versioncon.connected, false) — Plan 04-08 hand-off contract honored"
    - "Sync warning + flash precedence (UI-SPEC §1.4): syncWarningActive boolean field, gated entry on flashNoImpact; setUnreadCount stores count but suppresses overlay while warning active, re-applies on warning clear via setStatus tail"

key-files:
  created:
    - src/test/suite/statusBarManager.test.ts
  modified:
    - src/ui/StatusBarManager.ts
    - src/extension.ts

decisions:
  - "Module-level providers (presenceTreeProvider / activityLogProvider) constructed in activate() BEFORE the workspace IIFE — providers always exist, even when no workspace is open, so wireClientEvents can reference them without nullability surprises beyond the explicit `?.` chain."
  - "Self-identity mirrors (currentSelfMemberId / currentSelfDisplayName) at module scope rather than reaching into the IIFE's currentMemberId — the IIFE's value is always 'local-user' (a Phase 1/3 placeholder); module mirrors are updated from real authenticated id on client.getMemberId() at join. This unblocks isMine detection on the activity log without needing to refactor the IIFE's placeholder fields."
  - "currentBranchName mirror updated at IIFE init AND on every switchBranch — switchBranch additionally calls sendPresenceUpdate(activeTextEditor) so remote panels' divergence indicators refresh immediately. Local PresenceTreeProvider's setCurrentBranch is also called so the local user's own divergence prefix stays consistent."
  - "100ms debounce on onDidChangeActiveTextEditor — CONTEXT.md doesn't mandate one but the event can fire multiple times during a single tab focus operation (open + activate). Defensive Rule 2 guard against pathological cases (rapid Cmd-Tab cycling); does not affect normal interactive cadence."
  - "host path also locally upserts presence (presenceTreeProvider.upsert(info)) AFTER calling activeHost.upsertHostPresence(info) — the host doesn't receive its OWN presence-update broadcast back from itself (presence-update broadcasts EXCLUDE sender), so the local panel needs the explicit local upsert to show the host's row. Mirrors the Plan 04-04 broadcast policy."
  - "setChatLog NOT called in this plan — the host's chat-history send is null-guarded and a no-op until extension.ts wires setChatLog(chatLog, branchName). That wiring belongs to Plan 04-10 (chat panel) where the chat-log instance is constructed alongside the panel. No regression: Plan 04-04's null-guard handles the absence cleanly."
  - "chat-received system events (kind='system') NOT used to feed activity log here — the dedicated push-received / push-reverted / branch-created client events ALREADY feed it in their handlers. Doubling up via chat-received system events would create duplicate rows. The chat-received handler only acts on kind='user' messages (unread badge logic)."
  - "No new commands registered on package.json beyond what Plans 04-07/04-08 already added (refreshActivityLog, refreshPresence, activityLog.openEntry). The Plan-04-09 acceptance criteria asked for handler registration for activityLog.openEntry; package.json declaration was already done by Plan 04-07. Plan 04-10/04-11 will add openChat / manageChat to package.json when they ship."
  - "Test helpers (getItemTextForTest / getItemCommandForTest) added as public methods on StatusBarManager rather than exposing the StatusBarItem itself — keeps the test surface narrow + avoids leaking the disposable item to other call sites. Standard precedent: see syncTracker.test.ts which exercises pure public API."

# Metrics
metrics:
  duration: 7.2min
  completed: 2026-05-08
  tasks_completed: 4 (3 automated + 1 deferred manual UAT)
  files_created: 1
  files_modified: 2
  tests_added: 8
  total_tests_passing: 246
---

# Phase 4 Plan 09: Soft Notifications Summary

**Phase 4's integration plan: StatusBarManager gains flashNoImpact (CONF-08 green flash) + setUnreadCount (chat unread badge); extension.ts wires push-received → computeFileOverlap → toast (CONF-07) or flash (CONF-08) + activity-tree row; presence/chat client events route into PresenceTreeProvider/ActivityLogProvider/StatusBarManager; presence-update broadcast on every active-editor change (debounced 100ms); versioncon.activityLog.openEntry command dispatcher routes per ActivityKind. SC 4 (toast on overlap) and SC 5 (green flash on no impact) become observable end-to-end.**

## Performance

- **Duration:** ~7.2 min
- **Started:** 2026-05-08T03:00:52Z
- **Completed:** 2026-05-08T03:08:05Z
- **Tasks:** 3 automated tasks complete + 1 manual UAT deferred (Task 4 is `autonomous: false` and requires two VS Code Extension Development Host windows; cannot be automated)
- **Files modified:** 2 (`src/ui/StatusBarManager.ts`, `src/extension.ts`)
- **Files created:** 1 (`src/test/suite/statusBarManager.test.ts`)

## Accomplishments

### StatusBarManager (Task 1 + Task 2)

- **`flashNoImpact(unaffectedCount, durationMs = 5000)`** — CONF-08 green check flash. Text matches UI-SPEC §6.2 verbatim: `$(check) VersionCon — no impact (N file(s) unaffected)`; N === 1 uses singular `1 file unaffected`. Color `testing.iconPassed`. Reverts via `setStatus(currentStatus, currentSessionName)` after `durationMs`. Gated by `syncWarningActive` — sync warning beats flash per UI-SPEC §1.4.
- **`setUnreadCount(n)`** — chat unread badge. When `n > 0` AND `currentStatus === 'connected'`, text becomes `$(circle-filled) VersionCon $(comment) N` (UI-SPEC §6.2 literal); item.command swaps to `versioncon.openChat`; tooltip shows `{n} unread message(s) — click to open chat`. When `n === 0`, reverts via `setStatus`. Sync warning suppresses the overlay visually but preserves the count internally — re-applies when `setSyncWarning(false)` is called (verified by test).
- **Internal `applyUnreadOverlay()`** — mutates `item` directly without recursing through `setStatus`. Called from `setUnreadCount` and from `setStatus`'s tail (so transitions like reconnecting → connected re-apply the badge).
- **Two new private fields**: `syncWarningActive: boolean`, `unreadCount: number`. `setSyncWarning` mirrors the boolean so other methods can read it.
- **Test helpers**: `getItemTextForTest()` / `getItemCommandForTest()` expose private `item` for unit tests without leaking the StatusBarItem reference broadly.
- **8 new unit tests** in `src/test/suite/statusBarManager.test.ts`:
  1. flashNoImpact text + N file count
  2. flashNoImpact N=1 singular pluralization
  3. flashNoImpact reverts after duration (50ms test)
  4. flashNoImpact gated by syncWarningActive
  5. setUnreadCount(3) appends `$(comment) 3` overlay
  6. setUnreadCount(0) reverts to plain status
  7. setUnreadCount swaps command to `versioncon.openChat`
  8. setUnreadCount during syncWarning suppressed-but-preserved (re-applies on clear)

### extension.ts integration (Task 3)

- **Provider singletons** (`presenceTreeProvider`, `activityLogProvider`) constructed in `activate()` and registered with `vscode.window.registerTreeDataProvider('versioncon.presence', ...)` and `('versioncon.activityLog', ...)`. Module-level so `wireClientEvents` can read them.
- **Module-level mirrors**:
  - `unreadChatCount` — incremented on inbound user chat when panel hidden; cleared on chat-cleared.
  - `chatPanelIsActive` — Plan 04-10 (chat panel) flips this on view-state change; defaults `false` here so unread always increments.
  - `currentSelfMemberId` / `currentSelfDisplayName` — capture self identity from `client.getMemberId()` on join (member path) or `hostMemberId` on host start. Drives `isMine` flags + presence-update sender id.
  - `currentBranchName` — set at IIFE init AND on every `versioncon.switchBranch`; mirrored into `presenceTreeProvider.setCurrentBranch(...)` so the divergence indicator stays correct.
- **Helper functions** (module scope):
  - `formatPushToast(name, overlapping[], message)` — UI-SPEC §6.1 locked literal renderer. 1 file, 2-3 files, >3 files; empty `message` omits the `: '{msg}'` suffix.
  - `updateActivityContext()` / `updatePresenceContext()` — re-evaluate `versioncon.activityLog.empty` and `versioncon.presence.alone` context keys after every provider mutation; called from every client-event handler that mutates entries.
- **Push-received rewire** (REPLACES the old tracked-paths-based overlap):
  ```typescript
  const { overlapping } = computeFileOverlap(
    data.files.map(f => f.relativePath), getOpenTabPaths(), wsRoot, process.platform,
  );
  activityLogProvider?.addPushEntry({ ..., affectsLocal: overlapping.length > 0 });
  if (overlapping.length > 0) {
    statusBarManager.setSyncWarning(true);  // Phase 3 contract preserved
    void vscode.window.showInformationMessage(formatPushToast(data.memberDisplayName, overlapping, data.message));
  } else if (data.files.length > 0) {
    statusBarManager.flashNoImpact(data.files.length, 5000);
  }
  ```
- **Push-reverted / branch-created**: extended to feed activityLogProvider.addRevertEntry / addBranchCreateEntry. Uses `currentSelfMemberId` for `isMine`.
- **NEW client event listeners**:
  - `presence-update` → `presenceTreeProvider.upsert(info)` + `updatePresenceContext()`.
  - `member-left` → `presenceTreeProvider.removeMember(data.memberId)` + `updatePresenceContext()` (extends, doesn't replace, the existing sidebar-update member-left handler).
  - `chat-received` (kind === 'user', panel hidden) → increment unread + statusBar.setUnreadCount + activityLogProvider.setUnread.
  - `chat-cleared` → zero unread state. Plan 04-10 will additionally clear the panel.
  - `chat-truncated` / `chat-history` → no-op here; Plan 04-10 wires the chat panel.
- **Presence broadcast on activeTextEditor change** (inside the workspace IIFE): `sendPresenceUpdate(editor)` builds a `PresenceUpdate` wire message with workspace-relative posix `activeFilePath` (or `null`), calls `activeClient.sendMessage(msg)` for clients OR `activeHost.upsertHostPresence(info)` + local `presenceTreeProvider.upsert(info)` for hosts (the host's presence-update broadcast EXCLUDES the sender, so the local panel needs an explicit local upsert). 100ms debounce guards against rapid editor focus events.
- **Connection lifecycle**: `connection-changed` now sets `versioncon.connected` context key from status; on `disconnected` it clears the presence panel + identity mirrors. `wireHostEvents` mirrors `hostMemberId` into `currentSelfMemberId`. `session-ended` resets both.
- **Activity log click dispatcher**: `versioncon.activityLog.openEntry` command registered. Dispatches per `ActivityKind` — push/revert → `versioncon.showPushHistory`; branch-created → `versioncon.switchBranch`; chat-unread → `versioncon.openChat`.
- **Refresh commands**: `versioncon.refreshPresence` and `versioncon.refreshActivityLog` registered (their package.json declarations already shipped in Plans 04-07/04-08).
- **switchBranch enhancement**: after the branch swap, mirrors into `currentBranchName` + `presenceTreeProvider.setCurrentBranch(selected.label)` + re-broadcasts presence so remote members see the divergence change.

## Task Commits

| Task | Commit  | Subject |
|------|---------|---------|
| 1    | bae0fe7 | `feat(04-09): extend StatusBarManager with flashNoImpact + setUnreadCount` |
| 2    | 35f116f | `test(04-09): unit tests for StatusBarManager.flashNoImpact + setUnreadCount` |
| 3    | 72a851a | `feat(04-09): wire push-received overlap, presence/chat events, activity tree` |

Task 0 (read-only field-name audit) produced no source mutations and therefore no commit; resolutions captured below in "Field-name resolution" subsection.

Plan metadata commit: _(pending — added by final commit step)_

## Files Created/Modified

- `src/ui/StatusBarManager.ts` _(modified, +86 / -1)_ — flashNoImpact + setUnreadCount + applyUnreadOverlay private helper + 2 new fields + setSyncWarning mirror flag + 2 test helpers; setStatus tail re-applies unread badge.
- `src/test/suite/statusBarManager.test.ts` _(created, +81)_ — 8 Phase 4 unit tests covering all the new public surface + sync-warning precedence.
- `src/extension.ts` _(modified, +308 / -17)_ — module-level provider singletons + identity mirrors + helpers + activate-time provider registration + activityLog click dispatcher + refresh commands + push-received rewire + push-reverted/branch-created activity log feed + 5 NEW client event listeners + onDidChangeActiveTextEditor presence broadcast (debounced) + switchBranch presence re-broadcast + connection lifecycle context-key wiring.

## Field-name resolution (Task 0 audit)

The plan's Task 3 used placeholder names (`mySelfMemberId`, `currentBranchName`, `myDisplayName`, `connectionStatus`); read-only audit of `src/extension.ts` resolved each:

| Placeholder | Real symbol or replacement |
|-------------|---------------------------|
| `mySelfMemberId` | NEW module-level `currentSelfMemberId` (the IIFE's `currentMemberId` is the Phase 1/3 `'local-user'` placeholder; cannot be reused). Set from `client.getMemberId()` on join or `hostMemberId` on host start. |
| `currentBranchName` | NEW module-level `currentBranchName` (IIFE has no module-scoped branch field). Set at IIFE init and on every `switchBranch`. |
| `myDisplayName` | NEW module-level `currentSelfDisplayName`. Set from `client.getMembers().find(m => m.id === selfId).displayName` on join, defaults to `'You'` on host. |
| `connectionStatus` | Not needed as a single field — `activeClient !== null \|\| activeHost !== null` suffices for "is connected"; the status flows through `statusBarManager.setStatus` and the `versioncon.connected` context key. |
| Existing `push-received` handler | Lines 172-196 (per PATTERNS.md) — verified shape; rewrote handler body to use computeFileOverlap. |
| Existing `wireClientEvents` / `wireHostEvents` | Already module-scoped functions — extended in place. |

## Decisions Made

See `decisions:` in frontmatter. Key non-obvious calls:

1. **Self-identity mirrors at module scope** — the IIFE's `currentMemberId = 'local-user'` is a placeholder unchanged since Phase 1; we add proper module-level `currentSelfMemberId` populated from authenticated session id.
2. **Host upserts presence locally too** — host's broadcast excludes self; without local upsert the host's own row would never appear in the local PresenceTreeProvider.
3. **chat-received handler only acts on kind='user'** — system events (push/revert/branch-created) ride both the chat stream AND dedicated client events; we use the dedicated events for activity-log feed to avoid duplicates.
4. **setChatLog NOT called here** — Plan 04-10 owns the chat panel + chat-log construction. Host's null-guard handles absence cleanly.
5. **100ms debounce on onDidChangeActiveTextEditor** — defensive guard against rapid focus events; doesn't affect interactive cadence.
6. **No package.json edits** — all Phase 4 commands referenced here (refreshPresence, refreshActivityLog, activityLog.openEntry) already shipped in Plans 04-07/04-08. Future commands (openChat, manageChat) belong to Plans 04-10/04-11.

## Deviations from Plan

### Auto-fixed (Rules 1-3) — none requiring user permission

**1. [Rule 2 — Auto-add missing critical functionality] Added 100ms debounce to onDidChangeActiveTextEditor.** The plan didn't specify a debounce. CONTEXT.md "Presence broadcast cadence" says "no periodic heartbeat in v1" but doesn't address rapid focus events. Without a debounce, opening a file via Cmd-P (which fires both onDidOpenTextDocument and onDidChangeActiveTextEditor sequentially) can produce duplicate broadcasts. The 100ms timer is short enough to feel real-time but coalesces multi-event focus operations. Documented in the code comment at the subscription site.

**2. [Rule 2 — Auto-add missing critical functionality] Host path locally upserts presence after `activeHost.upsertHostPresence(info)`.** The plan called only `activeHost.upsertHostPresence(info)`; reading the SessionHost broadcast policy (Plan 04-04) revealed that `presence-update` broadcasts EXCLUDE the sender — so the host doesn't get their own row back. Without a local upsert, the host's own presence row would never render in their panel. Added `presenceTreeProvider?.upsert(info)` immediately after the host call to mirror the local view. Pattern matches the existing host-side member-list maintenance.

**3. [Rule 3 — Blocking issue] Module-level identity mirror fields needed because IIFE's `currentMemberId` is a placeholder.** The plan's Task 3 referenced `mySelfMemberId` as if a real authenticated id existed at module scope. Reading the file showed the IIFE's `currentMemberId = 'local-user'` is a Phase 1/3 placeholder that has never been replaced with the authenticated id. Added module-level `currentSelfMemberId` / `currentSelfDisplayName` that are populated from `client.getMemberId()` at join time. Documented in Task 0 audit and frontmatter decisions.

### Manual UAT deferred (Task 4 not run)

**Task 4 is `autonomous: false`** — a two-client UAT requires two VS Code Extension Development Host windows + human eyeball verification of toast text + status bar flash visibility. This cannot be automated by the executor. The Task 4 acceptance criteria explicitly require human sign-off. **Documented as deferred** to a manual run by the user — the build, all tests, all acceptance grep checks pass. The wiring is verified at the unit-test layer (8 new StatusBarManager tests) and integration-shape layer (`grep` patterns) — visual UX confirmation is the remaining open task that this automated executor cannot perform.

### Otherwise none

All plan acceptance criteria for Tasks 0-3 met. No other adaptations needed.

## Issues Encountered

None blocking. The TypeScript types from Plans 04-01..04-08 imported cleanly. `npx tsc --noEmit` runs in <2s; full `npm test` (which compiles + runs vscode-test) runs in ~10s. Pre-existing dirty state (deleted `test-workspace/.versioncon/branch/*`, untracked `.claude/`, the `04-07-SUMMARY.md` deletion that was renamed to `04-07-activity-tree-SUMMARY.md` in commit b60f33d but whose source-side deletion remains in the working tree) was left untouched per the prompt directive.

## STRIDE Threat Mitigation Verification

| Threat ID | Disposition | How addressed |
|-----------|-------------|---------------|
| T-04-09-01 (Tampering — push.message contains injection-y characters) | accept | `vscode.window.showInformationMessage(toast)` renders message as plain text; VS Code's own escaping handles malicious content. The chat panel webview is the markdown surface (Plan 04-10) and has CSP. |
| T-04-09-02 (Information disclosure — toast displays open-file names) | accept | This IS the feature (CONF-04 prep + CONF-07). User is the only audience. |
| T-04-09-03 (Tampering — path.basename leaks no path info beyond filename) | accept | Used intentionally; full paths remain in tooltips/activity tree. |
| T-04-09-04 (Denial of service — bursty push flood → toast spam) | accept | v1 has no per-source rate limiting on push-received. Each toast auto-dismisses; activity tree is ring-buffered (cap 200). RESEARCH §"Edge case 5" deferred. |
| T-04-09-05 (Elevation of privilege — non-host member's presence-update injects another id) | mitigate | Plan 04-04 (host) overrides msg.memberId before broadcast. This plan trusts the broadcast as already-sanitized — `presence-update` event payloads come from the host, never directly from a peer. |

All `mitigate` dispositions are backed by upstream code (Plan 04-04 host-side override). All `accept` dispositions documented above with rationale.

## Verification Results

- `npx tsc --noEmit` → exits 0 (no type errors)
- `npx tsc` (emit) → `dist/test/suite/statusBarManager.test.js` produced
- `npm run build` → exits 0 (esbuild bundles `src/extension.ts` to `dist/extension.js` cleanly)
- `npm test` → **246 passing**, 66 pending, 0 failing (was 238 → +8 new)
- All 11 Task 3 grep acceptance patterns match (computeFileOverlap, getOpenTabPaths, presenceTreeProvider new, activityLogProvider new, registerTreeDataProvider for both views, flashNoImpact(data.files.length, onDidChangeActiveTextEditor, versioncon.activityLog.openEntry, formatPushToast)
- All Task 1 grep acceptance patterns match (flashNoImpact, setUnreadCount, applyUnreadOverlay, syncWarningActive, unreadCount, UI-SPEC §6.2 literals)
- All Task 2 grep acceptance patterns match (test count ≥8, syncWarningActive in tests, "no impact" in tests)

## Self-Check

- [x] `src/ui/StatusBarManager.ts` modified (FOUND)
- [x] `src/test/suite/statusBarManager.test.ts` exists (FOUND)
- [x] `src/extension.ts` modified (FOUND)
- [x] Commit `bae0fe7` exists (FOUND)
- [x] Commit `35f116f` exists (FOUND)
- [x] Commit `72a851a` exists (FOUND)
- [x] `npx tsc --noEmit` exits 0
- [x] `npm run build` exits 0
- [x] `npm test` reports 246 passing / 0 failing (was 238 → +8, no regressions)
- [x] `grep -c "  flashNoImpact(\|  setUnreadCount(\|  private applyUnreadOverlay(" src/ui/StatusBarManager.ts` returns 3
- [x] `grep "computeFileOverlap(" src/extension.ts` matches
- [x] `grep "presenceTreeProvider = new PresenceTreeProvider" src/extension.ts` matches
- [x] `grep "activityLogProvider = new ActivityLogProvider" src/extension.ts` matches
- [x] `grep "flashNoImpact(data.files.length" src/extension.ts` matches
- [x] `grep "onDidChangeActiveTextEditor" src/extension.ts` matches (2 occurrences — header comment + subscription)
- [x] `grep "versioncon.activityLog.openEntry" src/extension.ts` matches (2 — header + handler registration)
- [x] UI-SPEC §6.1 toast formatter present in extension.ts (formatPushToast)
- [x] UI-SPEC §6.2 status bar literals present in StatusBarManager.ts

## Self-Check: PASSED

## Known Stubs / Deferred

**Task 4 (manual UAT) — DEFERRED.** Two-client UAT requires human eyeball verification across two VS Code Extension Development Host windows. Cannot be automated. The plan's `<acceptance_criteria>` for Task 4 explicitly require human sign-off (`autonomous: false`). Recommended next step for the user: run the Task 4 UAT script when convenient and append a PASS/FAIL sign-off note to this SUMMARY.

**`setChatLog` not wired here.** Plan 04-04's `setChatLog(chatLog, branchName)` two-arg signature is the contract; Plan 04-10 (chat panel) constructs the ChatLog instance and will wire it. Host's chat-history send is a no-op until then (null-guarded by Plan 04-04). No regression — this is the documented hand-off.

**`chatPanelIsActive` always `false`.** Plan 04-10 will flip this on `webviewPanel.onDidChangeViewState`; until then, every user chat increments unread (which is conservative — the worst case is a non-zero unread badge while the panel is theoretically focused, which is fine because Plan 04-10 will reset it to zero on its first `chat-viewed` postMessage).

**Plan 04-10/04-11 contracts referenced but not introduced here:**
- `versioncon.openChat` — referenced in StatusBarManager.applyUnreadOverlay + activityLog.openEntry dispatcher; will be registered by Plan 04-10.
- `versioncon.manageChat` — not referenced in this plan.

## Hand-off to Plan 04-10 (chat-panel)

- ChatPanel constructor will need to register `versioncon.openChat` command. The status bar's `applyUnreadOverlay` swaps `item.command` to that name on unread > 0 — already wired here.
- Set `chatPanelIsActive = true` on `webviewPanel.onDidChangeViewState` when `e.webviewPanel.active === true`. On the first `chat-viewed` postMessage from the webview, also reset `unreadChatCount = 0` + call `statusBarManager.setUnreadCount(0)` + `activityLogProvider.setUnread(0)`. Plan 04-09 already provides those hooks at module scope.
- Wire `client.on('chat-received', ...)` to also append the record to the chat panel (right after the existing unread-bump logic). The chat-cleared / chat-truncated / chat-history listeners in extension.ts already emit no-ops where the panel-side wiring will go.
- Construct ChatLog on session start; call `activeHost.setChatLog(chatLog, currentBranchName ?? 'main')` after host start (two-arg signature per Plan 04-04 deviation). Re-call on every `versioncon.switchBranch` so chat-history points at the new branch's log.

## Hand-off to Plan 04-11 (manage-chat)

- The `chat-cleared` / `chat-truncated` event handlers in extension.ts are already wired (Plan 04-09); the host's `broadcastChatCleared(...)` / `broadcastChatTruncated(...)` calls (Plan 04-04) will route through them. Plan 04-11 only needs to register the `versioncon.manageChat` QuickPick command and call the existing host helpers from its handlers.

---
*Phase: 04-presence-chat-file-level-conflict-notifications*
*Completed: 2026-05-08*
