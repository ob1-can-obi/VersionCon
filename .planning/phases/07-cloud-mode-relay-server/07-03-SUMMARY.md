---
phase: 07-cloud-mode-relay-server
plan: 03
subsystem: auth
tags: [jwt, jose, hs256, security, t-07-11, relay-portable]
dependency_graph:
  requires:
    - jose@^5.10.0 (npm — see Deviations: jose@6 ESM-only, switched to 5.10.x for CJS)
    - node:crypto (randomBytes, randomUUID, generateKeyPairSync — test only)
  provides:
    - src/auth/TokenService.ts (HS256 JWT issuer + verifier; relay-portable)
  affects:
    - package.json (new dep)
    - package-lock.json (regenerated)
tech_stack:
  added:
    - jose@5.10.0 (JWT signing + verification)
  patterns:
    - class-encapsulation (mirrors AuthHandler.ts secret-in-constructor + methods-return-verdict)
    - non-optional verify options (algorithms + audience always supplied)
    - jti via crypto.randomUUID (foundation for future revocation list)
key_files:
  created:
    - src/auth/TokenService.ts (76 lines — TokenClaims + TokenService class)
    - src/test/suite/tokenService.test.ts (145 lines — 8 cases in 'Phase 7 — token service' suite)
  modified:
    - package.json (added "jose": "^5.10.0" to dependencies)
    - package-lock.json (regenerated; resolved jose@5.10.0)
decisions:
  - Switched jose ^6.2.3 → ^5.10.0 (Rule 3 deviation — jose@6 is ESM-only and the extension compiles to CJS; jose@5 ships a CJS entry and has the identical HS256 / SignJWT / jwtVerify API)
  - RS256 keypair test feeds Node's KeyObject directly to jose.SignJWT.sign() (no importPKCS8 round-trip needed)
  - verify() post-checks role ∈ {'host','member'} and throws 'Missing role claim' otherwise (defense in depth — Rule 2; covers a buggy/compromised issuer that omits the role)
  - clockTolerance: '30s' baked into verify() (CONTEXT D-07 + RESEARCH §Pattern 3)
metrics:
  duration_minutes: 6
  completed_date: 2026-05-19
  tests_added: 8
  tests_total_before: 884
  tests_total_after: 892
requirements_satisfied: [NET-06]
---

# Phase 7 Plan 03: TokenService (jose-backed HS256 JWT) Summary

**One-liner:** Phase 7's L1 auth foundation — host-issued HS256 JWTs with strict algorithm-confusion defense, ready for verbatim consumption by the relay (plan 07-09).

## Tasks Completed

| # | Name | Status | Commit |
|---|------|--------|--------|
| 1 | Add jose dep + TokenService skeleton | done | 25ff180 |
| 2-RED | Failing test suite (8 cases) | done | 9935789 |
| 2-GREEN | Implement issue() + verify() | done | c3c2bf8 |

## What Shipped

### Final exported API surface — `src/auth/TokenService.ts`

```typescript
export interface TokenClaims {
  iss: string;            // hostMemberId
  sub: string;            // bearer's memberId
  aud: string;            // sessionId
  role: 'host' | 'member';
  // jti / iat / exp are set inside issue() — not part of input shape
}

export class TokenService {
  static newSecret(): Uint8Array;                         // 32 raw bytes
  constructor(secret: Uint8Array);                        // throws if !== 32 bytes
  issue(claims: TokenClaims): Promise<string>;            // HS256-signed JWT
  verify(token: string, audience: string): Promise<JWTPayload>;
}
```

### Locked invariants enforced

- **Algorithm pinning:** `verify()` always passes `algorithms: ['HS256']` to `jose.jwtVerify`. Source-grep gate (`grep -q "algorithms: \['HS256'\]" src/auth/TokenService.ts`) green. Two explicit tests cover the T-07-11 algorithm-confusion attack (alg:none and RS256 swap).
- **Secret type:** 32 raw bytes via `Uint8Array(crypto.randomBytes(32))`. Constructor throws `Error('TokenService secret must be 32 bytes')` on any other length. No base64 string handling anywhere (`! grep -E "secret.*toString\(['\"]base64" src/auth/TokenService.ts` returns nothing — T-07-secret-leak best-effort defense).
- **Audience non-optional:** `verify(token, audience)` requires the caller to pass an expected audience. Cross-session replay defense (T-07-cross-session).
- **Expiry enforcement:** `setExpirationTime(this.ttl)` with `this.ttl = process.env.VERSIONCON_TOKEN_TTL ?? '4h'` (jose timestring format). `clockTolerance: '30s'` baked into verify() for host/relay clock skew.
- **jti always present:** `crypto.randomUUID()` per token. Foundation for future revocation list (L4-deferred per CONTEXT).
- **Role post-check:** verify() validates `payload.role ∈ {'host','member'}` and throws `'Missing role claim'` otherwise (defense in depth for T-07-missing-claim).

