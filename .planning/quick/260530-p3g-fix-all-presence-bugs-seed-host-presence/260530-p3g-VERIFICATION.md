---
phase: quick-260530-p3g
verified: 2026-05-30T23:45:00Z
status: passed
score: 9/9 must-haves verified
gaps: []
---

# Quick Task 260530-p3g: Fix All Presence Bugs — Verification Report

**Task Goal:** Fix all Presence bugs — Bug 1 (seed host presence deterministically on host self-auth) and Bug 2 (optional clientId on auth-request + clientId-based member dedupe with ws rebind/cleanup).
**Verified:** 2026-05-30T23:45:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Immediately after host self-auth with NO file open, host id appears in getPresenceSnapshot() | VERIFIED | `upsertHostPresence` called at SessionHost.ts:988 inside the secret-verified block, after `this.hostMemberId = newMemberId` (line 967) and before `this.members.set` (line 1107). Test L asserts this directly. |
| 2 | A joiner connecting after host self-auth receives a presence-update frame for the host id (activeFilePath null when idle) | VERIFIED | `sendPresenceSnapshotToMember` iterates `getPresenceSnapshot()` and sends each entry as a `presence-update` to the joiner. Test M asserts this end-to-end. |
| 3 | Three auth-requests with the SAME clientId produce exactly ONE member entry that reuses the original memberId | VERIFIED | Dedupe REBIND path at SessionHost.ts:1012–1083: `clientIdToMemberId.get(incomingClientId)` returns existing memberId; `this.members.set(reuseId, ...)` rebinds ws; returns early. Test G asserts `members.length === 1` and all three responses share memberId M1. |
| 4 | Two auth-requests with DIFFERENT clientIds produce two distinct member entries | VERIFIED | Only the SAME clientId triggers rebind; distinct clientIds each enter the new-member path. Test H asserts two distinct memberIds and `getMembers().length === 2`. |
| 5 | An auth-request with NO clientId still registers a member (legacy back-compat) | VERIFIED | Dedupe block gated on `typeof incomingClientId === 'string' && incomingClientId.length > 0` (SessionHost.ts:1008–1009). Undefined `clientId` skips dedupe entirely. Test I sends two no-clientId auths and asserts two distinct members. |
| 6 | When a clientId is replaced, the superseded prior connection is closed and only one member-joined was ever broadcast | VERIFIED | Rebind path: `this.members.set(reuseId, { ws, ... })` BEFORE `transport.closeConnection(prior.ws, 1000, 'superseded-by-reconnect')` (line 1029). ws-identity guard in onClose prevents removeMember on the old ws. Test J asserts ws1 closes and only 1 member-joined observed by a peer. |
| 7 | A host-loopback reconnect with stable clientId still re-runs host-role assignment and host-presence seed — dedupe never short-circuits the host path | VERIFIED | Dedupe block gated on `role !== 'host'` (SessionHost.ts:1007). Role is determined FIRST (lines 950–995), BEFORE the dedupe block (lines 998–1093). Test K sends two host-role auths with same clientId and asserts host role is assigned and snapshot contains host both times. |
| 8 | A LAN auth-request frame with clientId absent is byte-identical to today (no clientId key serialized) | VERIFIED | `clientId?: string` is optional on `AuthRequest` (protocol.ts:92). SessionClient uses conditional spread `...(this.clientId ? { clientId: this.clientId } : {})` (SessionClient.ts:234). Test E builds a frame without clientId and asserts `JSON.parse` result has no `clientId` key. |
| 9 | No periodic presence heartbeat is introduced; presence remains event-driven | VERIFIED | The only `setInterval` in SessionHost.ts is the pre-existing WebSocket ping/pong liveness check (`startHeartbeat` at line 2549). No new timer for presence. `upsertHostPresence` fires exactly once per host self-auth event, not on a schedule. |

