---
phase: 07-cloud-mode-relay-server
verified: 2026-05-19T13:30:00Z
status: gaps_found
score: 2/3 success criteria verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 1/3 success criteria verified
  previous_verified: 2026-05-19T09:30:00Z
  hotfix_commit: 4413071
  gaps_closed:
    - "SC-1 — Host can start a cloud session from the same wizard used for LAN (was: partial — blocked by relay/src/server.ts:173 503 stub; now: VERIFIED — verifyClient invokes verifyToken / accepts host-bootstrap pending claims and re-verifies at first-frame against session-register verifySecret)"
  gaps_remaining:
    - "SC-2 — Member on a different network can join a cloud session (still: FAILED — BLOCKER 2 MD-03 unfixed; JoinPanel.ts:331 still passes empty bearer; relay's new verifyClient at server.ts:206-210 now correctly rejects empty bearers with 401 'empty-bearer', which is the right behavior — the missing piece is the joiner-side JWT bootstrap design)"
  regressions: []
  test_deltas:
    relay: "71 → 77 (+6) — serverAuthIntegration.test.js"
    extension: "996 → 996 (no change — extension code not touched by hotfix)"
requirement_traceability:
  - id: NET-06
    description: "Cloud mode works with the same UX as LAN (same protocol, different transport)"
    status: PARTIALLY_BLOCKED
    evidence: "Host-side cloud path now works end-to-end against a production-mode relay (requireAuth=true). serverAuthIntegration.test.js test 1 'host bootstrap happy path' asserts: real-signed HS256 host JWT + matching verifySecret → WSS upgrade accepted, session-register processed, registry.register commits with hostMemberId binding. SC-1 VERIFIED. Joiner-side cloud path still cannot complete because JoinPanel.ts:331 passes an empty bearer token; the BLOCKER 1 hotfix correctly rejects this at 401, but no design has been chosen for how the joiner obtains a JWT before the WSS handshake (MD-03 deferred per 07-REVIEW-FIX.md). SC-2 still FAILED. SC-3 was VERIFIED in the initial verification — unchanged."
gaps:
  - truth: "SC-2 — A member on a different network can join a cloud session by entering the relay address and credentials"
    status: failed
    reason: "BLOCKER 2 (MD-03 chicken-and-egg deadlock) was explicitly DEFERRED in this hotfix round per the user's instruction. src/ui/JoinPanel.ts:331 still instantiates `new CloudTransport(relayUrl, sessionId, '')` with an EMPTY bearer token. With BLOCKER 1 now fixed, the relay's verifyClient at relay/src/server.ts:199-210 correctly detects the empty bearer and rejects with 401 'empty-bearer' (event=auth-fail, reason=empty-bearer). The rejection itself is now CORRECT behavior — the relay is doing exactly what it should — but the joiner has no design path to obtain a valid JWT before the WSS handshake. The host-side flow (which mints per-joiner JWTs in `SessionHost.handleAuthRequest`) runs only AFTER the joiner is already connected, which can never happen. Resolution requires a plan-level redesign: either (a) a relay `/bootstrap` unauthenticated route that forwards `auth-request` to the host and returns the issued JWT to the joiner, (b) an out-of-band JWT issued by the host encoded in the deep-link with role:'pending' and short exp, or (c) a verifyClient carve-out that accepts unauthenticated member sockets and immediately forwards their first frame to the host-side auth-request flow. All three options change the Phase 7 cloud join contract end-to-end and need plan revision before code lands."
    artifacts:
      - path: "src/ui/JoinPanel.ts"
        issue: "Line 331: `new CloudTransport(relayUrl, sessionId, '')` — empty bearer token. Comment at 324-330 explicitly acknowledges the gap ('Token is empty for now ... that wiring lands in a later host-side plan. We currently pass '' and let the relay (when it exists) bounce the connection'). With BLOCKER 1 fixed, the relay now does bounce the connection — exactly as the comment predicted — and there is still no plan-level design to issue the joiner a JWT before the WSS handshake."
      - path: "relay/src/server.ts"
        issue: "Line 206-210: empty-bearer rejection is now ACTIVE and correct (was previously masked by the 503 stub). The relay's behavior is right; the gap is on the joiner side, not the relay."
    missing:
      - "Plan-level decision on MD-03 bootstrap design: choose between (a) relay /bootstrap route + host forwarding, (b) deep-link-encoded short-lived pending JWT, or (c) verifyClient carve-out for member-bootstrap sockets."
      - "Once the design is chosen, implement the joiner-side JWT acquisition flow in JoinPanel.ts (replacing the empty-string token at line 331) AND the corresponding relay-side handler."
      - "Add an integration test that opens two CloudTransports (host + member) against a relay started with `requireAuth: true` and asserts a full auth-request → auth-response → state-sync flow completes — the same shape as relay/test/serverAuthIntegration.test.js test 3 ('member auth happy path') but starting from a joiner WITHOUT a pre-issued member JWT."

