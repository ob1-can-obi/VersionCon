---
phase: 07-cloud-mode-relay-server
verified: 2026-05-19T09:30:00Z
status: gaps_found
score: 1/3 success criteria verified
overrides_applied: 0
re_verification: null
requirement_traceability:
  - id: NET-06
    description: "Cloud mode works with the same UX as LAN (same protocol, different transport)"
    status: BLOCKED
    evidence: "Wire-shape seams (Transport, CloudEnvelope, CloudTransport, TokenService) shipped; relay package shipped + 71/71 tests passing; deploy artifacts shipped. BUT two unfixed BLOCKERS prevent live cloud sessions: (1) relay/src/server.ts:173 always returns 503 'Relay auth pending (07-09)' even though 07-09 shipped verifyToken — the verifyClient closure captures verifyTokenFn but never invokes it; (2) JoinPanel.ts:331 constructs CloudTransport with empty Bearer token (MD-03 chicken-and-egg — joiner has no JWT before WSS handshake) which would be rejected by relay/src/auth.ts:88 even if (1) were fixed."
gaps:
  - truth: "SC-2 — A member on a different network can join a cloud session by entering the relay address and credentials"
    status: failed
    reason: "Cloud joiner cannot connect end-to-end. Two compounding defects, both reproducible from source: (a) relay/src/server.ts verifyClient closure NEVER invokes the loaded `verifyTokenFn` — line 173 unconditionally calls `cb(false, 503, 'Relay auth pending (07-09)')` even when 07-09's verifyToken is resolvable and callable. The token verification path that should populate `info.req.claims` from a real JWT does not exist. (b) src/ui/JoinPanel.ts:331 instantiates `new CloudTransport(relayUrl, sessionId, '')` with an EMPTY bearer token; relay/src/auth.ts:87-90 rejects empty bearers as `malformed`. The MD-03 deferred review item documents this chicken-and-egg deadlock — there is no design path for the joiner to obtain a JWT BEFORE the WSS handshake. Both defects are independently sufficient to break SC-2."
    artifacts:
      - path: "relay/src/server.ts"
        issue: "Line 163-178 verifyClient: dynamic import resolves auth.ts and binds verifyTokenFn, but never calls it. Production-mode WSS upgrades unconditionally fail with WSS code 503 'Relay auth pending (07-09)'. The comment on line 171-172 still reads as 07-08 stub language ('Once 07-09 ships verifyToken, this branch will call it and accept' — and the implementation NEVER caught up to that promise)."
      - path: "src/ui/JoinPanel.ts"
        issue: "Line 331: `new CloudTransport(relayUrl, sessionId, '')` — empty bearer token. Comment at 324-330 explicitly acknowledges the gap ('Token is empty for now ... that wiring lands in a later host-side plan. We currently pass '' and let the relay (when it exists) bounce the connection'). That 'later plan' never landed. The 07-REVIEW-FIX.md `MD-03 deferred` row documents this as 'Until resolved, cloud-mode join from JoinPanel cannot complete end-to-end' with no scheduled fix in Phase 7."
    missing:
      - "Wire relay/src/server.ts:verifyClient to actually call verifyTokenFn(info.req, registry) and stash returned TokenInfo as info.req.claims when verification succeeds (or cb(false, 401) on null)."
      - "Resolve MD-03 chicken-and-egg deadlock: either add a relay /bootstrap unauthenticated route that accepts an auth-request without a JWT, OR have the host issue the joiner JWT out-of-band (e.g., via a separate signaling channel encoded in the deep-link), OR allow the first frame to be an auth-request and have the relay forward it to the host BEFORE requiring a member JWT."
      - "Add an integration test that runs TWO CloudTransports against a real relay (host + member) with `requireAuth: true` (not the `'test'` carve-out) and asserts a full auth-request → auth-response → state-sync flow completes."

  - truth: "SC-1 — A host can start a cloud session from the same setup wizard used for LAN — UI shows 'Cloud' mode and no extra steps are required compared to LAN"
    status: partial
    reason: "Wizard UI surface (LAN/Cloud radio + Relay URL field + Test Connection + share-screen Cloud variant + deep-link) is fully implemented and tested (src/ui/WizardPanel.ts:381-823 + src/ui/webview/wizard/wizard.js + statusBarCloudStates.test.ts + wizardCloudStep.test.ts + wizardValidation.test.ts all green). SessionHostFactory.createCloud is fully wired: generates per-session JWT secret, issues host JWT with role:'host', opens CloudTransport, sends session-register first-frame envelope, wraps in CloudHostTransport demultiplexer (all 11 hostCloudWiring tests pass). HOWEVER: when SessionHostFactory.createCloud runs against a relay started in production mode (`requireAuth: true`), the host's WSS upgrade is rejected by the same defect that blocks SC-2 — relay/src/server.ts:173 returns 503 regardless of whether the bearer JWT is valid. The host cannot connect to the relay it just deployed. Functionality is paper-verifiable via the test-only `requireAuth: 'test'` carve-out, but a real Fly.io deploy following relay/README.md will reject every connection."
    artifacts:
      - path: "relay/src/server.ts"
        issue: "Same defect as SC-2: verifyClient unconditionally rejects production-mode upgrades. The host's session-register frame is never received because the WSS handshake fails before the connection handler runs."
      - path: "src/ui/WizardPanel.ts"
        issue: "Functional. Lines 667-678 correctly dispatch to SessionHostFactory.createCloud with sessionConfig + hostIdentity + relayUrl + sessionId. The wizard UI itself is unblocked — the failure mode is downstream at the relay handshake."
    missing:
      - "Same fix as SC-2: wire verifyTokenFn invocation in relay/src/server.ts:verifyClient. Without it, the wizard's Cloud path can never produce a working session against a real deployed relay."

