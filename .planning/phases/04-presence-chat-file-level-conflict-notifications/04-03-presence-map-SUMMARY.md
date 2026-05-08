---
phase: 04-presence-chat-file-level-conflict-notifications
plan: 03
subsystem: filesystem
tags: [presence, in-memory, accumulator, typescript, unit-tests]

# Dependency graph
requires:
  - phase: 04-presence-chat-file-level-conflict-notifications
    plan: 01
    provides: PresenceInfo type from src/types/chat.ts (Wave 1 contract)
provides:
  - PresenceMap class — in-memory wrapper around Map<memberId, PresenceInfo> (src/filesystem/PresenceMap.ts)
  - 5 mutation/query methods: upsert / removeMember / getSnapshot / clear / has
  - Defensive-copy invariant on getSnapshot()
  - 8 unit tests anchoring the mutation contract for downstream waves
affects:
  - 04-04-host-relay   (SessionHost may use PresenceMap or keep its inline Map; consumes PresenceInfo)
  - 04-08-presence-panel (PresenceTreeProvider wraps PresenceMap with refresh() side effects)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "In-memory accumulator class — no persistence (mirrors src/filesystem/SyncTracker.ts)"
    - "Defensive-copy snapshot pattern (Array.from(map.values())) so external mutation cannot corrupt internal state"
    - "Policy-agnostic data store — caller (SessionHost) is responsible for memberId/path sanitization; documented in JSDoc cross-referencing STRIDE threats"

key-files:
  created:
    - src/filesystem/PresenceMap.ts
    - src/test/suite/presenceMap.test.ts
  modified: []

key-decisions:
  - "PresenceMap is a class (not a bare Map) so Plan 04-08 (TreeProvider) has something to wrap with refresh() side effects and Plan 04-04 (host) can choose to use it or keep an inline Map"
  - "getSnapshot() returns Array.from(values()) defensive copy — consistent with SyncTracker.getOutOfSyncPaths() and ChatLog.getRecords() patterns established earlier in Phase 4"
  - "PresenceMap is policy-agnostic — sanitization of memberId (T-04-03-01) and activeFilePath (T-04-03-03) is the caller's responsibility (Plan 04-04 and Plan 04-06 respectively); documented in upsert() JSDoc"

patterns-established:
  - "Plan 04-03 confirms the Phase 4 'caller validates, store stores' pattern: SessionHost (Plan 04-04) overrides memberId from ws context BEFORE calling map.upsert(); PresenceMap trusts the input shape"

requirements-completed: [COLLAB-01]

# Metrics
duration: 2min
completed: 2026-05-08
---

# Phase 4 Plan 03: PresenceMap Summary

**In-memory accumulator class wrapping Map<memberId, PresenceInfo> with 5 methods (upsert / removeMember / getSnapshot / clear / has) and 8 unit tests — Wave 2 contract for both host (Plan 04-04) and client TreeProvider (Plan 04-08).**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-05-08T02:03:16Z
- **Completed:** 2026-05-08T02:05:51Z
- **Tasks:** 2 of 2
- **Files modified:** 2 (both created, 0 modified)

## Accomplishments

- New `src/filesystem/PresenceMap.ts` — class with private `entries = new Map<string, PresenceInfo>()` field and 5 methods. Imports `PresenceInfo` from `src/types/chat.ts` (Plan 04-01 contract). Zero filesystem operations — pure in-memory, mirroring `SyncTracker`.
- New `src/test/suite/presenceMap.test.ts` — 8 unit tests covering all 5 methods plus the defensive-copy invariant and insertion-order guarantee. Tests use a `setup()` factory to construct a fresh map per test and a tiny `info(memberId, file)` helper that emits a complete `PresenceInfo` literal so each assertion is self-contained.
- Full test suite now at **179 passing / 66 pending** (was 171; +8 new). All other suites unaffected.
- JSDoc on PresenceMap.ts cross-references the plan's STRIDE register (T-04-03-01, T-04-03-02, T-04-03-03) so a downstream implementer of Plan 04-04 sees the host-override obligation at the point of use without re-reading the threat model.

## Task Commits

Each task was committed atomically:

1. **Task 1: Create src/filesystem/PresenceMap.ts** — `9b4f9a0` (feat)
2. **Task 2: Add unit tests for PresenceMap** — `11447fb` (test)

**Plan metadata commit:** _(pending — added by final commit step)_

## Files Created/Modified

- `src/filesystem/PresenceMap.ts` _(created, 70 lines)_ — `export class PresenceMap` with `upsert(info)`, `removeMember(memberId)`, `getSnapshot()`, `clear()`, `has(memberId)`. All methods are 1-line bodies wrapping `Map.set` / `Map.delete` / `Array.from(...values())` / `Map.clear` / `Map.has`. JSDoc on the class describes the dual host/client lifecycle and cross-references the three STRIDE threats; JSDoc on `upsert()` documents the precondition that callers must have already overwritten `info.memberId` from the ws-authenticated closure value and normalized `info.activeFilePath` to workspace-relative posix form.
- `src/test/suite/presenceMap.test.ts` _(created, 80 lines)_ — `suite('PresenceMap', ...)` with 8 tests: upsert insert, upsert replace, removeMember, removeMember no-op, getSnapshot defensive copy, clear, has round-trip, insertion-order iteration. Mirrors the structure of `syncTracker.test.ts` (per-test fresh instance via `setup()`, simple synchronous assertions, no fixtures).

