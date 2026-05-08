---
phase: 04-presence-chat-file-level-conflict-notifications
plan: 07
subsystem: ui
tags: [activity-log, treeview, ring-buffer, sticky-unread, vscode-extension, typescript]

# Dependency graph
requires:
  - phase: 04-presence-chat-file-level-conflict-notifications/01
    provides: SystemEventSubKind union (push | revert | branch-created) — ActivityKind covers all + chat-unread sticky
  - phase: 04-presence-chat-file-level-conflict-notifications/05
    provides: Client event payload shape (id, timestamp, memberId, memberDisplayName, files, branchName) — Plan 04-09 will hand these to addPushEntry/addRevertEntry/addBranchCreateEntry
  - phase: 03-push-pull-history
    provides: BranchListProvider TreeDataProvider pattern — mirrored verbatim (EventEmitter, refresh(), flat tree, getTreeItem builds items from cached state)
provides:
  - ActivityLogProvider: vscode.TreeDataProvider<ActivityEntry>
  - ActivityEntry interface (kind, id, timestamp, memberId, memberDisplayName, isMine, files?, pushMessage?, affectsLocal?, branchName?, unreadCount?)
  - ActivityKind union: 'push' | 'revert' | 'branch-created' | 'chat-unread' (compile-time covers SystemEventSubKind)
  - 6 public mutators: addPushEntry, addRevertEntry, addBranchCreateEntry, setUnread, clear, refresh
  - 1 public reader: getEntries (defensive copy)
  - formatRelativeTime (pure, exported, testable)
  - Ring buffer cap (200 entries) with sticky-unread row exempt from the cap
  - Single-sticky invariant for the unread-chat row (setUnread filters prior sticky before insert)
  - All 8 UI-SPEC §6.3 label strings rendered verbatim
  - All 6 UI-SPEC §2.2 icon + theme-color combinations
  - package.json view registration: versioncon.activityLog view, refresh + openEntry commands, refresh menu, viewsWelcome (not-connected + connected-no-events)
affects:
  - 04-08-presence-panel (sibling view in same activitybar container; same registration pattern)
  - 04-09-soft-notifications (extension.ts wires push-received → addPushEntry, push-reverted → addRevertEntry, branch-created → addBranchCreateEntry, chat-message + viewstate → setUnread)
  - 04-10-chat-panel (chat panel onDidChangeViewState calls setUnread(0) when active; toggles versioncon.connected context key)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "TreeDataProvider mirror: EventEmitter pattern + refresh() + flat tree (getChildren(elem) returns []) — matches BranchListProvider verbatim"
    - "Ring buffer with sticky exemption: cap counts only non-sticky entries; sticky unread is preserved across trims"
    - "Single-sticky invariant via filter-before-insert: setUnread always strips any prior unread-chat-sticky row before adding the new one — concurrent calls cannot duplicate the row"
    - "Compile-time exhaustiveness: SystemEventSubKind extends ActivityKind ? true : never assertion guarantees adding a new system event kind to chat.ts breaks the build until ActivityKind is extended"
    - "Defensive-copy reader: getEntries returns [...this.entries] (mirrors ChatLog.getRecords + PresenceMap.getSnapshot)"
    - "Pure relative-time formatter with injectable now: testable without faked clocks"
    - "Reverse-chronological sort on render only: insert order preserves arrival; getChildren sorts by timestamp descending"

key-files:
  created:
    - src/ui/ActivityLogProvider.ts
    - src/test/suite/activityLogProvider.test.ts
  modified:
    - package.json

# Decisions
decisions:
  - "Sticky unread row exempt from RING_BUFFER_CAP — UI-SPEC §1.2 caps activity entries; the sticky marker is a UX affordance, not a buffer entry. Tested explicitly: ring 'sticky unread row preserved during ring buffer trim'."
  - "Separate command name versioncon.activityLog.openEntry registered by Plan 04-09 — this provider only declares the click target; the dispatcher (push/revert → smart push summary, branch → switchBranch picker) lives in extension.ts, keeping per-kind routing out of the provider."
  - "ActivityKind compile-time check links to SystemEventSubKind — if Plan 5+ adds a new system event kind, the build fails until ActivityKind is extended, preventing silent feature drift between chat-log and activity tree."
  - "getEntries returns a defensive copy [...this.entries] — mirrors ChatLog.getRecords (Plan 04-02 decision) + PresenceMap.getSnapshot (Plan 04-03 decision); explicit test 'getEntries returns a defensive copy' guards against future regression."
  - "package.json edit minimal/surgical — appends the view to versioncon array, two commands, one menu entry, two viewsWelcome blocks. No reformatting; Plan 04-08 will append a sibling presence view to the same array without conflict."
  - "Tooltip uses plain string (not MarkdownString) — T-04-07-01 disposition: keep tooltip a plain string so push messages cannot inject markdown/HTML; VS Code renders plain strings literally."

