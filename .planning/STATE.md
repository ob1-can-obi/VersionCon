---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
stopped_at: context exhaustion at 75% (2026-05-05)
last_updated: "2026-05-08T03:08:05Z"
last_activity: "2026-05-08 -- Plan 04-09 complete: StatusBarManager flashNoImpact/setUnreadCount + extension.ts integration glue (push-received overlap → toast/flash, presence broadcast on activeTextEditor change debounced, activity-tree dispatcher, 5 new client event listeners) + 8 new tests (246 passing)"
progress:
  total_phases: 9
  completed_phases: 2
  total_plans: 32
  completed_plans: 26
  percent: 81
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-04)

**Core value:** Teams collaborate on code without merge conflict pain — dependency-aware tracking means you only stop coding when changes genuinely affect what you're working on.
**Current focus:** Phase 4 — Presence, Chat + File-Level Conflict Notifications

## Current Position

Phase: 4 (Presence, Chat + File-Level Conflict Notifications) — EXECUTING
Plan: 10 of 11
Status: Executing Phase 4 — Plans 04-01..04-09 complete (9 of 11); wave-4 next (04-10 chat-panel)
Next: Plan 04-10 (chat-panel) — ChatPanel WebviewPanel + bundled markdown-it/highlight.js/codicons + CSP + WorkspaceState chatHiddenBefore. Will wire host.setChatLog(chatLog, branchName) (two-arg signature) and flip chatPanelIsActive on view-state change.
Last activity: 2026-05-08 -- Plan 04-09 complete: StatusBarManager flashNoImpact/setUnreadCount + extension.ts integration glue (push-received overlap → toast/flash, presence broadcast on activeTextEditor change debounced, activity-tree dispatcher, 5 new client event listeners) + 8 new tests (246 passing)

Progress: [████████░░] 81%

## Performance Metrics

**Velocity:**

- Total plans completed: 15
- Average duration: 4.2 min
- Total execution time: 1.05 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 6 | 23 min | 3.8 min |
| 04 | 9 | 40.5 min | 4.5 min |

**Recent Trend:**

