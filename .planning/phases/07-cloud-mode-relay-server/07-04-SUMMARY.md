---
phase: 07-cloud-mode-relay-server
plan: 04
subsystem: network/transport
tags: [transport, cloud, websocket, jwt-bearer-header, envelope, reconnect, wave-2, relay-portable]
dependency_graph:
  requires:
    - "07-01 — ClientTransport interface (src/network/Transport.ts) — CloudTransport implements drop-in"
    - "07-02 — CloudEnvelope wrap/serialize/deserialize (src/network/CloudEnvelope.ts) — send-side wrap; receive-side unwrap"
    - "07-03 — TokenService (src/auth/TokenService.ts) — caller (07-05/07-06) issues the JWT and passes the string to CloudTransport opaquely"
    - "src/network/heartbeat.ts ReconnectManager (PATTERNS Pattern C — reuse, do NOT re-implement backoff)"
  provides:
    - "src/network/CloudTransport.ts — CloudTransport class (implements ClientTransport from 07-01) + CloudConnectionState type + mapCloseCodeToState helper (all three exported)"
  affects:
    - "07-05 — Wizard cloud step (creates session, calls TokenService.issue, constructs SessionHost with `new CloudTransport(relayUrl, sessionId, hostToken)`)"
    - "07-06 — Join + UriHandler (constructs SessionClient with `new CloudTransport(relayUrl, sessionId, memberToken)`)"
    - "07-07 — StatusBarManager (subscribes via `cloudTransport.onStateChange(s => this.setCloudStatus(s, ctx))`; consumes the exact 4-tuple state union)"
    - "Future security phase (L3 E2E) — CryptoTransport decorator can wrap CloudTransport via the opaque TransportConnection seam; 07-02's EnvelopeEncryptedNotSupportedError is the v1↔L3 forward-compat alarm"
tech-stack:
  added: []
  patterns:
    - "Drop-in ClientTransport implementation alongside LanClientTransport — SessionClient is transport-agnostic (07-01 seam)"
    - "Byte-shape-only transport: zero msg.type / payload.type discrimination; protocol logic stays in SessionHost/SessionClient (seam discipline)"
    - "Discretionary injection seams for testability: WebSocketCtor parameter (default = ws.WebSocket) + reconnectManager: ReconnectManagerLike (default = new ReconnectManager())"
    - "ReconnectManagerLike narrow interface (scheduleReconnect + abort) — tests inject a spy without implementing the full ReconnectManager class"
    - "mapCloseCodeToState exported helper — single grep-auditable site for close-code → state translation"
    - "Loud forward-compat failure: malformed envelope AND encrypted:true both surface via onError; the DISTINCT error class is preserved at 07-02's throw site for future L3 instanceof-discrimination"
    - "Bearer-header credential carrier (NEVER URL query string) — T-07-03 ASVS V2.1.3 mitigation pinned by source-grep gate"
    - "Inline maxPayload literal at the constructor options bag — threat-model auditor finds the 1 MiB cap on the same line as the construction (T-07-08 grep auditability)"
key-files:
  created:
    - "src/network/CloudTransport.ts (~436 lines — CloudTransport class + CloudConnectionState type + ReconnectManagerLike interface + mapCloseCodeToState helper)"
    - "src/test/suite/cloudTransport.test.ts (~592 lines — 14 test cases: 13 plan-specified + 1 bonus mapCloseCodeToState unit; StubWebSocket + SpyReconnectManager helpers self-contained)"
  modified: []
