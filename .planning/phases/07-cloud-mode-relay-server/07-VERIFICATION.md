---
phase: 07-cloud-mode-relay-server
verified: 2026-05-20T22:30:00Z
status: human_needed
score: 3/3 success criteria verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 2/3 success criteria verified
  previous_verified: 2026-05-19T13:30:00Z
  gaps_closed:
    - "SC-2 — Member on a different network can join a cloud session (BLOCKER 2 / MD-03 chicken-and-egg deadlock fully resolved via plans 07-13 + 07-14: TokenService.issueBootstrap mints 15m role:member JWT → WizardPanel threads it into share-screen deep-link &bt= param → UriHandler parses &bt= (T-07-20 HIGH-redacted) → JoinPanel passes bootstrapToken into CloudTransport constructor (empty-bearer literal gone per N-07-14-C) → CloudTransport.swapToken atomically closes bootstrap socket and reconnects with host-issued real per-joiner JWT → SessionClient defers connection-changed:connected until post-swap second auth-response → relay registry shows real per-joiner sub NOT bootstrap sub; proven end-to-end by relay/test/bootstrapJoinerE2E.test.js Test 1 against requireAuth:true)"
  gaps_remaining: []
  regressions: []
  test_deltas:
    relay: "77 → 79 (+2) — bootstrapJoinerE2E.test.js"
    extension: "996 → 1061 (+65) — 07-13: +33 (bootstrapTokenIssue + hostBootstrapTokenWiring + wizardDeepLinkBootstrap); 07-14: +32 (uriHandlerBootstrapToken + joinPanelBootstrapToken + cloudTransportSwapToken + sessionClientCloudReconnect)"
requirement_traceability:
  - id: NET-06
    description: "Cloud mode works with the same UX as LAN (same protocol, different transport)"
    status: SATISFIED
    evidence: "All three SCs verified: SC-1 (host cloud session via wizard — VERIFIED pass 2); SC-2 (joiner bootstrap JWT flow — VERIFIED this pass, proven by bootstrapJoinerE2E.test.js Test 1 against requireAuth:true, extension 1061/79 relay pass); SC-3 (status bar cloud states — VERIFIED pass 1, unchanged). Test total: 1140 passing, 0 failing."
gaps: []
human_verification:
  - test: "MANUAL UAT-1 — Docker build smoke test"
    expected: "`cd relay && docker build -t versioncon-relay-test .` exits 0 in <60s; image runs `node dist/server.js` as USER node on port 8080; `curl http://localhost:8080/healthz` returns `{ok:true,sessions:0,uptime_s:N}`."
    why_human: "Requires a running Docker daemon. The executor in 07-12 noted Docker.app was offline locally and deferred to the verifier per plan instruction. Cannot be performed inside a non-Docker environment."

  - test: "MANUAL UAT-2 — End-to-end Fly.io deploy quickstart"
    expected: "An unfamiliar developer follows relay/README.md from a clean checkout and has a `wss://*.fly.dev` endpoint with `{ok:true,sessions:0}` from `/healthz` in 5 minutes (CONTEXT D-03 phase-gate test)."
    why_human: "Requires a Fly.io account, flyctl install, real cloud deploy, and stopwatch. Cannot be done programmatically."

  - test: "MANUAL UAT-3b — Two-machine live cloud session (SC-1 + SC-2 + SC-3 combined)"
    expected: "Host (Alice, machine A) runs wizard → Cloud mode → relay URL → Test Connection passes → creates session → share-screen deep-link contains &bt=eyJ... JWT. Member (Bob, machine B, different network) clicks deep-link → JoinPanel opens prefilled → Bob enters displayName → connects. Status bar on both shows `$(cloud) VersionCon — connected` with NO flicker through relay-unreachable during the bootstrap-swap window. Presence panel shows both Alice and Bob with real identities (no bootstrap-<sessionId> artifact). Chat, push, pull all function. OutputChannel on Bob's machine shows `bt=<redacted>` NOT the JWT plaintext (T-07-20). Relay logs show REAL_JOINER_ID sub, not bootstrap sub. SC-3 sub-test: stopping relay surfaces relay-unreachable; restarting reconnects; host ending session surfaces session-not-found."
    why_human: "Requires two physical machines on different networks, a deployed Fly.io relay, and human confirmation of visual status-bar transitions, presence, chat, and log content. Cannot be done programmatically. This is the final live verification of SC-2; all code-level evidence (E2E integration test) confirms the path is wired, but the live test exercises the real deploy, real OS deep-link registration, and real network routing."