# Metrics
metrics:
  duration: 4.3min
  completed: 2026-05-08
  tasks_completed: 3
  files_created: 2
  files_modified: 1
  tests_added: 27
  total_tests_passing: 225
---

# Phase 4 Plan 7: Activity Tree Summary

ActivityLogProvider (TreeDataProvider for `versioncon.activityLog`) renders a reverse-chronological in-memory ring buffer of push/revert/branch-create events plus a single sticky unread-chat row, mirroring BranchListProvider verbatim and exposing the exact icon + label strings locked by UI-SPEC §2.2 / §6.3.

## What was built

| Component | File | Role |
|-----------|------|------|
| ActivityLogProvider class | `src/ui/ActivityLogProvider.ts` | Implements `vscode.TreeDataProvider<ActivityEntry>`; holds entries; renders TreeItems |
| ActivityEntry interface | `src/ui/ActivityLogProvider.ts` | Carries push/revert/branch/chat-unread fields in one shape |
| `formatRelativeTime` | `src/ui/ActivityLogProvider.ts` | Pure exported helper for "just now" / "Ns ago" / "Nm ago" / "Nh ago" / "Nd ago" |
| Test suite | `src/test/suite/activityLogProvider.test.ts` | 27 tests — ring buffer, sticky, label formatting, TreeItem decoration, formatRelativeTime |
| View registration | `package.json` | `versioncon.activityLog` view + 2 commands + refresh menu + 2 viewsWelcome states |

### Behavior summary

- **Ring buffer:** non-sticky entries capped at 200; sticky unread row exempt from cap.
- **Sticky unread:** `setUnread(N>0)` upserts a single row with id `'unread-chat-sticky'` at index 0 of the rendered list; `setUnread(0)` removes it.
- **Render order:** sticky first (when present), then reverse-chronological by timestamp.
- **Click commands:** push/revert/branch → `versioncon.activityLog.openEntry` (Plan 04-09 dispatcher); chat-unread → `versioncon.openChat`.
- **Theme colors (UI-SPEC §2.2):** push (mine) `testing.iconPassed`, push (remote, no impact) `charts.blue`, push (affects me) `editorWarning.foreground`, revert `errorForeground`, branch-create `descriptionForeground`, chat-unread `charts.blue`.
- **Labels (UI-SPEC §6.3, locked copy):** all 8 cases verified verbatim — `You pushed N file(s)`, `{name} pushed N file(s)`, `{name} pushed N file(s) — affects you`, `You reverted N file(s)`, `{name} reverted N file(s)`, `You created branch '{name}'`, `{name} created branch '{name}'`, `$(circle-filled) N unread message(s)`.

### Tests added (27)

- Mutator + refresh contract (1)
- Ring buffer cap at 200 (1)
- Sticky unread preserved during trim (1)
- setUnread upsert / remove / replace (3)
- clear semantics (1)
- getChildren flat tree + sticky-first reverse-chronological order (2)
- getEntries defensive copy (1)
- All 8 UI-SPEC §6.3 label cases (8)
- TreeItem decoration: contextValue, click commands, tooltip (4)
- formatRelativeTime branches (5) + clock-skew clamp (1)

Total project tests: **225 passing** (was 198).

## Decisions Made

See `decisions:` in frontmatter. Key ones:

1. **Sticky unread exempt from cap** — UX marker, not an activity entry.
2. **Click command split** — provider declares `versioncon.activityLog.openEntry`; Plan 04-09 registers the actual handler that routes by kind.
3. **Compile-time exhaustiveness** — `SystemEventSubKind extends ActivityKind` assertion catches future drift.
4. **Defensive copy on getEntries** — matches ChatLog/PresenceMap pattern.
5. **Minimal package.json edit** — Plan 04-08 will append sibling presence view without conflict.
6. **Tooltip is plain string** — T-04-07-01 mitigation; no markdown injection surface.

## Deviations from Plan

None — plan executed exactly as written. The only nuance worth noting:

