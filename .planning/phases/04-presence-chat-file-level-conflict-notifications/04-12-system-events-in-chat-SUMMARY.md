---
phase: 04-presence-chat-file-level-conflict-notifications
plan: 12
subsystem: host-broadcast
tags: [host, chat, activity-timeline, broadcast, persistence, system-events, websocket, vscode-extension, typescript, gap-closure]

# Dependency graph
requires:
  - phase: 04-presence-chat-file-level-conflict-notifications/04
    provides: broadcastPush / broadcastRevert / broadcastBranchCreated method bodies (extended here), handleLocalChatMessage memberId/displayName resolution pattern, broadcast() fan-out with no-exclude semantics, hostMemberId / hostDisplayName resolution
  - phase: 04-presence-chat-file-level-conflict-notifications/02
    provides: ChatLog.append() for durable chat-log.json persistence, ChatRecord shape with kind / subKind / meta fields
  - phase: 04-presence-chat-file-level-conflict-notifications/01
    provides: ChatRecord type, ChatMessage envelope shape, SystemEventSubKind union ('push' | 'revert' | 'branch-created')
  - phase: 04-presence-chat-file-level-conflict-notifications/13
    provides: CR-01 client-frame coercion that this plan must coexist with — kind:'user' coercion is scoped to the chat-message wire onmessage handler ONLY, so host-internal writes from broadcastPush/Revert/BranchCreated remain legitimate kind:'system' emitters
provides:
  - broadcastPush extended: appends a kind:'system', subKind:'push' ChatRecord with meta:{ pushId, branch, files } to chat-log.json AND broadcasts a chat-message envelope so all connected clients render the activity event live (not only on next-join replay)
  - broadcastRevert extended: same shape, subKind:'revert', meta:{ pushId, branch, files }
  - broadcastBranchCreated extended: subKind:'branch-created', meta:{ branch }
  - Order-of-operations preserves Phase 3 contract — original wire envelope (push-notification / push-reverted / branch-created) fires FIRST and unconditionally, then ChatLog.append (failure swallowed), then chat-message envelope. Persistence failure does NOT block live broadcast.
  - Shared id between persisted ChatRecord.id and chat-message envelope.recordId — clients dedupe a live system event against the same record on subsequent chat-history replay.
  - 13 integration tests in `Phase 4 system events in chat` suite anchoring append + broadcast + identity-fallback + persistence-tolerance + CR-01 coexistence + shared-id contracts
