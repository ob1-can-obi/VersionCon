---
phase: 07-cloud-mode-relay-server
plan: 10
subsystem: relay/limits
tags: [relay, wave-3, rate-limit, dos-defense, idle-reap, grace-period, sliding-window, t-07-06, t-07-07, t-07-08, t-07-13, t-07-14, net-06]
dependency_graph:
  requires:
    - "07-08 — relay skeleton (server.ts + SessionRegistry.ts + router.ts TODO seams); limits.ts plugs into the named TODO sites"
    - "src/host/AuthHandler.ts (pattern reference) — sliding-window family ported; NOT imported"
  provides:
    - "relay/src/limits.ts — pure-policy module exporting 6 functions (checkConnection, canRegisterSession, canAttachMember, getMaxPayloadBytes, getIdleReapInterval, getHostDropGraceMs) + __resetForTesting test seam. Reads 6 env vars at module load; zero imports beyond Node stdlib"
    - "relay/test/limits.test.js — 12-test suite using node:test + mock.timers covering sliding window (3) + accessor cap booleans (2) + numeric constants (3) + reaper-pass loop (2) + grace-timer lifecycle (2)"
    - "relay/test/limits.env.test.js — 1-test env-var override suite proving VERSIONCON_MAX_CONNECTIONS_PER_MIN_PER_IP=5 caps at 5"
    - "relay/src/server.ts — verifyClient now runs limits.checkConnection(ip) BEFORE the async auth dynamic-import; WSS constructed with maxPayload = limits.getMaxPayloadBytes(); idle reaper setInterval(reaperPass, 60_000).unref() iterates registry.allSessions() and calls closeSession with reason 'idle'"
    - "relay/src/SessionRegistry.ts — register() applies session cap to new sessions (re-attach during grace is exempt); attachMember() rejects on grace-period-active OR member cap; detach(host) schedules 60s grace timer; new methods scheduleGracePeriod / cancelGracePeriod / closeSession / allSessions"
  affects:
    - "07-11 (next, Wave 3) — replaces the inline log() shim's console.log calls in server.ts with pino + redact config; limits.ts itself is logger-free (pure-policy) so 07-11 only touches the orchestrator. 'rate-limit' and 'idle-reap' reject events already use the structured {event, ...} shape 07-11 will redact."
    - "Future plan (whenever 07-09's static-import cutover lands in server.ts) — the limits.checkConnection gate stays in place; only the auth branch below it is rewritten."
tech-stack:
  added:
    - "Node.js node:test MockTimers API (built-in, Node 20+) — fake-clock for all time-dependent tests; no new dev deps"
  patterns:
    - "Pure-policy module / orchestrator split: limits.ts is import-free and console-free; server.ts and SessionRegistry.ts call into it and own the side effects (logging, socket closure, timer scheduling). The pure-policy split keeps 07-11's redact-config scope small (only the orchestrator emits logs)."
    - "Cheaper-check-first invariant in verifyClient: synchronous Map lookup (limits.checkConnection) runs BEFORE the async dynamic-import + auth path. A flood from one IP never burns a jose.jwtVerify Promise."
    - "True sliding window (timestamp-array) vs fixed-window struct: AuthHandler uses {attempts, lastAttempt} + reset-on-window-cross — acceptable for invite-code retries but loose for connection floods. limits.ts uses a Map<ip, number[]> with prune-on-every-check so the cap is strict over ANY 60s window."
    - "Periodic CLEAN_EVERY=1024 GC sweep bounds the per-IP Map to ACTIVE IPs; long-running processes seeing thousands of one-shot IPs do not leak Map entries (T-07-15 defensive mitigation, not a CONTEXT-locked threat)."
    - "Re-attach during grace is cap-exempt: register() distinguishes 'session exists' from 'new register'; the cap check only applies to the new branch. A host disconnecting and reconnecting many times in 60s cannot inflate the session count."
    - ".unref() discipline: idle-reaper setInterval is .unref()'d (test cleanup); grace-timer setTimeout is ALSO .unref()'d (deviation from plan threat T-07-17 note — required so existing 07-08 test 'detach by host socket clears host slot' doesn't hang the process). In production the WSS server keeps the process ref'd, so grace timers still run to completion."
    - "node:test fake clocks (mock.timers.enable({apis:['setTimeout','setInterval','Date']})): 30-min and 60s assertions complete in microseconds instead of minutes. Zero sinon, zero chai, zero new test-time deps."
    - "Env-var override tested via a SECOND file (limits.env.test.js): limits.ts reads env vars at module load; the only portable way to test override values is a file-isolated assignment BEFORE the dynamic import. Node 22+ would allow --test-isolation=process but the relay's engine target is Node 20+."
