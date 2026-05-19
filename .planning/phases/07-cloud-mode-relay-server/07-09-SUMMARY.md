---
phase: 07-cloud-mode-relay-server
plan: 09
subsystem: relay/auth
tags: [relay, wave-3, jwt, jose, hs256, two-step-verify, t-07-01, t-07-03, t-07-04, t-07-05, t-07-09, t-07-11, net-06]
dependency_graph:
  requires:
    - "07-03 — TokenService.ts (host-side jose@5 issuer; verify-side flow mirrored here but cannot reuse the class because relay needs aud→secret routing BEFORE verify can run)"
    - "07-08 — relay/src/SessionRegistry.ts (registry.getSession(aud) returns Session with verifySecret; positional register(sessionId, hostSocket, verifySecret) shape used by tests)"
    - "07-08 — relay/src/server.ts verifyClient hook seam (dynamic ./auth.js import already in place; 07-09 ships the module that the hook resolves)"
    - "jose@^5.10.0 (declared by 07-08 in relay/package.json; provides decodeJwt + jwtVerify with algorithms-lock support)"
  provides:
    - "relay/src/auth.ts — verifyToken(req: IncomingMessage, registry: SessionRegistry): Promise<TokenInfo | null>. Pure function (no module state). Two-step decode→lookup→verify per RESEARCH §Pattern 2. algorithms:['HS256'] non-optional (T-07-11). audience pinned to the decoded aud. 30s clockTolerance. Returns null on every failure path — NEVER throws (the verifyClient consumer requires this contract)."
    - "TokenInfo type — { sessionId: string; memberId: string; role: 'host' | 'member' } returned by verifyToken on success; consumed by 07-08's verifyClient seam and the eventual ws.on('close') wiring that will use the verified sessionId to call registry.detach()"
    - "AuthFailReason internal vocabulary — 'malformed' | 'expired' | 'wrong-alg' | 'unknown-session'. Used by logFail's structured {event:'auth-fail', sessionId, reason} log line. 07-11's pino redact config can expect these four values as the reason enum."
    - "relay/test/auth.test.js — 9 functional cases + 1 source-grep gate. Runs via `node --test test/auth.test.js` from relay/. Imports from ../dist/auth.js (flat dist tree per 07-08 tsconfig)."
    - "src/test/suite/inviteCodeLocality.test.ts — extension-side Mocha suite 'Phase 7 — invite code locality' (em-dash). Two tests: directory-wide source-grep over every .ts file under relay/src/ for /inviteCode|validateInviteCode|INVITE_CODE/, plus auth.ts-specific positive coverage of /algorithms:\\s*\\['HS256'\\]/. Defense-in-depth alongside 07-08's relay-side gate in router.test.js."
  affects:
    - "07-08 server.ts verifyClient — the dynamic ./auth.js import now resolves at runtime, but the conservative 503 branch is still in place (it always rejects when requireAuth=true even with auth.js present). The static-import-and-actually-call-verifyToken cutover is left as a known follow-up because 07-09's PLAN.md explicitly states 'this plan does NOT modify server.ts'. Documented in Deviations as deferred."
    - "07-10 limits — the verifyClient hook will compose with 07-10's per-IP rate-limit gate. Independent gates: rate-limit runs before verifyToken in the middleware chain (cheap reject before the HMAC compare). verifyToken's pure-function signature makes the composition trivial."
    - "07-11 logger — auth.ts's `console.error(JSON.stringify({event:'auth-fail', sessionId, reason}))` call sites become candidates for the find-and-replace pass. The four-field shape is locked; pino's redact config can list the reason enum verbatim. No bearer / no secret / no header value ever appears in the log line, so pino redact serves as a second line of defense rather than a sanitizer."
    - "07-05b host wiring (Wave 4) — SessionHost.start() will issue host + member JWTs using TokenService.issue() from 07-03, and post the verifySecret to the relay via session-register; the relay's verifyToken will then validate every subsequent member upgrade."
    - "Future L3 security phase — the no-invite-code-in-relay/src/ invariant is now enforced by TWO source-grep gates (07-08's router.test.js and 07-09's inviteCodeLocality.test.ts). When the L3 phase ships HKDF/Argon2-derived session keys, the relay's existing posture (never sees the invite code) carries over without modification."
