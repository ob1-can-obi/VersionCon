---
phase: 04-presence-chat-file-level-conflict-notifications
plan: 05
subsystem: networking
tags: [client, event-routing, chat, presence, websocket, typescript]

# Dependency graph
requires:
  - phase: 04-presence-chat-file-level-conflict-notifications
    plan: 01
    provides: 5 ProtocolMessage interfaces (ChatMessage, ChatCleared, ChatTruncated, ChatHistory, PresenceUpdate), 5 SessionEventMap keys (chat-received, chat-cleared, chat-truncated, chat-history, presence-update), VALID_TYPES gate accepting the new strings
  - phase: 01-foundation
    provides: SessionClient.handleMessage switch chain, SessionEventEmitter, parseMessage routing
provides:
  - SessionClient routes 5 new wire-protocol message types to typed events on the existing event emitter
  - Wire-shape → event-shape adaptation for the two field renames (recordId → id on chat-message, timestamp → lastUpdated on presence-update)
  - Typed test harness reusable pattern (private handleMessage invocation via typed bracket cast — no live WebSocket required for routing assertions)
affects:
  - 04-07-activity-tree (consumes chat-received system events for ring-buffer entries)
  - 04-08-presence-panel (consumes presence-update for the presence tree)
  - 04-09-soft-notifications (consumes chat-received for unread badge + chat-cleared for panel state)
  - 04-10-chat-panel (consumes chat-received, chat-cleared, chat-truncated, chat-history for panel state-update)
  - 04-11-extension-wiring (registers all five client.on(…) handlers in extension.ts)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Wire→event rename happens at the routing boundary (recordId → id, timestamp → lastUpdated). Downstream code never sees wire-only field names."
    - "Conditional spread for optional fields ({ ...(msg.subKind !== undefined ? { subKind: msg.subKind } : {}) }) preserves the JSDoc invariant 'subKind only set when kind === system' from src/types/chat.ts."
    - "Test harness invokes private handleMessage via typed bracket cast — avoids real WebSocket plumbing for routing-only assertions, mirroring the lightweight approach used in protocol.test.ts."

key-files:
  created: []
  modified:
    - src/client/SessionClient.ts
    - src/test/suite/client.test.ts

key-decisions:
  - "Conditional-spread for optional subKind/meta fields preserves the wire→event invariant: if the wire omits subKind, the ChatRecord event also omits it (rather than carrying an undefined property). Matches the JSDoc in src/types/chat.ts: 'subKind only set when kind === system'."
  - "Test harness uses typed bracket cast to reach private handleMessage — no real WebSocket spin-up needed for routing-only assertions. Cleaner than mocking WebSocket because the test contract is purely 'wire shape in, event shape out'."
  - "All 5 new cases land in a single contiguous Phase 4 banner block before `default:` so future readers can see the full set in one window."

requirements-completed: [COLLAB-01, COLLAB-02, COLLAB-04]

# Metrics
duration: 3min
completed: 2026-05-08
---

# Phase 4 Plan 05: SessionClient Wire→Event Routing Summary

**SessionClient.handleMessage now routes the five Phase 4 wire-protocol message types (chat-message, chat-cleared, chat-truncated, chat-history, presence-update) to typed events on the existing SessionEventEmitter, with field renames (recordId → id, timestamp → lastUpdated) handled at the routing boundary. 8 new unit tests anchor the wire→event contract.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-05-08T02:10:37Z
- **Completed:** 2026-05-08T02:13:45Z
- **Tasks:** 2 of 2
- **Files modified:** 2 (0 created, 2 modified)

## Accomplishments

- `src/client/SessionClient.ts` extended with five new `case` branches in `handleMessage`'s switch, mirroring the existing `push-notification → emit('push-received', …)` pattern.
- Two field renames handled inline at the routing boundary:
  - `chat-message.recordId` → `ChatRecord.id`
  - `presence-update.timestamp` → `PresenceInfo.lastUpdated`