decisions:
  - decision: "Inlined maxPayload: 1024 * 1024 at the WebSocket construction site (NOT a module-level constant)"
    rationale: "Plan §Verification step 7 source-grep expectation matches `maxPayload:\\s*1024\\s*\\*\\s*1024` AT THE CALL SITE. A module-level MAX_PAYLOAD_BYTES = 1024 * 1024 constant would split the grep — auditor sees the constant declaration in one place and the usage in another. Inlining keeps the T-07-08 mitigation auditable in one line. REFACTOR commit 11086f4 made this change post-GREEN."
  - decision: "Added a narrow ReconnectManagerLike interface (scheduleReconnect + abort only — NOT the full ReconnectManager API)"
    rationale: "Production code constructs `new ReconnectManager()` (concrete class from heartbeat.ts) by default. Tests inject a SpyReconnectManager that records scheduleReconnect calls — the spy only needs to implement two methods to satisfy the type. Widening the interface to include reset() / currentAttempt would force the spy to also implement those, eroding test isolation. Pattern C is preserved: CloudTransport imports ReconnectManager from ./heartbeat (source-grep gate) and the default constructor parameter is `new ReconnectManager()`."
  - decision: "markIntentionalClose() is on CloudTransport (NOT on the ClientTransport interface from 07-01)"
    rationale: "07-01 deliberately did NOT add markIntentionalClose to ClientTransport — LanClientTransport semantics already work via SessionClient.intentionalClose flag + transport.close(). CloudTransport adds the method as a class-level public surface because cloud mode has a different lifecycle (ReconnectManager schedules retries even after a code=1000 close in some edge cases). Callers wanting 'hard close, suppress reconnect' MUST call markIntentionalClose() first. SessionClient.disconnectInternal will downcast via `if (this.transport instanceof CloudTransport) this.transport.markIntentionalClose();` — 07-06's wiring problem, not ours. Source-grep gate intentionally does NOT enforce the interface widening — keeps 07-01 stable."
  - decision: "send() result of envelope-wrap path uses serialize(wrap(sessionId, msg)) verbatim (no alternate code path)"
    rationale: "Byte-shape contract from 07-02 is pinned by Plan test #6 — wire bytes MUST start with `{\"v\":1,\"sessionId\":\"vc-7f3a92\",\"encrypted\":false,\"payload\":`. Using anything other than wrap+serialize would risk diverging from the 07-02 invariant. send() catches synchronous throws (from JSON.stringify on a circular ref, for example) and returns false — no uncaught exception escapes into the ws library's event loop."
  - decision: "Receive path re-serializes env.payload to Buffer (NOT a typed ProtocolMessage delivery)"
    rationale: "07-01's ClientTransport.onMessage contract is `(raw: Buffer | ArrayBuffer | Buffer[]) => void`. LanClientTransport delivers raw protocol.ts bytes; SessionClient calls `parseMessage(raw.toString())` upstream. For CloudTransport to be a drop-in, the unwrapped payload object must be re-serialized so SessionClient's call site is identical for LAN and cloud. The cost (JSON.stringify of an already-parsed object) is microseconds and we're not in a hot path. Widening ClientTransport to accept ProtocolMessage directly would force a 07-01 refactor — defer."
  - decision: "Constructor parameter order — (relayUrl, sessionId, token, WebSocketCtor?, reconnectManager?)"
    rationale: "Production callers (07-05 host wizard, 07-06 join handler) pass exactly the three required strings — they DO NOT touch the discretion injection seams. Tests pass StubCtor + SpyReconnectManager in positions 4-5. Keeping the test seams at the END of the signature means the production call site reads `new CloudTransport(relayUrl, sessionId, hostToken)` — short, intentional, no test ceremony."
  - decision: "mapCloseCodeToState exported (NOT a private function)"
    rationale: "Test #14 (bonus) directly unit-tests the mapping — 4404 / 1000 / 1006 / 1011 / 4401. Exporting makes the test possible without reflection. The threat-model audit grep `grep -nE 'code === 4404|code === 1006|code === 1000' src/network/CloudTransport.ts` returns ONLY the lines inside mapCloseCodeToState (lines 113-114) confirming it's the sole branching site. Importing this function from 07-07 / 07-08 in the future would also be cleanly typed."
