---
phase: quick-260530-p3g
plan: 01
subsystem: presence
tags: [bug-fix, presence, session-host, session-client, protocol, tdd]
dependency_graph:
  requires: [260530-np7]
  provides: [PRESENCE-FIX-1, PRESENCE-FIX-2]
  affects: [SessionHost, SessionClient, protocol.ts, host.test.ts]
tech_stack:
  added: []
  patterns:
    - clientId dedupe via two O(1) Maps (clientIdToMemberId + reverse)
    - ws-identity guard on onClose to neutralize superseded sockets
    - deterministic host-presence seed before this.members.set (broadcast no-op invariant)
key_files:
  created: []
  modified:
    - src/network/protocol.ts
    - src/client/SessionClient.ts
    - src/host/SessionHost.ts
    - src/test/suite/host.test.ts
decisions:
  - Role-check BEFORE dedupe: role must be determined first so the host-loopback (role=host) always bypasses dedupe
  - Seed BEFORE this.members.set: on first host auth members is empty, so upsertHostPresence broadcast is a proven no-op
  - Two-map O(1) approach: clientIdToMemberId + memberIdToClientId reverse map for O(1) cleanup in removeMember
  - ws-identity guard: only removeMember if cm.ws === the closing ws, neutralizing late close from superseded sockets
metrics:
  duration: ~25 min
  completed: "2026-05-30T23:25:00Z"
  tasks: 3
  files_modified: 4
---

# Quick Task 260530-p3g: Fix All Presence Bugs + Seed Host Presence — Summary

**One-liner:** Deterministic host-presence seed in handleAuthRequest (activeFilePath null, before members.set) + clientId-based member dedupe with ws rebind/cleanup closing Bug 1 (host missing from Presence panel) and Bug 2 (duplicate member entries on reconnect/cloud-swap).

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Protocol clientId field + client-side stable clientId (Bug 2 wire) | bc1b035 |
| 2 | Host clientId dedupe + connection rebind/cleanup (Bug 2 host half) | e244dd3 |
| 3 | Deterministic host self-presence seed on host self-auth (Bug 1) | f912d28 |

## What Was Built

### Task 1 — Protocol + Client Wire Contract

`src/network/protocol.ts`: Added `clientId?: string` to `AuthRequest` with full JSDoc explaining the per-join stable identity, conditional-spread byte-shape preservation, and legacy fall-through semantics. `VALID_TYPES` unchanged (gates on `type`, not field presence).

`src/client/SessionClient.ts`: Added `import * as crypto from 'node:crypto'`. Added `private readonly clientId: string = crypto.randomUUID()` generated once at construction. In `onOpen` handler, spread clientId via `...(this.clientId ? { clientId: this.clientId } : {})` so the key is present on every reconnect with the same stable value.

### Task 2 — Host clientId Dedupe

`src/host/SessionHost.ts`:

1. Two private instance maps:
   - `clientIdToMemberId = new Map<string, string>()` — forward lookup
   - `memberIdToClientId = new Map<string, string>()` — reverse for O(1) cleanup

2. `handleAuthRequest` restructured (CRITICAL ORDERING preserved):
   - Role-check block runs FIRST (before dedupe) so `role` is known
   - Dedupe gated on `role !== 'host'` AND non-empty `incomingClientId`
   - **REBIND path**: reuses memberId, rebinds `this.members.set` to new ws BEFORE closing old ws, closes old ws via `closeConnection(prior.ws, 1000, 'superseded-by-reconnect')`, sends full auth-response + state-sync + chat-history + review-state-sync + presence-snapshot, skips member-joined broadcast, `return`s
   - **STALE path**: cleans both maps, falls through to new-member path
   - **NEW-MEMBER path**: unchanged behavior + records both maps after `this.members.set`

3. `onClose` handler: ws-identity guard — `if (cm && cm.ws === ws) this.removeMember(...)` so a superseded socket's late close is a no-op.

4. `removeMember`: O(1) reverse-map cleanup via `memberIdToClientId.get(memberId)` then delete from both maps.

### Task 3 — Deterministic Host Presence Seed

`src/host/SessionHost.ts`: Inside the secret-verified `timingSafeEqual` block, immediately after `this.hostMemberId = newMemberId` and BEFORE `this.members.set` (the new-member path), calls:

```typescript
this.upsertHostPresence({
  memberId: this.hostMemberId,
  displayName: this.hostDisplayName,
  branch: this.activeBranch ?? 'main',
  activeFilePath: null,
  lastUpdated: createTimestamp(),
});
```

This seeds the host in `presenceMap` deterministically on every host self-auth (including VS Code reloads). Because the seed runs before `this.members.set`, on the FIRST auth `this.members` is empty, so `upsertHostPresence`'s broadcast reaches zero members — the "broadcast is a no-op" invariant is proven by placement, not by timing. `extension.ts broadcastSelfPresenceOnJoin` remains the last-write-wins upsert path for the real `activeFilePath` once the editor fires.

## Tests Added

All tests written RED-first (failed before implementation), GREEN after:

| Test | Assertion |
|------|-----------|
| E | auth-request without clientId has no clientId key in JSON |
| F | SessionClient sends same clientId on two onOpen firings (stable across reconnects) |
| G | 3 auth-requests with same clientId → 1 member entry, memberId reused |
| H | Different clientId → 2 distinct member entries |
| I | No clientId → 2 distinct members (legacy back-compat preserved) |
| J | Superseded ws is closed by host; only 1 member-joined broadcast observed by peer |
| K | Host-loopback with stable clientId is NEVER deduped (role-check + seed always runs) |
| L | Host in getPresenceSnapshot() immediately after self-auth, activeFilePath null |
| M | Joiner connecting after host self-auth receives presence-update for host id (null activeFilePath) |

**Test results (new suites):**
- "Bug 2 wire contract" — 2 passing
- "Bug 2 host-half" — 5 passing
- "Bug 1 host self-presence seed" — 2 passing
- "Presence snapshot on join" (pre-existing) — 4 passing (no regression)
- "Phase 4 host relay" (pre-existing) — 11 passing (no regression)
- "Phase 4 host input validation" (pre-existing) — 10 passing (no regression)

**Combined new + affected suites: 34 passing, 0 failing.**

Lint (`npm run lint` = `tsc --noEmit`): clean.
Build (`npm run build`): clean.

Full suite note: ~217 pre-existing failures in the full vscode-test run are CWD-relative `readFileSync('src/...')` ENOENTs in tests that read source under vscode-test's working directory — these are pre-existing infrastructure noise unrelated to this task.

## Deviations from Plan

None — plan executed exactly as written. The CRITICAL ORDERING (role-check before dedupe, seed before members.set) was implemented as specified.

## Known Stubs

None. All presence data flows from real auth/reconnect events to the presenceMap and on to joiners via sendPresenceSnapshotToMember. No hardcoded empty values in the presence rendering path.

## Self-Check: PASSED

Files created/modified confirmed present:
- src/network/protocol.ts — modified (clientId field added)
- src/client/SessionClient.ts — modified (clientId field + crypto import + spread in onOpen)
- src/host/SessionHost.ts — modified (two maps + dedupe block + ws-identity guard + removeMember cleanup + seed)
- src/test/suite/host.test.ts — modified (9 new tests E-M across 3 suites)

Commits confirmed: bc1b035, e244dd3, f912d28 (all in `git log --oneline -5`).
