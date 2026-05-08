---
phase: 04-presence-chat-file-level-conflict-notifications
plan: 01
subsystem: networking
tags: [protocol, typescript, types, chat, presence, websocket]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: BaseMessage envelope, ProtocolMessage union, parseMessage / sendMessage helpers, VALID_TYPES gate
  - phase: 03-push-pull-history
    provides: PushFileEntry shape and tracked-paths-update precedent for server-trusted memberId
provides:
  - ChatRecord, PresenceInfo, ChatRecordKind, SystemEventSubKind type module (src/types/chat.ts)
  - 5 new ProtocolMessage interfaces (ChatMessage, ChatCleared, ChatTruncated, ChatHistory, PresenceUpdate)
  - Extended VALID_TYPES gate accepting the 5 new message strings
  - Client event map keys for chat-received / chat-cleared / chat-truncated / chat-history / presence-update
  - 11 round-trip parse/serialize tests anchoring the wire contract for downstream waves
affects:
  - 04-02-chat-log
  - 04-03-presence-map
  - 04-04-host-relay
  - 04-05-client-routing
  - 04-06-file-overlap
  - 04-07-status-bar
  - 04-08-presence-tree
  - 04-09-activity-tree
  - 04-10-chat-panel
  - 04-11-extension-wiring

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Type-only contract module pattern (src/types/chat.ts is pure types, no runtime imports — mirrors src/types/push.ts and src/types/branch.ts)"
    - "Server-trust contract documented in JSDoc; enforcement deferred to host relay plan (mirrors tracked-paths-update T-03-14 precedent)"

key-files:
  created:
    - src/types/chat.ts
  modified:
    - src/network/protocol.ts
    - src/types/events.ts
    - src/test/suite/protocol.test.ts

key-decisions:
  - "Phase 4 wire types added contract-first in Wave 1 so Waves 2-4 share one canonical shape"
  - "ChatRecord.meta.affectsLocal is computed client-side only — JSDoc documents non-persistence (T-04-01-03 accept disposition)"
  - "PresenceInfo.activeFilePath uses 'string | null' rather than 'string | undefined' so the value travels through JSON cleanly"
  - "VALID_TYPES gate test (rejects 'chat-bogus') verifies T-04-01-02 mitigation at the parser layer"

patterns-established:
  - "Phase-banner comment in protocol.ts ('// --- Phase 4: Chat + Presence messages ---') groups the new interfaces and threads phase ownership through the file"
  - "Threat-id JSDoc cross-references (T-04-01-01, T-04-01-04) on memberId and timestamp fields make the host-override obligation visible at the type definition site"

requirements-completed: [COLLAB-02, COLLAB-04]

# Metrics
duration: 6min
completed: 2026-05-08
---

# Phase 4 Plan 01: Wire Protocol + Chat/Presence Types Summary

**5 new ProtocolMessage types (chat-message, chat-cleared, chat-truncated, chat-history, presence-update), ChatRecord + PresenceInfo type module, and 11 round-trip parser tests laying the Wave 1 contract foundation for Phase 4.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-05-08T01:38:00Z
- **Completed:** 2026-05-08T01:44:26Z
- **Tasks:** 4 of 4
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments

- New `src/types/chat.ts` exports `ChatRecord`, `PresenceInfo`, `ChatRecordKind`, `SystemEventSubKind` with full JSDoc covering server-trust contracts, host-arrival-time semantics, and the client-only `affectsLocal` field.
- `src/network/protocol.ts` extended with five new `BaseMessage`-extending interfaces, the `MessageType` union and `VALID_TYPES` set both grown by exactly five entries, and `parseMessage` / `sendMessage` left untouched (message-type-agnostic).
- `src/types/events.ts` declares five new client event keys (`chat-received`, `chat-cleared`, `chat-truncated`, `chat-history`, `presence-update`) with payload types referencing the new chat module — forward-compatible scaffold for Plan 04-05.
- 11 new round-trip tests in `src/test/suite/protocol.test.ts` (10 round-trips across the 5 message types covering optional meta, both truncation modes, empty + mixed history records, both null and set `activeFilePath`, plus 1 negative regression test for the `VALID_TYPES` gate). Full test suite now at 140 passing / 0 failing / 66 pending placeholders.

## Task Commits

Each task was committed atomically:

1. **Task 1: Create src/types/chat.ts** — `7a53106` (feat)
2. **Task 2: Extend src/network/protocol.ts with 5 new ProtocolMessage types + VALID_TYPES entries** — `1a131ef` (feat)
3. **Task 3: Extend src/types/events.ts with 5 new client event keys** — `7e88d8a` (feat)
4. **Task 4: Add round-trip parse/serialize tests** — `cdb2f10` (test)