metrics:
  duration: "~8 minutes (sequential execution; 461s wall-clock from start to SUMMARY)"
  completed-date: "2026-05-19"
  tests-added: 14
  tests-total-before: 892
  tests-total-after: 906
requirements-completed: [NET-06]
---

# Phase 7 Plan 04: CloudTransport Summary

**One-liner:** Cloud-mode `ClientTransport` implementation — outbound WSS to a relay with Bearer-header auth, CloudEnvelope wrap/unwrap, exponential-backoff reconnect via the existing `ReconnectManager`, and a 4-state lifecycle (`'connected' | 'session-not-found' | 'relay-unreachable' | 'disconnected'`) ready for 07-07 StatusBarManager wiring.

## What Shipped

| Artifact | Role | Lines |
|----------|------|-------|
| `src/network/CloudTransport.ts` | `CloudTransport implements ClientTransport`; outbound `wss://` to relay; envelope wrap/unwrap; Bearer header; ReconnectManager reuse; `onStateChange` surface | 436 |
| `src/test/suite/cloudTransport.test.ts` | Mocha suite `Phase 7 — cloud transport` — 14 cases (13 plan-specified + 1 bonus `mapCloseCodeToState` unit) with `StubWebSocket` + `SpyReconnectManager` helpers self-contained | 592 |

**No modifications to any existing file.** `package.json`, `tsconfig.json`, `src/network/heartbeat.ts`, `src/network/CloudEnvelope.ts`, `src/network/Transport.ts`, `src/network/LanTransport.ts`, `src/host/SessionHost.ts`, `src/client/SessionClient.ts`, and `src/auth/TokenService.ts` are all `git diff`-empty.

## Exports Added

```ts
export type CloudConnectionState =
  | 'connected'
  | 'session-not-found'
  | 'relay-unreachable'
  | 'disconnected';

export interface ReconnectManagerLike {
  scheduleReconnect(connect: () => Promise<boolean>, onFailed: () => void): void;
  abort(): void;
}

export function mapCloseCodeToState(code: number, hadOpened: boolean): CloudConnectionState;

export class CloudTransport implements ClientTransport {
  constructor(
    relayUrl: string,
    sessionId: string,
    token: string,
    WebSocketCtor?: any,                      // default = ws.WebSocket
    reconnectManager?: ReconnectManagerLike,  // default = new ReconnectManager()
  );

  connect(): Promise<boolean>;
  onOpen(handler: () => void): void;
  onMessage(handler: (raw: Buffer | ArrayBuffer | Buffer[]) => void): void;
  onClose(handler: (code: number, reason: Buffer) => void): void;
  onError(handler: () => void): void;
  onPong(handler: () => void): void;
  onStateChange(handler: (s: CloudConnectionState) => void): void;  // cloud-specific surface
  send(msg: ProtocolMessage): boolean;
  ping(): void;
  isOpen(): boolean;
  markIntentionalClose(): void;
  close(code?: number, reason?: string): void;
}
```

All three exports are importable from `'../../network/CloudTransport.js'` by downstream Wave 2 + Wave 3 consumers.

## ClientTransport Interface Conformance

CloudTransport implements every method of the `ClientTransport` interface from 07-01 `src/network/Transport.ts`:

| Method | Behavior |
|--------|----------|
| `connect()` | Opens `new WebSocket(relayUrl, { headers: { Authorization: 'Bearer <jwt>' }, maxPayload: 1024 * 1024, perMessageDeflate: false })`. Resolves true on socket-open, false on pre-open failure. |
| `onOpen(h)` | Pushes handler to `openHandlers`; fired AFTER `emitStateChange('connected')` inside the `'open'` listener. |
| `onMessage(h)` | Receives `Buffer` of UNWRAPPED payload bytes — `Buffer.from(JSON.stringify(env.payload))` — so upstream `parseMessage(raw.toString())` is byte-identical with LAN. |
| `onClose(h)` | Receives `(code, reason)` after `mapCloseCodeToState` has fired `onStateChange`. |
| `onError(h)` | Parameterless. Fires on ws-level error AND on envelope-deserialize failure AND on encrypted:true (loud forward-compat). |
| `onPong(h)` | Forwarded from `ws.on('pong', ...)`. |
| `send(msg)` | Wraps in envelope via `wrap(sessionId, msg)` → `serialize()` → `ws.send(string)`. Returns false if not OPEN. |
| `ping()` | Forwards to `ws.ping()` if OPEN. |
| `isOpen()` | True iff `ws.readyState === WebSocket.OPEN`. |
| `close(code=1000, reason?)` | Forwards to `ws.close(code, reason)`. Idempotent. |