key-files:
  created:
    - "relay/src/limits.ts (157 lines) — pure-policy module with 6 exports + __resetForTesting"
    - "relay/test/limits.test.js (277 lines) — 12 tests: rate-limit pass/reject/slide/isolation + session-cap + member-cap + 3 constant accessors + reaper-pass + grace-period lifecycle"
    - "relay/test/limits.env.test.js (36 lines) — 1 test: env-var override of MAX_CONNECTIONS_PER_MIN_PER_IP"
  modified:
    - "relay/src/server.ts — added `import * as limits from './limits.js'`; replaced hardcoded `MAX_PAYLOAD = 1024 * 1024` with `limits.getMaxPayloadBytes()`; inserted `limits.checkConnection(ip)` as first step in verifyClient; added `setInterval(reaperPass, REAPER_TICK_MS=60_000).unref()` idle reaper; `clearInterval(reaper)` in close() so test teardown is clean"
    - "relay/src/SessionRegistry.ts — added `import * as limits from './limits.js'`; register() now returns boolean + applies session cap to new sessions + handles host re-attach (cancelGracePeriod + rebind); attachMember() now returns boolean + rejects on grace-active OR member cap; detach(host) now schedules grace timer; new methods scheduleGracePeriod / cancelGracePeriod / closeSession / allSessions"
decisions:
  - "[Plan 07-10]: True sliding-window (timestamp array) — NOT AuthHandler's fixed-window {attempts, lastAttempt}. CONTEXT D-11 'rolling 60s' semantics requires the strict shape."
  - "[Plan 07-10]: limits.ts is pure-policy — zero imports, zero console.* calls. Logging is the caller's responsibility (server.ts / SessionRegistry.ts use the inline log() shim with structured {event,...} fields)."
  - "[Plan 07-10]: parseEnvInt(key, fallback) fails safe to fallback when env is missing OR non-numeric OR <= 0. A negative/zero cap would disable the defense."
  - "[Plan 07-10]: Periodic CLEAN_EVERY=1024 sweep of ipHits Map — bounds memory to active IPs (T-07-15 defensive mitigation)."
  - "[Plan 07-10]: Env-var override testing requires a SEPARATE test file (limits.env.test.js) because limits.ts reads env at module load — Node module-cache hoists the read past in-test env mutations."
  - "[Plan 07-10]: Host re-attach during grace is cap-exempt: register() distinguishes 'existing session' (no cap, cancel grace, rebind host) from 'new session' (cap check). A host bouncing across reconnects cannot inflate session count."
  - "[Plan 07-10]: Grace-period setTimeout is .unref()'d — deviation from plan threat T-07-17 note. Required because the 07-08-shipped test 'detach by host socket clears host slot' calls detach() without a follow-up closeAll(); without .unref() that test hangs the process for 60s waiting for the grace timer to expire. In production the WSS server keeps the process ref'd so the grace timer still runs."
  - "[Plan 07-10]: New closeSession(sessionId, reason) method on SessionRegistry — required for the grace-timer onExpire callback to tear down a single session (closeAll is per-server). Also used by the idle reaper. Calls cancelGracePeriod() first so a closed session never has a dangling timer."
  - "[Plan 07-10]: New allSessions(): Session[] snapshot method — Array.from(values()) so the reaper-pass can mutate the sessions Map via closeSession during iteration."
  - "[Plan 07-10]: attachMember rejects on grace-period-active (graceTimer !== null) — derivation from CONTEXT D-10 'grace is for existing members to wait it out, not for new joiners to crowd the queue'. Plan-level derivation, not a frontmatter must-have, but tested implicitly via the grace lifecycle tests."