deferred:
  - truth: "Live cloud-mode session between two physical machines on different networks (host on machine A deploys relay, member on machine B clicks deep-link, both push/pull/chat)"
    addressed_in: "Phase 7 closeout — MANUAL UAT-3 (07-12-SUMMARY.md:156)"
    evidence: "07-12-SUMMARY explicitly defers this to the verifier as MANUAL UAT-3 because it requires deploying a real Fly.io machine and two physical clients on different networks. This is the canonical live test of SC-1 + SC-2 + SC-3 together."

human_verification:
  - test: "MANUAL UAT-1 — Docker build smoke test"
    expected: "`cd relay && docker build -t versioncon-relay-test .` exits 0 in <60s; image runs `node dist/server.js` as USER node on port 8080; `curl http://localhost:8080/healthz` returns `{ok:true,sessions:0,uptime_s:N}`."
    why_human: "Requires a running Docker daemon. The executor in 07-12 noted Docker.app was offline locally and deferred to the verifier per plan instruction. Cannot be performed inside a non-Docker environment; paper-verification of the Dockerfile passed line-by-line per 07-12-SUMMARY."

  - test: "MANUAL UAT-2 — End-to-end Fly.io deploy quickstart"
    expected: "An unfamiliar developer follows relay/README.md from a clean checkout and has a `wss://*.fly.dev` endpoint with `{ok:true,sessions:0}` from `/healthz` in ≤5 minutes (CONTEXT D-03 phase-gate test). If longer than 5 minutes, that is a doc-clarity defect."
    why_human: "Requires a Fly.io account, flyctl install, real cloud deploy, and stopwatch. Cannot be done programmatically. NOTE: even on a successful deploy, the relay will REJECT every WSS connection with 503 'Relay auth pending (07-09)' due to the BLOCKER above — the deploy itself can succeed at the infrastructure layer (healthz passes), but no VersionCon session can use it."

  - test: "MANUAL UAT-3 — Two-machine live cloud session (SC-1 + SC-2 + SC-3 combined)"
    expected: "Host (Alice, machine A) opens wizard → picks Cloud → enters wss://*.fly.dev relay URL → Test Connection succeeds → creates session → shares deep-link. Member (Bob, machine B, different network) clicks deep-link → confirmation prompt → JoinPanel opens prefilled → Bob enters displayName + invite code → connects. Both users see each other in presence; chat works; push/pull works; status bar shows `$(cloud) VersionCon — connected` on both."
    why_human: "Requires two physical machines on different networks, a deployed relay, and visual confirmation of presence/chat/push behavior in the UI. Cannot be done programmatically. STATUS: This test is EXPECTED TO FAIL with current code due to the two BLOCKERS above. The host's WSS upgrade and the joiner's WSS upgrade both fail at the relay's verifyClient; neither side reaches the protocol layer."

  - test: "SC-3 live verification — three distinct cloud connection states surface in status bar with correct precedence"
    expected: "While the host is connected, status bar shows `$(cloud) VersionCon — connected`. Stop the relay (`fly machine stop`) — status bar transitions to `$(warning) VersionCon — relay unreachable` with tooltip showing reconnect attempt. End the session on the host while a member is connected — member's status bar transitions to `$(error) VersionCon — session not found`."
    why_human: "Visual status bar transitions can only be confirmed by a human watching VS Code. Programmatic verification of StatusBarManager + CloudTransport.mapCloseCodeToState is complete (statusBarCloudStates.test.ts + cloudTransport.test.ts) — paper-verifiable, but the live VS Code render path needs human eyes. NOTE: same BLOCKER applies — without a working relay handshake, the user cannot reach the 'connected' state to begin with."