- The plan's `pushEntry` cap snippet computed `nonSticky.length > RING_BUFFER_CAP` after the push, which matches what was implemented; the test "ring buffer caps at 200 entries" verifies the cap precisely.
- Build-script ordering: needed `npx tsc` (no flag) to emit dist/test JS files for vscode-test to pick up the new test file. This was already documented in Plan 04-05's decisions.

## Threat Model Coverage

| Threat ID | Disposition | How addressed |
|-----------|-------------|---------------|
| T-04-07-01 | accept | TreeItem.tooltip is a plain string; VS Code renders literally — no XSS/markdown injection surface. |
| T-04-07-02 | accept | This provider does not normalize file paths; relies on Plan 04-06 + Plan 04-09 to feed already-normalized workspace-relative paths. |
| T-04-07-03 | mitigate | RING_BUFFER_CAP = 200 enforced in `pushEntry` after every insert; test "ring buffer caps at 200 entries" verifies. |
| T-04-07-04 | mitigate | `makeId(prefix, ts)` always emits `${prefix}-${ts}-${random}` — never the literal `'unread-chat-sticky'`. `setUnread` filters any prior sticky before insert. Test "setUnread replaces existing sticky on second call" verifies single-sticky invariant. |

## Verification Results

- `npx tsc --noEmit` → exits 0 (no type errors)
- `npx tsc` (emit) → dist/test/suite/activityLogProvider.test.js produced
- `npm test` → **225 passing**, 66 pending, 0 failing (was 198 → +27 new)
- `node -e "JSON.parse(...)"` → package.json well-formed
- View registration check: `versioncon.activityLog` present in `views.versioncon`; `versioncon.refreshActivityLog` + `versioncon.activityLog.openEntry` in commands

## Self-Check: PASSED

- [x] `src/ui/ActivityLogProvider.ts` exists
- [x] `src/test/suite/activityLogProvider.test.ts` exists
- [x] `package.json` modified (versioncon.activityLog registered, viewsWelcome added)
- [x] Commit `5564216` (feat: provider) found in git log
- [x] Commit `4229443` (test: tests) found in git log
- [x] Commit `dfd817c` (feat: package.json) found in git log
- [x] Total tests passing ≥ 198 (actual: 225)
- [x] All 4 ActivityKind cases (push, revert, branch-created, chat-unread) covered

## Commits

| Task | Commit | Subject |
|------|--------|---------|
| 1 | `5564216` | `feat(04-07): add ActivityLogProvider with ring buffer + sticky unread` |
| 2 | `4229443` | `test(04-07): unit tests for ActivityLogProvider` |
| 3 | `dfd817c` | `feat(04-07): register versioncon.activityLog view + viewsWelcome` |

## Hand-off to Plan 04-08 (presence-panel)

- The `views.versioncon` array now contains 5 entries (`versioncon.sidebar`, `branchTree`, `workspaceTree`, `branchList`, `activityLog`). Append `{ id: "versioncon.presence", name: "Presence" }` after `activityLog` (or at any position — order is up to UI-SPEC §0).
- `viewsWelcome` and `commands` arrays already contain the activityLog entries; presence entries should be appended without disturbing existing rows.
- Same TreeDataProvider pattern (BranchListProvider) is canon — keep it identical.

## Hand-off to Plan 04-09 (soft-notifications)

- Instantiate `new ActivityLogProvider()` once in `extension.ts` activation.
- Register the tree: `vscode.window.registerTreeDataProvider('versioncon.activityLog', provider)`.
- Wire SessionClient events:
  - `chat-received` (system, subKind='push') → compute `affectsLocal` via `computeFileOverlap` (Plan 04-06) → `provider.addPushEntry({ ... })`
  - `chat-received` (system, subKind='revert') → `provider.addRevertEntry({ ... })`
  - `chat-received` (system, subKind='branch-created') → `provider.addBranchCreateEntry({ ... })`
  - `chat-received` (kind='user') + chat panel hidden → increment unread → `provider.setUnread(N)`; chat panel becoming active → `provider.setUnread(0)`
- Register the dispatcher: `vscode.commands.registerCommand('versioncon.activityLog.openEntry', (entry: ActivityEntry) => { ... })` — route push/revert to a smart push summary modal; branch to switchBranch picker (UI-SPEC §3.2).
- Toggle context keys: `vscode.commands.executeCommand('setContext', 'versioncon.connected', boolean)` and `versioncon.activityLog.empty` for the viewsWelcome `when` clauses.
- The `versioncon.refreshActivityLog` command should call `provider.refresh()`.
