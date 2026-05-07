# Roadmap: VersionCon

## Overview

VersionCon is built in layers — each phase must be stable before the next adds to it. The networking foundation must exist before UI, which must exist before push, which must exist before conflict detection. The sequence follows the critical dependency chain: transport infrastructure, then the visual workspace, then the push and branch model, then team awareness features, then the AST-powered differentiator, then code review governance, then cloud reach, and finally AI agent integration as a read surface over everything below.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Extension Foundation + LAN Networking** - VS Code extension scaffold, WebSocket transport, host/join flow, connection status
- [ ] **Phase 2: Split-Pane UI + File System Layer** - Two-pane webview, drag-and-drop, stateless webview protocol, filesystem-as-truth
- [x] **Phase 3: Push, Sync + Branch Management** - Explicit push with diff, push history, revert, branch creation, admin/member permissions (6/6 plans done; 6/6 SCs satisfied by code, visual UAT deferred — see 03-VERIFICATION.md and 03-HUMAN-UAT.md)
- [ ] **Phase 4: Presence, Chat + File-Level Conflict Notifications** - Real-time presence, in-app chat, push activity log, soft conflict alerts
- [ ] **Phase 5: Dependency-Aware Conflict Detection (AST)** - AST child process, per-language parsers, function-level conflict attribution, smart push summary
- [ ] **Phase 6: Inline Code Review** - Diff + approve flow, line comments, mandatory review gate, review threads in chat
- [ ] **Phase 7: Cloud Mode + Relay Server** - Relay deployment, JWT auth, CloudTransport, same UX as LAN over internet
- [ ] **Phase 8: AI Agent API (MCP Integration)** - Embedded MCP server, read-only tools for branch state, dependency graph, activity

## Phase Details

### Phase 1: Extension Foundation + LAN Networking
**Goal**: Teams can create and join a live coding session on a local network from inside VS Code — no terminal commands, coding within seconds of connecting
**Depends on**: Nothing (first phase)
**Requirements**: NET-01, NET-02, NET-03, NET-04, NET-05, NET-07, NET-08, SAFE-01, SAFE-02
**Success Criteria** (what must be TRUE):
  1. A host can launch VS Code, open the extension, run the setup wizard, and have a live LAN session active within 60 seconds — no terminal required
  2. A joining member can select "Join," enter a host IP and credentials, and be inside the shared session within seconds — no terminal required
  3. The connection status indicator is always visible and accurately reflects whether the session is live, syncing, or disconnected
  4. Host IP is prominently displayed in the wizard so joiners can connect via manual IP when mDNS fails (VLAN environments)
  5. Connection automatically recovers after a sleep/wake cycle or brief network interruption via heartbeat-driven reconnect
**Plans:** 9 plans
Plans:
- [x] 01-00-PLAN.md — Wave 0: Test infrastructure and stub test files for all Phase 1 requirements (mocha + @vscode/test-cli)
- [x] 01-01-PLAN.md — Extension scaffold, package.json, build config, message protocol types, session model contracts
- [x] 01-02-PLAN.md — WebSocket host (SessionHost, AuthHandler, BandwidthMonitor) and client (SessionClient, ConnectionState, heartbeat/reconnect)
- [x] 01-03-PLAN.md — Session history persistence, secret storage, mDNS discovery, network utilities
- [ ] 01-04-PLAN.md — Host setup wizard: 3-step custom webview with auto-detection, invite code, and "share with team" screen
- [ ] 01-05-PLAN.md — Join panel with session history quick-reconnect and mDNS browse
- [ ] 01-05b-PLAN.md — Sidebar with member list and admin controls, status bar connection indicator
- [ ] 01-06-PLAN.md — Integration wiring: connect all components, event propagation, host shutdown confirmation, end-to-end verification
- [ ] 01-08-PLAN.md — Gap closure: fix disconnected color, heartbeat pong, host disconnect confirmation, stale wizard panel

### Phase 2: Split-Pane UI + File System Layer
**Goal**: Users see their workspace (left) and shared branch (right) as two panes inside VS Code and can move files between them by dragging
**Depends on**: Phase 1
**Requirements**: UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, UI-08, UI-09
**Success Criteria** (what must be TRUE):
  1. The VS Code window shows two panes — left is the user's personal workspace, right is the read-only shared branch view with expandable folder tree
  2. A user can drag a file from the branch (right) into the workspace (left) and that file appears in the workspace ready to edit — folder drags bring structure only (empty)
  3. A user can drag a file from workspace (left) back to branch (right) to stage it for pushing
  4. Drag-and-drop works correctly on VS Code 1.90+ on all three OS targets (the cross-webview regression is resolved)
  5. Refreshing or switching VS Code tabs does not lose workspace or branch state — webview state is always restored from the extension host