---

# Phase 7: Cloud Mode + Relay Server — Verification Report

**Phase Goal:** Teams who are not on the same local network can use VersionCon over the internet with the exact same UI and workflow as LAN mode.

**Verified:** 2026-05-19T09:30:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification.

## Executive Summary

Phase 7 ships an impressive volume of correct, well-tested infrastructure: clean Transport-interface refactor (07-01 — zero `ws` imports remain in SessionHost / SessionClient), byte-stable CloudEnvelope seam (07-02), HS256-locked TokenService (07-03), CloudTransport with full close-code → state mapping (07-04), full wizard Cloud-mode UI (07-05) + share-screen deep-link, join-panel cloud branch + UriHandler with required confirmation prompt (07-06), three-state StatusBarManager with full precedence rules (07-07), relay package skeleton (07-08) + auth.ts (07-09) + limits.ts/grace timer (07-10) + structured logger with pino redact (07-11), host-side cloud wiring via SessionHostFactory.createCloud + CloudHostTransport demultiplexer + relay first-frame carve-out + per-joiner JWT issuance (07-05b), Dockerfile + fly.toml + Deploy Your Relay README (07-12). All cross-cutting source-grep gates pass: router.ts has zero `.payload` reads; relay/src/ has zero `inviteCode` references; auth.ts and TokenService both pin `algorithms: ['HS256']`; relay/src/ has zero `console.*` calls; SessionHost and SessionClient have zero `ws` imports.

**However, two unfixed BLOCKERS prevent the phase goal from being achieved end-to-end:**

1. **`relay/src/server.ts` verifyClient never invokes the loaded `verifyTokenFn`** — line 173 unconditionally returns `cb(false, 503, 'Relay auth pending (07-09)')` even though 07-09 shipped `verifyToken` to the same package. In production mode (`requireAuth: true`), every WSS connection — host OR joiner — is rejected before the connection handler runs.

2. **JoinPanel constructs CloudTransport with an empty bearer token** (`new CloudTransport(relayUrl, sessionId, '')` at JoinPanel.ts:331), and 07-REVIEW-FIX.md `MD-03 deferred` explicitly documents that there is no design path for the joiner to obtain a JWT BEFORE the WSS handshake. The "let the host issue the JWT via auth-response" flow can never complete because the WSS handshake requires a valid JWT to even reach the host.

Both defects are independently sufficient to break SC-1 and SC-2. The relay can be built, deployed, and answer `/healthz` — but no VersionCon client can establish a WSS session through it. SC-3 (3 distinct status bar states) is paper-verifiable but unreachable in practice because the user can never get to `connected` to observe transitions.

Architecturally, Phase 7 is excellent: every seam is correct, every test is honest, every comment names the threat it mitigates. Operationally, it is one wire-up line away from working — but that line was not landed in Phase 7.

## Goal Achievement