tech-stack:
  added: []
  patterns:
    - "Two-step decode→lookup→verify: decodeJwt extracts aud WITHOUT signature check, then registry.getSession(aud) looks up the per-session verifySecret, then jwtVerify runs full validation with algorithms:['HS256'] + audience: aud + clockTolerance: '30s'. RESEARCH §Pattern 2. Any tampered-aud-at-pre-decode path can only misroute to the wrong secret — the subsequent HMAC compare then fails."
    - "Pure-function verify gate: verifyToken takes (req, registry) parameters. No module-level state, no globals, no env reads at call time. Testable without spinning up an http.Server — 9 of 10 tests in auth.test.js are direct function calls against fake req objects + a freshly-constructed SessionRegistry. The 10th test is a pure source-grep against the file."
    - "Failure log discipline: logFail emits ONLY {event:'auth-fail', sessionId, reason} — never the bearer, never the raw token, never the secret, never the Authorization header value. Reason vocabulary is the four-value enum. 07-11's pino redact is a second line of defense; the FIRST line is structural — the unsafe values never enter the log call."
    - "Lowercase header access (RESEARCH §Pitfall 5): req.headers.authorization (lowercase). Node's IncomingMessage interface normalizes inbound headers to lowercase regardless of the wire-side casing. Reading req.headers.Authorization (capital A) would return undefined on real traffic — explicit test case proves we don't accidentally read from that key."
    - "Defense-in-depth role check: after jwtVerify succeeds, payload.role is post-validated against the literal union {'host', 'member'}. jose's jwtVerify validates iss/aud/exp/signature but does NOT validate custom claims like role. A compromised host issuing role:'admin' would otherwise slip through. Mirrors TokenService.verify in 07-03."
    - "Algorithm-lock source-grep gate at two layers: relay/test/auth.test.js (Test #10) AND src/test/suite/inviteCodeLocality.test.ts (Test #2). A regression that drops `algorithms: ['HS256']` from auth.ts trips BOTH suites. Same belt-and-suspenders pattern 07-08 used for the .payload absence in router.ts (Test #5 in router.test.js)."
    - "Direct jose API use (no TokenService wrap): the relay imports decodeJwt + jwtVerify directly from jose because TokenService.verify(token, audience) takes a single secret bound at construction time, but the relay needs to pick the secret based on the token's claimed aud BEFORE verify can run. The two-step flow doesn't fit TokenService's single-secret-per-instance shape. TokenService remains the host-side issuer; auth.ts is the relay-side verifier."
key-files:
  created:
    - "relay/src/auth.ts (137 lines) — verifyToken + TokenInfo + AuthFailReason. Pure function, zero VS Code imports, zero invite-code references, zero hand-rolled HMAC."
    - "relay/test/auth.test.js (220 lines) — 9 functional cases + 1 source-grep gate. Node built-in test runner. Helpers: b64url, buildAlgNoneToken, buildRs256Token, buildHs256Token, fakeSocket, freshRegistry."
    - "src/test/suite/inviteCodeLocality.test.ts (86 lines) — extension-side Mocha suite with 2 tests + walkTsFiles recursive walker."
  modified: []