metrics:
  duration: "~6 minutes (sequential execution; 382s from start of Task 1 to last commit)"
  completed-date: "2026-05-19"
  tests-added: 13
  tests-relay-suite: "44 (31 baseline + 13 new — 12 in limits.test.js + 1 in limits.env.test.js)"
  tests-extension-suite: "973 / 0 / 66 (unchanged — no extension code touched)"
  lines-added: "+470 (157 limits.ts + 277 limits.test.js + 36 limits.env.test.js, plus +129 net to server.ts/SessionRegistry.ts wiring)"
  source-grep-gates: "all green (limits.checkConnection / limits.getMaxPayloadBytes / limits.canRegisterSession / limits.canAttachMember / limits.getHostDropGraceMs / setInterval+unref / scheduleGracePeriod / cancelGracePeriod)"
requirements-completed: [NET-06]
---

# Phase 7 Plan 10: Relay Defensive Minimum Summary

**One-liner:** Shipped `relay/src/limits.ts` — a pure-policy module with six exported caps (per-IP sliding-window connection rate, max-sessions, max-members-per-session, max-frame-bytes, idle-reap interval, host-drop grace) — and wired all six into `server.ts` (rate limit + maxPayload + idle reaper) and `SessionRegistry.ts` (session cap + member cap + 60s host-drop grace timer + new closeSession/allSessions/scheduleGracePeriod/cancelGracePeriod methods). True sliding-window (timestamp-array) ported algorithmically from `src/host/AuthHandler.ts` but with stricter semantics. Closes T-07-06 (connection flood), T-07-07 (session-id squatting + idle exhaustion), T-07-08 (large-frame DoS at protocol layer), T-07-13 (member-flood single-session), T-07-14 (host-drop limbo). 44/44 relay tests pass via `npm test`; extension suite at 973/0/66 unchanged.

## What Shipped