### Relay portability — confirmed

`grep -E "(from 'vscode'|require\(['\"]vscode)" src/auth/TokenService.ts` returns nothing. The module imports only `jose` and `node:crypto`. Plan 07-09's relay package can import `src/auth/TokenService.ts` verbatim without pulling in VS Code APIs.

### Eight test cases — all passing

| # | Test | Mitigates |
|---|------|-----------|
| 1 | happy path roundtrip (asserts all 6 claims + iat) | foundation |
| 2 | rejects expired token | T-07-01 (short-exp replay defense) |
| 3 | rejects token with wrong audience | T-07-cross-session |
| 4 | rejects alg:none | T-07-11 (algorithm confusion) |
| 5 | rejects RS256 swap | T-07-11 (algorithm swap) |
| 6 | rejects token signed with different secret | T-07-01 (forgery) |
| 7 | rejects token missing aud | T-07-missing-claim |
| 8 | rejects token missing role | T-07-missing-claim |

Final count: **892 passing** (884 pre-plan + 8 new). 66 pending. Zero new failures.

## Resolved jose version

| Source | Version |
|--------|---------|
| `npm view jose version` (npm latest) | **6.2.3** |
| `package-lock.json` resolved | **5.10.0** |

The two differ because the plan's planned ^6.2.3 was downgraded to ^5.10.0 (see Deviations). The lockfile pins exactly `5.10.0`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Downgraded jose ^6.2.3 → ^5.10.0 (CJS compatibility)**

- **Found during:** Task 1 (`npx tsc --noEmit` immediately after `npm install jose@^6.2.3 --save`).
- **Issue:** jose@6.x is ESM-only (`"type": "module"` in its package.json + `dist/webapi/index.js` as the only entry). The VersionCon extension compiles to CommonJS (no `"type": "module"` in root package.json, `tsconfig.json` `module: Node16` resolution emitting CJS). `tsc` errored with `TS1479: ... is an ECMAScript module and cannot be imported with 'require'`.
- **Fix:** `npm uninstall jose && npm install jose@^5.10.0 --save`. jose@5.10.0 ships a CJS entry (`./dist/node/cjs/index.js`) and has the IDENTICAL `SignJWT` / `jwtVerify` API surface used by this plan — the plan's pseudo-code paste-in worked unchanged.
- **Files modified:** package.json, package-lock.json.
- **Commit:** 25ff180.
- **Why Rule 3 not Rule 4:** This is a technical-impossibility fix (the locked version literally doesn't compile in this project's module shape), not an architectural pivot. The library, algorithm, claim schema, and verify-options contract from CONTEXT D-07 are all preserved verbatim. The version bump-down is a packaging detail, not a security-property change. Plan 07-09 (relay) will likewise need jose@^5.10.0 unless that package opts into `"type": "module"`.

**2. [Rule 2 — Critical functionality] Added role post-check in verify()**

- **Found during:** Task 2 (GREEN implementation).
- **Issue:** jose's `jwtVerify` does NOT validate custom claims like `role` — it only checks signature + standard claims (iss/aud/exp). A token that was correctly signed but had `role: 'admin'` (or no role at all) would pass jose verification.
- **Fix:** After `jwtVerify` resolves, verify() inspects `payload.role` and throws `'Missing role claim'` unless it's strictly `'host'` or `'member'`.
- **Files modified:** src/auth/TokenService.ts.
- **Commit:** c3c2bf8.
- **Test coverage:** Case 8 in the suite ("rejects token missing role claim") issues a token via `issue()` with the role field stripped (via cast-to-TokenClaims), then asserts verify() rejects.

### Asymmetric RED phase (note, not a deviation)