decisions:
  - decision: "Import jose directly in auth.ts rather than reusing TokenService from 07-03"
    rationale: "TokenService.verify(token, audience) takes a single secret bound at constructor time. The relay needs to pick the secret based on the token's CLAIMED aud BEFORE verify can run — pre-decode → lookup → verify is a strict three-step sequence that doesn't fit TokenService's single-secret-per-instance shape. Direct use of jose.decodeJwt + jose.jwtVerify is cleaner and keeps TokenService scoped to its actual responsibility (host-side issuance + verification of a single secret known at construction time)."
  - decision: "console.error(JSON.stringify({...})) for failure logging — NOT importing 07-11's logger.ts"
    rationale: "07-11 is the same Wave as 07-09; introducing a cross-plan dependency within a wave would force 07-11 to ship FIRST or 07-09 to import an unfinished module. The four-field shape ({event, sessionId, reason}) is locked, and 07-11's find-and-replace pass can mechanically swap the console.error call sites for the pino logger. The unsafe values (bearer, secret, header) never enter the log line, so the redaction layer 07-11 adds is a defense-in-depth backstop rather than a sanitizer."
  - decision: "registry.getSession(aud) — not registry.get(aud) as the plan example showed"
    rationale: "07-08 shipped SessionRegistry with the method name `getSession(sessionId)`. The PLAN.md interface block showed `registry.get(...)` as a placeholder example. The actual deployed API takes precedence; this is documentation drift in the plan example, not an architectural disagreement. The test file uses fakeSocket() to satisfy 07-08's positional register(sessionId, hostSocket, verifySecret) shape — verifyToken never touches hostSocket, only session.verifySecret."
  - decision: "Tests import from `../dist/auth.js` (flat) — NOT `../dist/src/auth.js` (nested)"
    rationale: "07-08's tsconfig.json has `rootDir: './src'` + `outDir: './dist'`, which produces a FLAT dist tree (`relay/dist/auth.js`, not `relay/dist/src/auth.js`). The PLAN.md example showed `../dist/src/auth.js` but the actual layout from 07-08 is flat. Existing sibling test files (router.test.js, sessionRegistry.test.js, server.test.js) all use the flat path."
  - decision: "ERR_JWT_EXPIRED distinguished from all other jwtVerify failures"
    rationale: "jose 5.10.0's JWTExpired exception carries `code === 'ERR_JWT_EXPIRED'`. All other failures (algorithm mismatch, signature failure, audience mismatch, claim validation, malformed JWT contents post-decodeJwt) are bucketed as `reason: 'wrong-alg'`. The narrow vocabulary (4 values) keeps 07-11's pino redact config simple and stable. The expired/wrong-alg distinction surfaces during ops debugging without leaking signature details."
  - decision: "Rephrased an invite-code-referencing comment in auth.ts to avoid the literal `inviteCode` substring"
    rationale: "07-08's router.test.js Test #2 source-greps relay/src/ for /\\binviteCode\\b/ across every .ts file. The original auth.ts header comment included the literal `inviteCode / validateInviteCode / INVITE_CODE` as documentation of WHAT the file does not reference. That literal tripped the gate — same edge case 07-08 hit with `.payload` in router.ts (and resolved by rephrasing the CRITICAL INVARIANT comment there). Reworded to 'host-side join-secret identifiers' so the test gate stays single-line-enforced. Trade-off: minor loss of comment lexical precision; gain of one-regex source-grep enforcement that survives future edits."
  - decision: "verifyToken accepts the registry as a second positional argument (NOT a module-level singleton)"
    rationale: "Pure-function shape — 9 of 10 tests construct a fresh registry per test, register one session, and call verifyToken. No global setUp/tearDown needed. 07-08's verifyClient will bind the registry at construction time via a closure: `verifyClient: (info, cb) => verifyToken(info.req, sessions).then(t => cb(!!t, t ? undefined : 401, t ? undefined : 'Unauthorized'))`."
  - decision: "Did NOT modify relay/src/server.ts (the dynamic-import-to-static-import cutover from 07-08 is left as a known follow-up)"
    rationale: "Plan 07-09 PLAN.md explicitly states 'this plan does NOT modify server.ts' (objective line 77). The orchestrator's sequential_execution note also said: 'If the plan PLAN.md does not authorize this, instead leave the dynamic import alone and note it as a known follow-up.' Plan authority wins. The current server.ts still uses the dynamic `./auth.js` import and the conservative-503 branch — even though auth.ts now exists and is callable, the server's verifyClient stub does NOT yet call verifyToken (it reaches the 'Once 07-09 ships verifyToken' comment and STILL rejects with 503). The Wave 4 integration plan (likely 07-05b host wiring) owns the cutover. Recorded as a Deferred Item below."
