---
phase: 04-presence-chat-file-level-conflict-notifications
plan: 04
subsystem: host
tags: [chat, presence, relay, websocket, server-trust, vscode-extension, typescript]

# Dependency graph
requires:
  - phase: 01-networking-foundation
    provides: SessionHost relay framework (broadcast helper, member-left lifecycle, ws-bound memberId closure pattern, async-tolerant onmessage switch)
  - phase: 03-push-pull-history
    provides: Existing tracked-paths-update / push-notification handler pattern (T-03-14 server-trust precedent) — mirrored verbatim for Phase 4 chat/presence
  - phase: 04-presence-chat-file-level-conflict-notifications/01
    provides: Wire types (ChatMessage, PresenceUpdate, ChatHistory, ChatCleared, ChatTruncated) and ChatRecord/PresenceInfo type contract
  - phase: 04-presence-chat-file-level-conflict-notifications/02
    provides: ChatLog persistence — append, getRecent(100), per-branch chat-log.json
  - phase: 04-presence-chat-file-level-conflict-notifications/03
    provides: PresenceMap accumulator — upsert, removeMember, getSnapshot
provides:
  - SessionHost.chatLog field + setChatLog(chatLog, branchName) wiring
  - SessionHost.presenceMap field + presence cleanup on member-left
  - chat-message wire handler — server-trusted memberId + host-arrival timestamp + ChatLog append + broadcast-to-all (no exclude)
  - presence-update wire handler — server-trusted memberId + host-arrival timestamp + PresenceMap upsert + broadcast-excluding-sender
  - 7 public methods: setChatLog, upsertHostPresence, getPresenceSnapshot, broadcastChatCleared, broadcastChatTruncated, sendChatHistoryToMember, handleLocalChatMessage
  - chat-history replay on auth handshake (after state-sync, per RESEARCH Open Q #2)
  - 11 integration tests anchoring server-trust + broadcast policy + lifecycle + replay + spoof-protection contracts
affects:
  - 04-07-activity-tree
  - 04-08-presence-panel
  - 04-09-soft-notifications
  - 04-10-chat-panel
  - 04-11-manage-chat

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Async ws.on('message') callback: handler is now async to support awaited chatLog.append; outer try/catch already swallows errors per T-01-05"
    - "Server-trust override: closure-bound memberId (captured at auth time) overwrites msg.memberId before persist + broadcast — extends T-03-14 / tracked-paths-update precedent to chat-message + presence-update"
    - "Host-arrival timestamp stamping: createTimestamp() override before persist + broadcast — chat ordering is host event-loop order, not client clock"
    - "Conditional spread for optional fields: ...(msg.subKind !== undefined ? { subKind: msg.subKind } : {}) preserves the JSDoc invariant 'subKind only set when kind === system' and avoids leaking explicit undefined onto the wire/disk"
    - "Graceful degradation on chatLog null: chat-message handler still broadcasts even when setChatLog has not yet been called — live chat survives wiring race conditions"
    - "Fire-and-forget chat-history replay: void this.sendChatHistoryToMember(...) so auth handshake never blocks on a chat-history failure (the method itself logs and swallows)"

key-files:
  created: []
  modified:
    - src/host/SessionHost.ts
    - src/test/suite/host.test.ts

key-decisions:
  - "setChatLog signature took (chatLog, branchName) instead of just (chatLog) — the plan offered both shapes; chose the two-arg variant because SessionHost has no existing branch-tracking field that Task 3's chat-history send could read from"
  - "displayName resolved from this.members.get(memberId)?.member.displayName at relay time — falls back to the claimed value only if the member entry is missing (defensive fallback, never reachable in normal flow because the closure-bound memberId is always in this.members)"
  - "handleLocalChatMessage uses this.hostMemberId ?? 'host' fallback — the host process may not have self-authenticated as a member; using a stable 'host' marker keeps persistence + broadcast working regardless of self-auth state"
  - "T-04-04-04 mitigation is structural, not code — the ProtocolMessage union permits chat-cleared / chat-truncated wire types but the onmessage switch has NO inbound branches for them; spoofed messages from non-host clients silently drop. Verified by integration test"
  - "chatLog/activeBranch null-guard in auth handshake: chat-history send is a no-op until extension.ts calls setChatLog — pre-wave-3 connections won't get history but won't error either"
  - "Test harness built with raw ws package instead of full SessionClient: routing-only assertions don't need the client's reconnect/heartbeat machinery, and the smaller harness lets each test verify wire-level send/receive precisely"

patterns-established:
  - "Server-trust + host-stamp envelope policy now applies to FOUR wire types: push-notification, tracked-paths-update, chat-message, presence-update. Future Phase 4-7 wire types added by the relay should follow the same rewrite-then-broadcast pattern (closure-bound id, createTimestamp() stamp)"
  - "Public broadcast helpers exposed for downstream plans to invoke without re-implementing the broadcast() loop or the exclude-sender bookkeeping. broadcastChatCleared / broadcastChatTruncated / broadcastPush / broadcastRevert / broadcastBranchCreated / broadcastBranchLocked all sit at the SessionHost public surface as thin wrappers over the private broadcast(msg, excludeId?) method"
  - "Fire-and-forget async-from-sync pattern: void this.sendChatHistoryToMember(...) inside the synchronous handleAuthRequest — pattern extracted from existing extension.ts Phase 3 wiring (void operator + async fn). Future plans hooking optional async work into existing sync handshakes can adopt the same shape"

requirements-completed: [COLLAB-02, COLLAB-04, COLLAB-05]

# Metrics
duration: 8min
completed: 2026-05-08
---

# Phase 4 Plan 04: Host Relay Summary

**SessionHost is now the trusted relay for Phase 4 chat + presence: server-trusted memberId override on chat-message and presence-update, host-arrival timestamp stamping, ChatLog persistence before broadcast, PresenceMap accumulation with member-left cleanup, last-100 chat-history replay on auth handshake, and seven new public helpers (including handleLocalChatMessage) that downstream Plans 04-08 / 04-10 / 04-11 import directly.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-05-08T02:18:56Z
- **Completed:** 2026-05-08T02:26:31Z
- **Tasks:** 4 of 4
- **Files modified:** 2 (0 created, 2 modified)

## Accomplishments

- **Two new wire-handler branches** in `src/host/SessionHost.ts`'s onmessage switch — one for `chat-message`, one for `presence-update`. Both mirror the existing `tracked-paths-update` precedent (T-03-14 server-trust): the closure-bound `memberId` captured at auth time overwrites the client-claimed `msg.memberId` field before persistence + broadcast. `createTimestamp()` stamps host-arrival time over the client clock. The chat-message branch persists to ChatLog BEFORE broadcasting (single source of truth for joiners' chat-history replay); the presence-update branch upserts into PresenceMap. Broadcast policy: chat-message includes sender (no exclude — sender sees own echo per RESEARCH Open Q #1); presence-update excludes sender (mirrors the `member-joined` pattern).
- **`ws.on('message', ...)` callback converted to async** so the chat-message branch can `await chatLog.append(record)`. Outer try/catch already swallows errors per T-01-05; null-guard on `this.chatLog` lets live chat survive wiring race conditions.
- **`removeMember()` now clears the presence entry** alongside `memberTracking` and `bandwidthMonitor` — the departed member's slot disappears from clients' presence panels via the existing `member-left` broadcast cycle.
- **Seven new public methods** between the Phase 3 broadcast block and the Phase 3 member-tracking block, under a new "Phase 4: Chat + Presence public API" header:
  - `setChatLog(chatLog, branchName)` — wires both the chat-log reference AND the active-branch label used by chat-history replay (Task 3). Plan offered single-arg shape; chose two-arg because SessionHost had no existing branch-tracking field.
  - `upsertHostPresence(info)` — host's `onDidChangeActiveTextEditor` entry point. Upserts into PresenceMap then broadcasts to all connected members (host's own slot is news to every connected client).
  - `getPresenceSnapshot()` — defensive copy for Plan 04-08's PresenceTreeProvider.
  - `broadcastChatCleared(hostMemberId, hostDisplayName)` and `broadcastChatTruncated(mode, ...)` — hard-contract imports for Plan 04-11. Host-only outbound; the onmessage switch has NO inbound branch for these types, so a malicious client cannot synthesize cleared/truncated events (T-04-04-04 mitigation).
  - `sendChatHistoryToMember(memberId, branch)` — single-client send (mirrors the sync-response shape) used by Task 3's auth-handshake replay. Logs and swallows failures so auth never blocks.
  - `handleLocalChatMessage(msg)` — host's local compose path used by Plan 04-10. Re-uses the SAME `chatLog.append` + `broadcast` path as the wire handler so host-origin messages are indistinguishable from remote ones — single-source-of-truth fan-out.