---

# Phase 7: Cloud Mode + Relay Server — Re-Verification Report (Pass 3 — SC-2 Closure)

**Phase Goal:** Teams who are not on the same local network can use VersionCon over the internet with the exact same UI and workflow as LAN mode.

**Verified:** 2026-05-20T22:30:00Z
**Status:** human_needed (all code-level checks PASS; Manual UAT-3b is the final live gate)
**Re-verification:** Yes — Pass 3, after BLOCKER 2 (MD-03) closure via plans 07-13 + 07-14
**Score change:** 2/3 → **3/3** success criteria verified (SC-2 promoted from failed to VERIFIED; SC-1 + SC-3 unchanged from pass 2)

## Executive Summary

Pass 3 is the first time all three Phase 7 Success Criteria are code-level verified. BLOCKER 2 (MD-03 joiner-JWT chicken-and-egg deadlock) is fully closed by plans 07-13 (host-side bootstrap JWT mint + deep-link &bt= plumbing) and 07-14 (joiner-side bt consume + CloudTransport.swapToken + SessionClient orchestration + E2E test). Zero relay production code was modified; the relay's existing verifyToken path accepts the bootstrap JWT shape verbatim (proven by both the pre-existing serverAuthIntegration.test.js test 3 and the new bootstrapJoinerE2E.test.js test 1 which runs against `requireAuth: true`).

**What changed since pass 2 (commits 5c1439b through 66b8915):**

Nine commits in two plan waves:

- 07-13 (5c1439b, 4e93e46, d3b176e + eae3246 docs): TokenService.issueBootstrap 15m hard-capped role:member JWT; SessionHost.attachBootstrapToken/getBootstrapToken; SessionHostFactory.createCloud mints and attaches; WizardPanel.bootstrapToken state field + cloud-branch pickup; wizard.js 4-arg buildDeepLink with &bt= suffix. 33 new extension tests; relay unchanged at 77.
- 07-14 (4d882ca, 933255d, b48d49d, 38ee1f5 + 66b8915 docs): CONTEXT.md MD-03 lock; UriHandler bt parse + T-07-20 HIGH redaction; JoinPanel JoinPrefill/JoinState bootstrapToken field + applyPrefill + legacy-deep-link guard + empty-bearer literal removal; CloudTransport.swapToken + swapInProgress flag; SessionClient cloudSwapCompleted orchestration; relay/test/bootstrapJoinerE2E.test.js E2E test. 32 new extension tests + 2 relay tests.

**Test counts (verified firsthand by running both suites):**
- Extension: **1061 passing, 66 pending, 0 failing** (target: ≥1061 per 07-14 SUMMARY)
- Relay: **79 passing, 0 failing** (target: ≥79 per 07-14 SUMMARY)

## Goal Achievement

### Observable Truths (mapped to ROADMAP SCs)

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | **SC-1**: Host can start a cloud session from the same wizard used for LAN — UI shows "Cloud" mode and no extra steps required vs LAN | **VERIFIED** (pass 2; unchanged) | Wizard.js Cloud radio + relay-URL step + 4-arg buildDeepLink with &bt=; WizardPanel.handleWizardComplete cloud branch dispatches to SessionHostFactory.createCloud; SessionHostFactory mints + attaches bootstrapToken; host-side E2E proven by serverAuthIntegration.test.js test 1. |
| 2 | **SC-2**: Member on a different network can join a cloud session by entering relay address + credentials — connection lifecycle identical to LAN mode | **VERIFIED** (was: failed passes 1+2) | relay/test/bootstrapJoinerE2E.test.js Test 1 "E2E: bootstrap JWT → auth-response → real-JWT reconnect; registry shows real per-joiner sub, NOT bootstrap sub" passes in 274ms against `requireAuth: true`. Extension wiring confirmed: UriHandler bt parse (extension.ts:278), JoinPanel threads bootstrapToken into CloudTransport (JoinPanel.ts:372), CloudTransport.swapToken atomically closes bootstrap socket and reconnects (CloudTransport.ts:521), SessionClient cloudSwapCompleted defers connection-changed until post-swap second auth-response (SessionClient.ts:319-352). Zero empty-bearer literals remain in JoinPanel.ts (grep gate N-07-14-C: 0 hits). |
| 3 | **SC-3**: Connection status indicator correctly reflects cloud relay connection health — connecting / connected / relay-unreachable / session-not-found / reconnecting are distinct and accurate | **VERIFIED** (pass 1; unchanged) | StatusBarManager.setCloudStatus + CloudTransport.mapCloseCodeToState: 3 distinct states (connected / relay-unreachable / session-not-found) surfaced. swapInProgress flag additionally suppresses state-change emit during the bootstrap-swap window (cloudTransportSwapToken.test.ts test 2 pins no-flicker). T-07-23 pinned: state-change handler receives only string enum value, NEVER the JWT. |

