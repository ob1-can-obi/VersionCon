---
phase: 07-cloud-mode-relay-server
source_review: 07-REVIEW.md
fix_scope: critical_warning
applied: 12
partial: 1
deferred: 3
skipped: 0
findings_in_scope: 15
tests_passing: 996 ext + 71 relay
created: 2026-05-18T00:00:00Z
status: partial
---

# Phase 7 — Code Review Fix Report

**Source review:** `07-REVIEW.md`
**Iteration:** 1
**Scope:** HIGH + MEDIUM (15 findings).

## Summary

| Category | Count |
| --- | --- |
| Findings in scope | 15 |
| Applied | 12 |
| Partial | 1 |
| Deferred | 3 (with rationale below) |
| Skipped | 0 |
| Extension tests | 996 / 996 passing |
| Relay tests | 71 / 71 passing |

Source-grep invariants verified post-fix:
- T-07-02 `relay/src/router.ts` does NOT reference `.payload` (router untouched; HI-01 annotation lives in `server.ts`).
- T-07-05 `relay/src/` does NOT reference `inviteCode`.
- 07-09 `relay/src/auth.ts` still contains `algorithms: ['HS256']`.
- 07-11 no `console.*` calls in `relay/src/`.
- 07-01 controllers do NOT construct `WebSocket(Server)`.

## Per-finding results

| ID | Severity | Status | Commit | Notes |
| --- | --- | --- | --- | --- |
| HI-01 | HIGH | applied: requires human verification | `cdb1318` | Relay annotates `payload.memberId = claims.sub` on every member→host frame inside `relay/src/server.ts` (second named carve-out alongside the host-role first-frame carve-out). Spoof defense: if joiner pre-supplies a `memberId`, it must match `claims.sub` or the relay closes 4400. `router.ts` byte-pass-through invariant preserved. Logic-bug class — flagged for human verification of the carve-out boundary (HI-01 has semantic correctness that source-grep cannot pin). |
| HI-02 | HIGH | applied | `8d2832c` | `WizardPanel.handleWizardComplete` derives `sessionId` from `crypto.randomBytes(6).toString('hex')` prefixed with `vc-` (48 bits entropy, decoupled from `inviteCode`). Output shape still matches the SESSION_ID_SHAPE regex in `relay/src/auth.ts` so MD-02's aud-shape gate accepts it. Existing buildDeepLink unit test passes (uses arbitrary `vc-7f3a92` literal, not the derivation function). |
| HI-03 | HIGH | applied | `4ff062f` | `ClientTransport` interface widened with optional `isCloud()` + `markIntentionalClose()`. `SessionClient.transport.onClose` skips `attemptReconnect()` when `transport.isCloud?.()` — CloudTransport owns reconnect. `SessionClient.disconnectInternal` calls `transport.markIntentionalClose?.()` BEFORE `transport.close()` to abort any pending reconnect timer. LAN paths unchanged (optional chain). |
| HI-04 | HIGH | applied | `2a77d9a` | `SessionRegistry.attachMember` now returns `AttachMemberResult` discriminated by `unknown-session` / `grace-active` / `member-cap`. `server.ts` closes with 4404 / 4503 / 4429 respectively. `CloudTransport.mapCloseCodeToState` gains matching states (`session-not-found` / `grace-period-active` / `member-cap-reached`) so retry policy differentiates terminal vs transient. Bundled with HI-05 since both share the discriminated-result refactor. |
| HI-05 | HIGH | applied: requires human verification | `2a77d9a` | `SessionRegistry.register` now accepts an optional `hostMemberId` (= `claims.sub`) and binds it on first register. Subsequent register calls whose `hostMemberId` mismatches the bound value are rejected; server closes 4403 `host-identity-mismatch`. Backwards-compat: 3-arg callers (tests) get pre-HI-05 lenient behavior — they pass `undefined` so the gate is not engaged. Logic-bug class — flagged for human verification of the identity-bind ordering across grace-recover + re-register paths. |
| HI-06 | HIGH | applied | `789a994` | `startServer` throws if `requireAuth: 'test'` AND `process.env.NODE_ENV === 'production'`. Inside `verifyClient`, the test-mode branch also fail-safes to 401 if NODE_ENV becomes 'production' between startup and a request (defense-in-depth against late env mutation). |
| MD-01 | MEDIUM | applied | `61ceea6` | Dropped dead `EnvelopeShapeError` / `EnvelopeEncryptedNotSupportedError` imports + unreachable catch branches in `CloudHostTransport.handleInbound`. The handler calls `JSON.parse` (not `deserialize`) per the local comment, so the envelope error classes never reach the catch. Re-introducing the L3 forward-compat seam (call `deserialize` again) was rejected as scope creep — left as a documented future-restore note. |
| MD-02 | MEDIUM | applied | `28ef8df` | `relay/src/auth.ts` validates the unverified `aud` against `/^vc-[a-z0-9-]{1,64}$/` before logging. On shape mismatch the log line is `{event:'auth-fail', reason:'malformed-aud'}` with NO echo of the attacker-controlled bytes. Closes the log-injection / log-poisoning attack via crafted JWTs. |
| MD-03 | MEDIUM | deferred | n/a | Bootstrap-path implementation (anonymous `/bootstrap` route or out-of-band JWT issuance) is a plan-level redesign — would change the cloud join handshake contract end-to-end. Requires Phase 7 plan revision (07-06 / 07-09) plus relay-side route handling. Out of scope for code review fixes. **Until resolved, cloud-mode join from JoinPanel cannot complete end-to-end** — flagged for Phase 7 closure note. |
| MD-04 | MEDIUM | deferred | n/a | Skipping the `JSON.parse → re-stringify` cycle in `CloudHostTransport.sendRaw` would require splitting `SessionHost.broadcast` into a cloud-aware fan-out helper. That refactor reaches into `SessionHost.broadcast` (hot path with byte-shape contracts pinned in `cloudEnvelope.test.ts`) and is too invasive to land safely without dedicated tests for the broadcast amortization path. Performance impact is real but bounded by `MAX_FRAME_BYTES = 1 MiB` per frame; deferred to a follow-up perf phase. |
| MD-05 | MEDIUM | partial | `4ff062f` | The HI-03 fix (`markIntentionalClose` wiring + single reconnect owner) eliminates the most-common race (duplicate scheduler). However, a true idempotency guard inside `CloudTransport.connect()` that refuses a second concurrent call (per the review's recommended defensive cleanup + memoized in-flight Promise) is NOT yet in place. The remaining race window is much narrower post-HI-03 — the user would have to manually trigger a reconnect during a pending scheduled retry, AND CloudTransport's class-level handler arrays would interleave events. Documented as a follow-up; not blocking. |
| MD-06 | MEDIUM | applied | `b4e8e2f` | `relay/src/server.ts` enforces `envelope.sessionId === attachedSessionId` on every post-attach frame. Mismatch closes 4400 `session-id-mismatch-post-attach`. |
| MD-07 | MEDIUM | applied | `fb3ce2c` | `SessionHost.attachCloudIssuer` JSDoc rewritten as "single-shot guard" (not "idempotent"). Throw message updated to match. Behavior unchanged — the misleading doc-claim was the defect. |
| MD-08 | MEDIUM | applied (host-side only) | `d6e97e6` | `TokenService.verify` now accepts an optional `expectedIssuer` parameter; when supplied, jose's `jwtVerify` validates `iss` matches. Relay-side `verifyToken` (`relay/src/auth.ts`) was NOT extended in this iteration because adding an `iss` check there requires deciding the iss-validation policy for member tokens (member JWTs are issued by the host, so iss === host.memberId for both host AND member tokens — the validation is meaningful but ties into HI-05's host-identity-bind work). Host-side is the bigger defense-in-depth gain (future client-side trust extensions); relay-side iss check deferred for a follow-up that can co-design with the multi-host story. |
| MD-09 | MEDIUM | applied | `47b0c72` | `SavedSession` widened with `mode?: 'lan'\|'cloud'` + `relayUrl?` + `sessionId?`. Cloud branch of `JoinPanel.handleJoinConnect` writes `mode: 'cloud'` + relayUrl + sessionId. LAN branch writes `mode: 'lan'` explicitly. Quick-connect UI re-render to consume `mode` is left for a future plan (the type widening is the structural prerequisite). |