- **Auth handshake wiring (Task 3):** after `state-sync` is sent to the newly authenticated member, `void this.sendChatHistoryToMember(newMemberId, this.activeBranch)` fires fire-and-forget so the joiner's chat panel populates with prior context. Per RESEARCH Open Q #2 the handshake order is now `auth-response → state-sync → chat-history → (broadcast member-joined)`. Guarded by a `chatLog/activeBranch` null check so the call is a no-op until extension.ts wires the active branch.
- **11 new integration tests** under `suite('Phase 4 host relay', ...)` in `src/test/suite/host.test.ts`. Built a small in-test harness (`connectClient` + `waitFor`) using the raw `ws` package — routing-level assertions don't need the full SessionClient's reconnect/heartbeat machinery. Tests cover server-trust gates, broadcast policy (sender-included for chat, sender-excluded for presence), lifecycle (member-left clears presence), replay (chat-history after state-sync, last-100 cap), and spoof protection (chat-cleared / chat-truncated silently drop on inbound).
- **Test count: 187 → 198 passing / 0 failing.** `npx tsc --noEmit` clean. `npm run build` succeeds.

## Task Commits

Each task was committed atomically:

1. **Task 1: chat-message + presence-update handlers + fields + member-left cleanup** — `f14a090` (feat)
2. **Task 2: 7 public Phase 4 API helpers (setChatLog, upsertHostPresence, getPresenceSnapshot, broadcastChatCleared, broadcastChatTruncated, sendChatHistoryToMember, handleLocalChatMessage)** — `20e08f3` (feat)
3. **Task 3: chat-history replay on auth handshake (after state-sync)** — `a4870ae` (feat)
4. **Task 4: 11 integration tests for chat/presence relay + handshake replay** — `9b8e850` (test)