metrics:
  duration: "~6 minutes (sequential execution; 351s wall-clock from start of Task 1 RED to last commit)"
  completed-date: "2026-05-19"
  tests-added: 12
  tests-relay-suite: "31 (auth 10 new + 21 from 07-08 — full relay suite green)"
  tests-extension-suite: "973 / 0 / 66 (971 baseline + 2 new — no regression)"
  lines-added: "+443 (137 src/auth.ts + 220 test/auth.test.js + 86 src/test/suite/inviteCodeLocality.test.ts)"
  source-grep-gates: "all green (algorithms:['HS256'] in auth.ts via 2 gates / no invite-code in relay/src/ via 2 gates / no vscode imports / no createHmac / no bearer-in-log / failure-log shape pinned)"
requirements-completed: [NET-06]
---

# Phase 7 Plan 09: Relay Auth (JWT Verify Gate) Summary

**One-liner:** Shipped `relay/src/auth.ts` — the L1 JWT verify gate that every cloud-mode WSS upgrade hits. Pure-function `verifyToken(req, registry): Promise<TokenInfo | null>` implements the two-step decode→lookup→verify flow: `decodeJwt` extracts `aud` for per-session secret routing, then `jwtVerify` runs with `algorithms: ['HS256']` non-optional (T-07-11 algorithm-confusion defense), `audience: aud` pinned (T-07-01 cross-session replay defense), and `clockTolerance: '30s'`. Role is sourced exclusively from `payload.role` — T-07-09 preserves Phase 4.1's "first-authenticated-wins-host" BAN into cloud mode. Failure logging is locked to `{event:'auth-fail', sessionId, reason}` only — never the bearer, never the secret, never the Authorization header value (T-07-03/04 hygiene). 10 new relay tests + 2 extension-side source-grep tests; all 17 verification gates green; 31/31 relay tests pass, 973/0/66 extension suite (no regression).

## What Shipped

| Artifact | Role | Lines |
|----------|------|-------|
| `relay/src/auth.ts` | Pure-function `verifyToken(req, registry)` + `TokenInfo` type + `AuthFailReason` internal vocabulary. Two-step decode→lookup→verify with `algorithms:['HS256']` non-optional. | 137 (new) |
| `relay/test/auth.test.js` | 9 functional cases (happy + expired + unknown-session + alg:none + RS256-swap + missing-header + no-Bearer-prefix + case-insensitive + role-claim-respected) + 1 source-grep gate (algorithms:['HS256'] literal present in auth.ts). | 220 (new) |
| `src/test/suite/inviteCodeLocality.test.ts` | Extension-side Mocha suite 'Phase 7 — invite code locality' (em-dash). Two tests: directory-wide grep over every .ts file under relay/src/ + auth.ts-specific positive coverage of `algorithms:['HS256']`. | 86 (new) |

## Final API Surface

```typescript
// relay/src/auth.ts

export type TokenInfo = {
  sessionId: string;     // = the verified aud claim
  memberId: string;      // = the verified sub claim
  role: 'host' | 'member'; // verbatim from the verified role claim
};

// Internal — not exported, but documented for 07-11's redact config:
type AuthFailReason = 'malformed' | 'expired' | 'wrong-alg' | 'unknown-session';

export async function verifyToken(
  req: IncomingMessage,
  registry: SessionRegistry,
): Promise<TokenInfo | null>;
```

**Signature contract:**