### Observable Truths (mapped to ROADMAP SCs)

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | **SC-1**: Host can start a cloud session from the same wizard used for LAN — UI shows "Cloud" mode and no extra steps required vs LAN | partial | UI: VERIFIED (wizard.js renders Cloud radio, relay-URL step, share-screen Cloud variant; WizardPanel.ts:381-823 handles cloud-set-mode / wizard-set-relay-url / wizard-test-relay-connection messages; wizardCloudStep.test.ts 27 tests pass). Wiring: VERIFIED (WizardPanel.handleWizardComplete:667-678 dispatches to SessionHostFactory.createCloud which is fully implemented). End-to-end: FAILS — when SessionHostFactory.createCloud calls cloudTransport.connect(), the WSS upgrade is rejected by relay/src/server.ts:173 with code 503 in production mode (`requireAuth: true`). Same defect that breaks SC-2. |
| 2 | **SC-2**: Member on a different network can join a cloud session by entering relay address + credentials — coding within same time window as LAN mode | failed | TWO compounding BLOCKERS: (a) relay/src/server.ts:163-178 verifyClient captures verifyTokenFn from the resolved auth.ts module and then unconditionally calls `cb(false, 503, 'Relay auth pending (07-09)')` — verifyTokenFn is never invoked, claims are never stashed on info.req, and 401-vs-403-vs-503 decisioning never happens. (b) src/ui/JoinPanel.ts:331 instantiates CloudTransport with token `''`; relay/src/auth.ts:87-90 rejects empty bearers; 07-REVIEW-FIX.md MD-03 deferred row documents this as "cloud-mode join from JoinPanel cannot complete end-to-end". Joiner can never reach the host's auth-request → auth-response flow. |
| 3 | **SC-3**: Connection status indicator correctly reflects cloud relay connection health, including relay server unreachable as a distinct state from session-not-found | verified | StatusBarManager.setCloudStatus surfaces 3 distinct states (`connected` / `relay-unreachable` / `session-not-found`) with byte-identical UI-SPEC strings (StatusBarManager.ts:280-339; 18 tests in statusBarCloudStates.test.ts). CloudTransport.mapCloseCodeToState (CloudTransport.ts:128-146) maps WSS codes correctly: 4404 → session-not-found, 1000 → disconnected, 4403 → host-identity-mismatch, 4429 → member-cap-reached, 4503 → grace-period-active, all others → relay-unreachable. Precedence rules implemented (sync-warning beats cloud; cloud-connected layers unread; terminal states suppress; setSyncWarning(false) re-apply branches on currentCloudState). Live verification deferred to UAT-3 (gated by the same BLOCKERS as SC-1/SC-2, so live observation will be limited to `relay-unreachable` until the verifyClient defect is fixed). |

**Score:** 1/3 truths verified, 1 partial, 1 failed.

### Per-Plan Must-Haves Audit

