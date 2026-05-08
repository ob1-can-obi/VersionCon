---
phase: 04-presence-chat-file-level-conflict-notifications
plan: 08
subsystem: ui
tags: [presence-panel, treeview, you-suffix, branch-divergence, vscode-extension, typescript]

# Dependency graph
requires:
  - phase: 04-presence-chat-file-level-conflict-notifications/01
    provides: PresenceInfo type — wraps memberId, displayName, branch, activeFilePath, lastUpdated
  - phase: 04-presence-chat-file-level-conflict-notifications/03
    provides: PresenceMap class — wrapped as the underlying data store inside the provider
  - phase: 04-presence-chat-file-level-conflict-notifications/05
    provides: presence-update client event payload — Plan 04-09 will hand these to upsert(info)
  - phase: 03-push-pull-history
    provides: BranchListProvider TreeDataProvider pattern — mirrored verbatim (EventEmitter, refresh(), flat tree, getTreeItem builds items from cached state)
provides:
  - PresenceTreeProvider class implementing vscode.TreeDataProvider<PresenceInfo>
  - 7 public methods: refresh, upsert, removeMember, clear, setSelfMemberId, setCurrentBranch, getEntries
  - UI-SPEC §2.1 row anatomy: $(account) icon, displayName label, basename description, "(you)" suffix, $(git-compare) divergence prefix, presenceMember-self/other contextValue
  - Sort order: self first, then case-insensitive alphabetical by displayName
  - Tooltip format: "On branch: {branch}\nFile: {fullPath or '(no file)'}"
  - package.json view registration: versioncon.presence view, refreshPresence command, view/title menu icon, two viewsWelcome blocks (not-connected + connected-alone)
affects:
  - 04-09-soft-notifications (extension.ts wires presence-update events to provider.upsert; on tab change emits presence-update; sets versioncon.presence.alone context key)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "TreeDataProvider mirror: EventEmitter pattern + refresh() + flat tree (getChildren(elem) returns []) — matches BranchListProvider/ActivityLogProvider verbatim"
    - "Wrap PresenceMap (Plan 04-03) as underlying data store: provider's mutators delegate to map.upsert/removeMember/clear and call refresh()"
    - "Self-first sort comparator: branches BEFORE locale-compare so memberId === selfMemberId guarantees row index 0 regardless of name"
    - "Defensive-copy reader: getEntries returns map.getSnapshot() which already returns a fresh array"
    - "Branch divergence indicator gated on currentBranch !== null: provider does not annotate divergence until extension.ts wires the active branch (no false-positive prefix on first render before wiring)"

key-files:
  created:
    - src/ui/PresenceTreeProvider.ts
    - src/test/suite/presenceTreeProvider.test.ts
  modified:
    - package.json

# Decisions
decisions:
  - "PresenceTreeProvider OWNS its PresenceMap instance privately — same pattern as ActivityLogProvider's private entries[]; mutators wrap the map + refresh() so callers (Plan 04-09) only need a single object reference, not two."
  - "currentBranch null-guard before divergence prefix — when extension.ts hasn't yet called setCurrentBranch (or session is disconnected), divergence indicator stays off rather than showing every member as divergent. This matches UI-SPEC §2.1 'when presence.branch !== currentBranch' literally only when both are known."
  - "Self-first comparator before alphabetical — explicit short-circuit returns -1/+1 for self before falling through to localeCompare; cleaner than partition-then-concat and tested directly via 'sorts self first, others alphabetical'."
  - "Description format string: \"$(git-compare) {branch} · {basename}\" — divergent rows show BOTH the divergent branch name AND the file basename so the user can see what they're working on AND that they're on a different branch in one row."
  - "package.json edit minimal/surgical — single view append, one command append, one menu entry, two viewsWelcome blocks. Co-exists with Plan 04-07's activityLog registration without rearrangement."

# Metrics
metrics:
  duration: 3.3min
  completed: 2026-05-08
  tasks_completed: 3
  files_created: 2
  files_modified: 1
  tests_added: 13
  total_tests_passing: 238
---

# Phase 4 Plan 8: Presence Panel Summary