## Deferred — rationale summary

- **MD-03 (cloud-join chicken-and-egg deadlock)** — plan-level redesign. Requires either a `/bootstrap` unauthenticated relay route or out-of-band joiner-JWT issuance via the deep link. Both options change the Phase 7 cloud join contract end-to-end and need plan revision before code lands. Flagged in 07-VERIFICATION as a Phase 7 closure note.
- **MD-04 (broadcast amortization regression in cloud mode)** — performance refactor that crosses the `SessionHost.broadcast` hot path with pinned byte-shape contracts. Safe to land only after dedicated broadcast-byte-shape tests for cloud fan-out exist. Deferred to a follow-up perf phase.
- **MD-08 (relay-side iss validation)** — partial: host side applied. Relay side deferred because iss-validation policy for member-role tokens needs to co-design with multi-host work (member JWTs carry `iss = host.memberId`, so the validation is asymmetric).

## Constraint preservation check

All hard constraints from the fix prompt verified after the fix run:

- 07-02 byte-shape snapshot: HOST→member broadcast unchanged (`server.ts` annotates ONLY member→host direction).
- T-07-02 source-grep: `relay/src/router.ts` contains NO `.payload` references (annotation moved to `server.ts`).
- T-07-05 source-grep: `relay/src/` contains NO `inviteCode` references.
- 07-09 source-grep: `relay/src/auth.ts` still contains literal `algorithms: ['HS256']`.
- 07-11 source-grep: no `console.*` in `relay/src/`.
- 07-01 transport seam: no `WebSocket(Server)` in controllers.
- HI-02 wire-level coordination: the WizardPanel sessionId change is purely outbound (it changes the value the host generates). Existing wire tests use literal `vc-*` ids so no test breakage; the new value still matches the relay's MD-02 aud-shape regex.

## Test runs

```
npm test                # extension: 996 / 996 passing
cd relay && npm test    # relay:     71 / 71 passing
```

---

_Fixed: 2026-05-18_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