affects:
  - 04-07 ActivityLogProvider (system events now arrive at clients via chat-message; ActivityLogProvider's onChatReceived handler can construct activity entries from system records, satisfying CONTEXT.md line 29 "activity timeline IS chat timeline")
  - 04-10 ChatPanel (system rows render via record.kind === 'system' renderer that was already in place from Plan 04-10, now exercised end-to-end on the wire)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Wire broadcast-FIRST ordering: original push-notification / push-reverted / branch-created envelope fires before any ChatLog or chat-message work — Phase 3 fan-out contract is never regressed by a downstream chat write"
    - "Fire-and-forget persistence with caught-and-logged failure: ChatLog.append errors are swallowed (logged with console.error) so a transient disk-write failure cannot block the live wire broadcast — mirrors the chat-message wire handler's posture in Plan 04-04"
    - "Shared recordId between persisted record and envelope: ChatRecord.id is computed once, written to chat-log.json AND used as ChatMessage.recordId in the broadcast envelope — clients dedupe same-record live + replay events against this stable id"
    - "Host-internal kind:'system' write path: this is NOT a wire frame from a client, so Plan 04-13's CR-01 client-frame coercion does not apply — kind:'system' here is legitimate; CR-01 only coerces frames arriving via the chat-message onmessage switch branch"
    - "Identity policy mirrors handleLocalChatMessage (Plan 04-04): memberId = this.hostMemberId ?? 'host', memberDisplayName = this.hostDisplayName — 'host' fallback covers the pre-self-auth case"
    - "Body strings follow UI-SPEC §6.1 / §6.4 system-event format already used by ActivityLogProvider — `{hostDisplayName} pushed {N} file(s)`, `{hostDisplayName} reverted {N} file(s)`, `{hostDisplayName} created branch '{branchName}'`"
    - "Null-chatLog tolerance: when setChatLog has not been called (test fixtures, pre-init host), broadcasts still fire and persistence is silently skipped — keeps the host robust against initialization-order regressions"

# What this delivers
delivers:
  - CONTEXT.md line 29 lock satisfied: every host activity (push, revert, branch-create) now produces both a wire envelope AND a durable ChatRecord, so the activity timeline IS the chat timeline. Late joiners get the same history via 04-04 chat-history replay; live members see system events arrive in real time alongside user chat.
  - Closes the gap-closure target identified in 04-VERIFICATION.md (gaps_found): system events were specified by COLLAB-04 but were not emitted to chat — only push/revert/branch-create wire envelopes existed. Plan 04-12 adds the chat-log + chat-message side without disturbing the existing fan-out.
  - Composes correctly with Plan 04-13's CR-01 input-coercion: client-authored kind:'system' frames are still rejected (coerced to 'user') in the wire handler, but host-emitted kind:'system' records flow through the legitimate broadcast path.

# Files changed
key-files:
  modified:
    - path: src/host/SessionHost.ts
      change: "broadcastPush / broadcastRevert / broadcastBranchCreated each extended (+127 lines, -7 lines): each method now (1) fires its original Phase 3 wire envelope unchanged, (2) appends a kind:'system' ChatRecord to chatLog with the appropriate subKind + meta + body, (3) broadcasts a chat-message envelope. Persistence failure caught and logged, broadcast still fires. Shared recordId between persisted record and envelope."
    - path: src/test/suite/host.test.ts
      change: "Added `Phase 4 system events in chat` suite — 13 tests (+489 lines): append + broadcast for each of the three methods (×2 = 6), Phase 3 wire-envelope preservation (×3), identity 'host' fallback, identity hostMemberId path, persistence-failure tolerance, null-chatLog tolerance, CR-01 coexistence (host-internal kind:'system' preserved), shared persisted-id ↔ envelope-recordId contract."
  created: []

# Test results
tests:
  added: 13
  total_passing: 311  # was 298 after Wave 7 — +13 from this plan, no regressions
  total_pending: 66
  suite: "Phase 4 system events in chat"
  exit: 0

# Acceptance against plan must_haves
must_haves_met:
  - "broadcastPush appends kind:'system' subKind:'push' ChatRecord with meta:{ pushId, branch, files } AND broadcasts chat-message envelope before returning"
  - "broadcastRevert appends kind:'system' subKind:'revert' ChatRecord with meta:{ pushId, branch, files } AND broadcasts envelope"
  - "broadcastBranchCreated appends kind:'system' subKind:'branch-created' ChatRecord with meta:{ branch: branch.name } AND broadcasts envelope"
  - "memberId on system records is this.hostMemberId or the 'host' fallback (matches handleLocalChatMessage convention)"
  - "memberDisplayName is this.hostDisplayName"
  - "Body strings follow UI-SPEC §6.1 / §6.4 format used by ActivityLogProvider — concise human-readable summaries"
  - "Chat-log persistence failure caught and logged but does not block the original broadcastPush/Revert/BranchCreated wire broadcast (broadcast still fires)"
  - "chat-message envelope passes through same fan-out as handleLocalChatMessage — broadcast() with no exclude — so all clients see system events live"
  - "Existing 04-04 host-relay tests still pass (no regression in chat-message wire handler or chat-history replay)"
  - "System-event ChatRecords are visible to ChatPanel.renderSystemRow because the renderer keys off record.kind === 'system' (already in place per Plan 04-10) — verified via test that confirms wire envelope reaches client with kind:'system' preserved"
  - "kind:'system' here coexists with Plan 04-13 CR-01: tests confirm CR-01 still coerces client-authored kind:'system' frames; host-internal system writes are unaffected"

# Deviations from plan
deviations:
  - "Plan 04-12 was originally dispatched to a parallel-executor worktree agent. The agent committed Task 1 (the SessionHost.ts implementation, commit cb85245) cleanly, then hit a usage limit while saving Task 2's 489-line test suite as an unstaged change in the worktree. The orchestrator salvaged the worktree: tsc --noEmit clean, all 13 staged tests pass against the committed implementation. The orchestrator then committed the tests (commit bb6bfda) and authored this SUMMARY. Implementation logic, test coverage, and acceptance criteria are unchanged — only the SUMMARY authorship moved from agent to orchestrator due to the budget interruption."

# Self-Check
self_check_status: PASSED
self_check_notes:
  - "311 passing (was 298 after Wave 7, +13 from this plan, 0 regressions)"
  - "tsc --noEmit: clean"
  - "Each must_have anchored to ≥1 test in `Phase 4 system events in chat`"
  - "CR-01 coexistence test confirms host-internal kind:'system' writes are NOT coerced by the input-validation path 04-13 added"
  - "Shared-recordId test confirms dedupe contract for late-join replay"