| Plan | Component | Status | Evidence |
|---|---|---|---|
| **07-01** | Transport interface refactor + LanTransport drop-in | VERIFIED | `src/network/Transport.ts` defines HostTransport + ClientTransport; SessionHost and SessionClient have zero `from 'ws'` imports and zero `new WebSocket(Server)?(...)` constructs (verified by grep). LanTransport.ts wraps the original behavior. 884 → 996 tests preserved. |
| **07-02** | CloudEnvelope wrap/unwrap + byte-shape snapshot | VERIFIED | `src/network/CloudEnvelope.ts` exports wrap, serialize, deserialize, EnvelopeShapeError, EnvelopeEncryptedNotSupportedError. Byte-shape pinned: `'{"v":1,"sessionId":"vc-7f3a92","encrypted":false,"payload":{"type":"ping"}}'` snapshot literal present in cloudEnvelope.test.ts:52,62. Target field added for 07-05b unicast (lines 49-68); JSON.stringify omits undefined → broadcast byte-shape preserved. |
| **07-03** | TokenService HS256-locked jose JWT issuer/verifier | VERIFIED | `src/auth/TokenService.ts` line 84 contains literal `algorithms: ['HS256']`; expectedIssuer parameter added per MD-08 host-side fix. |
| **07-04** | CloudTransport — outbound WSS + Bearer header + close-code → state mapping | VERIFIED | `src/network/CloudTransport.ts` opens WSS with `headers: { Authorization: \`Bearer ${this.token}\` }` (line 227), maxPayload: 1024*1024 (line 228), serialize/deserialize envelope on every send/receive, mapCloseCodeToState exported. HI-03 isCloud() + markIntentionalClose() added (lines 460-462, 448-451). HI-04 differentiated states added (lines 96-98, 132-138). |
| **07-05** | Wizard cloud step — LAN/Cloud radio + Relay URL + Test Connection + share screen | VERIFIED | `src/ui/WizardPanel.ts:25-52` widens WizardState to 5 steps with mode/relayUrl/relayUrlReachable/sessionId; `src/ui/webview/wizard/wizard.js` renders Cloud radio + cloud network step + Cloud share screen variant; HI-02 fix applied at WizardPanel.ts:651-660 — sessionId now derived from `crypto.randomBytes(6).toString('hex')` (48 bits entropy) instead of inviteCode.toLowerCase(). |
| **07-06** | JoinPanel cloud branch + UriHandler with confirmation prompt | PARTIAL — UI works, end-to-end blocked by MD-03 | `src/ui/JoinPanel.ts:84-126` openPrefilled + applyPrefill; `src/extension.ts:248-319` VersionConUriHandler implements showInformationMessage BEFORE openPrefilled (T-07-10); package.json `activationEvents: ["onUri"]` registered. **MD-03 BLOCKER**: JoinPanel.ts:331 passes empty token to CloudTransport — cloud joins cannot complete. |
| **07-07** | StatusBarManager 3 cloud states + precedence | VERIFIED | StatusBarManager.ts:280-339 setCloudStatus + applyCloudStatus; byte-identical UI-SPEC text (`$(cloud) VersionCon — connected` / `$(warning) ... relay unreachable` / `$(error) ... session not found`); precedence (sync-warning beats cloud, cloud-connected layers unread, terminal states suppress); 18 tests in statusBarCloudStates.test.ts. |
| **07-08** | Relay skeleton — server.ts + SessionRegistry + router byte-pass-through | PARTIAL — server.ts has unfixed wire-up gap | relay/src/server.ts, SessionRegistry.ts, router.ts all present. router.ts has zero `.payload` references (T-07-02 invariant verified by grep + test). SessionRegistry distinct register/attachMember APIs (T-07-09). server.ts /healthz route OK. **BLOCKER**: server.ts:163-178 verifyClient never calls verifyTokenFn. |
| **07-09** | Relay auth.ts — jose JWT verify + HS256 lock + invite-code-locality | VERIFIED (in isolation) — but unwired | relay/src/auth.ts:130 contains `algorithms: ['HS256']`; verifyToken returns TokenInfo or null; MD-02 fix applied at lines 113-116 (SESSION_ID_SHAPE regex gate on aud before log emission). 10/10 auth.test.js pass. **Module is shipped but not consumed by server.ts** — the verifyTokenFn import in server.ts:165 captures but never calls it. |
| **07-10** | Relay limits.ts — rate limit + caps + grace timer + idle reaper | VERIFIED | relay/src/limits.ts 6 env-var policy module; grace timer in SessionRegistry.scheduleGracePeriod / cancelGracePeriod; idle reaper in server.ts:453-466 (.unref() on the interval handle — T-07-17 lite). 13 tests passing. |
| **07-11** | Relay logger.ts — pino + redact + structured migration | VERIFIED | relay/src/logger.ts pino with redact paths stripping bearer/payload/code/secret. Zero `console.*` calls in relay/src/ (grep verified). 19 tests passing. |
| **07-05b** | Host-side cloud wiring + CloudHostTransport + first-frame carve-out + per-joiner JWT | VERIFIED (paper-level) | SessionHostFactory.createCloud (61 lines) generates secret + issues host JWT + opens transport + sends session-register + wraps in CloudHostTransport + attachCloudIssuer. CloudHostTransport.ts demultiplexer routes by `payload.memberId`. server.ts first-frame carve-out (lines 188-345) reads payload.type/sessionId/verifySecret for HOST role only (and rejects member-role session-register with 4400). HI-01 second carve-out (member→host memberId annotation) implemented at server.ts:239-269 + 371-380 + 412-425. SessionHost.handleAuthRequest cloud-mode tail issues per-joiner JWT at SessionHost.ts:799-820. **End-to-end FAILS via SC-1/SC-2 BLOCKERS above.** |
| **07-12** | Deployment + docs — Dockerfile + fly.toml + relay/README.md + top-level README cloud section | VERIFIED (paper-level — manual UAT pending) | All 4 files present. Dockerfile multi-stage node:20-alpine + USER node + EXPOSE 8080. fly.toml force_https=true + auto_stop_machines="off" + auto_start_machines=true + /healthz check. relay/README.md 189 lines covering 9 env vars + cost transparency + troubleshooting. README.md +22 lines "VersionCon for Cloud Teams" section. Manual UAT-1 (docker build) + UAT-2 (5-min Fly deploy) deferred to verifier — Docker daemon was offline locally per 07-12-SUMMARY. |