**Cloud-specific (NOT on ClientTransport):**

| Method | Behavior |
|--------|----------|
| `onStateChange(h)` | Cloud-mode lifecycle handler. Fires on open / close / pre-open-error. Receives ONLY the state enum value (T-07-state-leak — never URL, sessionId, or token). |
| `markIntentionalClose()` | Sets `intentionalClose = true` AND calls `reconnect.abort()`. Defense in depth removes the race between a pending retry timer and the close handler. SessionClient.disconnectInternal will call this when the transport is a CloudTransport instance (07-06 wiring problem). |

## Close-Code → State Mapping (canonical)

The `mapCloseCodeToState(code: number, hadOpened: boolean): CloudConnectionState` exported helper is the SOLE close-code branching site in CloudTransport.ts.

| WSS close code | `hadOpened` | Returned state | Reconnect? |
|----------------|-------------|----------------|------------|
| `4404` (custom — relay: session not found) | any | `'session-not-found'` | NO (terminal — T-07-reconnect-loop mitigation) |
| `1000` (normal closure) | any | `'disconnected'` | NO (terminal — caller-initiated or graceful) |
| `1006` (abnormal closure — no close frame received) | any | `'relay-unreachable'` | YES (ReconnectManager schedules retry) |
| `1001` (going away), `1011` (server error), `4401` (invalid token), any other | any | `'relay-unreachable'` | YES |
| Pre-open TCP/TLS failure (synthetic — error before open) | `false` | `'relay-unreachable'` | YES |

The `hadOpened` parameter is kept in the function signature so a future "soft close" branch can distinguish pre-open vs post-open failures. Today both paths funnel into `'relay-unreachable'` for non-1000/4404 codes — but the seam is open.

**Why 4404 is its own state vs bundled into relay-unreachable:** UX rationale from CONTEXT D-10 — "session not found" is distinct user-actionable feedback (host has shut down OR session-id typo) vs "relay unreachable" (network issue OR relay down). The 07-07 StatusBarManager surfaces both states with distinct help text.

## Wave 2 Downstream Wiring Notes

### For 07-06 (SessionClient join + UriHandler)

After receiving a cloud-mode invite (URI handler decodes `vscode://versioncon/join-cloud?session=vc-...&token=<jwt>`), 07-06 will construct a SessionClient with an explicit CloudTransport:

```ts
// 07-06 sketch — joiner-side cloud connect
const relayUrl = config.get('cloudRelayUrl');     // 'wss://relay.fly.dev'
const sessionId = parsedUri.query.session;        // 'vc-7f3a92'
const token = parsedUri.query.token;              // JWT issued by host (relayed via invite)

const cloudTransport = new CloudTransport(relayUrl, sessionId, token);
const client = new SessionClient(/* hostIp ignored */ '', 0, inviteCode, displayName, cloudTransport);

await client.connect();   // SessionClient's existing connect() flow drives the transport
```

The two ignored args (`hostIp`, `port`) are LAN-mode positional parameters from 07-01's constructor signature. 07-06 may decide to refactor SessionClient's constructor to accept a `transport-only` overload — that's a 07-06 discretion call, not this plan's scope.

### For 07-07 (StatusBarManager)