**Score: 3/3** truths verified.

### SC-2 Closure Chain — End-to-End Wiring Trace

The following is the complete data-flow from host share to joiner connected, verified against the actual code:

| Step | Actor | Code Location | Verified By |
|---|---|---|---|
| 1. Host mints bootstrap JWT | TokenService.issueBootstrap | src/auth/TokenService.ts:92-100 | bootstrapTokenIssue.test.ts 12 tests; grep: `'15m'`=2, `'bootstrap-'`=2, `setProtectedHeader({ alg: 'HS256' })`=2 |
| 2. SessionHostFactory mints + attaches to SessionHost | SessionHostFactory.createCloud | src/host/SessionHostFactory.ts:135-139 | hostBootstrapTokenWiring.test.ts 8 tests |
| 3. WizardPanel picks up token from SessionHost | getBootstrapToken() → state.bootstrapToken | src/ui/WizardPanel.ts (cloud branch) | wizardDeepLinkBootstrap.test.ts 13 tests |
| 4. Deep-link renders &bt= JWT | wizard.js buildDeepLink 4-arg | src/ui/webview/wizard/wizard.js:21-34 | wizardDeepLinkBootstrap.test.ts; grep: `&bt=`=4 hits in wizard.js |
| 5. UriHandler parses bt from deep-link | params.get('bt') | src/extension.ts:278 | uriHandlerBootstrapToken.test.ts 11 tests; T-07-20: bt=<redacted> literal present (3 hits), 0 unredacted appendLine sites |
| 6. JoinPrefill → JoinState → CloudTransport | applyPrefill + constructor | src/ui/JoinPanel.ts:304, 372 | joinPanelBootstrapToken.test.ts 8 tests; N-07-14-C: 0 empty-bearer literals |
| 7. Bootstrap WSS upgrade accepted by relay | relay verifyToken (role:member path) | relay/src/auth.ts:74-164 | bootstrapJoinerE2E.test.js Test 2 precondition (requireAuth:true) |
| 8. auth-request byte-pass-routed to host | relay/src/router.ts (T-07-02) | relay/src/router.ts | grep: 0 `.payload` refs; E2E test step exercises live routing |
| 9. Host issues real per-joiner JWT in auth-response | SessionHost.handleAuthRequest | src/host/SessionHost.ts | serverAuthIntegration.test.js test 3 (existing) |
| 10. SessionClient triggers swapToken on first auth-response | cloudSwapCompleted guard + cloud.swapToken(msg.token) | src/client/SessionClient.ts:319-335 | sessionClientCloudReconnect.test.ts 5 tests |
| 11. CloudTransport.swapToken closes bootstrap socket, reconnects with real JWT | swapToken + swapInProgress | src/network/CloudTransport.ts:521-537 | cloudTransportSwapToken.test.ts 9 tests |
| 12. Second auth-response arrives over real-JWT socket → connection-changed:connected emitted | cloudSwapCompleted=true → legacy path | src/client/SessionClient.ts:352 | sessionClientCloudReconnect.test.ts test 2 |
| 13. Registry shows real per-joiner sub, NOT bootstrap sub | relay SessionRegistry | relay/src/registry.ts | bootstrapJoinerE2E.test.js Test 1 assertions: memberSubs.includes(REAL_JOINER_ID) AND !memberSubs.includes('bootstrap-'+SESSION_ID) |

### Required Artifacts