**Score:** 9/9 truths verified

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/network/protocol.ts` | Optional clientId field on AuthRequest | VERIFIED | `clientId?: string` present at line 92 with full JSDoc. VALID_TYPES unchanged (gates on `type`, not field presence). |
| `src/client/SessionClient.ts` | Stable per-instance clientId, conditional-spread in onOpen | VERIFIED | `private readonly clientId: string = crypto.randomUUID()` at line 102. Spread `...(this.clientId ? { clientId: this.clientId } : {})` at line 234 inside onOpen handler. `import * as crypto from 'node:crypto'` at line 1. |
| `src/host/SessionHost.ts` | upsertHostPresence seed + clientId dedupe/rebind | VERIFIED | `upsertHostPresence` called at line 988 (Bug 1). Two maps declared at lines 266–271. Dedupe block lines 998–1093. ws-identity guard lines 789–797. removeMember cleanup lines 2581–2585. |
| `src/test/suite/host.test.ts` | Tests E–M covering both bugs | VERIFIED | Nine new tests present: E (LAN byte-shape), F (stable clientId across reconnects), G (3 auths → 1 member), H (different clientIds → distinct), I (legacy no-clientId), J (superseded ws closed, 1 member-joined), K (host-loopback not deduped), L (host in snapshot after self-auth), M (joiner receives host presence-update). |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| SessionClient.ts onOpen handler | auth-request frame | conditional spread `...(this.clientId ? { clientId: this.clientId } : {})` | WIRED | Line 234. `clientId` is `private readonly` field set once at construction (line 102). Re-fires same value on every reconnect. |
| SessionHost.ts handleAuthRequest host-role branch | presenceMap (via upsertHostPresence) | seed after `this.hostMemberId = newMemberId`, before `this.members.set` | WIRED | `this.hostMemberId = newMemberId` at line 967. `upsertHostPresence({...})` at lines 988–994. `this.members.set(newMemberId, ...)` at line 1107. Correct placement confirmed: seed is INSIDE the `timingSafeEqual` block, BEFORE the new-member path. |
| SessionHost.ts handleAuthRequest member branch | clientIdToMemberId + memberIdToClientId maps | dedupe lookup, rebind ws, reuse memberId — SKIPPED for role==='host' | WIRED | `role !== 'host'` gate at line 1007. `clientIdToMemberId.get(incomingClientId)` at line 1011. `members.set(reuseId, { ws, ... })` at line 1024. Maps updated at lines 1034–1035. Both maps recorded for new-member path at lines 1112–1114. removeMember O(1) cleanup via reverse map at lines 2581–2585. |

---

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| SessionHost.ts getPresenceSnapshot() | presenceMap entries | upsertHostPresence called with real memberId, displayName, branch, activeFilePath:null, lastUpdated:createTimestamp() | Yes — seeded from actual auth data, not hardcoded | FLOWING |
| sendPresenceSnapshotToMember | entries from getPresenceSnapshot() | iterates presenceMap; sends each as presence-update to joiner ws | Yes — real data flows from auth → presenceMap → presence-update frames | FLOWING |

---

## Behavioral Spot-Checks

Step 7b: SKIPPED — requires running the VS Code extension test runner. The task's test suites (host.test.ts) are integration tests that spin up a real SessionHost on a random port and use real WebSocket connections. They cannot be verified without `npm test` in the VS Code test runner environment. The SUMMARY reports 34 passing, 0 failing for new + affected suites.

---

## Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|---------|
| PRESENCE-FIX-1 | Host presence seeded deterministically on host self-auth | SATISFIED | upsertHostPresence inside timingSafeEqual block at SessionHost.ts:988, before members.set. getPresenceSnapshot() includes host immediately after auth. |
| PRESENCE-FIX-2 | Optional clientId on auth-request + host dedupe/rebind + legacy fallback | SATISFIED | clientId?: string on AuthRequest (protocol.ts:92). SessionClient sends stable clientId (SessionClient.ts:102,234). Host dedupe block with role-first ordering, two O(1) maps, rebind path, ws-identity guard, removeMember cleanup (SessionHost.ts:998–1115, 786–798, 2581–2585). |

---

## Anti-Patterns Found

None. Specific checks performed:

- No `return null` / `return {}` / `return []` in new code paths
- No TODO/FIXME/PLACEHOLDER in the four modified files
- No hardcoded empty presence data in rendering paths
- No periodic setInterval for presence (existing heartbeat interval is pre-existing WebSocket liveness check, unrelated)
- No Co-Authored-By in commit messages (commits bc1b035, e244dd3, f912d28 confirmed clean)
- Conditional spread in SessionClient is correct: `clientId` is `private readonly` so it is always a non-empty string; the conditional form is correct per the plan's "future-proof" rationale and correctly passes Test E (which uses a raw object literal without the field, not SessionClient itself)

---

## Human Verification Required

None for automated logic. The following are UAT items that were the original triggers for this task, and are out of scope for code-level verification:

1. **Two-machine UAT re-test:** Connect a second machine (LAN or cloud) after host idles on the Welcome tab and confirm the host id appears in the Presence panel immediately.
2. **Cloud reconnect cycle:** Trigger a cloud bootstrap-swap and confirm the joiner does not produce a duplicate Presence panel entry.

These are end-to-end behavioral checks on real hardware — no code gap, just UAT confirmation.

---

## Summary

All 9 observable truths are verified against the actual codebase. The implementation matches the plan's critical ordering requirements exactly:

**Bug 1 (host missing from Presence panel):** `upsertHostPresence` is called at SessionHost.ts line 988, inside the `timingSafeEqual`-verified host-role block, after `this.hostMemberId = newMemberId` (line 967) and before `this.members.set` (line 1107). This placement ensures the broadcast from `upsertHostPresence` is a proven no-op on first auth (members map is empty), and `getPresenceSnapshot()` returns the host entry immediately for all subsequent joiners.

**Bug 2 (duplicate member entries):** The dedupe block (lines 998–1093) is gated on `role !== 'host'` AND non-empty `incomingClientId`, guaranteeing: (a) the host-loopback always bypasses dedupe and re-runs the role-check + seed; (b) legacy clients (no clientId) get the identical new-member path as today; (c) reconnecting members with a stable clientId get their ws rebound with the original memberId, the superseded socket closed, and no duplicate member-joined broadcast. The ws-identity guard in onClose (lines 789–797) and O(1) reverse-map cleanup in removeMember (lines 2581–2585) complete the cleanup path.

Nine new tests (E–M) directly exercise each behavioral requirement, including the two critical invariants (host-loopback-not-deduped and LAN byte-shape). No periodic presence timer was introduced.

---

_Verified: 2026-05-30T23:45:00Z_
_Verifier: Claude (gsd-verifier)_