PresenceTreeProvider (TreeDataProvider for `versioncon.presence`) renders one row per online member with self-first ordering, the locked `(you)` suffix, and a `$(git-compare)` branch-divergence prefix per UI-SPEC §2.1. Wraps a private PresenceMap (Plan 04-03) so Plan 04-09 only needs a single reference to wire inbound `presence-update` events into.

## What was built

| Component | File | Role |
|-----------|------|------|
| PresenceTreeProvider class | `src/ui/PresenceTreeProvider.ts` | Implements `vscode.TreeDataProvider<PresenceInfo>`; wraps PresenceMap; renders TreeItems |
| Test suite | `src/test/suite/presenceTreeProvider.test.ts` | 13 tests — mutators, sort order, (you) suffix, divergence prefix, tooltip, contextValue |
| View registration | `package.json` | `versioncon.presence` view + `versioncon.refreshPresence` command + view/title menu icon + 2 viewsWelcome blocks |

### Behavior summary

- **Mutators (delegate-then-refresh):** `upsert(info)`, `removeMember(memberId)`, `clear()` each delegate to the wrapped PresenceMap then call `refresh()` to fire `onDidChangeTreeData`.
- **Setters (refresh-only):** `setSelfMemberId(id)` and `setCurrentBranch(branch)` mutate provider-local state then `refresh()` so `(you)` and divergence prefix re-render.
- **Render anatomy (UI-SPEC §2.1):** `$(account)` icon, label = `displayName`, description = `basename(activeFilePath)` or `"(no file)"`, tooltip = `"On branch: {branch}\nFile: {fullPath or '(no file)'}"`.
- **(you) suffix:** appended to `description` when `info.memberId === selfMemberId`.
- **Branch divergence indicator:** `$(git-compare) {info.branch} · ` prefix applied when `currentBranch !== null && info.branch !== currentBranch`.
- **contextValue:** `presenceMember-self` for self row, `presenceMember-other` for everyone else.
- **Sort order:** self first; remaining members alphabetical by `displayName` (case-insensitive `localeCompare`).
- **Reader:** `getEntries()` returns `PresenceMap.getSnapshot()` (defensive copy by construction).

### Tests added (13)

- Mutator contract: upsert, removeMember, clear (3)
- Sort order: self-first-then-alphabetical (1) + alphabetical-only when no selfMemberId (1)
- (you) suffix: applied to self only (1)
- Description formatting: basename of nested path (1) + "(no file)" fallback (1)
- Branch divergence: $(git-compare) when divergent (1) + no prefix when matching (1)
- Tooltip exact-string match: "On branch: {branch}\nFile: {path}" (1)
- contextValue: self (1) + other (1)

Total project tests: **238 passing** (was 225, +13).

## Decisions Made

See `decisions:` in frontmatter. Key ones:

1. **Provider owns the PresenceMap** — single object reference for Plan 04-09 wiring; mirrors ActivityLogProvider's private `entries[]` ownership pattern.
2. **currentBranch null-guard** — divergence prefix stays off until extension.ts wires the active branch via `setCurrentBranch`, preventing false-positive annotations on first render.
3. **Description format `$(git-compare) {branch} · {basename}`** — divergent rows show BOTH the divergent branch name AND the file the member is working on.
4. **Minimal package.json edit** — sibling-append only; co-exists with Plan 04-07's activityLog registration without disturbing existing rows.

## Deviations from Plan

None — plan executed exactly as written. Notes:

- The plan's example code uses `path.basename` from Node's `path` module; `import * as path from 'path'` was used and works under VS Code's Node runtime.
- Plan 04-09 will need to call `setSelfMemberId` AND `setCurrentBranch` after auth-response + branch resolution to enable the `(you)` suffix and divergence prefix; documented in the Hand-off section below.

## Threat Model Coverage