StatusBarManager subscribes via `onStateChange` and translates each state to the existing `setCloudStatus(state, ctx)` API:

```ts
// 07-07 sketch — StatusBarManager wiring
if (transport instanceof CloudTransport) {
  transport.onStateChange((s) => {
    // s is exactly one of 'connected' | 'session-not-found' | 'relay-unreachable' | 'disconnected'
    statusBarManager.setCloudStatus(s, {
      relayUrl: /* from CloudStatusContext — NOT from transport */,
      sessionId: /* from CloudStatusContext — NOT from transport */,
    });
  });
}
```

The state enum is the EXACT 4-tuple `'connected' | 'session-not-found' | 'relay-unreachable' | 'disconnected'` — no widening required. If 07-07 needs a `'reconnecting'` substate (e.g. between a 1006 close and the next reconnect attempt), it must derive it from the `ReconnectManager.currentAttempt` counter or a separate event — CloudTransport does not emit `'reconnecting'` in v1.

### For 07-05 (host-side wizard cloud step)

The host wizard creates the session, calls `TokenService.issue(hostClaims)` to mint a host-role JWT, and constructs SessionHost with a CloudTransport:

```ts
// 07-05 sketch — host-side cloud session creation
const tokenSvc = new TokenService(/* shared secret from session-store */);
const hostToken = await tokenSvc.issue({
  iss: hostMemberId,
  sub: hostMemberId,
  aud: sessionId,
  role: 'host',
});

const cloudTransport = new CloudTransport(relayUrl, sessionId, hostToken);
// NOTE: CloudTransport implements ClientTransport, NOT HostTransport. The host
// in cloud mode is ALSO a client (of the relay) — see D-04 in CONTEXT.md.
// 07-05 will need to provide a CloudHostAdapter that bridges HostTransport
// → CloudTransport (open question for 07-05; not this plan's scope).
```

**Open question deferred to 07-05:** SessionHost's constructor expects a `HostTransport` (07-01 interface; many connections, server-side). CloudTransport implements `ClientTransport` (single connection, client-side). 07-05 will need to introduce a fan-out adapter — likely `CloudHostAdapter implements HostTransport` that wraps a single CloudTransport and demultiplexes inbound envelopes by `payload.senderMemberId` or similar. This plan deliberately does NOT ship that adapter — D-04 says the host is "client to relay" so the host-fanout responsibility is the relay's, not the transport's. 07-05's call.

## Threat-Mitigation → Test Mapping

| Threat ID | Mitigation | Test # | Assertion |
|-----------|------------|--------|-----------|
| **T-07-03** | JWT in `Authorization: Bearer` header; NEVER query string | **#1, #13** | #1 asserts options.headers.Authorization === 'Bearer fake.jwt.token' AND URL has no `?token=` / `?jwt=`. #13 source-grep verifies CloudTransport.ts contains no `?token=` / `?jwt=` / `wss://...?...` patterns AND contains `Authorization.*Bearer`. ASVS V2.1.3 / V3.1.1. |
| **T-07-08** | `maxPayload: 1024 * 1024` (1 MiB) on WebSocket constructor | **#2** | Asserts options.maxPayload === 1024 * 1024 AND options.perMessageDeflate === false. Inline literal at the call site keeps it grep-auditable. ASVS V13.1.4. |
| **T-07-envelope-shape** | Malformed envelope surfaces via `onError` (try/catch around deserialize) | **#8** | Emits `'{not-json'` over the stubbed message event; asserts onError fires exactly once AND onMessage never fires AND no exception escapes. ASVS V13.1.1. |
| **T-07-encrypted-skew** | `encrypted:true` from future L3 peer surfaces via `onError` (loud forward-compat failure) | **#9** | Emits `{"v":1,"sessionId":"x","encrypted":true,"payload":"opaque-ciphertext"}`; asserts onError fires AND onMessage never fires. Distinct error CLASS preserved at 07-02 throw site for future L3 instanceof-discrimination. |
| **T-07-reconnect-loop** | 4404 is terminal — reconnect NOT scheduled on session-not-found | **#3** | Emits close 4404 after open; asserts spy.scheduleCalls.length === 0 AND no new stub ws constructed. Tests #4 + #11 separately confirm scheduleReconnect IS called for 1006 AND aborted by markIntentionalClose. |
| **T-07-state-leak** | onStateChange handler receives ONLY the state enum (no URL, sessionId, or token) | (covered by API surface — handler signature is `(s: CloudConnectionState) => void`) | TypeScript-level guarantee; no runtime test needed because the handler signature is the contract. |