**Plan metadata commit:** _(pending — added by final commit step)_

## Files Created/Modified

- `src/host/SessionHost.ts` _(modified, +277 / -1 lines across 4 commits)_ — 2 new wire-handler branches, 3 new fields (`chatLog`, `activeBranch`, `presenceMap`), 7 new public methods, async ws.on('message') callback, presence cleanup in removeMember, chat-history replay in handleAuthRequest.
- `src/test/suite/host.test.ts` _(modified, +578 lines)_ — Suite `Phase 4 host relay` with 11 integration tests + harness helpers (`connectClient`, `waitFor`).

## Decisions Made

- **`setChatLog(chatLog, branchName)` two-arg signature** — the plan offered both shapes; chose two-arg because SessionHost had no existing branch-tracking field that Task 3's chat-history send could read from. Plan 04-04 truth statements list `setChatLog` without a fixed arity, so this is consistent.
- **`displayName` resolved from `this.members.get(memberId)?.member.displayName`** — falls back to the claimed value only if the member entry is missing. In normal flow the closure-bound `memberId` is always present in `this.members`, so the fallback is purely defensive (would only fire if the member close handler raced ahead of the in-flight onmessage). Aligns with RESEARCH §"Envelope rules" #2.
- **`handleLocalChatMessage` uses `this.hostMemberId ?? 'host'` fallback** — the host process may not have self-authenticated as a member (e.g., in headless or test contexts). Using a stable 'host' string keeps persistence + broadcast working regardless of self-auth state. Documented at the method site so a future Plan 04-10 wiring change can revisit if needed.
- **T-04-04-04 mitigation is structural, not code** — the `ProtocolMessage` union permits `chat-cleared` / `chat-truncated` wire types (correctly — host outbound) but the onmessage switch has NO inbound branches for them. Spoofed messages from non-host clients fall through and silently drop. Verified by the integration test "chat-cleared and chat-truncated have NO inbound handler — silently ignored". This matches the Plan 04-04 plan's `<threat_model>` disposition — no inbound code path is the mitigation.
- **chatLog / activeBranch null-guard in auth handshake** — the chat-history send is a no-op until extension.ts wires `setChatLog`. Pre-wave-3 connections won't get history but won't error either; downstream Plans 04-09 / 04-10 will wire the call site.
- **Test harness built with raw `ws` package, not full `SessionClient`** — routing-only assertions don't need reconnect/heartbeat machinery. The smaller harness (`connectClient` returns ws + memberId + send/close/waitFor/onMessage) is ~50 lines and more precise for wire-level assertions. Mirrors the Plan 04-05 client.test.ts decision (typed bracket cast over `handleMessage`) at one level higher.
- **Conditional spread for optional fields** — `...(msg.subKind !== undefined ? { subKind: msg.subKind } : {})` preserves the `chat.ts` JSDoc invariant "subKind only set when kind === 'system'" and avoids leaking explicit `undefined` into the persisted record. Same pattern Plan 04-05 used for the wire-to-event translation; reused here for the wire-to-record translation.