The plan's RED expectation said all 8 tests would fail with `NOT IMPLEMENTED — Task 2`. In practice, 4 failed (the ones that called `issue()` first) and 4 passed (the rejection-only tests that built adversarial tokens by hand and only called `verify()` — which threw, satisfying `assert.rejects()`). This is consistent with the plan's own design — the rejection assertions deliberately use `assert.rejects(() => svc.verify(...))` WITHOUT an error matcher so the suite survives jose minor-version upgrades. The 4 positive-path tests carried the RED signal; the 4 rejection tests became the regression net once GREEN landed. No code change needed.

## Discretion-zone decisions for downstream consumers (plan 07-09)

- **RS256 keypair feed to jose:** the test uses `crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })` and passes the returned `KeyObject` directly to `SignJWT.sign(privateKey)`. No `importPKCS8` round-trip. Plan 07-09's relay integration tests can use the same shortcut to construct adversarial RS256 tokens.
- **jose error class names:** jose 5.10.0 throws `JWTExpired`, `JWTClaimValidationFailed`, `JOSEAlgNotAllowed`, `JWSInvalid` etc., but we deliberately do not pin these in tests. Plan 07-09's relay verifier should likewise check by rejection, not by class name, so a future jose upgrade does not silently break the WSS close-code mapping (4401 vs 4404).

## Threat Coverage Confirmed

| Threat ID | Mitigation | Test |
|-----------|------------|------|
| T-07-01 (forgery / replay) | HS256 + 32-byte secret + audience required + exp enforced | Cases 2, 3, 6 |
| T-07-11 (algorithm confusion) | `algorithms: ['HS256']` always passed to jwtVerify | Cases 4, 5 |
| T-07-replay | `exp = iat + ttl`, default 4h, configurable via env | Case 2 |
| T-07-cross-session | `aud` is sessionId, caller-supplied to verify | Case 3 |
| T-07-missing-claim | jose rejects missing aud; we reject missing role | Cases 7, 8 |
| T-07-secret-leak | Secret is Uint8Array, never base64 string; constructor enforces 32 bytes | Source-grep gate |

## Phase-wide gates — all green

| Gate | Result |
|------|--------|
| `npx tsc` | exit 0 |
| `npx vscode-test --grep "Phase 7.*token service"` | 8 passing |
| `npm test` (full suite) | 892 passing, 0 failing, 66 pending |
| `grep -q '"jose":' package.json` | present |
| `grep -q '"jose"' package-lock.json` | present (5.10.0) |
| `grep -q 'export class TokenService' src/auth/TokenService.ts` | present |
| `grep -q "algorithms: \['HS256'\]" src/auth/TokenService.ts` | present |
| `grep -q 'crypto\.randomBytes(32)' src/auth/TokenService.ts` | present |
| `grep -q 'crypto\.randomUUID()' src/auth/TokenService.ts` | present |
| `! grep -E "from 'vscode'" src/auth/TokenService.ts` | no match (relay-portable) |
| `! grep -E "crypto\.createHmac" src/auth/TokenService.ts` | no match (no hand-rolled HMAC) |
| `! grep -E "secret.*toString\(['\"]base64" src/auth/TokenService.ts` | no match |

## TDD Gate Compliance

- ✅ RED commit (9935789): test-only commit prefixed `test(07-03):`. 4 tests fail at `issue()` stub; 4 rejection tests pass-for-wrong-reason (documented above) — design choice per plan, not a TDD violation.
- ✅ GREEN commit (c3c2bf8): feat commit AFTER the RED commit, all 8 tests pass.
- (Optional REFACTOR not needed — implementation already minimal and clear.)

## Wave 1 Status

Plan 07-03 is the third and final Wave 1 plan for Phase 7. Wave 1 ships:
- **07-01** (Transport seam) — c0ba05f
- **07-02** (CloudEnvelope) — 6f8ac80
- **07-03** (TokenService) — c3c2bf8 (this plan)

Wave 2 can begin: it depends on all three of these foundations.

## Self-Check: PASSED

- ✅ src/auth/TokenService.ts exists
- ✅ src/test/suite/tokenService.test.ts exists
- ✅ Commit 25ff180 (Task 1) found
- ✅ Commit 9935789 (RED) found
- ✅ Commit c3c2bf8 (GREEN) found
- ✅ jose in package.json + package-lock.json (5.10.0 resolved)
- ✅ All 8 cases in 'Phase 7 — token service' suite pass
- ✅ Full suite: 892 passing, 0 failing