deferred:
  - truth: "Live cloud-mode session between two physical machines on different networks (host on machine A deploys relay, member on machine B clicks deep-link, both push/pull/chat)"
    addressed_in: "Phase 7 closeout — MANUAL UAT-3 (07-12-SUMMARY.md:156)"
    evidence: "07-12-SUMMARY explicitly defers this to the verifier as MANUAL UAT-3 because it requires deploying a real Fly.io machine and two physical clients on different networks. This is the canonical live test of SC-1 + SC-2 + SC-3 together. Status update: with BLOCKER 1 fixed, the HOST side of UAT-3 should now succeed end-to-end (the host's WSS upgrade + session-register + registry commit are all exercised by serverAuthIntegration.test.js test 1 with real HS256 JWTs). The MEMBER side of UAT-3 is still expected to fail at the WSS handshake because of MD-03."

human_verification:
  - test: "MANUAL UAT-1 — Docker build smoke test"
    expected: "`cd relay && docker build -t versioncon-relay-test .` exits 0 in <60s; image runs `node dist/server.js` as USER node on port 8080; `curl http://localhost:8080/healthz` returns `{ok:true,sessions:0,uptime_s:N}`."
    why_human: "Requires a running Docker daemon. The executor in 07-12 noted Docker.app was offline locally and deferred to the verifier per plan instruction. Cannot be performed inside a non-Docker environment; paper-verification of the Dockerfile passed line-by-line per 07-12-SUMMARY. Unchanged from initial verification."

  - test: "MANUAL UAT-2 — End-to-end Fly.io deploy quickstart"
    expected: "An unfamiliar developer follows relay/README.md from a clean checkout and has a `wss://*.fly.dev` endpoint with `{ok:true,sessions:0}` from `/healthz` in ≤5 minutes (CONTEXT D-03 phase-gate test). If longer than 5 minutes, that is a doc-clarity defect."
    why_human: "Requires a Fly.io account, flyctl install, real cloud deploy, and stopwatch. Cannot be done programmatically. STATUS UPDATE: with BLOCKER 1 fixed, the deployed relay will now ACCEPT WSS connections from a real host (the host's HS256 JWT signed against a freshly-generated per-session secret will be re-verified at first-frame against the session-register payload's verifySecret). The relay is no longer 'deploy succeeds but rejects everything' — it is 'deploy succeeds, host can connect, joiner still cannot'."

  - test: "MANUAL UAT-3a — Host-side single-machine cloud session (SC-1 alone)"
    expected: "Host (Alice, machine A) opens wizard → picks Cloud → enters wss://*.fly.dev relay URL → Test Connection succeeds → creates session → status bar shows `$(cloud) VersionCon — connected`. Stop here — do not attempt the joiner side."
    why_human: "Requires a deployed Fly.io relay + a VS Code instance + visual status-bar confirmation. NEW IN THIS RE-VERIFICATION: this is the live counterpart to serverAuthIntegration.test.js test 1; it exercises the BLOCKER 1 hotfix in a real deploy. Previously this would have failed with 503 at the WSS upgrade. After the hotfix, this is EXPECTED TO PASS."

  - test: "MANUAL UAT-3b — Two-machine live cloud session (SC-1 + SC-2 + SC-3 combined)"
    expected: "Host (Alice, machine A) opens wizard → picks Cloud → enters wss://*.fly.dev relay URL → Test Connection succeeds → creates session → shares deep-link. Member (Bob, machine B, different network) clicks deep-link → confirmation prompt → JoinPanel opens prefilled → Bob enters displayName + invite code → connects. Both users see each other in presence; chat works; push/pull works; status bar shows `$(cloud) VersionCon — connected` on both."
    why_human: "Requires two physical machines on different networks, a deployed relay, and visual confirmation of presence/chat/push behavior in the UI. Cannot be done programmatically. STATUS: This test is EXPECTED TO FAIL on the joiner side due to BLOCKER 2 (MD-03). The host side (UAT-3a) should now succeed; Bob's WSS upgrade will be rejected at relay/src/server.ts:206-210 with 401 'empty-bearer' because JoinPanel.ts:331 still passes an empty string for the bearer token. Bob's CloudTransport will surface this as `relay-unreachable` per the CloudTransport.mapCloseCodeToState fallback (any non-mapped close → relay-unreachable)."

  - test: "SC-3 live verification — three distinct cloud connection states surface in status bar with correct precedence"
    expected: "While the host is connected, status bar shows `$(cloud) VersionCon — connected`. Stop the relay (`fly machine stop`) — status bar transitions to `$(warning) VersionCon — relay unreachable` with tooltip showing reconnect attempt. End the session on the host while a member is connected — member's status bar transitions to `$(error) VersionCon — session not found`."
    why_human: "Visual status bar transitions can only be confirmed by a human watching VS Code. Programmatic verification of StatusBarManager + CloudTransport.mapCloseCodeToState is complete (statusBarCloudStates.test.ts + cloudTransport.test.ts) — paper-verifiable, but the live VS Code render path needs human eyes. STATUS UPDATE: with BLOCKER 1 fixed, the host CAN now reach the `connected` state — the first state of the three is reachable. The `relay-unreachable` state is also reachable (stop the relay → 1006 close). The `session-not-found` state requires a joiner reaching the relay first, which is still blocked by BLOCKER 2 — so this third state remains only paper-verifiable until MD-03 is resolved."