**Plan metadata commit:** _(pending — added by final commit step)_

## Files Created/Modified

- `src/types/chat.ts` _(created)_ — 4 type exports: ChatRecord, PresenceInfo, ChatRecordKind, SystemEventSubKind. Pure type module; no runtime imports.
- `src/network/protocol.ts` _(modified)_ — Added `import type { ChatRecord, SystemEventSubKind } from '../types/chat.js'`; appended 5 entries to MessageType, 5 to ProtocolMessage union, 5 to VALID_TYPES; defined 5 new exported interfaces under a `// --- Phase 4: Chat + Presence messages ---` banner.
- `src/types/events.ts` _(modified)_ — Added `import type { ChatRecord, PresenceInfo } from './chat.js'`; appended 5 keys to SessionEventMap with JSDoc per RESEARCH Open Q #1.
- `src/test/suite/protocol.test.ts` _(modified)_ — Appended a new top-level `suite('Phase 4 protocol', ...)` block with 5 sub-suites + 1 regression test (11 tests total, all green).

## Decisions Made

- **Type-only `chat.ts` module** — followed `src/types/push.ts` precedent (pure type module, no runtime imports). Keeps the dependency graph one-way: `protocol.ts` and `events.ts` import from `chat.ts`, never the reverse.
- **ChatMessage.recordId vs ChatRecord.id** — kept the spec verbatim from RESEARCH (the wire envelope uses `recordId`, the persisted record uses `id`). Plan 04-04 will translate one to the other on the host before `chatLog.append(...)`.
- **`activeFilePath: string | null`** — explicitly null, not undefined, so the field round-trips cleanly through `JSON.stringify` (undefined is dropped). Tested both null and set values.
- **Threat-id JSDoc references** — added `T-04-01-01`, `T-04-01-02`, `T-04-01-04` references inline at the type definition sites so downstream implementers see the host-override obligation at the point of use.

## Deviations from Plan

None — plan executed exactly as written. All 4 tasks landed in the spec'd files with the spec'd shapes. Verification (`npx tsc --noEmit`, `npm run build`, `npm test --grep "Phase 4 protocol"`, full `npm test`) all green on first run.

## Issues Encountered

None. Existing `tsconfig.json` (Node16 module resolution, strict mode) and the existing protocol parsing pattern accepted the additions without modification. The pre-existing test scaffold in `protocol.test.ts` (Phase 1 placeholders without bodies) was left intact; the new Phase 4 suite is appended below it.

## TDD Gate Compliance

This plan's tasks were marked `tdd="true"` but the underlying behavior is pure type contracts — there are no behavior tests to fail-then-pass for type definitions (TypeScript compilation is the test). For Task 4 (the round-trip tests), the test commit (`cdb2f10`) follows the implementation commits (`7a53106`, `1a131ef`, `7e88d8a`) because the protocol union must already exist for tests to type-check against it. This matches the plan's instruction: "extend the wire protocol [...] then add round-trip parse/serialize tests for each new type so downstream waves can rely on the contracts." Documented for transparency; no remediation needed.

## Self-Check

- [x] `src/types/chat.ts` exists (FOUND)
- [x] Commit `7a53106` exists (FOUND)
- [x] Commit `1a131ef` exists (FOUND)
- [x] Commit `7e88d8a` exists (FOUND)
- [x] Commit `cdb2f10` exists (FOUND)
- [x] `npx tsc --noEmit` passes (verified after each task)
- [x] `npm run build` passes (verified after Task 4)
- [x] `npm test --grep "Phase 4 protocol"` reports 11 passing
- [x] Full `npm test` reports 140 passing / 0 failing

## Self-Check: PASSED

## Next Phase Readiness

- Wave 2 (Plans 04-02 ChatLog, 04-03 PresenceMap, 04-04 host relay, 04-05 client routing) can now import `ChatRecord` and `PresenceInfo` directly and dispatch the 5 new message types through the existing `parseMessage` pipeline without further protocol changes.
- Threat mitigations T-04-01-01 (memberId override) and T-04-01-04 (timestamp override) are documented in JSDoc at the type definition sites; Plan 04-04 must implement the runtime override in `SessionHost.handleConnection`. T-04-01-02 (VALID_TYPES gate) is already enforced and tested. T-04-01-03 (`affectsLocal` non-persistence) is documented in JSDoc; Plan 04-02 (`ChatLog.append`) must strip `meta.affectsLocal` before persisting.

---
*Phase: 04-presence-chat-file-level-conflict-notifications*
*Completed: 2026-05-08*
