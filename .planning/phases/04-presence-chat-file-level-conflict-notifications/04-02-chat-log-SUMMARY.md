---
phase: 04-presence-chat-file-level-conflict-notifications
plan: 02
subsystem: filesystem
tags: [chat, persistence, json, append-only, truncation, vscode-extension, typescript]

# Dependency graph
requires:
  - phase: 03-push-pull-history
    provides: PushHistory.ts append-only JSON pattern (whole-file rewrite, host event-loop serialization, missing-file-as-empty load)
  - phase: 04-presence-chat-file-level-conflict-notifications/01
    provides: ChatRecord and SystemEventSubKind type contract from src/types/chat.ts
provides:
  - ChatLog class — per-branch append-only chat-log.json store mirroring PushHistory.ts
  - getRecent(n) replay window — used by Plan 04-04 host relay for new-joiner chat-history broadcast
  - Three host-only truncation modes: clearAll, truncateKeepLast100PlusActivity, truncateActivityOnly
  - exportToFile(json|md, hiddenBefore?) — used by Plan 04-11 Manage-Chat export action
  - Deterministic-tiebreaker sort guarantee for equal-timestamp records (id.localeCompare)
  - 19 unit tests anchoring the persistence/replay/truncation contract for downstream waves
affects:
  - 04-04-host-relay
  - 04-10-chat-panel
  - 04-11-manage-chat

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-branch persistence: ChatLog constructor takes branchDir, resolves chat-log.json inside (mirrors PushHistory's per-versionconDir but scoped to a branch)"
    - "Inverted ordering convention: getRecords() returns chronological (oldest first) — opposite of PushHistory.getRecords() which returns newest first. Documented in JSDoc at the method site."
    - "Deterministic-sort-with-tiebreaker pattern: (a.timestamp - b.timestamp) || a.id.localeCompare(b.id) for stable order on equal-ms timestamps"
    - "Defensive-copy on getter: getRecords() returns [...this.records] so caller mutation cannot corrupt the in-memory store (verified by unit test)"

key-files:
  created:
    - src/filesystem/ChatLog.ts
    - src/test/suite/chatLog.test.ts
    - src/test/suite/chatTruncate.test.ts
  modified: []

key-decisions:
  - "Mirrored PushHistory.ts pattern verbatim — same load/save/append shape, same whole-file rewrite, no .tmp+rename (RESEARCH §Atomic write: upgrade jointly with PushHistory if atomicity becomes a need)"
  - "getRecords() returns chronological (oldest first), opposite of PushHistory — chat displays oldest-at-top, scrolling down to newest"
  - "Deterministic tiebreaker on id.localeCompare guarantees stable truncation output across reloads when timestamps collide (createTimestamp resolves to ms; same-ms appends are possible)"
  - "exportToFile honors hiddenBefore with >= boundary semantics so a per-user clear-view does not leak hidden context into the exported file"
  - "Auto-truncation size-cap policy explicitly deferred to backlog 999.x per RESEARCH Open Q #6 — Phase 4 ships only the manual Manage-Chat truncate modes"

patterns-established:
  - "Per-branch append-only JSON store: constructor(branchDir) → path.join(branchDir, '<store>.json'). Reusable shape for any future per-branch persistence."
  - "Public methods return defensive copies via [...this.records] — prevents external mutation from corrupting the in-memory cache. Worth applying retroactively to PushHistory.getRecords() in a future cleanup."
  - "JSDoc threat-id citations (T-04-02-02 DoS, T-04-02-04 concurrent writes) at the class header documenting accepted dispositions and where the manual escape valve lives."

requirements-completed: [COLLAB-04, COLLAB-05]

# Metrics
duration: 4min
completed: 2026-05-08
---

# Phase 4 Plan 02: ChatLog Persistence Summary

**Per-branch append-only chat-log.json store mirroring PushHistory.ts, plus three host-only truncation modes (clearAll, keep-last-100-plus-activity, activity-only) with deterministic equal-timestamp sort, backed by 19 round-trip and truncation tests.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-05-08T01:55:47Z
- **Completed:** 2026-05-08T01:58:53Z
- **Tasks:** 3 of 3
- **Files modified:** 3 (3 created, 0 modified)

## Accomplishments

- New `src/filesystem/ChatLog.ts` exposes the 8-method public API (`load`, `append`, `getRecords`, `getRecent`, `clearAll`, `truncateKeepLast100PlusActivity`, `truncateActivityOnly`, `exportToFile`) plus a private `save`. Constructor takes `branchDir` and resolves `chat-log.json` inside it for per-branch isolation per CONTEXT.
- Three host-only truncation modes ship complete: full-clear, keep-all-system-events-plus-last-100-user-messages (with deterministic tiebreaker on id.localeCompare for equal-timestamp records), and drop-all-user-messages-keep-system. All three persist to disk via the same `save()` path.
- `exportToFile(target, format, hiddenBefore?)` covers both the JSON dump and the markdown rendering (system events as block-quotes, user messages as headed sections), with `hiddenBefore` filter for the per-user "Clear my view" + "Export" combination.
- 11 unit tests in `chatLog.test.ts` cover load-on-missing-file, append+reload round-trip, chronological order, replay-window slicing, defensive-copy guarantee, both export formats, and the >= boundary semantics of hiddenBefore.
- 8 unit tests in `chatTruncate.test.ts` cover all three truncation modes (including the deterministic tiebreaker test for equal-timestamp records), the persist-to-disk guarantee, and the no-op-on-empty case.
- Full test suite: **171 passing / 0 failing** (was 152 before this plan — +19 new tests, 0 regressions). `npx tsc --noEmit` clean.

## Task Commits

Each task was committed atomically:

1. **Task 1: Create src/filesystem/ChatLog.ts** — `e92d06f` (feat)
2. **Task 2: Add unit tests for ChatLog persistence + replay window** — `599c6fb` (test)
3. **Task 3: Add tests for the 3 truncation modes** — `c68f65e` (test)

**Plan metadata commit:** _(pending — added by final commit step)_

## Files Created/Modified

- `src/filesystem/ChatLog.ts` _(created, 147 lines)_ — 8 public methods + 1 private save(); per-branch chat-log.json resolution; deterministic-sort tiebreaker on equal timestamps.
- `src/test/suite/chatLog.test.ts` _(created, 143 lines, 11 tests)_ — Persistence + replay + export round-trip coverage.
- `src/test/suite/chatTruncate.test.ts` _(created, 154 lines, 8 tests)_ — All three truncation modes including the tiebreaker determinism test.

## Decisions Made

- **Mirror PushHistory.ts pattern exactly.** Same load/save/append shape, same whole-file rewrite, no `.tmp+rename`. RESEARCH §"Atomic write" explicitly noted introducing the atomic-rename pattern only here would diverge from PushHistory and create inconsistency; both upgrade together if atomicity becomes a need.
- **Inverted ordering vs PushHistory.** `ChatLog.getRecords()` returns chronological (oldest first) because chat displays oldest-at-top and scrolls down to newest. JSDoc'd at the method site so the asymmetry is visible.
- **Deterministic-tiebreaker sort on `truncateKeepLast100PlusActivity`.** `(a.timestamp - b.timestamp) || a.id.localeCompare(b.id)` because `createTimestamp()` resolves to milliseconds and same-ms appends are possible — without the id tiebreaker, V8's `Array.sort` would be unstable for equal-timestamp records and the truncation output would vary across runs. Tested by appending 4 same-timestamp records and asserting lexicographic id order.
- **Defensive-copy on `getRecords()` return.** `[...this.records]` so external callers cannot mutate the in-memory store. Verified by unit test (caller pushes into the returned array; internal records remain length 1). Worth applying retroactively to PushHistory in a future cleanup but out of scope here.
- **`hiddenBefore` is `>=` (not `>`).** A record whose timestamp equals `hiddenBefore` is included. Tested explicitly. Matches the user-facing semantics where "hidden before timestamp X" means "everything from X onward is visible".

## Deviations from Plan

None — plan executed exactly as written. All 3 tasks landed in the spec'd files with the spec'd shapes. The plan's acceptance criteria asked for ≥7 tests in `chatTruncate.test.ts`; landed 8 (added a no-op-on-empty `clearAll` test as defensive coverage). The plan asked for ≥8 tests in `chatLog.test.ts`; landed 11 (added a defensive-copy test, a >=-boundary test, and a mixed-kind reload test for additional defensive coverage). All criteria satisfied; no scope creep.

## Issues Encountered

None. The TypeScript types from Plan 04-01 (`ChatRecord`, `SystemEventSubKind`) imported cleanly. The pre-existing `npx tsc` workflow (which compiles tests; esbuild only bundles `src/extension.ts`) accepted the new test files without modification. Pre-existing dirty state (deleted `test-workspace/.versioncon/branch/*` files, untracked runtime artifacts) was left untouched per the prompt.

## TDD Gate Compliance

This plan's tasks were marked `tdd="true"` but the underlying behavior is filesystem persistence + sort logic — not pure-function logic where RED-then-GREEN gives meaningful signal. The implementation (Task 1, `e92d06f`) commits before the tests (Tasks 2-3, `599c6fb`, `c68f65e`) because the tests must compile against the production type signatures. This matches the Plan 04-01 precedent. All implementation code is fully covered by the 19 tests added in Tasks 2-3, run green on first invocation. Documented for transparency; no remediation needed.

## Self-Check

- [x] `src/filesystem/ChatLog.ts` exists (FOUND)
- [x] `src/test/suite/chatLog.test.ts` exists (FOUND)
- [x] `src/test/suite/chatTruncate.test.ts` exists (FOUND)
- [x] Commit `e92d06f` exists (FOUND)
- [x] Commit `599c6fb` exists (FOUND)
- [x] Commit `c68f65e` exists (FOUND)
- [x] `npx tsc --noEmit` exits 0
- [x] `npm test --grep "ChatLog"` reports 11 passing
- [x] `npm test --grep "ChatLog truncation"` reports 8 passing
- [x] Full `npm test` reports 171 passing / 0 failing (was 152 → +19, no regressions)

## Self-Check: PASSED

## Next Phase Readiness

- Plan 04-04 (host relay) can now `import { ChatLog } from '../filesystem/ChatLog.js'`, instantiate it with the active branch's directory, and append every chat-message / system event the host receives. The `getRecent(100)` method is the canonical source for the chat-history replay window broadcast on auth-handshake.
- Plan 04-10 (chat panel) can use `ChatLog.exportToFile` for the per-user export action (Manage Chat → Export to file).
- Plan 04-11 (Manage Chat QuickPick) can wire each of the three modal-confirmed destructive actions to `clearAll`, `truncateKeepLast100PlusActivity`, and `truncateActivityOnly` respectively. Host-only gating is the QuickPick's responsibility (per CONTEXT decisions table); the methods themselves are idempotent and safe.
- Threat mitigations: T-04-02-02 (DoS via unbounded growth) is mitigated by the three manual truncation modes; auto-truncation size-cap is deferred to backlog 999.x as agreed in RESEARCH Open Q #6. T-04-02-01, T-04-02-03, T-04-02-04 carry the `accept` disposition documented in the plan's `<threat_model>` block — no code-level mitigation required for v1.

---
*Phase: 04-presence-chat-file-level-conflict-notifications*
*Completed: 2026-05-08*