| Artifact | Description | Status | Details |
|---|---|---|---|
| `src/auth/TokenService.ts` | issueBootstrap method — 15m role:member JWT minter | VERIFIED | :92-100 — issueBootstrap present; '15m' literal (grep: 2); 'bootstrap-' literal (grep: 2); HS256 header pin (grep: 2) |
| `src/host/SessionHost.ts` | attachBootstrapToken + getBootstrapToken single-shot setter/getter | VERIFIED | :354-375 — both methods wired |
| `src/host/SessionHostFactory.ts` | issueBootstrap + attachBootstrapToken call in createCloud | VERIFIED | :135-139 — mint before _testHostJwt, attach to host |
| `src/ui/WizardPanel.ts` | bootstrapToken WizardState field + cloud-branch pickup | VERIFIED | bootstrapToken in interface + initialState + getBootstrapToken() pickup |
| `src/ui/webview/wizard/wizard.js` | 4-arg buildDeepLink with &bt= | VERIFIED | :21-34 — 4-arg; 2 call sites pass state.bootstrapToken; LAN regression byte-identical |
| `src/extension.ts` | UriHandler bt parse + T-07-20 redaction + openPrefilled thread | VERIFIED | :278 params.get('bt'); :324 btLog conditional redaction; :334 bootstrapToken:bt in prefill |
| `src/ui/JoinPanel.ts` | JoinPrefill + JoinState bootstrapToken + applyPrefill + empty-bearer removed | VERIFIED | :30,59 fields; :171 initial; :304 applyPrefill; :372 CloudTransport with bootstrapToken; 0 empty-bearer literals |
| `src/network/CloudTransport.ts` | swapToken method + swapInProgress flag | VERIFIED | :521 swapToken; :169 swapInProgress; grep: swapToken=6, swapInProgress=12 |
| `src/client/SessionClient.ts` | cloudSwapCompleted orchestration + connect/disconnect resets | VERIFIED | :87 field; :319-352 swap branch; :196 connect reset; :707 disconnect reset; 0 'bootstrap-' literals |
| `relay/test/bootstrapJoinerE2E.test.js` | E2E test against requireAuth:true | VERIFIED | 370 lines, 2 tests, both PASS; Test 1 full round-trip asserts registry composition |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `wizard.js buildDeepLink` | `&bt=` deep-link param | 4-arg call with `state.bootstrapToken` | WIRED | 2 call sites confirmed; encodeURIComponent wraps JWT |
| `extension.ts UriHandler` | `JoinPanel.openPrefilled` | `bootstrapToken: bt` in prefill literal | WIRED | extension.ts:334; 11 unit tests |
| `JoinPanel.handleJoinConnect` | `CloudTransport constructor` | `new CloudTransport(relayUrl, sessionId, this.state.bootstrapToken)` | WIRED | JoinPanel.ts:372; zero empty-bearer hits |
| `CloudTransport` (bootstrap socket) | relay verifyToken | Authorization header with bootstrap JWT | WIRED | bootstrapJoinerE2E.test.js Test 2 precondition: opened===true against requireAuth:true |
| relay router | host CloudHostTransport | T-07-02 byte-pass-through | WIRED | 0 `.payload` refs in router.ts; E2E test exercises live routing |
| `SessionClient.handleMessage auth-response` | `CloudTransport.swapToken` | `cloud.swapToken(msg.token)` | WIRED | SessionClient.ts:335; sessionClientCloudReconnect.test.ts test 1 |
| `CloudTransport.swapToken` | relay verifyToken (real JWT) | close bootstrap (code 1000) + reopen with `this.token = newToken` | WIRED | bootstrapJoinerE2E.test.js Test 1 full round-trip; cloudTransportSwapToken.test.ts test 1 |
| relay registry | real per-joiner memberId | `session.memberSubs` excludes bootstrap sub | WIRED | bootstrapJoinerE2E.test.js Test 1: `!memberSubs.includes('bootstrap-'+SESSION_ID)` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| `WizardPanel.ts` | `state.bootstrapToken` | `host.getBootstrapToken()` from `SessionHostFactory.createCloud` → `tokenService.issueBootstrap()` | Yes — cryptographically signed JWT minted per session | FLOWING |
| `JoinPanel.ts` | `state.bootstrapToken` | prefill.bootstrapToken from UriHandler → `params.get('bt')` from real deep-link URL | Yes — real JWT from host's deep-link | FLOWING |
| `CloudTransport.ts` | `this.token` | initial = bootstrapToken from JoinPanel; post-swap = real JWT from `auth-response.token` | Yes — real JWT in both phases; swap is atomic | FLOWING |
| `SessionClient.ts` | `this.memberId` | post-swap second auth-response `.memberId` field from host's `handleAuthRequest` | Yes — real per-joiner identity; NOT bootstrap sub | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Extension test suite: 1061 passing | `npm test` (run directly) | **1061 passing, 66 pending, 0 failing in 16s** | PASS |
| Relay test suite: 79 passing | `cd relay && npm test` (run directly) | **79 passing, 0 failing in ~2s** | PASS |
| E2E: bootstrap JWT → real-JWT reconnect; registry correct | `node --test relay/test/bootstrapJoinerE2E.test.js` (run directly) | **2/2 pass in 280ms against requireAuth:true** | PASS |
| E2E precondition: bootstrap JWT accepted by verifyClient | Test 2 in bootstrapJoinerE2E.test.js | **PASS** — bootstrap JWT shape accepted by relay's existing verifyToken path | PASS |
| swapToken = 0 calls in SC-3 during normal swap | cloudTransportSwapToken.test.ts test 2 | No `relay-unreachable` state-change fired during swap window (swapInProgress gate) | PASS |
| Empty-bearer literal removed | `grep -c "new CloudTransport(relayUrl, sessionId, '')" src/ui/JoinPanel.ts` | **0** | PASS |
| bootstrap- in SessionClient | `grep -c "bootstrap-" src/client/SessionClient.ts` | **0** | PASS |