## Deviations from Plan

**Two minor adaptations** — neither required user permission (Rule 3: blocking issues / signature mismatch with actual SessionHost shape):

1. **[Rule 3 — Blocking] `setChatLog` signature widened to `(chatLog, branchName)`.** The plan suggested either a single-arg `setChatLog(chatLog)` with an inferred `getActiveBranch()` lookup OR threading `branch` through the constructor. Reading SessionHost.ts revealed neither pattern existed: there is no `getActiveBranch` method on the host, no `currentBranch` field, and the constructor only takes `(config, hostDisplayName)`. The cleanest fix was to widen `setChatLog` to take the branch name explicitly, store it as `this.activeBranch`, and use it in `sendChatHistoryToMember`'s call site inside the auth handshake. Documented in the Decisions section above; downstream Plan 04-09 (extension.ts wiring) will need to call `setChatLog(chatLog, branchName)` instead of `setChatLog(chatLog)`.
2. **[Rule 3 — Blocking] `handleLocalChatMessage` uses `this.hostMemberId ?? 'host'` instead of `this.selfMemberId`.** The plan referenced `this.selfMemberId` and `this.selfDisplayName` fields that don't exist in SessionHost. The closest existing fields are `this.hostMemberId` (set when the first member self-authenticates as host) and `this.hostDisplayName` (constructor arg). Used those; added a 'host' string fallback for the case where the host hasn't self-authenticated yet. Same logical intent — host's own identity drives the local-compose path — with the field names that actually exist.

No other deviations. All 4 tasks landed in the spec'd files with the spec'd shapes. Plan acceptance criteria asked for 6+ tests; landed 11. Test count contract (≥187) satisfied: 187 → 198 (+11, no regressions).

## Issues Encountered

None blocking. The TypeScript types from Plans 04-01, 04-02, 04-03 (`ChatRecord`, `PresenceInfo`, `SystemEventSubKind`, `ChatLog`, `PresenceMap`) imported cleanly. The pre-existing `npx tsc` workflow (compiles tests; esbuild only bundles `src/extension.ts`) accepted both file modifications without configuration changes. Pre-existing dirty state (deleted `test-workspace/.versioncon/branch/*` files, untracked `.claude/` and runtime artifacts) was left untouched per the prompt directive.

## TDD Gate Compliance

Tasks were marked `tdd="true"` but the underlying behavior is integration-level wire-protocol relay, not pure-function logic where RED-then-GREEN gives meaningful signal. The implementation (Tasks 1-3, commits `f14a090`, `20e08f3`, `a4870ae`) commits before the tests (Task 4, commit `9b8e850`) because the tests must compile against the production type signatures (`SessionHost.setChatLog`, `getPresenceSnapshot`, `handleLocalChatMessage`, `upsertHostPresence`, `broadcastChatCleared`, `broadcastChatTruncated`). This matches the Plans 04-01, 04-02, 04-03, 04-05 precedent. All implementation code is fully covered by the 11 tests added in Task 4, run green on first invocation. Documented for transparency; no remediation needed.

## STRIDE Threat Mitigation Verification