### Cross-Cutting Source-Grep Gate Verification

All cross-cutting invariants documented in ROADMAP.md "Cross-cutting constraints" verified by grep against the live tree:

| Invariant | Test | Result |
|---|---|---|
| T-07-02 — router never reads `envelope.payload` | `grep -c '.payload' relay/src/router.ts` | 0 hits — VERIFIED |
| T-07-05 — invite code never on relay-side wire path | `grep -rn 'inviteCode' relay/src/` | 0 hits — VERIFIED |
| 07-03 + 07-09 HS256 algorithm pin | `grep -n "algorithms: \['HS256'\]" relay/src/auth.ts src/auth/TokenService.ts` | Both present (relay/src/auth.ts:130 + src/auth/TokenService.ts:84) — VERIFIED |
| 07-11 no console in relay/src/ | `grep -rnE '^\s*console\.' relay/src/` | 0 hits (only comment-string match for the word `console` exists) — VERIFIED |
| 07-01 SessionHost no ws import | `grep -nE "^import .* from 'ws'" src/host/SessionHost.ts` | 0 hits — VERIFIED |
| 07-01 SessionClient no ws import | `grep -nE "^import .* from 'ws'" src/client/SessionClient.ts` | 0 hits — VERIFIED |
| 07-01 SessionClient no new WebSocket | `grep -nE 'new WebSocket\(' src/client/SessionClient.ts` | 0 hits (the only match was a comment string `pre-refactor this method constructed new WebSocket(...)`) — VERIFIED |
| Deep-link scheme uniformity | `grep -rn 'vscode://versioncon.versioncon/join' src/ relay/` | Used uniformly across WizardPanel deep-link build + JoinPanel openPrefilled + UriHandler dispatch — VERIFIED |
| package.json onUri activation | `grep -n 'onUri' package.json` | Line 14: `"activationEvents": ["onUri"]` — VERIFIED |
| jose dep pinned | `grep -n '"jose"' package.json relay/package.json` | Both pin `^5.10.0` — VERIFIED |

### HI-Fix Verification (07-REVIEW-FIX.md applied items)