### Source-Grep Gate Results (all 13 — verified firsthand)

| # | Gate | Expected | Actual | Status |
|---|---|---|---|---|
| T-07-02 | `grep -c '\.payload' relay/src/router.ts` | 0 | **0** | PASS |
| T-07-05 | `grep -rE 'inviteCode' relay/src/ \| wc -l` | 0 | **0** | PASS |
| T-07-11 relay | `grep -c "algorithms: \['HS256'\]" relay/src/auth.ts` | ≥1 | **2** | PASS |
| T-07-11 host | `grep -c "setProtectedHeader({ alg: 'HS256' })" src/auth/TokenService.ts` | 2 | **2** | PASS |
| bootstrap exp | `grep -c "'15m'" src/auth/TokenService.ts` | ≥1 | **2** | PASS |
| bootstrap sub | `grep -c "bootstrap-'" src/auth/TokenService.ts` | ≥1 | **2** | PASS |
| logger discipline | `grep -rE '^\s*console\.' relay/src/ \| wc -l` | 0 | **0** | PASS |
| HI-06 | `grep -A 3 "requireAuth: 'test'" relay/src/server.ts \| grep -c "NODE_ENV"` | ≥1 | **1** | PASS |
| T-07-13 redact | `grep -c "bt=<redacted>" src/extension.ts` | ≥1 | **3** | PASS |
| N-07-14-C | `grep -c "new CloudTransport(relayUrl, sessionId, '')" src/ui/JoinPanel.ts` | 0 | **0** | PASS |
| N-07-14-B | `grep -c "bootstrap-" src/client/SessionClient.ts` | 0 | **0** | PASS |
| swapToken | `grep -c "swapToken" src/network/CloudTransport.ts` | ≥1 | **6** | PASS |
| swapInProgress | `grep -c "swapInProgress" src/network/CloudTransport.ts` | ≥2 | **12** | PASS |

All 13 gates PASS.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| NET-06 | 07-13, 07-14 | Cloud mode works with the same UX as LAN (same protocol, different transport) | SATISFIED | SC-1 (wizard parity), SC-2 (joiner bootstrap flow), SC-3 (status bar states) all VERIFIED; 1140 tests passing; E2E test proves end-to-end round-trip against requireAuth:true relay |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| (none) | — | No stubs, TODOs, or hardcoded empty values in the SC-2 closure code path | — | — |

The two previously-open BLOCKERs from prior passes are both resolved:

- `relay/src/server.ts:173` 503 stub — FIXED by BLOCKER 1 hotfix (commit 4413071; confirmed pass 2)
- `src/ui/JoinPanel.ts:331` empty-bearer literal — FIXED by plan 07-14 (commit 933255d; confirmed this pass — grep returns 0)

No new anti-patterns introduced. 07-14 SUMMARY section "Known Stubs" is empty. Full source scan of the 4 modified source files finds no placeholder strings, no `=[]`/`={}`/`=null` flowing to UI, no TODO markers in the SC-2 code path.

### Human Verification Required

Three items remain for human/live verification. These are NOT code gaps — all code-level evidence confirms the path is wired and tested. These require physical hardware, cloud infrastructure, or visual confirmation.

#### 1. MANUAL UAT-1 — Docker build smoke test

**Test:** `cd relay && docker build -t versioncon-relay-test .` followed by `docker run -p 8080:8080 versioncon-relay-test` and `curl http://localhost:8080/healthz`.
**Expected:** Build exits 0 in <60s; image runs `node dist/server.js` as USER node on port 8080; healthz returns `{ok:true,sessions:0,uptime_s:N}`.
**Why human:** Requires a running Docker daemon. Docker.app was offline locally during 07-12 execution; paper-verification of Dockerfile passed line-by-line. Unchanged from passes 1-2.

#### 2. MANUAL UAT-2 — End-to-end Fly.io deploy quickstart

**Test:** Follow relay/README.md from a clean checkout. Time the steps. Confirm `wss://*.fly.dev/healthz` returns `{ok:true,sessions:0}` within 5 minutes.
**Expected:** Unfamiliar developer can complete the deploy in under 5 minutes (CONTEXT D-03 phase-gate).
**Why human:** Requires a Fly.io account, flyctl installation, real cloud deploy, and stopwatch. Cannot be done programmatically.

#### 3. MANUAL UAT-3b — Two-machine live cloud session (SC-1 + SC-2 + SC-3 combined)

**Test:** Full 18-step procedure from 07-14-SUMMARY.md (preserved verbatim in that document). Key verification points:

- Step 5: Deep-link contains `&bt=eyJ...` (JWT-shaped string visible in share screen).
- Step 11: Status bar transition on joiner is clean — NO flicker through `relay-unreachable` during the bootstrap-swap window. (Proves T-07-21 + swapInProgress mitigation in production.)
- Step 17: Bob's OutputChannel shows `bt=<redacted>` — JWT NEVER logged in plaintext (T-07-20 HIGH mitigation confirmed in production).
- Step 18: Relay logs show REAL_JOINER_ID sub, NOT `bootstrap-<sessionId>` sub.
- Steps 19-21: SC-3 live: stop relay → `relay-unreachable`; restart → `connected`; host ends session → `session-not-found`.

**Expected:** All 18 steps complete without error. Pass criteria per 07-14-SUMMARY. Full SC-1 + SC-2 + SC-3 observable end-to-end in a real cloud network environment.
**Why human:** Requires two physical machines on different networks, a deployed Fly.io relay, and human eyes on status-bar transitions, presence panel, chat, push/pull, and OutputChannel content. The E2E integration test (bootstrapJoinerE2E.test.js) proves the code path is correct in-process; UAT-3b proves it in the real deploy environment including OS deep-link registration and real TLS routing.

## Conclusion

All three Phase 7 Success Criteria are now code-level verified. The phase goal — "Teams who are not on the same local network can use VersionCon over the internet with the exact same UI and workflow as LAN mode" — is achievable end-to-end with the code as it stands.

**Phase 7 mark-complete is unblocked at the code level.** Proceeding to Phase 8 is appropriate. The three Manual UAT items (UAT-1, UAT-2, UAT-3b) are live verification steps the user runs against a real deploy and are NOT blocking the code verdict.

---

_Re-verified: 2026-05-20T22:30:00Z_
_Pass 1: 2026-05-19T09:30:00Z — gaps_found 1/3 (BLOCKER 1 + BLOCKER 2)_
_Pass 2: 2026-05-19T13:30:00Z — gaps_found 2/3 (BLOCKER 1 fixed; BLOCKER 2 deferred)_
_Pass 3: 2026-05-20T22:30:00Z — human_needed 3/3 (all code-level SCs VERIFIED; Manual UAT pending)_
_Verifier: Claude (gsd-verifier, Sonnet 4.6)_