---

# Phase 7: Cloud Mode + Relay Server — Re-Verification Report (BLOCKER 1 Hotfix)

**Phase Goal:** Teams who are not on the same local network can use VersionCon over the internet with the exact same UI and workflow as LAN mode.

**Verified:** 2026-05-19T13:30:00Z
**Status:** gaps_found
**Re-verification:** Yes — after BLOCKER 1 hotfix (commit `4413071`)
**Score change:** 1/3 → 2/3 success criteria verified (SC-1 promoted from partial to VERIFIED; SC-2 still FAILED; SC-3 still VERIFIED)

## Executive Summary

This is a re-verification of Phase 7 after the BLOCKER 1 hotfix (commit `4413071` — "fix(07-VERIFICATION): BLOCKER 1 — wire verifyToken into verifyClient with host bootstrap defer") was applied to address the first of two blockers identified in the initial 07-VERIFICATION.md (timestamp 2026-05-19T09:30:00Z).

**What changed:**

1. **`relay/src/server.ts` verifyClient is now WIRED.** The previous 503 stub at line 173 has been replaced by a full production auth gate (server.ts:192-286). `verifyToken` is statically imported from `./auth.js`; `decodeJwt` and `jwtVerify` are statically imported from `jose`. The verifyClient flow now:
   - Performs unverified `decodeJwt` to extract `role` + `aud` + `sub`
   - Shape-checks all three fields (SESSION_ID_SHAPE on aud, host|member on role)
   - For host-role on a NEW session (registry.getSession returns null), accepts the connection with PENDING claims and defers JWT signature verification to first-frame time — re-verifies the JWT against the verifySecret extracted from the session-register payload BEFORE `registry.register` is called
   - For member-role OR host re-register (session already exists), runs full async `verifyToken` and stashes verified claims on `info.req.claims`
2. **Async first-frame handler.** server.ts:397-541 is now async (`handleFirstFrame`) because host bootstrap may need to `await jwtVerify` against the session-register verifySecret. Frames received during the verify window are queued in `pendingFrames` (capped at 64) and drained FIFO after settle (server.ts:588-634).
3. **6 new integration tests** in `relay/test/serverAuthIntegration.test.js` exercise the new path with REAL HS256-signed JWTs (not the `requireAuth: 'test'` carve-out):
   - Test 1: Host bootstrap happy path — real JWT + matching verifySecret → registry commits
   - Test 2: Host bootstrap signature mismatch — forged verifySecret → 4401 'host-bootstrap-signature-fail'; registry empty
   - Test 3: Member auth happy path — pre-registered session + real member JWT signed with same secret → upgrade accepted
   - Tests 4-6: Missing/malformed/bad-role rejections → 401