- Last 5 plans: 04-09 (7.2 min), 04-08 (3.3 min), 04-07 (4 min), 04-06 (3 min), 04-02 (4 min)
- Trend: 04-09 was the most complex plan in Phase 4 (integration glue across StatusBarManager + extension.ts + 5 client event listeners + presence broadcast + activity-tree dispatcher); duration ~2x median because the file-name resolution audit and module-level identity-mirror plumbing required reading the entire IIFE before mutating extension.ts. Three Rule-2/3 deviations recorded inline (debounce, host-side local upsert, identity mirror fields). 8 new tests; 246 passing total.

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Pre-Phase 1]: Use `web-tree-sitter` (WASM) from day one — never `node-tree-sitter`. Switching later requires rewriting entire AST layer.
- [Pre-Phase 1]: Manual IP join path must be built BEFORE mDNS discovery. mDNS fails silently in VLANs and corporate/university networks.
- [Pre-Phase 1]: Stateless webview architecture — all state in extension host; webview fires `webview-ready` on mount and receives full state snapshot.
- [Pre-Phase 2]: Route drag-and-drop events through extension host to avoid VS Code 1.90+ cross-webview regression (issue #256444).
- [Plan 01-00]: Test stubs created as Wave 0 before production code — every requirement tagged in test descriptions for traceability.
- [Plan 01-01]: Added @types/node and types array to tsconfig for Node16 module resolution compatibility with test stubs.
- [Plan 01-01]: Updated .gitignore to exclude node_modules, dist, .venv, .vscode-test, and *.vsix.
- [Plan 01-02]: First authenticated member gets host role; tracked via hostMemberId for admin command authorization.
- [Plan 01-02]: SessionClient uses null-ws pattern to distinguish intentional disconnect from connection drops.
- [Plan 01-03]: Used optional chaining for bonjour-service Service.stop (type declares it as optional).
- [Plan 04-01]: Phase 4 wire types added contract-first in Wave 1 so Waves 2-4 share one canonical shape.
- [Plan 04-01]: ChatRecord.meta.affectsLocal is computed client-side only — JSDoc documents non-persistence (T-04-01-03).
- [Plan 04-01]: PresenceInfo.activeFilePath uses 'string | null' rather than 'string | undefined' so the value travels through JSON cleanly.
- [Plan 04-01]: VALID_TYPES gate test verifies T-04-01-02 mitigation — invented chat-* types are rejected at the parser layer.
- [Plan 04-06]: computeFileOverlap takes platform as injectable arg so darwin/linux/win32 branches all unit-test on any host OS.
- [Plan 04-06]: pathLib selection inside the function (path.win32 vs path.posix) decouples relative-path correctness from the runtime OS — reproducible win32 tests on macOS CI.
- [Plan 04-06]: Path normalization splits on both path.sep and backslash so synthetic win32 inputs normalize correctly when the host platform differs (deviation Rule 2 — correctness improvement, no behavior change in production).
- [Plan 04-06]: TabInputTextDiff in getOpenTabPaths includes BOTH original and modified URIs — user clearly cares about both files visible in the diff view.
- [Plan 04-02]: ChatLog mirrors PushHistory.ts pattern verbatim — same load/save/append shape, same whole-file rewrite, no .tmp+rename (atomic-rename upgrade deferred jointly with PushHistory).
- [Plan 04-02]: ChatLog.getRecords() returns chronological (oldest first), opposite of PushHistory — chat displays oldest-at-top, scrolling down to newest.
- [Plan 04-02]: truncateKeepLast100PlusActivity uses (timestamp, id.localeCompare) sort tiebreaker so equal-ms records produce deterministic output across reloads (V8 sort is unstable for ties without it).
- [Plan 04-02]: ChatLog.getRecords() returns a defensive copy ([...this.records]) so external mutation cannot corrupt the in-memory cache; worth applying retroactively to PushHistory.
- [Plan 04-02]: exportToFile honors hiddenBefore with >= boundary semantics so per-user clear-view does not leak hidden context into exports.
- [Plan 04-03]: PresenceMap is a class (not a bare Map) so Plan 04-08 (TreeProvider) has something to wrap with refresh() side effects and Plan 04-04 (host) can choose to use it or keep an inline Map — overrides RESEARCH §"PresenceMap location" advice based on Plan 04-08's needs.
- [Plan 04-03]: getSnapshot() returns Array.from(values()) defensive copy — consistent with SyncTracker.getOutOfSyncPaths() and ChatLog.getRecords() patterns; tested explicitly so the invariant survives refactors.
- [Plan 04-03]: PresenceMap is policy-agnostic — sanitization of memberId (T-04-03-01) and activeFilePath (T-04-03-03) is the caller's responsibility (Plan 04-04 and Plan 04-06); documented in upsert() JSDoc cross-referencing STRIDE threat IDs.
- [Plan 04-05]: Wire→event field renames (recordId → id, timestamp → lastUpdated) happen at the SessionClient routing boundary so downstream code never sees wire-only field names — keeps the event-payload contract authoritative once it leaves SessionClient.
- [Plan 04-05]: Conditional spread for optional subKind/meta fields preserves the JSDoc invariant 'subKind only set when kind === system' from src/types/chat.ts; carrying explicit undefined would leak wire-shape into consumers.
- [Plan 04-05]: Test harness invokes private handleMessage via typed bracket cast — avoids real WebSocket spin-up for routing-only assertions; cleaner than mocking ws because the contract is purely 'wire shape in, event shape out'.
- [Plan 04-05]: Build-script ordering quirk discovered — `npm run build` only bundles extension.ts; downstream plans that touch test files must run `npx tsc` (no flag) before `npm test` to compile dist/test/*.js, otherwise vscode-test runs stale compiled tests.
- [Plan 04-04]: setChatLog widened to (chatLog, branchName) two-arg signature — SessionHost has no existing branch-tracking field that Task 3's chat-history send could read from; storing activeBranch on the host is the cleanest fix. Plan 04-09 (extension wiring) must call setChatLog(chatLog, branchName) accordingly.
- [Plan 04-04]: handleLocalChatMessage uses this.hostMemberId ?? 'host' fallback — the host process may not have self-authenticated as a member; using a stable 'host' marker keeps the local-compose path working regardless of self-auth state.
- [Plan 04-04]: T-04-04-04 (chat-cleared/chat-truncated spoofing) mitigation is structural, not code — the ProtocolMessage union permits both wire types but the onmessage switch has NO inbound branches; spoofed messages from non-host clients silently drop. Verified by integration test that spoofed cleared/truncated never reach other clients AND host doesn't crash.
- [Plan 04-04]: chat-message broadcast includes sender (no exclude) per RESEARCH Open Q #1 — sender sees own message after host echo. presence-update excludes sender (mirrors member-joined). Both branches mirror tracked-paths-update precedent (T-03-14) for the closure-bound memberId override.
- [Plan 04-04]: Test harness uses raw ws package, not full SessionClient — routing-level integration tests don't need reconnect/heartbeat machinery. Smaller harness (connectClient + waitFor, ~50 lines) gives precise wire-level send/receive assertions; mirrors Plan 04-05's typed-bracket-cast decision at one level higher.
- [Plan 04-07]: Sticky unread row exempt from RING_BUFFER_CAP — UI-SPEC §1.2 caps activity entries; the sticky marker is a UX affordance, not a buffer entry. Tested via "sticky unread row preserved during ring buffer trim".
- [Plan 04-07]: Click command split — provider declares `versioncon.activityLog.openEntry`; Plan 04-09 will register the actual handler that routes by kind (push/revert → smart push summary; branch → switchBranch picker). Keeps per-kind UX routing out of the provider.
- [Plan 04-07]: ActivityKind compile-time exhaustiveness check (`SystemEventSubKind extends ActivityKind ? true : never`) breaks the build if a new system event kind is added to chat.ts without extending ActivityKind — prevents silent drift between chat-log and activity tree.
- [Plan 04-07]: getEntries returns a defensive copy `[...this.entries]` — mirrors Plan 04-02 ChatLog.getRecords + Plan 04-03 PresenceMap.getSnapshot patterns; explicit test guards against future regression.
- [Plan 04-07]: package.json edit minimal/surgical (single view append, two commands, one menu, two viewsWelcome blocks) — Plan 04-08 will append a sibling presence view to the same arrays without conflict.
- [Plan 04-08]: PresenceTreeProvider OWNS its PresenceMap instance privately — single object reference for Plan 04-09 wiring; mirrors ActivityLogProvider's private entries[] ownership pattern. Mutators delegate then refresh.
- [Plan 04-08]: Branch divergence prefix gated on `currentBranch !== null` — until extension.ts wires the active branch via setCurrentBranch (or session is disconnected), divergence indicator stays off rather than annotating every member as divergent. Matches UI-SPEC §2.1 literal "when presence.branch !== currentBranch" only when both are known.
- [Plan 04-08]: Description format `$(git-compare) {branch} · {basename}` — divergent rows show BOTH the divergent branch name AND the file the member is working on, in the same row.
- [Plan 04-08]: Self-first sort comparator branches BEFORE locale-compare — explicit short-circuit returns -1/+1 for self before falling through to localeCompare; cleaner than partition-then-concat and tested directly.
- [Plan 04-08]: package.json edit minimal/surgical — sibling-append only (versioncon.presence after versioncon.activityLog). Co-exists with Plan 04-07's registration without disturbing existing rows.
- [Plan 04-09]: Module-level provider singletons (presenceTreeProvider, activityLogProvider) constructed in activate() BEFORE the workspace IIFE — both wireClientEvents (module scope) and the IIFE can reference them without nullability surprises beyond the explicit `?.` chain.
- [Plan 04-09]: Self-identity mirror fields (currentSelfMemberId / currentSelfDisplayName) added at module scope rather than reusing the IIFE's currentMemberId — the IIFE's value is the Phase 1/3 'local-user' placeholder; module mirrors are populated from authenticated client.getMemberId() at join time. Unblocks isMine detection on the activity log without refactoring placeholder fields.
- [Plan 04-09]: Active-branch mirror (currentBranchName) updated at IIFE init AND on every switchBranch — switchBranch additionally calls sendPresenceUpdate(activeTextEditor) so remote panels' divergence indicators refresh immediately when the local user moves to a different branch.
- [Plan 04-09]: 100ms debounce on onDidChangeActiveTextEditor → presence-update — defensive Rule 2 guard against rapid focus events (Cmd-P open + activate fires the event multiple times). One outbound message per intent without sacrificing real-time feel.
- [Plan 04-09]: Host's local presence upsert (presenceTreeProvider.upsert(info)) is explicit — the host's broadcast EXCLUDES the sender per Plan 04-04 broadcast policy, so without local upsert the host's own row would never appear in their panel.
- [Plan 04-09]: chat-received handler only acts on kind='user' — system events (push/revert/branch-created) ride both the chat stream AND the dedicated client events; activity-log feed routes through the dedicated events to avoid duplicate rows.
- [Plan 04-09]: setChatLog NOT wired here — Plan 04-10 (chat panel) constructs the ChatLog instance and owns the wiring. Host's chat-history send is a no-op until then (null-guarded by Plan 04-04). No regression.
- [Plan 04-09]: setUnreadCount precedence — sync warning suppresses the badge visually but PRESERVES the count internally; setStatus tail re-applies the overlay when the warning clears AND status is 'connected'. setSyncWarning(true/false) mirrors the boolean into syncWarningActive so flashNoImpact and applyUnreadOverlay can read it.
- [Plan 04-09]: Task 4 (manual two-client UAT) deferred — autonomous: false. Visual UX confirmation across two VS Code Extension Development Host windows requires human eyeball verification of toast text + status bar flash; cannot be automated. Wiring verified at unit-test layer (8 new tests) + grep-shape integration check.

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 2]: Cross-webview drag-and-drop VS Code 1.90+ regression (issue #256444) requires a throwaway spike before full UI implementation
- [Phase 5]: tree-sitter-java and tree-sitter-cpp WASM compatibility with web-tree-sitter@0.25.x is unvalidated — may require custom WASM builds or deferring Java/C++ support
- [Phase 7]: Cloud relay operational model (hosting platform, cost model, self-host option) is not yet decided — needs decision before Phase 7 planning
- [Phase 8]: VS Code MCP API is new (2025) — McpStdioServerDefinition vs McpHttpServerDefinition tradeoffs need research during Phase 8 planning

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-05-08T03:08:05Z
Stopped at: Completed plan 04-09 (Phase 4 wave-4 next; soft notifications integration glue shipped — toast/flash/activity-tree/presence broadcast all wired end-to-end; manual UAT deferred)
Resume file: None