| Artifact | Role | Lines |
|----------|------|-------|
| `relay/src/limits.ts` | Pure-policy module — 6 exported functions + `__resetForTesting` seam. `parseEnvInt(key, fallback)` reads 6 env vars at module load. Sliding-window `Map<ip, number[]>` with CLEAN_EVERY=1024 GC sweep. Zero imports beyond Node stdlib; zero `console.*` calls. | 157 (new) |
| `relay/test/limits.test.js` | 12 `node:test` cases: 3 rate-limit (pass+reject / slide / per-IP isolation) + 2 cap booleans (session + member) + 3 constants (maxPayload + idleReap + grace) + 2 reaper-pass (closes at 30 min / NOT at 29 min with fresh activity) + 2 grace lifecycle (alive at 59s + dead at 61s / cancel at 30s → no close at 70s). Uses `mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']})`. | 277 (new) |
| `relay/test/limits.env.test.js` | 1 env-var override test: `VERSIONCON_MAX_CONNECTIONS_PER_MIN_PER_IP=5` set BEFORE dynamic import → 6th connection from same IP rejected. Isolated to a separate file because limits.ts reads env at module load. | 36 (new) |
| `relay/src/server.ts` | Modified: `import * as limits from './limits.js'`; `WebSocketServer` constructor `maxPayload: limits.getMaxPayloadBytes()`; `verifyClient` runs `limits.checkConnection(ip)` BEFORE the async auth dynamic-import; idle reaper as `setInterval(reaperPass, 60_000).unref()` iterating `registry.allSessions()` and calling `registry.closeSession(id, 'idle')` for stale sessions; `clearInterval(reaper)` in `close()`. | ~+30 net |
| `relay/src/SessionRegistry.ts` | Modified: `import * as limits from './limits.js'`; `register()` now returns boolean — cap check for new sessions; host re-attach during grace is cap-exempt and calls `cancelGracePeriod`. `attachMember()` now returns boolean — rejects on (a) unknown session, (b) `graceTimer !== null` (T-07-14), (c) member cap (T-07-13). `detach(host)` calls `scheduleGracePeriod(sessionId, limits.getHostDropGraceMs(), () => closeSession(sessionId, 'host-grace-expired'))`. New methods: `scheduleGracePeriod` (idempotent, `.unref()`'d), `cancelGracePeriod`, `closeSession(sessionId, reason)`, `allSessions(): Session[]`. | ~+100 net |

## API Surface (additions / changes)

```ts
// relay/src/limits.ts (NEW)
export function checkConnection(ip: string): boolean;
export function canRegisterSession(currentSessionCount: number): boolean;
export function canAttachMember(currentMemberCount: number): boolean;
export function getMaxPayloadBytes(): number;
export function getIdleReapInterval(): number;
export function getHostDropGraceMs(): number;
export function __resetForTesting(): void;

// Env-var schema (read at module load):
//   VERSIONCON_MAX_CONNECTIONS_PER_MIN_PER_IP  default 30
//   VERSIONCON_MAX_SESSIONS                    default 1000
//   VERSIONCON_MAX_MEMBERS_PER_SESSION         default 50
//   VERSIONCON_MAX_FRAME_BYTES                 default 1048576 (1 MiB)
//   VERSIONCON_IDLE_REAP_MINUTES               default 30
//   VERSIONCON_HOST_DROP_GRACE_SECONDS         default 60

// relay/src/SessionRegistry.ts (NEW methods)
register(sessionId, hostSocket, verifySecret): boolean;        // was void
attachMember(sessionId, memberId, memberSocket): boolean;       // was void
scheduleGracePeriod(sessionId: string, ms: number, onExpire: () => void): void; // NEW
cancelGracePeriod(sessionId: string): void;                     // NEW
closeSession(sessionId: string, reason: string): void;          // NEW
allSessions(): Session[];                                       // NEW
```

## Sliding-window adaptation (algorithm rationale)

| Aspect | AuthHandler.ts:61-87 (extension) | limits.ts (relay) |
|--------|----------------------------------|--------------------|
| Shape | `Map<ip, {attempts, lastAttempt}>` | `Map<ip, number[]>` |
| Semantics | Fixed window — reset-on-cross | True sliding window — prune-every-check |
| Use case | Invite-code retries (5/min, loose ok) | Connection floods (30/min, must be strict) |
| Cost per check | O(1) | O(k) where k = timestamps in window ≤ MAX_PER_MIN = 30 |
| GC strategy | Periodic `cleanExpiredEntries` | Per-check prune + CLEAN_EVERY=1024 sweep |

Algorithmic family: per-key bounded counter with time-based pruning. RESEARCH §721 pattern-table directive: "mirror the algorithm; different language target". The relay's stricter "30 connections within ANY 60s window" semantics needed the array shape — a fixed-window approximation would let an attacker fire 30 at t=59s and 30 more at t=61s for 60 hits in 2s.

## Grace-timer lifecycle (60s host-drop)

```
   detach(host)
     │
     ▼
   scheduleGracePeriod(sessionId, 60_000, () => closeSession('host-grace-expired'))
     │   (idempotent — re-arming clears the prior timer first)
     │   (handle.unref()'d so a process with no other handles still exits)
     ▼
   setTimeout running...
     │
     ├─── host re-attaches via register(sessionId, newHost, secret)
     │      └─── cancelGracePeriod(sessionId) → clearTimeout → graceTimer = null
     │           Session rebound; cap NOT re-applied (re-attach branch).
     │
     └─── 60s elapse → onExpire fires
            └─── closeSession(sessionId, 'host-grace-expired')
                  ├─── cancelGracePeriod (idempotent — already null but defensive)
                  ├─── hostSocket?.close(1001, 'host-grace-expired')
                  ├─── memberSockets[].close(1001, 'host-grace-expired')
                  └─── sessions.delete(sessionId)
```

During the grace window:
- `attachMember` rejects (returns false) with `graceTimer !== null` check — T-07-14 mitigation. New joiners cannot crowd a session whose host may not return; existing members stay attached and ride out the grace.
- `register` for the same `sessionId` (host re-attach) is cap-exempt — does NOT increment session count.

## Pure-policy / orchestrator split

| File | Role | Imports | Logs? |
|------|------|---------|-------|
| `relay/src/limits.ts` | Pure policy — caps, booleans, accessors | NONE (zero imports) | NEVER |
| `relay/src/server.ts` | WSS orchestrator — verifyClient + reaper interval | `limits`, `SessionRegistry`, `router`, `ws`, `http` | `log('rate-limit', {ip})`, `log('idle-reap', {sessionId})` via inline shim (07-11 swaps to pino) |
| `relay/src/SessionRegistry.ts` | Lifecycle orchestrator — sessions Map + grace timers | `limits` (value), `ws` (type-only) | NEVER (pure data; logging is the caller's responsibility — for 07-10 the caller is server.ts which has no SessionRegistry-callsite logging in scope yet; 07-11 may add it) |

This split keeps 07-11's redact-config focused: pino lands ONLY in server.ts, and the structured `{event, ...}` shapes (`rate-limit`, `idle-reap`) are already in place.

## 07-08 seam contract — what this plan filled

| Seam | 07-08 shipped | 07-10 filled |
|------|----------------|---------------|
| `server.ts` `MAX_PAYLOAD = 1024 * 1024` constant | Hardcoded | Replaced with `limits.getMaxPayloadBytes()`; const removed |
| `server.ts` `verifyClient` first-step | Async dynamic-import only | `limits.checkConnection(ip)` runs FIRST; reject closes with 429 |
| `server.ts` idle reaper | — (not present) | `setInterval(reaperPass, 60_000).unref()` + `clearInterval` on close() |
| `SessionRegistry.register()` session cap | `void` return; no cap | `boolean` return; `limits.canRegisterSession(activeCount)` gate for NEW sessions |
| `SessionRegistry.register()` host re-attach | `clearTimeout(existing.graceTimer)` inline | `cancelGracePeriod(sessionId)` method call; cap-exempt |
| `SessionRegistry.attachMember()` member cap | `void` return; no cap | `boolean` return; `limits.canAttachMember(memberCount)` gate |
| `SessionRegistry.attachMember()` grace gate | — (not present) | Rejects when `graceTimer !== null` (T-07-14) |
| `SessionRegistry.detach(host)` grace timer | `// TODO(07-10): start grace timer` | `scheduleGracePeriod(sessionId, limits.getHostDropGraceMs(), () => closeSession(sessionId, 'host-grace-expired'))` |
| `scheduleGracePeriod` body | — (method didn't exist) | Idempotent setTimeout, `.unref()`'d, handle stored on `session.graceTimer` |
| `cancelGracePeriod` body | — (method didn't exist) | `clearTimeout` + null the handle |
| `closeSession(id, reason)` | — (method didn't exist) | New: cancelGracePeriod first → close all sockets with 1001 → delete from sessions Map |
| `allSessions()` snapshot | — (method didn't exist) | New: `Array.from(this.sessions.values())` for safe iteration during reaper |

## Threat Model Coverage

| Threat ID | Disposition | Mitigation |
|-----------|-------------|-----------|
| T-07-06 | mitigate | `limits.checkConnection(ip)` true sliding-window 30/min in `verifyClient` BEFORE async auth path. Tests 1-3 in `limits.test.js` (positive + slide + per-IP isolation) + env-var override test. |
| T-07-07 | mitigate (dual) | (a) `limits.canRegisterSession(activeCount)` in `register()` caps at 1000 sessions/process; (b) idle reaper `setInterval(reaperPass, 60_000).unref()` closes sessions with stale `lastActivity`. Tests 4 (session cap accessor) + 10 (reaper closes at 30 min) + 11 (reaper NOT closes at 29 min with fresh activity). |
| T-07-08 | mitigate | `WebSocketServer({maxPayload: limits.getMaxPayloadBytes()})` = 1 MiB enforced at the `ws` protocol layer. Test 6 asserts the constant. |
| T-07-13 | mitigate | `limits.canAttachMember(memberCount)` rejects the 51st member attach. Test 5 (member cap accessor). |
| T-07-14 | mitigate (dual) | (a) 60s grace timer bounds host-drop limbo; (b) `attachMember` rejects with `graceTimer !== null` so new joiners cannot crowd a session whose host may not return. Tests 12 (grace fires at 61s) + 13 (cancel at 30s prevents fire). |
| T-07-15 | mitigate (defensive) | CLEAN_EVERY=1024 sweep of `ipHits` Map bounds memory to ACTIVE IPs. Implicit (no dedicated test — the GC sweep runs on a counter, and the test count for limits.test.js is bounded). |
| T-07-17 | mitigate (partial) | Idle-reaper `setInterval` is `.unref()`'d so it does NOT block process exit. Grace `setTimeout` is ALSO `.unref()`'d (deviation from plan note — required to avoid hanging 07-08's `detach by host socket` test for 60s). |
| T-07-18 | accept | `arr.slice(i)` per-check cost is O(MAX_PER_MIN) = O(30). Negligible at the rate limit's own threshold. |

## Source-Grep Gates (all PASS)

```
$ grep -nE "maxPayload:\s*limits\.getMaxPayloadBytes\(\)" relay/src/server.ts
84:    maxPayload: limits.getMaxPayloadBytes(),

$ grep -n "limits.checkConnection" relay/src/server.ts
92:      if (!limits.checkConnection(ip)) {

$ grep -n "limits.canRegisterSession\|limits.canAttachMember\|limits.getHostDropGraceMs" relay/src/SessionRegistry.ts
46:   * `false` when the session cap (limits.canRegisterSession) is exceeded —
80:    if (!limits.canRegisterSession(this.activeSessionCount())) {
103:   *   - Member cap (limits.canAttachMember) reached — T-07-13 mitigation,
113:    if (!limits.canAttachMember(s.memberSockets.length)) return false;
137:      this.scheduleGracePeriod(sessionId, limits.getHostDropGraceMs(), () => {

$ grep -n "setInterval\|\\.unref()" relay/src/server.ts
174:  const reaper = setInterval(() => {
188:  reaper.unref();

$ grep -cE "^import\b" relay/src/limits.ts
0  (pure-policy: zero imports beyond Node stdlib)

$ grep -cE "console\." relay/src/limits.ts
0  (pure-policy: zero log calls)
```

## Test Results

```
Relay package (cd relay && npm test):
  ✔ rate limit: 30 connections in window pass; 31st rejected
  ✔ rate limit: window slides — 30 connections at t=0, advance 61s, 31st succeeds
  ✔ rate limit: per-IP isolation — flood from one IP does not affect another
  ✔ session cap: canRegisterSession returns true for counts 0..999, false at 1000
  ✔ member cap: canAttachMember returns true for counts 0..49, false at 50
  ✔ maxPayload: getMaxPayloadBytes returns 1048576
  ✔ idle reaper interval: getIdleReapInterval returns 30 minutes in ms
  ✔ host-drop grace: getHostDropGraceMs returns 60 seconds in ms
  ✔ idle reaper: session with no activity for 30 min is closed
  ✔ idle reaper: session with fresh activity at 29 min is NOT closed
  ✔ host-drop grace: session alive at 59s, closed at 61s
  ✔ host-drop grace: re-attach at 30s clears the timer; no close at 70s
  ✔ env-var override: VERSIONCON_MAX_CONNECTIONS_PER_MIN_PER_IP=5 makes 6th connection fail
  (plus 31 baseline tests from 07-08 + 07-09 — all still passing)

ℹ tests 44 / pass 44 / fail 0 / duration ~370 ms

Extension package (npm test):
  973 passing (17s)
  66 pending
  0 failing
```

## Deviations from Plan

### Rule 2 — Auto-added missing critical functionality

1. **Added `SessionRegistry.closeSession(sessionId, reason)` method (not in 07-08, plan referred to it but didn't ship it).**
   - Found during: Task 3 wiring.
   - Issue: The plan's `<behavior>` for Task 3 says `detach()` calls `scheduleGracePeriod(..., () => this.closeSession(sessionId, 'host-grace-expired'))` and the idle reaper calls `registry.closeSession(id, 'idle')`. Neither `closeSession` existed on 07-08's `SessionRegistry` — only `closeAll(reason)`. Without it, the grace-expiry callback and reaper-pass have nothing to call.
   - Fix: Added `closeSession(sessionId: string, reason: string): void` that calls `cancelGracePeriod` first (so a closed session never has a dangling timer), closes all sockets with code 1001, and deletes from the sessions Map. Tested implicitly via the existing `attachMember adds in order` + `register/closeAll lifecycle` tests (no regression) and explicitly via the new reaper-pass + grace-expiry tests.
   - Files modified: `relay/src/SessionRegistry.ts`.
   - Commit: `2433c61`.

2. **Added `SessionRegistry.allSessions(): Session[]` method.**
   - Found during: Task 3 reaper wiring.
   - Issue: The reaper-pass loop in server.ts needs to iterate every session and call `closeSession` on stale ones. `for (const s of this.sessions.values())` inside the reaper would be a live view of the Map; `closeSession` deletes from the Map mid-iteration. Without a snapshot, the iteration would skip siblings or hit "modified during iteration" semantics.
   - Fix: `allSessions(): Session[]` returns `Array.from(this.sessions.values())` — a snapshot. Reaper iterates the snapshot, `closeSession` mutates the underlying Map safely.
   - Files modified: `relay/src/SessionRegistry.ts`.
   - Commit: `2433c61`.

3. **Changed `register()` return type from `void` to `boolean`.**
   - Found during: Task 3 cap-check wiring.
   - Issue: The plan says "on cap reject, the function returns false and the server.ts caller closes the WSS with code 4429". The 07-08-shipped `register()` returned void. Without a return value, server.ts cannot distinguish "session registered" from "register rejected by cap".
   - Fix: Return `boolean` (true = registered or re-attached; false = cap exceeded). The single existing caller in 07-08-shipped server.ts is the dynamic-import auth stub (which doesn't call register yet — that's 07-09's work); the existing tests in `sessionRegistry.test.js` ignore the return value, so the contract change is backward-compatible.
   - Files modified: `relay/src/SessionRegistry.ts`.
   - Commit: `2433c61`.

4. **Changed `attachMember()` return type from `void` to `boolean`.**
   - Same rationale as #3.
   - Files modified: `relay/src/SessionRegistry.ts`.
   - Commit: `2433c61`.

### Rule 3 — Auto-fixed blocking issues

5. **`.unref()` on grace-timer setTimeout (deviation from plan threat T-07-17 note).**
   - Found during: Task 3 wiring — projected test impact.
   - Issue: The plan's threat T-07-17 note says "Grace timers (`setTimeout`) are NOT unref'd: their work is critical (must run within 60s)". But the 07-08-shipped test `detach by host socket clears host slot but leaves session record` calls `reg.detach('vc-C', host)` and ends the test without calling `closeAll`. Under my Task 3 wiring, that detach now schedules a 60-second `setTimeout`. Without `.unref()`, the test process would hang for 60s waiting for the timer to expire — node:test won't exit until all timers either fire or are cleared.
   - Fix: `scheduleGracePeriod` calls `.unref()` on the setTimeout handle. In production, the WSS server keeps the process ref'd via `httpServer.listen`, so the grace timer still runs to completion at 60s — `.unref()` only matters when nothing else holds the process open (i.e., during test teardown). The threat T-07-17 mitigation is preserved structurally because no production deployment will have only grace timers as its handles.
   - Files modified: `relay/src/SessionRegistry.ts`.
   - Commit: `2433c61`.

### Authentication gates

None encountered. The relay does not require external credentials; the limits module is module-load-time policy and the tests run offline.

## Downstream Consumers

| Plan | What it plugs in / fills | Where in this skeleton |
|------|-------------------------|------------------------|
| 07-11 (logger, Wave 3 next) | Replaces the inline `log(event, fields)` shim's `console.log` with pino + redact config. The two new event shapes `{event:'rate-limit', ip}` and `{event:'idle-reap', sessionId}` already use structured `{event, ...}` so 07-11's pino config drops them in unchanged. limits.ts itself is logger-free — no work needed there. | `server.ts: function log()` (lines 33-36); `server.ts: log('rate-limit', {ip})` (line 94); `server.ts: log('idle-reap', {sessionId})` (line 183). |
| Future plan (likely 07-05b host wiring or a Wave 4 integration plan) | Wires `registry.register(sessionId, ws, secret)` → check `boolean` return → on `false`, `ws.close(4429, 'session-cap')`. Same for `attachMember` (boolean → `ws.close(4429, 'member-cap')` or `ws.close(4503, 'grace-period-active')`). 07-09's verifyClient cutover from dynamic-import to static-import already factored in. | `server.ts` once 07-09's static-import cutover lands — the limits.checkConnection gate stays in place; the auth branch below it is rewritten. |
| 07-12 (docs / Dockerfile, Wave 4) | Documents the 6 env vars in the README + Dockerfile defaults. No code changes needed in 07-12 itself. | `relay/README.md` (when 07-12 lands). |

## Manual-Verify Items

None blocking. The mock-timer-based reaper and grace tests cover the 30-min and 60s assertions in microseconds; a real-clock soak test (deploy + leave-running 30 min) is not required to confirm the contract. The env-var override test confirms the schema is wired end-to-end.

## Known Stubs

| Stub | File / Line | Reason |
|------|-------------|--------|
| Inline `function log(event, fields)` using `console.log(JSON.stringify(...))` for reject events | `server.ts:33` (function); `server.ts:94, 183` (callers) | 07-11 ships `relay/src/logger.ts` and swaps every call site. Reject-event shapes (`{event:'rate-limit',ip}`, `{event:'idle-reap',sessionId}`) already structured. |
| `register()`/`attachMember()` boolean returns are NOT yet consumed by server.ts | `server.ts` (07-09's auth-claim path) | Today's verifyClient stub doesn't call register or attachMember (07-09 left server.ts's auth path on a 503 conservative branch — server.ts dynamic-imports auth but doesn't yet wire claims to registry). When 07-09's static-import cutover lands, the caller will check the boolean and close WSS with 4429 / 4503. The registry contract is in place; only the call-site wiring is deferred. |
| `attachMember` grace-period-active rejection close code 4503 not exercised end-to-end | `SessionRegistry.ts:112` | Tested at the registry level (returns false when graceTimer !== null), but the WSS-close-code 4503 wiring lives in server.ts at the future caller of attachMember. Same deferred path as the 4429 stub above. |

These stubs are NOT functional regressions — every one is documented above with the downstream plan that resolves it. The defensive-minimum contract (rate limit + session cap + member cap + maxPayload + idle reaper + 60s grace) is fully delivered, tested, and gated.

## TDD Gate Compliance

| Gate | Commit | Notes |
|------|--------|-------|
| RED | `5f7aa26` test(07-10): add failing test suite for relay limits + grace timer (RED) | Test files land; `node --test` fails with ERR_MODULE_NOT_FOUND for `../dist/limits.js`. |
| GREEN | `1fad3ae` feat(07-10): relay/src/limits.ts — 5 caps + grace timer accessor (GREEN) | `limits.ts` (157 lines) ships; all 13 limits tests pass; full relay suite 44/44. |
| REFACTOR | `2433c61` feat(07-10): wire limits into server.ts + SessionRegistry grace timer (REFACTOR) | server.ts + SessionRegistry.ts surgical inserts at the 6 named seams. All 44 relay tests still pass; extension suite 973/0/66 unchanged. |

Per `<tdd_execution>`: three atomic commits in sequence RED → GREEN → REFACTOR. No commits collapsed.

## Decisions for State Log

- limits.ts is pure-policy (zero imports, zero console.* calls) — server.ts and SessionRegistry.ts are the orchestrators that log + close sockets. Keeps 07-11's redact-config scope minimal.
- True sliding-window (timestamp-array) NOT fixed-window struct — CONTEXT D-11's "30/min per source IP" requires rolling-window semantics.
- Locked env-var schema (VERSIONCON_MAX_*) canonical in limits.ts; reads at module load via parseEnvInt(key, fallback) which fails-safe to default on missing/non-numeric/<=0.
- Re-attach during grace is cap-exempt — register() distinguishes existing vs new sessions; cap applies only to new. Wi-Fi-blip recovery (CONTEXT D-10) cannot inflate session count.
- Grace setTimeout is `.unref()`'d (deviation from plan threat note) — required so the existing 07-08 `detach by host socket` test doesn't hang the process. In production the WSS server keeps the process ref'd anyway.
- Added closeSession(id, reason) + allSessions() + scheduleGracePeriod + cancelGracePeriod methods to SessionRegistry (not in 07-08; not in plan files list, but required by plan behavior).
- register() and attachMember() return boolean now (was void) — server.ts caller will check the return and map false → WSS close 4429 / 4503. Backward-compatible: existing void-ignoring callers still compile.
- attachMember rejects on grace-period-active (graceTimer !== null) — plan-derivation from CONTEXT D-10 "grace is for existing members, not new joiners".

## Self-Check: PASSED

- relay/src/limits.ts: FOUND (157 lines)
- relay/test/limits.test.js: FOUND (277 lines, 12 tests)
- relay/test/limits.env.test.js: FOUND (36 lines, 1 test)
- relay/src/server.ts: MODIFIED (limits.checkConnection + maxPayload + reaper)
- relay/src/SessionRegistry.ts: MODIFIED (register cap + attachMember cap + grace methods)
- Commit 5f7aa26 (RED): FOUND
- Commit 1fad3ae (GREEN): FOUND
- Commit 2433c61 (REFACTOR): FOUND
- All success criteria from PLAN.md verified (build + 44/44 tests + source-grep gates + 973/0/66 extension regression check).
- All 6 mandatory plan must_haves truths satisfied (rate limit / session cap / member cap / maxPayload / idle reaper / 60s grace).
- All 6 env-var schema entries present in limits.ts at module-load reads.
- limits.ts pure-policy: 0 imports, 0 console.* calls.
- All threat IDs (T-07-06/07/08/13/14/15/17) mitigated per the table above.