- Returns `TokenInfo` on success; `null` on every failure path.
- NEVER throws (07-08's verifyClient consumer requires this).
- Pure function — no module-level state, no globals.
- Single side effect on failure: `console.error(JSON.stringify({event:'auth-fail', sessionId, reason}))`.

## How verifyToken Works

```
                 Authorization: Bearer <token>
                              │
                              ▼
                  ┌───────────────────────────┐
                  │ Step 1: header parse      │ ── missing / no Bearer prefix
                  │ req.headers.authorization │       → null + 'malformed'
                  └─────────────┬─────────────┘
                                ▼
                  ┌───────────────────────────┐
                  │ Step 2: decodeJwt (unsafe)│ ── no aud / malformed JWT
                  │ extract aud (no signature)│       → null + 'malformed'
                  └─────────────┬─────────────┘
                                ▼
                  ┌───────────────────────────┐
                  │ Step 3: registry lookup   │ ── session not registered
                  │ registry.getSession(aud)  │       → null + 'unknown-session'
                  └─────────────┬─────────────┘
                                ▼
                  ┌───────────────────────────┐
                  │ Step 4: jwtVerify         │ ── exp in past
                  │   algorithms: ['HS256']   │       → null + 'expired'
                  │   audience: aud           │ ── alg:none / RS256 / forgery /
                  │   clockTolerance: '30s'   │    audience mismatch / sig fail
                  └─────────────┬─────────────┘       → null + 'wrong-alg'
                                ▼
                  ┌───────────────────────────┐
                  │ Step 5: post-condition    │ ── role ∉ {'host','member'}
                  │ payload.role in {host,    │    or sub not a string
                  │   member} & sub: string   │       → null + 'malformed'
                  └─────────────┬─────────────┘
                                ▼
                  TokenInfo { sessionId, memberId, role }
```

## How It Connects

```
WSS handshake
     │
     ▼
07-08 server.ts verifyClient stub (still in place — see Deferred below)
     │  (the dynamic `./auth.js` import now resolves successfully because
     │   07-09 ships the module — but server.ts still hits its conservative
     │   503 branch and rejects. The static-import-and-call cutover is the
     │   Wave 4 follow-up.)
     │
     │  When the cutover ships:
     ▼
   verifyToken(info.req, sessions)
        │           │
        │           └─> registry.getSession(aud) lookup
        │
        ▼
   { sessionId, memberId, role } | null
        │
        ├── null  → cb(false, 401, 'Unauthorized')
        │
        └── ok    → stash claims on req, cb(true)
                    ws.on('connection') reads the verified claims
                    ws.on('close') → registry.detach(sessionId, ws)
```

## Three-Commit TDD Chain

1. `ec30a1a` — **RED.** `relay/test/auth.test.js` lands with 10 tests; `node --test` fails with `ERR_MODULE_NOT_FOUND` for `dist/auth.js` (target doesn't exist yet).
2. `ac055cf` — **GREEN.** `relay/src/auth.ts` ships. All 10 auth tests pass, full 31/31 relay suite green.
3. `806c14a` — **Task 3 / extension-side gate.** `src/test/suite/inviteCodeLocality.test.ts` adds 2 extension-side source-grep tests; 973/0/66 extension suite green.

(No REFACTOR commit — implementation was clean on first GREEN, only required the comment-rephrase patch which was rolled into the same commit window before push.)

## Verification Gates

All 17 phase-wide gates from PLAN.md `<verification>` block green:

| Gate | Command | Result |
|------|---------|--------|
| G1 Relay TypeScript compile | `cd relay && npx tsc` | PASS (exit 0) |
| G2 Relay auth tests | `cd relay && node --test test/auth.test.js` | PASS (10/10) |
| G3 Relay package test script wired | `grep '"test":.*node --test test/' relay/package.json` | PASS |
| G4 Relay npm test green | `cd relay && npm test` | PASS (31/31) |
| G5 Extension TypeScript compile | `npx tsc` | PASS (exit 0) |
| G6 Extension invite-code-locality tests | `npx vscode-test --grep "Phase 7.*invite code locality"` | PASS (2/2) |
| G7 verifyToken exported | `grep "export async function verifyToken" relay/src/auth.ts` | PASS |
| G8 TokenInfo exported | `grep "export type TokenInfo" relay/src/auth.ts` | PASS |
| G9 Algorithm-lock literal present (T-07-11) | `grep "algorithms: \['HS256'\]" relay/src/auth.ts` | PASS |
| G10 Lowercase header access | `grep "headers\\.authorization" relay/src/auth.ts` | PASS |
| G11 No VS Code imports in relay | `! grep -E "(from 'vscode'\\|require\\('vscode')" relay/src/auth.ts` | PASS |
| G12 No invite-code refs in relay/src/ (T-07-05) | `! grep -rE "inviteCode\\|validateInviteCode\\|INVITE_CODE" relay/src/` | PASS |
| G13 No hand-rolled HMAC (V6 Cryptography) | `! grep -E "createHmac" relay/src/auth.ts` | PASS |
| G14 No bearer/secret in log calls (T-07-03/04) | `! grep -E "console\\.(log\\|error\\|warn).*authorization\\|...Bearer\\|...verifySecret" relay/src/auth.ts` | PASS |
| G15 Failure-path logging shape locked | `grep "event: 'auth-fail'" relay/src/auth.ts` | PASS |
| G16 Role from claim (T-07-09) | `grep "payload.role" relay/src/auth.ts` | PASS |
| G17 Two-step verify present | `grep "decodeJwt" && grep "jwtVerify"` | PASS (both found) |

## STRIDE Coverage

| Threat ID | Mitigation | Evidence |
|-----------|------------|----------|
| T-07-01 (forgery / cross-session replay / role escalation) | HS256 with per-session 32-byte secret; jwtVerify audience pinned to decoded aud | 4 tests: happy / expired / unknown-session / role-claim-respected |
| T-07-11 (algorithm-confusion) | `algorithms: ['HS256']` non-optional; source-grep gate at 2 layers | 2 tests: alg:none rejected / RS256 rejected. Source-grep gates: relay/test/auth.test.js Test #10 + src/test/suite/inviteCodeLocality.test.ts Test #2 |
| T-07-05 (invite code locality) | Source-grep gate at 2 layers: 07-08's router.test.js + 07-09's inviteCodeLocality.test.ts | Both gates green; relay/src/ has 0 matches for `/inviteCode\|validateInviteCode\|INVITE_CODE/` |
| T-07-09 (first-authenticated-wins-host ban preserved into cloud mode) | Role sourced exclusively from `payload.role`; no codepath infers role from connection order | 1 test: role-claim-respected. Two tokens with same aud but different roles each return their claim's role verbatim. |
| T-07-03 (bearer leak via logs) | `logFail` emits only {event, sessionId, reason} — never bearer, never raw token | Source-grep gate G14 + test observation (logs in test output show only the structured shape) |
| T-07-04 (secret leak via logs) | `auth.ts` never logs the session object or any field of it beyond aud | Source-grep gate G14 includes `verifySecret` check |
| T-07-malformed-token (DoS via flood of bad tokens) | Accepted — bounded by O(1) crypto cost per request; 07-10's per-IP rate limit backstops | Documented in threat model line 734 |
| T-07-pre-decode-trust | Accepted — tampered aud at pre-decode can only misroute lookup; subsequent verify fails on HMAC mismatch | Documented in threat model line 735; implicit in unknown-session + wrong-aud test cases |

## Test Cases Inventory

| # | Test | What It Proves |
|---|------|----------------|
| 1 | happy | Valid HS256 token resolves to `{sessionId, memberId, role}` with role 'host' verbatim |
| 2 | expired | `setExpirationTime(now - 3600)` returns null; reason 'expired' (jose code `ERR_JWT_EXPIRED` observed in stderr) |
| 3 | unknown-session | aud='vc-other' against registry that only knows 'vc-known' → null; reason 'unknown-session'. Exercises the pre-decode → lookup-miss path. |
| 4 | alg:none | Hand-built token `<b64url(alg:none header)>.<b64url(payload)>.` (empty signature segment) → null. Proves `algorithms: ['HS256']` rejects unsigned tokens. |
| 5 | RS256 swap | Real RS256-signed token via `crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })` + jose SignJWT.sign(privateKey) → null. Proves `algorithms: ['HS256']` rejects asymmetric algorithms. |
| 6 | missing-header | req.headers = {} → null; reason 'malformed'. |
| 7 | no-Bearer-prefix | authorization='NotBearer xyz' → null; reason 'malformed'. |
| 8 | case-insensitive | Lowercase 'authorization' key works; capital 'Authorization' key returns null. Proves RESEARCH §Pitfall 5 mitigation. |
| 9 | role-claim-respected (T-07-09) | Two tokens with same aud but role:'host' and role:'member' each return their claim's role verbatim. |
| 10 | source-grep gate | `algorithms: ['HS256']` literal present in relay/src/auth.ts (T-07-11 regression catch). |

Extension-side (src/test/suite/inviteCodeLocality.test.ts):

| # | Test | What It Proves |
|---|------|----------------|
| 1 | directory-wide grep | Every .ts file under relay/src/ matches zero of `/inviteCode\|validateInviteCode\|INVITE_CODE/`. T-07-05. |
| 2 | auth.ts positive coverage | auth.ts contains zero invite-code refs AND contains `algorithms: ['HS256']` literal. T-07-05 + T-07-11 defense-in-depth. |

## jose 5.10.0 Error Code Observed

The plan's `<output>` block asked for the exact jose error code used to distinguish `expired` from `wrong-alg`:

- **`JWTExpired.code === 'ERR_JWT_EXPIRED'`** — confirmed observed during test runs.
- All other jose verify-time exceptions (`JWTInvalid`, `JWSSignatureVerificationFailed`, `JWSAlgorithmNotAllowed`, `JWTClaimValidationFailed`, etc.) fall through to the `reason: 'wrong-alg'` bucket.

This matches the documented value in jose's error class hierarchy. No version-specific surprise. 07-11's pino redact-tests can assert against the four-value reason enum verbatim: `'malformed' | 'expired' | 'wrong-alg' | 'unknown-session'`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Comment rephrase] Renamed invite-code-referencing comment in auth.ts to defeat 07-08's source-grep gate**

- **Found during:** Task 2 GREEN — the initial auth.ts header comment explicitly listed `inviteCode / validateInviteCode / INVITE_CODE` as documentation of the file's negative invariants.
- **Issue:** 07-08's `router.test.js` Test #2 source-greps `relay/src/` for `/\binviteCode\b/` across every `.ts` file. The literal `inviteCode` in the comment tripped the gate even though the file had no functional invite-code dependency.
- **Fix:** Rephrased to "host-side join-secret identifiers" — describes the same invariant without matching the source-grep regex. Identical edge case to 07-08's own `.payload` comment rephrase in `router.ts`.
- **Files modified:** `relay/src/auth.ts` (comment block only)
- **Commit:** `ac055cf` (rolled into the Task 2 GREEN commit)

**2. [Rule 3 — API name correction] Used `registry.getSession(aud)` (the actual 07-08 API) instead of `registry.get(aud)` (the plan's placeholder example)**

- **Found during:** Task 2 GREEN — TypeScript wouldn't compile auth.ts against the actual SessionRegistry from 07-08.
- **Issue:** PLAN.md `<interfaces>` block showed `registry.get(sessionId)` as a placeholder. The actual deployed API in 07-08 is `getSession(sessionId)`.
- **Fix:** auth.ts calls `registry.getSession(unverifiedAud)`. Test file's `freshRegistry()` helper also adapts to 07-08's positional `register(sessionId, hostSocket, verifySecret)` shape (vs. the plan's named-arg example) — uses a `fakeSocket()` stub for the hostSocket position because verifyToken never touches it.
- **Files modified:** `relay/src/auth.ts`, `relay/test/auth.test.js`
- **Commit:** `ec30a1a` (test file) + `ac055cf` (auth.ts)

**3. [Rule 3 — Import path correction] Tests import from `../dist/auth.js` (flat) — NOT `../dist/src/auth.js` (nested)**

- **Found during:** Task 1 RED.
- **Issue:** Plan example used `from '../dist/src/auth.js'` and `from '../dist/src/SessionRegistry.js'`. 07-08's tsconfig has `rootDir: './src'` + `outDir: './dist'`, which produces a FLAT dist tree.
- **Fix:** Imports use `from '../dist/auth.js'` and `from '../dist/SessionRegistry.js'`. Matches the convention already established by 07-08's three sibling test files.
- **Files modified:** `relay/test/auth.test.js`
- **Commit:** `ec30a1a` (rolled into Task 1 RED commit)

### Deferred / Known Follow-ups

**1. [Plan-bounded] Did NOT modify `relay/src/server.ts` (the dynamic-import → static-import cutover from 07-08 is intentionally deferred)**

- **Why deferred:** Plan 07-09 PLAN.md objective line 77 explicitly states **"this plan does NOT modify server.ts"**. The orchestrator's `sequential_execution` block additionally said: *"If the plan PLAN.md does not authorize this, instead leave the dynamic import alone and note it as a known follow-up."*
- **Current state:** server.ts still uses `const authModulePath: string = './auth.js'; import(authModulePath).then(...)`. The dynamic import NOW resolves successfully (auth.ts exists with the expected `verifyToken` export), but the server's verifyClient stub still reaches the conservative 503 branch (`cb(false, 503, 'Relay auth pending (07-09)')`) and rejects every upgrade.
- **What's needed:** A future plan (likely 07-05b host wiring or a small 07-09-followup) converts the dynamic import to `import { verifyToken } from './auth.js'` at the top of server.ts, deletes the conservative-503 branch, and replaces it with `verifyToken(info.req, sessions).then(t => cb(!!t, t ? undefined : 401, t ? undefined : 'Unauthorized'))`. The `ws.on('close')` handler also wires `registry.detach(claims.sessionId, ws)` using the verified claims stashed on `info.req` by verifyClient.
- **Risk if skipped:** None — 07-09's tests verify auth.ts in isolation, and the conservative-503 stub is fail-closed (T-07-16 preserved). The current relay deployment cannot accept ANY authenticated connection until the cutover ships, but that's the intended pre-Wave-4 posture.
- **Tracked as:** Deferred-item below.

### Auth Gates / Authentication Encounters

None — this plan added no commands or external service integrations that require credentials.

## Threat Flags

No new security-relevant surface introduced beyond the threat model already specified by PLAN.md. The verifyToken function IS the new auth surface; it's fully mitigated by the test cases inventoried above.

## Self-Check: PASSED

Verifications run after writing this SUMMARY:

- `[ -f relay/src/auth.ts ]` → FOUND
- `[ -f relay/test/auth.test.js ]` → FOUND
- `[ -f src/test/suite/inviteCodeLocality.test.ts ]` → FOUND
- `git log --oneline | grep -q "ec30a1a"` → FOUND (RED commit)
- `git log --oneline | grep -q "ac055cf"` → FOUND (GREEN commit)
- `git log --oneline | grep -q "806c14a"` → FOUND (Task 3 commit)
- `cd relay && npm test` → 31/31 PASS
- `npx vscode-test --grep "Phase 7.*invite code locality"` → 2/2 PASS

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Wave 4 integration | server.ts dynamic `./auth.js` import → static top-level `import { verifyToken } from './auth.js'` + remove conservative-503 branch + wire `cb(!!t, ...)` + wire `ws.on('close') → registry.detach(claims.sessionId, ws)` | open | 07-09 (this plan, intentional — out of plan scope per PLAN.md line 77) |

## TDD Gate Compliance

Plan-level type was `execute`, not `tdd`, BUT every task carried `tdd="true"` so the TDD cycle was enforced per-task:

- Task 1 (`test:` commit `ec30a1a`) — RED ✓
- Task 2 (`feat:` commit `ac055cf`) — GREEN ✓
- Task 3 (`test:` commit `806c14a`) — extension-side gate (separate concern; no RED-GREEN needed because the tested artifacts already existed when this test was written)

Gate sequence satisfied: `test` → `feat` → `test` (the third commit isn't a TDD cycle violation — it's a separate test file with no underlying production code change).