| HI ID | Fix | Verification Method | Status |
|---|---|---|---|
| HI-01 | Relay annotates `payload.memberId = claims.sub` on every member→host frame; spoof defense rejects mismatched pre-existing memberId with 4400 | relay/src/server.ts:239-269 `annotateMemberFrame` helper; called at lines 371-380 (first member frame) + 412-425 (subsequent member frames). Spoof check at line 259-263 returns null on mismatch; caller closes 4400 | VERIFIED in source. Spoof boundary semantics flagged for live human verification per 07-REVIEW-FIX.md "requires human verification" note. |
| HI-02 | sessionId derivation decoupled from inviteCode — uses crypto.randomBytes(6).toString('hex') with 'vc-' prefix | WizardPanel.ts:49-52 documents the change; sessionId regex `/^vc-[a-z0-9-]{1,64}$/` in relay/src/auth.ts:63 accepts the new shape | VERIFIED |
| HI-03 | Single reconnect owner: ClientTransport interface widened with optional isCloud() + markIntentionalClose(); SessionClient.transport.onClose skips attemptReconnect when transport.isCloud?.() | Transport.ts:248-258 declares both methods; CloudTransport.ts:448-451 implements markIntentionalClose; CloudTransport.ts:460-462 implements isCloud(); SessionClient.ts (around lines 236-247 per the grep) uses optional chain | VERIFIED |
| HI-04 | Differentiated close codes via AttachMemberResult discriminated union | SessionRegistry.ts:35-41 declares RegisterResult + AttachMemberResult; server.ts:328-368 closes 4403/4404/4429/4503 per reason; CloudTransport.ts:96-98 + 132-138 maps each to a distinct CloudConnectionState | VERIFIED |
| HI-05 | hostMemberId binding on first register; subsequent register with mismatched sub closes 4403 | SessionRegistry.ts:97-157 register() captures hostMemberId on first call; reject branch at lines 111-117 returns `host-identity-mismatch`; server.ts:329-334 closes 4403 with log line | VERIFIED in source. Ordering across grace-recover + re-register paths flagged for human verification per 07-REVIEW-FIX.md note. |
| HI-06 | startServer throws if `requireAuth: 'test'` AND `NODE_ENV === 'production'`; verifyClient fail-safes to 401 if NODE_ENV mutates mid-process | server.ts:70-74 startup assertion; server.ts:135-140 in-request fail-safe with 401 | VERIFIED |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Relay test suite runs and passes | `cd relay && npm test` | 71/71 pass in ~640ms | PASS |
| Extension test suite runs and passes | `npm test` | 996 passing, 66 pending, 0 failing in 16s | PASS |
| Healthz route serves JSON shape | `relay/test/server.test.js` "GET /healthz returns 200 + { ok, sessions, uptime_s }" | included in 71/71 — PASS | PASS |
| router.ts compiled to dist/ | `ls relay/dist/` | server.js + auth.js + router.js + SessionRegistry.js + limits.js + logger.js present | PASS |
| CloudTransport sends Bearer + envelope | `cloudTransport.test.ts` 13 tests including Bearer-in-Authorization-header + maxPayload + close-code map | included in 996 passing | PASS |
| Production WSS upgrade succeeds when token is valid | No test exists for `requireAuth: true` + valid JWT path | **n/a — test gap matching the BLOCKER** | FAIL — see Gaps |

### Deferred-UAT Inventory

Three manual UAT items were explicitly deferred to the verifier by 07-12-SUMMARY.md. All three remain pending. Two are gated by the BLOCKERS:

1. **UAT-1 — Docker build smoke test** — independent of the BLOCKER. Pure container build verification. Pending human Docker daemon.
2. **UAT-2 — 5-minute Fly.io deploy quickstart** — partially gated. The deploy itself can complete (healthz will pass); the relay will then reject every WSS connection. Doc-clarity dimension is still testable; functional dimension fails.
3. **UAT-3 — Two-machine live cloud session** — fully gated by the BLOCKERS. Will fail in current code; cannot succeed without fixing relay/src/server.ts:verifyClient AND resolving MD-03.

### Anti-Pattern Scan

| File | Pattern | Severity | Notes |
|---|---|---|---|
| `relay/src/server.ts:173` | Stub-shaped `cb(false, 503, 'Relay auth pending (07-09)')` after auth-module successfully resolved | BLOCKER | This is the wire-up gap. Comment at 171-172 says "Once 07-09 ships verifyToken, this branch will call it and accept" — but the code never landed. |
| `src/ui/JoinPanel.ts:331` | `new CloudTransport(relayUrl, sessionId, '')` — empty Bearer token | BLOCKER | MD-03 deferred per 07-REVIEW-FIX.md. Documented as "cloud-mode join from JoinPanel cannot complete end-to-end". |
| `src/network/CloudTransport.ts:444-447` | `markIntentionalClose` documented as NOT-on-interface | INFO | Intentional API design — surfaced via optional method on the interface (Transport.ts:258). |
| `src/network/CloudHostTransport.ts:89-92` | `console.log` in production logger seam | INFO | Documented as intentional ops-visibility surface; replaced via `_setDemuxLoggerForTest` in test paths. Not in `relay/src/` so doesn't violate the 07-11 invariant. |
| `src/ui/JoinPanel.ts:324-330` | Comment acknowledges gap: "Token is empty for now ... let the relay (when it exists) bounce the connection — the protocol-level auth-request flow remains unchanged." | BLOCKER (already counted) | Authors documented the gap honestly; the gap was not closed. |