- Optional fields (`subKind`, `meta`) preserved via conditional spread so they only land on the event payload when present on the wire — matches the JSDoc invariant in `src/types/chat.ts`.
- `import type { ChatRecord, PresenceInfo } from '../types/chat.js'` added at the top of SessionClient.ts; existing imports unchanged.
- Existing message routing (auth, member-join/left/kicked, heartbeat, push-notification, push-reverted, branch-created, branch-locked, permission-changed, error) untouched.
- 8 new unit tests in `src/test/suite/client.test.ts` under a single `suite('Phase 4 client events', ...)` block. Tests construct a SessionClient, register typed listeners via `.on()`, then invoke the private `handleMessage` directly via a typed bracket cast. No live WebSocket plumbing needed.
- Test coverage:
  - chat-message → chat-received with full ChatRecord shape verification + recordId → id rename
  - chat-message with `kind: 'system'`, `subKind: 'push'`, and full `meta` (pushId/branch/files) preserved
  - chat-cleared → chat-cleared with hostMemberId/hostDisplayName preserved
  - chat-truncated for both modes (`keep-100-and-activity`, `activity-only`)
  - chat-history → chat-history with branch + records (mixed user + system) preserved
  - presence-update → presence-update with timestamp → lastUpdated rename
  - presence-update with `activeFilePath: null` forwarded as `null` (not coerced to undefined)
- Full test suite now at **187 passing / 0 failing / 66 pending placeholders** (8 new green over the 179 baseline).

## Task Commits

Each task was committed atomically:

1. **Task 1: Add five new switch cases in SessionClient.handleMessage routing to typed events** — `d4f8776` (feat)
2. **Task 2: Unit tests verify the 5 wire types translate to the 5 typed events** — `72c3193` (test)

**Plan metadata commit:** _(pending — added by final commit step)_

## Files Created/Modified

- `src/client/SessionClient.ts` _(modified)_ — Added `import type { ChatRecord, PresenceInfo } from '../types/chat.js'`. Inserted 5 new `case` branches under a `// --- Phase 4: Chat + Presence wire → typed events (Plan 04-05) ---` banner before `default:` in `handleMessage`. 58 lines added; no existing code modified.
- `src/test/suite/client.test.ts` _(modified)_ — Added imports (`SessionClient`, the 5 new ProtocolMessage interface types, `ChatRecord`, `PresenceInfo`). Appended a new top-level `suite('Phase 4 client events', ...)` block below the existing TDD-placeholder suites with 8 tests; existing scaffolds untouched. 260 lines added.

## Decisions Made

- **Conditional spread for optional fields** — `{ ...(msg.subKind !== undefined ? { subKind: msg.subKind } : {}) }` preserves the JSDoc invariant that `subKind` is only set when `kind === 'system'`. Same pattern for `meta`. Carrying an explicit `undefined` would leak the wire-shape into downstream consumers and break `assert.strictEqual(record.subKind, undefined)` semantics for missing-field tests.
- **Test harness via private-method bracket cast** — `(client as unknown as { handleMessage: HandleMessageFn }).handleMessage.call(client, msg, () => {})` reaches the private method without `any` and without spinning up a real WebSocket. Cleaner than the alternative (mocking ws + emitting `'message'` events) because the contract under test is purely "wire shape in, event shape out". Mirrors the lightweight approach in `protocol.test.ts` where `parseMessage` is exercised directly.
- **Phase banner comment** — `// --- Phase 4: Chat + Presence wire → typed events (Plan 04-05) ---` groups the 5 new cases so future readers see the full set in one window. Matches the precedent set in `protocol.ts` ("// --- Phase 4: Chat + Presence messages ---") and `events.ts` ("// Phase 4: Chat + Presence client events").

## Deviations from Plan

None — plan executed exactly as written. All 2 tasks landed in the spec'd files with the spec'd shapes. The plan's pseudo-skeleton for the test harness mentioned an open question about whether to use a real WebSocket pattern or call `handleMessage` directly; the latter was selected (cleaner, faster, no port allocation). All acceptance criteria greps pass. `npx tsc --noEmit`, `npm run build`, full `npm test` all green on first run.

## Issues Encountered