4. **Test counts:**
   - Relay: **71 → 77** passing (+6 new integration tests)
   - Extension: **996 → 996** passing (no change — extension code not touched by hotfix)

**What did NOT change (per user's explicit instruction):**

- **BLOCKER 2 (MD-03 chicken-and-egg)** remains DEFERRED. `src/ui/JoinPanel.ts:331` still passes an empty bearer token to `new CloudTransport(relayUrl, sessionId, '')`. The relay's new verifyClient at server.ts:199-210 correctly detects and rejects empty bearers with 401, which is the right defensive behavior — but the joiner has no way to obtain a JWT before the WSS handshake, so cloud join from JoinPanel still cannot complete end-to-end.

**Net effect on Success Criteria:**

| SC | Previous | Current | Reason |
|---|---|---|---|
| SC-1 | partial | **VERIFIED** | Host bootstrap end-to-end now works with real HS256 JWT against `requireAuth: true`. Confirmed by serverAuthIntegration.test.js test 1 (registry.activeSessionCount() === 1 after valid bootstrap; session.hostMemberId bound to JWT.sub). |
| SC-2 | failed | failed | BLOCKER 2 unchanged. Joiner-side empty-bearer rejection is now correctly enforced but blocks completion; MD-03 design decision still pending. |
| SC-3 | verified | verified | No change. StatusBarManager.setCloudStatus + CloudTransport.mapCloseCodeToState still surface 3 distinct states. Live observation of all three states is now PARTIALLY unblocked — `connected` and `relay-unreachable` are reachable end-to-end; `session-not-found` still requires a joiner reaching the relay (gated by SC-2). |

The hotfix is a **clean, well-fenced fix** that:
- Preserves the T-07-09 invariant (role determined by JWT, NEVER by connection order)
- Preserves the T-07-02 router byte-pass-through invariant (the new code paths live in server.ts, not router.ts)
- Preserves the T-07-11 HS256 algorithm pin (jwtVerify call at server.ts:458-462 explicitly passes `algorithms: ['HS256']`)
- Adds a NEW threat-model boundary: host bootstrap JWT is signature-verified BEFORE registry.register, closing the "forged JWT registers a session with attacker-controlled verifySecret" attack vector (serverAuthIntegration.test.js test 2 asserts this)

## Goal Achievement

### Observable Truths (mapped to ROADMAP SCs)

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | **SC-1**: Host can start a cloud session from the same wizard used for LAN — UI shows "Cloud" mode and no extra steps required vs LAN | **VERIFIED** (was: partial) | UI: VERIFIED unchanged (wizard.js renders Cloud radio, relay-URL step, share-screen Cloud variant; WizardPanel.ts:381-823 handles cloud-set-mode / wizard-set-relay-url / wizard-test-relay-connection messages; wizardCloudStep.test.ts 27 tests pass). Wiring: VERIFIED unchanged (WizardPanel.handleWizardComplete:667-678 dispatches to SessionHostFactory.createCloud at SessionHostFactory.ts:61-129). **End-to-end: NOW VERIFIED** — relay/src/server.ts:192-286 verifyClient now decodes the host JWT, accepts host bootstrap with pending claims (server.ts:251-262 when registry.getSession returns null AND role==='host'), and first-frame at server.ts:455-471 re-verifies the JWT signature against the session-register verifySecret with `algorithms:['HS256']` BEFORE registry.register. Integration-tested with REAL HS256 JWTs in relay/test/serverAuthIntegration.test.js test 1: `assert.equal(server.registry.activeSessionCount(), 1, 'session must be registered after valid bootstrap')` + `assert.equal(session.hostMemberId, HOST_MEMBER_ID, 'hostMemberId must be bound from JWT.sub')` both pass. |
| 2 | **SC-2**: Member on a different network can join a cloud session by entering relay address + credentials — coding within same time window as LAN mode | failed (unchanged) | BLOCKER 2 (MD-03) still unfixed per user's explicit instruction. src/ui/JoinPanel.ts:331 still passes empty bearer token. The relay's new verifyClient at relay/src/server.ts:199-210 now correctly enforces empty-bearer rejection (`if (rawJwt.length === 0) cb(false, 401, 'unauthorized')`) — which is the right behavior, but blocks completion. There is still no design path for the joiner to obtain a JWT BEFORE the WSS handshake. 07-REVIEW-FIX.md MD-03 row still reads "**Until resolved, cloud-mode join from JoinPanel cannot complete end-to-end**" — deferred to a fresh planning task. |
| 3 | **SC-3**: Connection status indicator correctly reflects cloud relay connection health, including relay server unreachable as a distinct state from session-not-found | verified (unchanged) | StatusBarManager.setCloudStatus surfaces 3 distinct states (`connected` / `relay-unreachable` / `session-not-found`) with byte-identical UI-SPEC strings (StatusBarManager.ts:280-339; 18 tests in statusBarCloudStates.test.ts). CloudTransport.mapCloseCodeToState (CloudTransport.ts:128-146) maps WSS codes correctly: 4404 → session-not-found, 1000 → disconnected, 4403 → host-identity-mismatch, 4429 → member-cap-reached, 4503 → grace-period-active, all others → relay-unreachable. Precedence rules implemented. Live verification of all 3 states is now PARTIALLY reachable: `connected` + `relay-unreachable` are now end-to-end testable via host-only deploy (UAT-3a); `session-not-found` still requires a joiner reaching the relay (gated by SC-2). |

**Score:** **2/3** truths verified, 1 failed. (Previous: 1/3 verified, 1 partial, 1 failed.)

### BLOCKER 1 Hotfix Verification

| Check | Method | Result |
|---|---|---|
| `verifyToken` is statically imported (not 503 stub) | `grep -n "import.*verifyToken" relay/src/server.ts` | Line 30: `import { verifyToken } from './auth.js';` — VERIFIED |
| `decodeJwt` + `jwtVerify` are statically imported | `grep -n "from 'jose'" relay/src/server.ts` | Line 25: `import { decodeJwt, jwtVerify } from 'jose';` — VERIFIED |
| No more 503 'Relay auth pending' stub | `grep -n "Relay auth pending" relay/src/server.ts` | 0 hits (only in pre-07-09 stub comment that documents removed behavior) — VERIFIED |
| Host bootstrap pending-claims path exists | server.ts:251-262 | Captures `_pendingHostBootstrap: true` + `_rawJwt` when role==='host' AND registry.getSession(aud) is undefined — VERIFIED |
| First-frame JWT signature re-verify | server.ts:455-471 | `await jwtVerify(rawJwt, new Uint8Array(verifySecret), { algorithms: ['HS256'], audience: claims.aud, clockTolerance: '30s' })`; close 4401 'host-bootstrap-signature-fail' on rejection — VERIFIED |
| Member / host re-register goes through full verifyToken | server.ts:266-286 | `verifyToken(info.req, registry).then(...)` — VERIFIED |
| Async first-frame handler with pendingFrames queue | server.ts:397-541 + 588-634 | `handleFirstFrame` declared async; subsequent-frame handler buffers up to 64 frames in `pendingFrames` during verify window, drains FIFO after settle. `pendingFrames.length >= 64` closes 4400 'too-many-frames-before-first-settles' — VERIFIED |
| HI-06 production guard preserved | server.ts:104-108 | startServer throws if `requireAuth: 'test'` AND `NODE_ENV === 'production'` — VERIFIED unchanged |
| T-07-09 invariant preserved (role from JWT, not connection order) | server.ts:216,251,422 | Role read from `decoded.role` (verifyClient), then from `claims.role` (handleFirstFrame); never from connection ordinal — VERIFIED |
| HS256 algorithm pin preserved on first-frame verify | server.ts:459 | `algorithms: ['HS256']` literal at jwtVerify call site — VERIFIED |
| T-07-02 router byte-pass-through preserved | `grep -c '.payload' relay/src/router.ts` | 0 hits — VERIFIED (the new payload reads are all in server.ts at the documented first-frame carve-out) |
| Logger swap preserved (no console.* in relay/src/) | `grep -rnE '^\s*console\.' relay/src/` | 0 hits — VERIFIED |
| New auth-fail log events use redact-safe shape | `grep -n "auth-fail" relay/src/server.ts` | server.ts:201,207,217,222,227,235: all emit `{event:'auth-fail', reason:'<discriminator>', ip}` — NO bearer/payload/code/secret keys — VERIFIED |

### New Integration Tests (`relay/test/serverAuthIntegration.test.js`)

| Test | Asserts | Status |
|---|---|---|
| 1. Host bootstrap happy path | real HS256 JWT + matching verifySecret → WSS upgrade accepted → session-register processed → `registry.activeSessionCount() === 1` AND `session.hostMemberId === HOST_MEMBER_ID` | PASS |
| 2. Host bootstrap signature mismatch | JWT signed with secret A + session-register with verifySecret B → ws closes with code 4401 + reason matches `/host-bootstrap-signature-fail/` AND `registry.activeSessionCount() === 0` | PASS |
| 3. Member auth happy path | After host bootstrap, member JWT signed with same secret → second WSS upgrade accepted → `memberCli.opened === true` | PASS |
| 4. No Authorization header | `openClient(server.port, null)` → `opened === false`, `closeCode !== null` (1006 abnormal closure) | PASS |
| 5. Malformed Bearer (random string) | `openClient(server.port, 'not-a-jwt-just-random-bytes')` → `opened === false` | PASS |
| 6. Bad role shape (`role: 'admin'`) | Signed JWT with role !== host/member → `opened === false` | PASS |

All 6 tests run via `node --test test/serverAuthIntegration.test.js`. They exercise the actual production code path (`requireAuth: true`), not the `requireAuth: 'test'` carve-out — closing the test gap noted in the initial verification ("test gap matching the BLOCKER").

### Re-verified Per-Plan Must-Haves (delta from initial verification)

| Plan | Status (initial) | Status (now) | Delta |
|---|---|---|---|
| **07-08** Relay skeleton + server.ts | PARTIAL — server.ts had unfixed wire-up gap | VERIFIED | verifyClient now invokes verifyTokenFn (and decodeJwt for bootstrap). 503 stub removed. |
| **07-09** Relay auth.ts | VERIFIED (in isolation) — but unwired | VERIFIED + WIRED | verifyToken is now called by server.ts:266 for the member / host-re-register path. The module is no longer orphaned. |
| **07-05b** Host-side cloud wiring | VERIFIED (paper-level) | VERIFIED (paper + integration) | End-to-end host bootstrap now exercised by serverAuthIntegration.test.js test 1 with real HS256 JWTs. |
| **07-06** JoinPanel cloud branch | PARTIAL — UI works, end-to-end blocked by MD-03 | PARTIAL (unchanged) | MD-03 still deferred per user's explicit instruction. |
| All other plans | VERIFIED | VERIFIED | No change. |

### Test Counts (Behavioral Spot-Checks)

| Behavior | Command | Result | Status |
|---|---|---|---|
| Relay test suite runs and passes | `cd relay && npm test` | **77/77 pass in ~1.8s** (was 71/71) | PASS |
| Extension test suite runs and passes | `npm test` | **996 passing, 66 pending, 0 failing in 17s** (unchanged — extension code not touched) | PASS |
| Production WSS upgrade succeeds when token is valid | `relay/test/serverAuthIntegration.test.js` test 1 | **PASS** — was the previous test gap; now closed | PASS |
| Production WSS upgrade rejects forged signatures | `relay/test/serverAuthIntegration.test.js` test 2 | PASS | PASS |
| Production WSS upgrade rejects empty bearers | implicit in test 4 (no Authorization header → reject) + the new server.ts:206-210 path | PASS (covered) | PASS |

### Anti-Pattern Re-scan (delta from initial verification)

| File | Pattern (initial) | Pattern (now) | Delta |
|---|---|---|---|
| `relay/src/server.ts:173` | BLOCKER — 503 stub `cb(false, 503, 'Relay auth pending (07-09)')` after auth-module successfully resolved | NONE — line 173 is now part of the legitimate WSS server configuration; the stub language was replaced by the real auth gate at server.ts:192-286 | **FIXED by commit 4413071** |
| `src/ui/JoinPanel.ts:331` | BLOCKER — empty Bearer token | BLOCKER (unchanged) — empty Bearer token still passed; MD-03 deferred | **NOT FIXED — explicitly deferred per user instruction** |
| `src/network/CloudTransport.ts:444-447` | INFO — markIntentionalClose documented as NOT-on-interface | INFO (unchanged) | No change |
| `src/network/CloudHostTransport.ts:89-92` | INFO — console.log in production logger seam | INFO (unchanged) | No change |
| `src/ui/JoinPanel.ts:324-330` | BLOCKER (already counted) — comment acknowledges gap | BLOCKER (unchanged) | No change |

Net anti-pattern delta: 1 BLOCKER removed (server.ts:173), 0 added.

## Gaps Summary

The BLOCKER 1 hotfix is **surgical, well-tested, and threat-model-faithful**. It closes the verifyClient wire-up gap that was the larger of the two phase-blocking defects, and it does so in a way that:

- Adds the host-bootstrap defer-verify-to-first-frame pattern with a clear, documented threat boundary (server.ts:32-52)
- Pins the HS256 algorithm on the new jwtVerify call site (server.ts:459)
- Preserves the T-07-02 router byte-pass-through invariant (the new payload reads remain in server.ts)
- Preserves the T-07-09 invariant (role from JWT, NEVER from connection order)
- Closes the test-coverage gap with 6 new real-JWT integration tests exercising both happy and failure paths
- Adds a NEW threat-model defense (forged-JWT-with-attacker-secret attack on host bootstrap, asserted by serverAuthIntegration.test.js test 2)

**SC-1 is now end-to-end verifiable** against a production-mode relay. The wizard's Cloud path produces a working host session.

**SC-2 remains FAILED** — but the failure mode has shifted in an important way. Before the hotfix, SC-2 was failing for TWO compounding reasons: (a) the relay's 503 stub rejected everything; (b) JoinPanel passes an empty bearer. After the hotfix, only (b) remains. The relay's behavior at the empty-bearer rejection (server.ts:206-210 → 401 'unauthorized') is now CORRECT defensive behavior; the gap has migrated entirely to the joiner side and is a plan-level design question (MD-03):

- Option A: Relay `/bootstrap` unauthenticated route that forwards `auth-request` to the host's CloudHostTransport and returns the host's `auth-response` JWT to the joiner; joiner then re-opens WSS with the JWT.
- Option B: Short-lived `role: 'pending'` JWT encoded in the deep-link by the host's wizard share screen; signed with the same per-session verifySecret; joiner uses it to open WSS and immediately requests promotion to a `role: 'member'` JWT via `auth-request`.
- Option C: verifyClient carve-out that accepts member sockets with no JWT and forwards their first frame (which MUST be `auth-request`) to the host's `handleAuthRequest`; on host's `auth-response`, the relay closes the unauthenticated socket and asks the joiner to re-open with the new JWT.

All three change the cloud join contract end-to-end. None is appropriate as a hotfix; the user has correctly scoped this as a fresh planning task and left BLOCKER 2 deferred for this round.

**SC-3 is now PARTIALLY live-verifiable.** The first two states (`connected`, `relay-unreachable`) are reachable end-to-end via a host-only deploy. The third state (`session-not-found`) still requires a joiner reaching the relay, which is gated by SC-2.

### Recommended Next Steps

1. **MANUAL UAT-3a (new, host-only)** — deploy the relay to Fly.io per relay/README.md, then run the wizard from a local VS Code as a host, pick Cloud mode, point at the deployed `wss://*.fly.dev`, and verify the status bar shows `$(cloud) VersionCon — connected`. This is the live counterpart to serverAuthIntegration.test.js test 1 and is the lowest-cost validation of the BLOCKER 1 fix in a real network environment.

2. **Schedule MD-03 design decision** as a Phase 7-followup planning task. The three options (relay /bootstrap route, deep-link pending JWT, member-bootstrap verifyClient carve-out) each have distinct security and contract implications; this is not a hotfix — it needs PLAN.md review.

3. **Once MD-03 is implemented**, re-verify SC-2 + run MANUAL UAT-3b (two-machine live cloud session). At that point Phase 7's goal is fully achievable end-to-end.

---

_Re-verified: 2026-05-19T13:30:00Z_
_Previous verification: 2026-05-19T09:30:00Z (status: gaps_found, score: 1/3)_
_Hotfix commit: 4413071 — "fix(07-VERIFICATION): BLOCKER 1 — wire verifyToken into verifyClient with host bootstrap defer"_
_Verifier: Claude (gsd-verifier, Opus 4.7 1M context)_