## Decisions Made

- **Class instead of a bare Map** — Plan plan-of-record decision: a `class` gives Plan 04-08 (`PresenceTreeProvider`) something to wrap with `refresh()` side effects and gives Plan 04-04 (host) the option to consume the same shape. RESEARCH §"PresenceMap location" had originally said "a Map with two methods on the host is overkill for a class", but the planner's call to standardize the data structure once and let both consumers choose was correct — Plan 04-08's TreeProvider needs more than two methods (it needs `getSnapshot` for `getChildren()` and `has`/`removeMember` for diff updates), so the class earns its keep. Documented as a key-decision so the rationale survives RESEARCH archaeology.
- **`Array.from(this.entries.values())` for getSnapshot** — same pattern as `SyncTracker.getOutOfSyncPaths()` (`Array.from(this.outOfSyncPaths)`) and `ChatLog.getRecords()` (`[...this.records]`). Consistency with the rest of Phase 4's data layer; tested explicitly with a "mutating it does not affect the map" test.
- **JSDoc cross-references to STRIDE threat IDs** — placed inline on the class header and on `upsert()`. Mirrors the same pattern Plan 04-01 used for `T-04-01-01..04` references on `ChatRecord.memberId` / `timestamp`. Makes the host-override obligation visible at the type/method site so Plan 04-04 implementers can't miss it.
- **No `getSize()` or `entries()` accessor** — the plan spec was 5 methods exactly; resisting scope creep keeps the surface area small. Plan 04-08 can use `getSnapshot().length` if a count is needed.

## Deviations from Plan

None — plan executed exactly as written. Both tasks landed in the spec'd files with the spec'd shapes. All acceptance criteria for Task 1 (`grep export class`, `grep -c <5 method signatures>`, `grep import path`, `grep -c fs imports`, `npx tsc --noEmit`) and Task 2 (`grep -c "test('"` returns 8, `grep "defensive copy"`, `grep "removeMember"`, `npm test --grep "PresenceMap"` passes 8) verified green on first run.

## Issues Encountered

- **Test compilation step.** First `npm test --grep "PresenceMap"` after writing the test file reported `0 passing` because `npm run build` only invokes `esbuild` on `src/extension.ts` (per `esbuild.config.mjs`); test files are compiled separately by `tsc` (the `lint` script's `tsc --noEmit` doesn't emit). Resolved by running `npx tsc` to populate `dist/test/suite/presenceMap.test.js`. Pre-existing build pipeline behavior, not a Phase 4 regression — documented here so future Phase 4 plans know to run `tsc` (not just `npm run build`) before invoking the test suite. Falls under deviation Rule 3 territory (blocking issue) but the fix was a one-shot command, not a code change, so no commit was needed.

## TDD Gate Compliance

This plan's tasks were marked `tdd="true"`. Per the plan's task ordering (Task 1 = production code, Task 2 = tests), the test commit (`11447fb`) follows the implementation commit (`9b4f9a0`) — same pattern as Plan 04-01 (Task 4 tests after the protocol/types implementations). The strict RED → GREEN cycle is non-applicable here because:
1. The PresenceMap class body is single-line method delegations to `Map`, with no real algorithm to fail-test against,
2. The plan explicitly orders Task 1 first and the must-haves require the file to exist before tests can import it.

This matches the prior precedent set in 04-01's TDD Gate Compliance section. Documented for transparency; no remediation needed.

## Threat Flags

None — no new threat surface beyond what's already in the plan's `<threat_model>`. PresenceMap introduces no network endpoints, no auth paths, no file access, and no schema changes; it's a pure in-memory data structure consumed by SessionHost (Plan 04-04, where the actual trust-boundary mitigations land).

## Self-Check

- [x] `src/filesystem/PresenceMap.ts` exists (FOUND)
- [x] `src/test/suite/presenceMap.test.ts` exists (FOUND)
- [x] Commit `9b4f9a0` exists (FOUND)
- [x] Commit `11447fb` exists (FOUND)
- [x] `npx tsc --noEmit` passes
- [x] `npm test --grep "PresenceMap"` reports 8 passing
- [x] Full `npm test` reports 179 passing / 66 pending (was 171 — net +8 new tests; all other suites unchanged)
- [x] No `fs.` / `fs/promises` / `writeFile` / `readFile` references in PresenceMap.ts (`grep` returns 0)

## Self-Check: PASSED

## Next Phase Readiness

- Plan 04-04 (`SessionHost` chat/presence relay) can now `import { PresenceMap } from '../filesystem/PresenceMap.js'` and `new PresenceMap()` as a private host field, OR keep an inline `Map<string, PresenceInfo>` per its own preference — both options are open. The plan must still implement the T-04-03-01 mitigation (overwrite `msg.memberId` from the ws-authenticated closure variable BEFORE calling `presenceMap.upsert(info)`) — PresenceMap itself is policy-agnostic by design.
- Plan 04-08 (`PresenceTreeProvider`) can wrap a single `PresenceMap` instance with `_onDidChangeTreeData` plumbing; `getChildren()` calls `presenceMap.getSnapshot()` and the defensive-copy invariant guarantees TreeView mutations cannot corrupt the underlying state.

---
*Phase: 04-presence-chat-file-level-conflict-notifications*
*Completed: 2026-05-08*