| Threat ID | Mitigation | Evidence |
|-----------|-----------|----------|
| T-04-04-01 (Spoofing — claim foreign memberId in chat-message) | Server-trust override before persist + broadcast | Test "chat-message: host overrides client-claimed memberId with ws-authed memberId" — claims 'bob-attacker', asserts record.memberId === alice's authenticated id |
| T-04-04-02 (Spoofing — claim foreign memberId in presence-update) | Same override | Test "presence-update: host overrides memberId and broadcasts (excludes sender)" — claims 'attacker-id', asserts both broadcast payload AND host snapshot use ws-authed id |
| T-04-04-03 (Tampering — client timestamp manipulates chat ordering) | createTimestamp() stamp before broadcast | Test "chat-message: host stamps server timestamp" — client sends timestamp=1, asserts record.timestamp >= test start time |
| T-04-04-04 (EoP — non-host sends chat-cleared / chat-truncated) | Host onmessage switch has NO inbound branch — messages silently drop | Test "chat-cleared and chat-truncated have NO inbound handler — silently ignored (T-04-04-04)" — alice spoofs both types, asserts bob receives 0 cleared/truncated AND host did not crash |
| T-04-04-05 (Info disclosure — chat-history exposes prior chat to authed members) | Accept (feature, not leak) | Replay window is the COLLAB-02 spec; membership is gated by AuthHandler |
| T-04-04-06 (DoS — chat-message flood) | Accept (same v1 posture as push-notification — none) | RESEARCH §"Edge case 9" 64KB body cap is the only protection; full DoS is deferred |

All `mitigate` dispositions are now backed by code AND a passing test. All `accept` dispositions are documented above with rationale.

## Self-Check

- [x] `src/host/SessionHost.ts` exists (FOUND)
- [x] `src/test/suite/host.test.ts` exists (FOUND)
- [x] Commit `f14a090` exists (FOUND — `git log --oneline | grep f14a090`)
- [x] Commit `20e08f3` exists (FOUND)
- [x] Commit `a4870ae` exists (FOUND)
- [x] Commit `9b8e850` exists (FOUND)
- [x] `npx tsc --noEmit` exits 0
- [x] `npm run build` exits 0
- [x] `npm test --grep "Phase 4 host relay"` reports 11 passing
- [x] `npm test --grep "SessionHost"` reports 5 passing (no regression)
- [x] Full `npm test` reports 198 passing / 0 failing (was 187 → +11, no regressions)
- [x] All 7 public methods present (`grep -c "  setChatLog(\|  upsertHostPresence(\|  getPresenceSnapshot(\|  broadcastChatCleared(\|  broadcastChatTruncated(\|  async sendChatHistoryToMember(\|  async handleLocalChatMessage("` returns 7)
- [x] 2 chat-message / presence-update handler branches (`grep -c "msg.type === 'chat-message'\|msg.type === 'presence-update'"` returns 2)
- [x] `this.presenceMap.removeMember` present in removeMember body
- [x] chat-history sent AFTER state-sync (visual code review at SessionHost.ts:483-500 confirms ordering)

## Self-Check: PASSED

## Next Phase Readiness

- **Plan 04-07 (activity tree):** can subscribe to client `chat-received` events with `kind === 'system'` to populate the activity TreeView; the host-side append already serializes system events into chat-log.json before broadcast (single source of truth).
- **Plan 04-08 (presence panel):** can call `host.getPresenceSnapshot()` for the initial render and rely on the `presence-update` broadcast (excluding sender) to maintain the live cache. Host-side T-04-03-01 (server-trust on memberId) is now enforced in the wire handler — PresenceMap stores only sanitized data.
- **Plan 04-09 (soft notifications):** can hook `client.on('push-received')` and use the existing chat-message broadcast cycle to log overlapping pushes as system events; the host's chat-message handler will persist the system event identically to a user message.
- **Plan 04-10 (chat panel):** can call `host.handleLocalChatMessage({ recordId, kind, body })` from the panel's send-message postMessage handler. The contract is single-source-of-truth fan-out: host's own messages persist + broadcast through the same chatLog.append + broadcast path as remote-client messages.
- **Plan 04-11 (manage-chat QuickPick):** can call `host.broadcastChatCleared(hostMemberId, hostDisplayName)` after running `chatLog.clearAll()` locally, and `host.broadcastChatTruncated(mode, hostMemberId, hostDisplayName)` after the two non-destructive truncation modes. The hard-contract import is satisfied — both methods exist on SessionHost's public surface.
- **Plan 04-09 / extension.ts wiring:** must call `host.setChatLog(chatLog, branchName)` (two-arg signature) on session start and on every branch switch. Note the deviation from the plan's nominal single-arg shape — see Decisions section.

---
*Phase: 04-presence-chat-file-level-conflict-notifications*
*Completed: 2026-05-08*