| Threat ID | Disposition | How addressed |
|-----------|-------------|---------------|
| T-04-08-01 | accept | Active file paths exposed via tooltip — this is the feature (COLLAB-01); not a leak. |
| T-04-08-02 | mitigate | Provider does not normalize `activeFilePath`; relies on Plan 04-06 (computeFileOverlap) + Plan 04-09 (extension.ts) to feed already workspace-relative posix paths. Provider's tooltip displays the value as-is per the upstream invariant. |
| T-04-08-03 | mitigate | Provider trusts whatever PresenceInfo.memberId is passed; the host (Plan 04-04) is the trust boundary that overwrites memberId from the ws-bound closure before broadcasting. |

## Verification Results

- `npx tsc --noEmit` → exits 0 (no type errors)
- `npx tsc` (emit) → `dist/test/suite/presenceTreeProvider.test.js` produced
- `npm test -- --grep "PresenceTreeProvider"` → **13 passing** in 28ms
- `npm test` (full suite) → **238 passing**, 66 pending, 0 failing (was 225 → +13 new)
- `node -e "JSON.parse(...)"` → package.json well-formed
- View registration check: `versioncon.presence` present in `views.versioncon`; `versioncon.refreshPresence` in `commands`; refresh menu wired to `view == versioncon.presence`; both viewsWelcome blocks (`!versioncon.connected` + `versioncon.connected && versioncon.presence.alone`) present
- `grep -c "versioncon.presence" package.json` → 5 (≥4 required)

## Self-Check: PASSED

- [x] `src/ui/PresenceTreeProvider.ts` exists
- [x] `src/test/suite/presenceTreeProvider.test.ts` exists
- [x] `package.json` modified (versioncon.presence registered, viewsWelcome added, refreshPresence command + menu)
- [x] Commit `8381ba6` (feat: provider) found in git log
- [x] Commit `47ed1de` (test: tests) found in git log
- [x] Commit `c63858e` (feat: package.json) found in git log
- [x] Total tests passing ≥ 225 (actual: 238)
- [x] All 7 public methods present (refresh, upsert, removeMember, clear, setSelfMemberId, setCurrentBranch, getEntries)
- [x] All UI-SPEC §2.1 literals present in code: `(you)`, `git-compare`, `ThemeIcon('account')`, `presenceMember-self`, `presenceMember-other`, `On branch:`

## Commits

| Task | Commit | Subject |
|------|--------|---------|
| 1 | `8381ba6` | `feat(04-08): add PresenceTreeProvider with self-first sort + divergence indicator` |
| 2 | `47ed1de` | `test(04-08): unit tests for PresenceTreeProvider` |
| 3 | `c63858e` | `feat(04-08): register versioncon.presence view + viewsWelcome + refreshPresence command` |

## Hand-off to Plan 04-09 (soft-notifications)

- Instantiate `new PresenceTreeProvider()` once in `extension.ts` activation.
- Register the tree: `vscode.window.registerTreeDataProvider('versioncon.presence', provider)`.
- After auth-response: call `provider.setSelfMemberId(myMemberId)` so the `(you)` suffix renders for the local user.
- After branch-resolution / on branch change: call `provider.setCurrentBranch(branchName)` so the `$(git-compare)` divergence prefix activates. Pass `null` on disconnect to suppress divergence annotations.
- Wire SessionClient `presence-update` event to `provider.upsert(info)`.
- Wire SessionClient `member-left` event to `provider.removeMember(memberId)`.
- Wire SessionClient `connection-changed → disconnected` to `provider.clear()`.
- Toggle context keys for `viewsWelcome`:
  - `vscode.commands.executeCommand('setContext', 'versioncon.connected', boolean)` (shared with activityLog).
  - `vscode.commands.executeCommand('setContext', 'versioncon.presence.alone', provider.getEntries().filter(e => e.memberId !== selfMemberId).length === 0)` — re-evaluate after every upsert/remove.
- Register `versioncon.refreshPresence` command → calls `provider.refresh()`.
- Subscribe to `vscode.window.onDidChangeActiveTextEditor`: send a `presence-update` ProtocolMessage to the active session AND upsert into the local provider so the user's own active file shows in their own panel.

## Hand-off to Plan 04-10 (chat-panel)

- Plan 04-10 does not interact with the presence panel directly. The chat panel header may show "{N} online" derived from `provider.getEntries().length`, but the source of truth stays in the provider; the chat panel is a read-only consumer.