## Heartbeat Reuse Confirmation

- **Imported:** `import { ReconnectManager } from './heartbeat.js';` (line 52 of CloudTransport.ts).
- **Never called directly:** `getReconnectDelay` is not imported and not referenced anywhere in CloudTransport.ts (source-grep test #12 enforces).
- **Hand-rolled backoff math forbidden:** `Math.pow(2, ...)` pattern not present (source-grep test #12 enforces).
- **Default construction:** `this.reconnect = reconnectManager ?? new ReconnectManager();` — production callers get the real exponential-backoff machinery with 10-attempt cap and jitter.
- **Test injection:** SpyReconnectManager (in the test file) structurally satisfies `ReconnectManagerLike` (the narrow interface declared in CloudTransport.ts) and is passed as constructor arg 5 — defaults remain untouched for production.

## Seam Discipline Audit (Plan §Verification + Task 3 STEPs 2-5)

| Audit | Expected | Actual |
|-------|----------|--------|
| `grep -nE "envelope\.payload\.\|env\.payload\." src/network/CloudTransport.ts` | ≤1 (the JSON.stringify line) | 0 — the bare `env.payload` reference doesn't match the trailing-dot pattern (correct: no deep-payload inspection) |
| `grep -nE "msg\.type\|payload\.type\|case .auth-request" src/network/CloudTransport.ts` | 0 | 0 — transport is byte-shape-only |
| `grep -rnE "wss://.*\?token=" src/` | 0 | 0 — repo-wide invariant holds |
| `grep -nE "getReconnectDelay\(" src/network/CloudTransport.ts` | 0 | 0 — Pattern C upheld |
| `grep -nE "from ['\"]\\./heartbeat" src/network/CloudTransport.ts` | 1 | 1 (line 52) |
| `grep -nE "Authorization.*Bearer" src/network/CloudTransport.ts` | ≥1 | 2 (line 5 JSDoc, line 208 construction site) |
| `grep -nE "maxPayload:\\s*1024\\s*\\*\\s*1024" src/network/CloudTransport.ts` | 1 inline literal | 1 (line 204 — REFACTOR commit 11086f4 inlined the constant) |
| `grep -nE "code === 4404\|code === 1006\|code === 1000" src/network/CloudTransport.ts` | matches ONLY inside `mapCloseCodeToState` | 2 (lines 113-114, both inside mapCloseCodeToState — fallthrough handles 1006/other) |
| `git diff src/network/heartbeat.ts` | empty | empty — heartbeat.ts unmodified |
| `grep -nE "from ['\"](vscode\|\.\./ui\|\.\./client/SessionClient)" src/network/CloudTransport.ts` | 0 | 0 — relay-portable |
| `git diff package.json tsconfig.json` | empty | empty |

## Test Count Delta

| When | Total Passing | Pending | Failing |
|------|--------------:|--------:|--------:|
| Before plan (07-03 SUMMARY baseline) | 892 | 66 | 0 |
| After Task 1 RED (test file added, tsc fails) | 892 | 66 | 0 (tsc blocks vscode-test from running new file; existing suite uncompiled) |
| After Task 2 GREEN | 906 | 66 | 0 |
| After Task 3 REFACTOR (maxPayload inline) | **906** | 66 | 0 |

Net for this plan: **+14 new tests** (13 plan-specified + 1 bonus `mapCloseCodeToState` unit). Two consecutive `npm test` runs both produced 906 / 0 / 66 — no flake.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Refactor commit fixed source-grep mismatch on maxPayload literal**

- **Found during:** Task 3 STEP 2 audit
- **Issue:** The GREEN commit declared `const MAX_PAYLOAD_BYTES = 1024 * 1024;` at module scope and used `maxPayload: MAX_PAYLOAD_BYTES` at the construction site. The Plan's §Verification step 7 grep `grep -qE "maxPayload:\s*1024\s*\*\s*1024|maxPayload:\s*1048576" src/network/CloudTransport.ts` would have failed because the literal is split between the constant declaration (line 102 pre-refactor) and the usage (line 209 pre-refactor) — neither line matches the regex.
- **Fix:** Removed the module-level constant; inlined `maxPayload: 1024 * 1024` at the WebSocket construction site (line 204 of the post-refactor file). Test #2 still passes (asserts the runtime value === 1024 * 1024) and the §Verification grep now succeeds.
- **Files modified:** `src/network/CloudTransport.ts`
- **Commit:** `11086f4`

**2. [Rule 1 — Bug] Removed `?token=` / `?jwt=` literal substring from JSDoc comment**

- **Found during:** Task 2 test execution — Test #13 (source-grep gate) failed because the JSDoc comment at line 32 of the GREEN file said `forbid \`?token=\` / \`?jwt=\` in this file`. The literal patterns appeared inside backticks but the source-grep regex matched them regardless.
- **Fix:** Rewrote the JSDoc comment to reference the patterns by description rather than literal: `forbid query-string credential parameters in this file and any wss URL with a query string`.
- **Files modified:** `src/network/CloudTransport.ts` (during GREEN — inline fix, no separate commit)
- **Commit:** Folded into `a5beef9` (GREEN)

No Rule 2 (missing functionality), Rule 3 (blocking), or Rule 4 (architectural decision) deviations occurred.

### Discretion Choices Made (logged for downstream visibility)

**1. Added `ReconnectManagerLike` interface (NOT the concrete class)**

Plan §Task 2 §behavior listed the optional `ReconnectManagerLike` interface as a discretion call. Chose to add it — tradeoff: extra 5 lines in CloudTransport.ts for a narrower test surface. The interface is intentionally narrow (scheduleReconnect + abort only) so a future replacement of ReconnectManager doesn't have to satisfy a wide API to remain compatible.

**2. WebSocketCtor injection seam (NOT a sinon module-level mock)**

Plan §Task 2 §behavior §Discretion call offered sinon as an alternative. Chose the constructor-parameter injection — keeps the test file fully synchronous, no module-mocking machinery, no test-only side effects on import. The cast `WebSocketCtor: any = WebSocket` is a known trade — `ws.WebSocket`'s constructor type is complex enough that a stricter typing would force the test stub to implement methods that CloudTransport doesn't actually call. The discretion is documented in the JSDoc.

**3. Bonus 14th test (mapCloseCodeToState unit)**

Plan specified 13 tests. Added a 14th — a direct unit test of `mapCloseCodeToState` covering 4404 / 1000 / 1006 / 1011 / 4401 / `hadOpened` true+false. Plan tests #3-#5 cover the mapping indirectly through state-observation; pinning the function directly catches regressions where the function's mapping changes but the close-code → state sequence happens to still pass (e.g. someone widens 1006 to a different return value but the `relay-unreachable` happens to fire for an unrelated reason elsewhere).

**4. markIntentionalClose() NOT widened onto ClientTransport interface**

Plan §Decision-zone allowed widening ClientTransport to include markIntentionalClose. I did NOT widen it — keeps 07-01 stable. 07-06's SessionClient.disconnectInternal will downcast via `instanceof CloudTransport`. Logged as a decision above so 07-06 doesn't re-debate.

### No Threat Flags Raised

CloudTransport ships zero new network endpoints (it's a CLIENT — it opens, never accepts), zero new file access patterns, zero new auth surface (Bearer header is the existing JWT mechanism from 07-03, just transported via HTTP header rather than wire body). The plan's `<threat_model>` register fully covers the change set.

## TDD Gate Compliance

| Gate | Commit | Subject | Pass/Fail |
|------|--------|---------|-----------|
| RED | `da144cb` | `test(07-04): add failing CloudTransport suite (RED)` | ✅ tsc fails with `Cannot find module '../../network/CloudTransport.js'` — confirmed RED |
| GREEN | `a5beef9` | `feat(07-04): CloudTransport with Bearer header + envelope wrap + ReconnectManager reuse (GREEN)` | ✅ all 14 tests pass; full suite 906/0/66 |
| REFACTOR | `11086f4` | `refactor(07-04): inline maxPayload literal at call site for grep auditability` | ✅ all 14 still pass; behavior byte-identical |

## Wave 2 Readiness Gate

**PASSED.** CloudTransport is consumable by:
- **07-05** (host wizard cloud step) — pending CloudHostAdapter discretion call (D-04 host-as-client-to-relay implies fanout lives in the relay, not the transport)
- **07-06** (join + UriHandler) — direct `new CloudTransport(relayUrl, sessionId, token)` construction; SessionClient downcasts for `markIntentionalClose()`
- **07-07** (StatusBarManager) — `onStateChange` returns the exact 4-tuple state union; no widening needed

## Commits Landed

| # | Hash | Type | Message |
|---|------|------|---------|
| 1 | `da144cb` | test | `test(07-04): add failing CloudTransport suite (RED)` |
| 2 | `a5beef9` | feat | `feat(07-04): CloudTransport with Bearer header + envelope wrap + ReconnectManager reuse (GREEN)` |
| 3 | `11086f4` | refactor | `refactor(07-04): inline maxPayload literal at call site for grep auditability` |

## Self-Check: PASSED

- ✅ File `src/network/CloudTransport.ts` exists (436 LOC)
- ✅ File `src/test/suite/cloudTransport.test.ts` exists (592 LOC)
- ✅ Commit `da144cb` (RED) found in git log
- ✅ Commit `a5beef9` (GREEN) found in git log
- ✅ Commit `11086f4` (REFACTOR) found in git log
- ✅ `npx tsc --noEmit` exit 0
- ✅ `npx vscode-test --grep "Phase 7.*cloud transport"` — 14 passing
- ✅ Full suite `npm test` — 906 passing / 0 failing / 66 pending (twice consecutively)
- ✅ `package.json` and `tsconfig.json` unchanged (verified `git diff` returns empty)
- ✅ Wave 1 files (07-01 / 07-02 / 07-03) unchanged
- ✅ `src/network/heartbeat.ts` unchanged (PATTERNS Pattern C — reuse, not modify)
- ✅ `grep -q "implements ClientTransport" src/network/CloudTransport.ts` succeeds
- ✅ `grep -q "from ['\"]\./heartbeat" src/network/CloudTransport.ts` succeeds
- ✅ `! grep -E "getReconnectDelay\(|Math\.pow\(2," src/network/CloudTransport.ts` succeeds (no hand-rolled backoff)
- ✅ `! grep -rE "wss://.*\?token=" src/` succeeds (repo-wide invariant — no URL-query-string credentials)
- ✅ `grep -q "Authorization.*Bearer" src/network/CloudTransport.ts` succeeds
- ✅ `grep -qE "maxPayload:\s*1024\s*\*\s*1024" src/network/CloudTransport.ts` succeeds (inline literal at the construction site)
- ✅ `! grep -E "from ['\"](vscode|\.\./ui|\.\./client/SessionClient)" src/network/CloudTransport.ts` succeeds (relay-portable)