**Plans:** 4 plans
Plans:
- [ ] 02-01-PLAN.md — Types/interfaces + FileSystemLayer with TDD (copy file, structure-only, path validation, tree building)
- [ ] 02-02-PLAN.md — SplitPanePanel WebviewPanel class + webview assets (HTML split layout, CSS, JS drag handlers)
- [ ] 02-03-PLAN.md — Extension wiring: openWorkspace command, FileSystemWatcher with debounce, integration tests
- [ ] 02-04-PLAN.md — Visual verification checkpoint: human confirms drag-and-drop, state restore, no cross-webview regression
**UI hint**: yes

### Phase 3: Push, Sync + Branch Management
**Goal**: Users can explicitly push their changes to the shared branch, view full push history, revert any push, and admins can manage branches and permissions
**Depends on**: Phase 2
**Requirements**: PUSH-01, PUSH-02, PUSH-03, PUSH-04, PUSH-05, PUSH-06, PUSH-07, PUSH-08, PUSH-09, PUSH-10, PUSH-11, BRANCH-01, BRANCH-02, BRANCH-03, BRANCH-04, BRANCH-05, BRANCH-06, BRANCH-07, BRANCH-08, BRANCH-09, SAFE-03, SAFE-04
**Success Criteria** (what must be TRUE):
  1. A user who drags files to the branch pane sees no change to shared code until they explicitly hit "Push" with a message — the branch is read-only until that moment
  2. Before pushing, the user sees a smart summary: list of changed files, line-by-line diff, and who on the team might be affected
  3. A user can open push history, find any past push, and revert the entire push or select individual files to revert — team receives a notification when a revert happens
  4. An admin can create branches, lock branches, grant or revoke per-person push rights, and restrict members to specific branches — all at runtime without restarting
  5. When the workspace is out of sync with the latest branch state, the extension blocks staging, unstaging, debug, and run actions with a modal that points the user to the Sync command — there is no dismiss-only escape hatch
  6. Sync is a real file pull: branch files are copied into the workspace, with a per-file conflict prompt (Keep mine / Take branch / Show diff) whenever local edits collide with the incoming version
**Plans:** 6 plans complete (gap closure 03-06 shipped 2026-05-07; visual UAT deferred per 03-HUMAN-UAT.md)
Plans:
- [x] 03-01-PLAN.md — Wave 0/1: Create SyncTracker service + test scaffolds (syncTracker, permissionEnforcement, pushIntegration)
- [x] 03-02-PLAN.md — Wave 1: Wire permission gates into push/createBranch commands, expand admin permission UI, enhance types/protocol
- [x] 03-03-PLAN.md — Wave 2: computeAffectedMembers in PushService, partial-revert broadcast fix, host-side relay permission validation
- [x] 03-04-PLAN.md — Wave 2: Wire SyncTracker into extension lifecycle, debug/task sync warnings, markSynced command (v1 sync-state-only; file-pull deferred)
- [x] 03-05-PLAN.md — Wave 3: BranchListProvider all-branches view (BRANCH-03), quickMergeFiles command (BRANCH-07), structuredMergeBranch walkthrough (BRANCH-08)
- [x] 03-06-PLAN.md — Gap closure: block stage/unstage/debug/run on out-of-sync (modal, not toast); replace markSynced acknowledge with real pull-on-demand command (PUSH-10) and per-file conflict prompts (PUSH-11)

### Phase 4: Presence, Chat + File-Level Conflict Notifications
**Goal**: Team members can see who is online and what they are working on, communicate via in-app chat, and receive soft non-blocking alerts when a teammate's push touches files they have open
**Depends on**: Phase 3
**Requirements**: COLLAB-01, COLLAB-02, COLLAB-03, COLLAB-04, COLLAB-05, COLLAB-06, COLLAB-07, CONF-01, CONF-07, CONF-08
**Success Criteria** (what must be TRUE):
  1. Any team member can see a live presence panel showing who is online, which file each person has open, and which branch they are on — without having to ask anyone
  2. Team members can send text messages and paste syntax-highlighted code snippets in the in-app chat without leaving VS Code
  3. Push events, revert events, and branch events are automatically posted to the chat timeline so the activity history is always visible
  4. When a teammate pushes changes to a file the user has open, the user receives a soft non-blocking notification (not a modal) identifying what changed and who pushed it
  5. When a push does not affect the user's workspace at all, the user sees a green "no impact" status and continues working without interruption
**Plans**: TBD
**UI hint**: yes