**Build vs. type-check vs. test-runner mismatch (resolved, not a deviation):** The repo's `npm run build` only bundles `src/extension.ts` via esbuild — it does NOT compile test files into `dist/test/`. The `npx tsc --noEmit` command type-checks but emits nothing. The vscode-test runner discovers `dist/test/**/*.test.js`. After Task 2's source change, `dist/test/suite/client.test.js` was stale (still showing only the original placeholder suites), so a first `npm test` run reported 179 passing without including the new Phase 4 suite. Running `npx tsc` (without `--noEmit`) compiled the new tests into `dist/`; subsequent `npm test` then correctly reported 187 passing with the 8 new tests visible. Documented for the next executor — Plan 04-04 and downstream plans should run `npx tsc` (no flag) before `npm test` after touching test files. (No code change needed; this is just a build-script ordering quirk in the existing scaffold.)

## STRIDE Threat Disposition

All threats from the plan's `<threat_model>` are addressed:

| Threat ID | Disposition | Resolution |
|-----------|-------------|------------|
| T-04-05-01 | accept | recordId → id rename happens entirely inside the client process; no untrusted boundary crossed by the rename itself. Documented in inline comment on the `case 'chat-message'` branch. |
| T-04-05-02 | accept | chat-history replay window is policy decided in Plan 04-04 (host-side authentication gate); client only routes whatever the host sent. No client-side filtering needed. |
| T-04-05-03 | mitigate (deferred to Plan 04-04) | Client receives only host-stamped memberId. Inline banner comment cross-references T-04-01-01/04 and notes the host enforcement obligation. Client does not re-validate. |

## TDD Gate Compliance

This plan's tasks were marked `tdd="true"`. Strict TDD gate sequence (RED → GREEN → REFACTOR) was followed at the plan level rather than per-task:

- **Task 1 (GREEN):** `feat(04-05)` commit `d4f8776` adds the routing implementation. Type-checking is the test for the immediate type-correctness contract; the broader behavioral test follows in Task 2.
- **Task 2 (RED+GREEN merged):** `test(04-05)` commit `72c3193` adds the 8 behavior tests; all pass on first run because the implementation already exists. Strict TDD would have inverted these (write failing test first), but the plan's task ordering (Task 1: implementation → Task 2: tests) explicitly inverts that flow. Documented for transparency; matches the plan's explicit task sequence.

If a strict RED gate were required, all 8 tests would have failed against an empty `case` chain, then passed after Task 1. The current order ships the same final state with one fewer commit.

## Self-Check

- [x] `src/client/SessionClient.ts` modified (FOUND — 5 new cases verified by `grep -c "case 'chat-(message|cleared|truncated|history)'\|case 'presence-update':"` returns 5)
- [x] `src/test/suite/client.test.ts` modified (FOUND — `Phase 4 client events` suite present)
- [x] Commit `d4f8776` exists (FOUND in `git log --oneline`)
- [x] Commit `72c3193` exists (FOUND in `git log --oneline`)
- [x] `npx tsc --noEmit` passes (verified after both tasks)
- [x] `npm run build` passes
- [x] `npm test` reports 187 passing / 0 failing / 66 pending — 8 new tests in the Phase 4 client events suite all green
- [x] No regression: existing 179 tests still pass

## Self-Check: PASSED

## Next Phase Readiness

- Wave 2 Plan 04-04 (host chat/presence relay) can now broadcast `chat-message`, `chat-cleared`, `chat-truncated`, `chat-history`, `presence-update` over the wire and the connected clients will translate them into typed events without further protocol or client work.
- Wave 3 Plans 04-07/08/09/10/11 (UI surfaces) can register `client.on('chat-received', …)` etc. in `extension.ts` and consume the typed payloads directly. Wire-shape adaptation is fully encapsulated inside SessionClient.
- The `SessionEvent` union (`SessionEventMap` in `src/types/events.ts`) and the `ProtocolMessage` union (in `src/network/protocol.ts`) are now end-to-end consistent for Phase 4 — no further wire→event reconciliation is needed in downstream plans.

---
*Phase: 04-presence-chat-file-level-conflict-notifications*
*Completed: 2026-05-08*