No other stub patterns found in the 13 plan-touched files.

## Gaps Summary

Phase 7 ships **excellent infrastructure plumbing** but stops one wire-up line short of working. Every architectural seam is correct, every threat-model anchor is named in source, every cross-cutting source-grep gate passes, and 996 extension + 71 relay tests are green.

But the **production WSS handshake never works** for two distinct and independently-sufficient reasons:

1. **Server-side wire-up missed** — `relay/src/server.ts:163-178` resolves `auth.ts`, captures `verifyTokenFn`, and then ignores it. The verifyClient closure was authored for 07-08 (auth pending), and when 07-09 shipped `verifyToken`, no PR wired the call. Every production-mode WSS upgrade is rejected with `cb(false, 503, 'Relay auth pending (07-09)')`. The comment block at lines 110-119 still describes pre-07-09 stub behavior.

2. **Client-side cloud join has no JWT** — `src/ui/JoinPanel.ts:331` constructs `new CloudTransport(relayUrl, sessionId, '')`. The relay's `auth.ts:87-90` rejects empty bearer tokens. 07-REVIEW-FIX.md MD-03 (deferred) documents this as a chicken-and-egg deadlock: the joiner has no way to obtain a JWT before the WSS handshake because the host issues the JWT via `auth-response` AFTER the WSS handshake completes. Resolving this requires a plan-level redesign (a `/bootstrap` unauthenticated route on the relay, or an out-of-band JWT issuance flow encoded in the deep-link, or a relay carve-out for member auth-requests pre-JWT).

The host-side wizard path (07-05 + 07-05b) is similarly blocked by defect (1) — SessionHostFactory.createCloud's `cloudTransport.connect()` call will fail at the WSS upgrade in any production deploy.

**Phase 7 cannot achieve its goal as shipped.** It is paper-verifiable (tests pass, source-grep gates pass, code review high-severity findings addressed) but not behaviorally verifiable. Defect (1) is a few-line fix; defect (2) requires the plan-level work explicitly deferred in 07-REVIEW-FIX.md MD-03.

### Recommended Next Steps

1. **Fix defect (1) immediately** — in `relay/src/server.ts:verifyClient`, after `verifyTokenFn` is confirmed callable, actually call it:
   ```typescript
   const tokenInfo = await verifyTokenFn(info.req, registry);
   if (!tokenInfo) {
     cb(false, 401, 'auth-failed');
     return;
   }
   (info.req as any).claims = { role: tokenInfo.role, aud: tokenInfo.sessionId, sub: tokenInfo.memberId };
   cb(true);
   ```
   This makes the host-side cloud path (SC-1) work end-to-end. Add an integration test that exercises `requireAuth: true` with a real signed host JWT issued by TokenService — the absence of this test is what allowed the gap to ship.

2. **Resolve defect (2) — MD-03 chicken-and-egg** — this needs a plan-level decision: most likely a relay `/bootstrap` route that accepts an `auth-request` payload, forwards it to the host's CloudHostTransport for invite-code validation, receives the host's `auth-response` with the joiner JWT, and returns it to the joiner. The joiner then re-opens the WSS with the JWT in the Bearer header. Alternative: encode an "anonymous join token" in the deep-link issued by the host's wizard share screen (signed with the same per-session secret, but with a very short `exp` and a `role: 'pending'` claim that only authorizes the `/bootstrap` route). Either approach is a fresh planning task; do NOT attempt to land this as a hotfix.

3. **Re-run UAT-3** once both defects are fixed — the live two-machine session is the canonical end-to-end test.

---

_Verified: 2026-05-19T09:30:00Z_
_Verifier: Claude (gsd-verifier, Opus 4.7 1M context)_