### Phase 5: Dependency-Aware Conflict Detection (AST)
**Goal**: Conflict notifications upgrade from file-level to function-level — users are told exactly which symbol changed, who changed it, and on which line they call it
**Depends on**: Phase 4
**Requirements**: CONF-02, CONF-03, CONF-04, CONF-05, CONF-06, CONF-09, CONF-10
**Success Criteria** (what must be TRUE):
  1. After a teammate pushes a change, a user who calls a modified function sees a notification like "calculate_total() was modified by Alice — you call this in line 34" rather than just "file changed"
  2. AST analysis runs in a separate child process and never causes the VS Code extension host to freeze or become unresponsive — push flow completes at normal speed
  3. Dependency analysis works for Python, JavaScript/TypeScript, Java, and C++ codebases; for all other languages, the system falls back to file-level and line-level detection (not silence)
  4. Files larger than 500KB and paths matching node_modules/dist are skipped automatically — conflict detection never hangs on generated or minified files
  5. The smart push summary upgrades from "files changed" to "dependency impact + affected teammates," showing which symbols each teammate depends on before the push lands
**Plans**: TBD

### Phase 6: Inline Code Review
**Goal**: Users can request a formal review of their changes before they merge, reviewers can approve or request changes with inline comments, and admins can make review mandatory for merges to main
**Depends on**: Phase 5
**Requirements**: REVIEW-01, REVIEW-02, REVIEW-03, REVIEW-04
**Success Criteria** (what must be TRUE):
  1. A user can open a review panel for any staged change and see a side-by-side diff of exactly what changed in each file
  2. A reviewer can approve the change, request changes, or leave line-level comments — all from inside VS Code without opening a browser
  3. When an admin configures a branch to require review before merge, the merge action is blocked until at least one reviewer approves
  4. Review comments appear in the in-app chat thread so the team can follow the conversation without switching panels
**Plans**: TBD
**UI hint**: yes

### Phase 7: Cloud Mode + Relay Server
**Goal**: Teams who are not on the same local network can use VersionCon over the internet with the exact same UI and workflow as LAN mode
**Depends on**: Phase 6
**Requirements**: NET-06
**Success Criteria** (what must be TRUE):
  1. A host can start a cloud session from the same setup wizard used for LAN — the UI shows "Cloud" mode and no extra steps are required compared to LAN
  2. A member on a different network can join a cloud session by entering the relay address and credentials — they are coding within the same time window as LAN mode
  3. The connection status indicator correctly reflects cloud relay connection health, including relay server unreachable as a distinct state from session-not-found
**Plans**: TBD

### Phase 8: AI Agent API (MCP Integration)
**Goal**: AI coding agents (Claude Code, Cursor, Codex) can query VersionCon's collaboration context so they can give advice that is aware of branch state, pending syncs, and dependency impacts
**Depends on**: Phase 7
**Requirements**: AI-01, AI-02, AI-03, AI-04
**Success Criteria** (what must be TRUE):
  1. Claude Code (or any MCP-compatible client) can call a VersionCon tool to read the current branch state, sync status, and recent push activity without any manual setup beyond enabling the extension
  2. An AI agent can read the full dependency graph — which symbols each workspace file uses and who else depends on those symbols — to give conflict-aware advice
  3. AI agents cannot push, create branches, or modify shared state on behalf of users — the API is strictly read-only
  4. An AI agent that has read VersionCon context can correctly identify that a user's local workspace is out of sync and advise them to pull before running
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Extension Foundation + LAN Networking | 8/9 | In Progress | - |
| 2. Split-Pane UI + File System Layer | 0/4 | Not started | - |
| 3. Push, Sync + Branch Management | 6/6 | Complete (UAT deferred) | 2026-05-07 |
| 4. Presence, Chat + File-Level Conflict Notifications | 0/TBD | Not started | - |
| 5. Dependency-Aware Conflict Detection (AST) | 0/TBD | Not started | - |
| 6. Inline Code Review | 0/TBD | Not started | - |
| 7. Cloud Mode + Relay Server | 0/TBD | Not started | - |
| 8. AI Agent API (MCP Integration) | 0/TBD | Not started | - |

## Backlog

### Phase 999.1: Bonjour service-name collision blocks two extension hosts on same machine (BACKLOG)

**Goal:** [Captured for future planning] — Two extension dev hosts on the same machine cannot co-host LAN sessions because both register the same Bonjour service name. The second `Host Session` attempt throws `Error: Service name is already in use on the network` and the first host's connection drops mid-handshake. Fix by appending a per-instance suffix (PID, random, or workspace path hash) to the Bonjour service name in the discovery layer.
**Requirements:** TBD
**Plans:** 0 plans

**Repro:** Launch two extension dev hosts via `code --extensionDevelopmentPath=… /tmp/wsA` and `…/tmp/wsB`. Both click Host Session.
**Affected code:** Phase 1/2 discovery/networking layer (likely `src/network/` or `src/discovery/`).
**Surfaced:** 2026-05-07 during Phase 3 (03-06) visual UAT. Blocked the single-machine two-host UAT setup; visual UAT for SC 5 / SC 6 was deferred as a result. This bug will block any future single-machine UAT for LAN-dependent features.
**Suggested home:** small dedicated phase OR rolled into Phase 4 (presence/chat) as a prerequisite.

Plans:
- [ ] TBD (promote with /gsd-review-backlog when ready)
