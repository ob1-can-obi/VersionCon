---
phase: 07-cloud-mode-relay-server
review_depth: standard
files_reviewed: 17
findings:
  high: 6
  medium: 9
  low: 8
  info: 4
status: issues
reviewer: gsd-code-reviewer
created: 2026-05-18T00:00:00Z
---

# Phase 7 — Code Review (Cloud Mode + Relay Server)

This review covers the 17 source files listed in scope for Phase 7. Findings
classified per `<adversarial_stance>`: HIGH = BLOCKER (incorrect behavior,
security vulnerability, or end-to-end functionality break); MEDIUM/LOW = WARNING
(quality, defense-in-depth gap, or robustness defect that should be fixed);
INFO = documentation/style polish.

The Phase 7 surface is large (cloud-host factory + transport seam refactor +
new relay package + JWT issuer/verifier + UI deep-link). The relay-side files
are tight and the threat-model anchors are visible in source. The extension-side
adapter (`CloudHostTransport`) and the relay's member→host annotation behavior
do NOT line up, however — see HI-01.

---

## HIGH (BLOCKER)

### HI-01 — Cloud-mode joining is non-functional: relay never injects `payload.memberId`, host-side demux treats joiner auth-request as a "system frame"

**File:** `relay/src/server.ts:262-276` and `src/network/CloudHostTransport.ts:386-397`
**Category:** correctness / security

**Issue:**
End-to-end cloud joining cannot succeed with the code as shipped.

The host-side demultiplexer `CloudHostTransport.handleInbound` routes frames by
reading `payload.memberId`. When `payload.memberId` is absent (or non-string /
empty), the frame is dispatched to `systemMessageHandlers` — NOT to any
`VirtualConnection`, so `onConnection` does NOT fire and `SessionHost.handleConnection`
is never invoked (`src/network/CloudHostTransport.ts:386-397`).

A real joiner's first frame is an `auth-request`. The `AuthRequest` interface
in `src/network/protocol.ts:70-83` has NO `memberId` field, and
`SessionClient.connect()` emits a bare auth-request:
```
this.transport.send({ type:'auth-request', inviteCode, displayName, timestamp });
```
The relay forwards bytes verbatim (`relay/src/router.ts:100-109` member→host
path performs no annotation). So the host receives an `auth-request` payload
with no `memberId` → demux treats it as a system frame → SessionHost has no
subscriber → silent drop.

The Phase-7 plan (`07-05b-PLAN.md` §threat-model T-07-mid line 825) explicitly
states "the relay should additionally annotate inbound traffic with the verified
sub claim — DOCUMENTED as a 07-09 closing layer." 07-09 ships only the
`TokenInfo {sessionId, memberId, role}` for the verifyClient seam — there is NO
member→host payload-injection step in `relay/src/server.ts` or
`relay/src/router.ts`.

The existing test `src/test/suite/hostCloudWiring.test.ts:270-278` papers over
this by MANUALLY injecting `memberId: 'joiner-routing-key-1'` into the simulated
payload — it cannot detect the missing relay-side injection.

**Fix:**
Either (a) inject `payload.memberId = claims.sub` on every member→host frame
inside `relay/src/server.ts`'s `ws.on('message')` handler (parse JSON, set
`payload.memberId`, re-stringify, forward) — but this breaks the
byte-pass-through invariant T-07-02 on member→host direction and would need an
explicit carve-out comment;
or (b) have the joiner's `SessionClient`-via-`CloudTransport` include its
own `claims.sub` as `payload.memberId` on every outbound frame — but a member
does not have access to its `sub` until after auth-response, so an alternative
identifier (the JWT itself, decoded locally) is required; the relay would still
need to validate that `payload.memberId === claims.sub` to prevent spoofing.

Option (a) is the design the plan documents. Add the injection in server.ts
and add an explicit byte-pass-through carve-out comment plus a source-grep
test relaxation. Add an integration test that uses a REAL relay between two
CloudTransports rather than the FakeClientTransport seam — the seam hides
this defect.

---

### HI-02 — `sessionId` derivation `'vc-' + inviteCode.toLowerCase()` makes invite code trivially recoverable from any sessionId observation (T-07-05 broken)

**File:** `src/ui/WizardPanel.ts:654`
**Category:** security

**Issue:**
The cloud share-screen / deep-link sessionId is derived as:
```ts
this.state.sessionId = 'vc-' + this.state.inviteCode.toLowerCase();
```
Invite codes are 6 characters from a 32-character uppercase alphabet
(`src/utils/id.ts:7`). Anyone who observes `sessionId` (relay logs, on-wire
envelopes, network observers) can recover the invite code by:
```
inviteCode = sessionId.slice(3).toUpperCase()
```

The relay logger redacts `code` / `*.code` / `token` / `secret` paths
(`relay/src/logger.ts:55-82`) — but DOES NOT redact `sessionId`. By design:
"sessionId is the routing key and is intentionally NOT in the redact set
(operational signal)" (`relay/src/server.ts:308-310`). Log lines containing
`sessionId` include `{event:'connection-open'…}`, `{event:'auth-fail',sessionId,reason}`,
`{event:'idle-reap',sessionId}`, etc. Every one of these LEAKS THE INVITE CODE.

This directly contradicts the 07-05 threat-model invariant
(`07-CONTEXT.md` + 07-05b plan): *"`inviteCode` literal must NOT appear
anywhere in relay/src/"*. The grep gate passes because the literal field name
is absent — but the **value** is recoverable from `sessionId` with one
`.toUpperCase()` operation, so the structural defense is meaningless.

Anyone with read access to the Fly.io log stream, or anyone running tcpdump
between the joiner and the relay (sessionId rides in plaintext in every
envelope), can recover the invite code and replay it to join the session.

**Fix:**
Derive `sessionId` from random bytes, completely decoupled from `inviteCode`.
For example:
```ts
this.state.sessionId = 'vc-' + crypto.randomBytes(6).toString('hex');
```
Persist this in WizardState alongside (not derived from) `inviteCode`. Update
the deep-link to carry the new sessionId. Document the locked decoupling in
07-CONTEXT.md with a source-grep test asserting `inviteCode` is not used in
`sessionId` construction in WizardPanel.ts.

---

### HI-03 — Cloud-mode reconnect storm: both `SessionClient` and `CloudTransport` schedule duplicate reconnects on unintentional close

**File:** `src/network/CloudTransport.ts:285-296` and `src/client/SessionClient.ts:201-237`
**Category:** correctness

**Issue:**
Two independent `ReconnectManager` instances both fire on the same close event
in cloud mode:

1. `CloudTransport.connect()` registers `ws.on('close', …)` which calls
   `this.reconnect.scheduleReconnect(() => this.connect(), …)` whenever
   `state === 'relay-unreachable'` (lines 290-295).
2. `SessionClient.connect()` registers `transport.onClose(…)` which calls
   `this.attemptReconnect()` (which itself calls `this.reconnect.scheduleReconnect(() => this.connect(), …)` — `SessionClient.ts:539-555`).

`SessionClient.connect()` internally calls `this.transport.connect()`, which
creates a brand-new `WebSocket` and overwrites `this.ws` inside CloudTransport.
The previous ws (also scheduled to reconnect by CloudTransport's own scheduler)
is orphaned but its handler arrays still fan out into the shared class
instance's handler lists. After two race wins, you can have one ws emitting
events while another is mid-construction. Per-attempt closures are correct,
but the duplicate ladder doubles the connection rate against the relay (which
will then 429 the host's IP — `relay/src/limits.ts:38` MAX_PER_MIN = 30).

The CloudTransport JSDoc at lines 405-411 explicitly states
"`SessionClient.disconnectInternal` will call this [markIntentionalClose] when
the transport is a CloudTransport instance," but `SessionClient.ts` has ZERO
calls to `markIntentionalClose`:
```
$ grep -n markIntentionalClose src/client/SessionClient.ts
(no output)
```

`disconnectInternal` only sets `this.intentionalClose = true` on the
`SessionClient` (lines 622-625) and calls `transport.close(1000, …)`. That
1000 close happens to map to `'disconnected'` in `mapCloseCodeToState`, which
short-circuits CloudTransport's reconnect branch — so intentional disconnect
works by coincidence. UN-intentional close (1006, 1011, 4401, etc.) maps to
`'relay-unreachable'` and BOTH reconnect schedulers fire.

**Fix:**
Choose ONE reconnect owner. CloudTransport's own reconnect logic exists
because the close-code → state mapping needs to gate retries (4404
terminal vs 1006 retry). The cleanest fix: remove `attemptReconnect()` from
the `SessionClient.transport.onClose` path when `transport.isCloud?.()` is true
(let the transport own reconnect entirely), and have CloudTransport emit a
synthetic re-open event so SessionClient can re-send auth-request after the
backoff completes. Also wire `disconnectInternal` to call
`(transport as CloudTransport).markIntentionalClose?.()` BEFORE `transport.close()`
to make the design intent explicit.

---

### HI-04 — Relay's `attachMember` reject reasons collapse to single close code 4429, losing diagnostic signal AND breaking client state mapping

**File:** `relay/src/server.ts:248-252` and `relay/src/SessionRegistry.ts:109-118`
**Category:** correctness / security

**Issue:**
Three distinct reject conditions in `SessionRegistry.attachMember()` all return
`false` undifferentiated:
- Unknown sessionId (no auto-create — "Phase 4.1 invariant violation prevention")
- `graceTimer !== null` — session is in host-drop grace window (T-07-14)
- Member cap reached (T-07-13)

The server closes with one code:
```ts
const attached = registry.attachMember(sid, claims.sub, ws);
if (!attached) {
  ws.close(4429, 'attach-rejected');
  return;
}
```

`SessionRegistry.ts:96-108` documents two distinct intended close codes
("caller closes with 4429 or 4503 'grace-period-active'") — but the server
emits only 4429.

Consequences:
1. `CloudTransport.mapCloseCodeToState` treats 4429 as `'relay-unreachable'`
   (everything not 1000/4404 → unreachable). The joiner client retries
   immediately, hitting the same condition, busy-looping until rate-limited
   by `checkConnection` (30/min/IP). For an unknown sessionId this is wrong —
   it should map to `'session-not-found'` (a 4404).
2. Operations cannot distinguish "host hasn't returned from a drop yet"
   (transient) from "session never existed" (terminal) from "session at member
   cap" (semi-terminal).

**Fix:**
Differentiate the three failure modes — return a discriminated result
(`{ ok: false, reason: 'unknown-session' | 'grace-active' | 'member-cap' }`)
and close with:
- `unknown-session` → 4404 'session-not-found'
- `grace-active`    → 4503 'grace-period-active' (still maps to relay-unreachable)
- `member-cap`      → 4429 'member-cap-reached'

Add `mapCloseCodeToState` cases for 4503 (=> relay-unreachable, transient
retry OK) and ensure 4404 path doesn't try to reconnect.

---

### HI-05 — `SessionRegistry.register()` lets ANY host-role JWT bearer evict an existing host AND rotate verifySecret without identity check

**File:** `relay/src/SessionRegistry.ts:60-78`
**Category:** security

**Issue:**
The host re-attach branch in `register()`:
```ts
if (existing) {
  if (existing.hostSocket !== null) {
    existing.hostSocket.close(1008, 'host-replaced');
  }
  this.cancelGracePeriod(sessionId);
  existing.hostSocket = hostSocket;
  existing.verifySecret = verifySecret;     // <-- secret is silently rotated
  existing.lastActivity = Date.now();
  return true;
}
```
The relay's only auth check is "valid host-role JWT for this aud" — which
means **any** principal holding a valid host-role JWT for the session id can
boot the current host and install a NEW `verifySecret`. After secret rotation,
the previous host's JWTs (issued to its joiners using the *original* secret)
no longer verify against `session.verifySecret`. Every joiner is silently
locked out at the relay (auth-fail), even though the original host still
believes they are connected.

There is no record of `hostMemberId` on register — the `hostMemberId?` field
exists on `Session` but is never populated by `register()` (see line 38: "may
populate from JWT iss/sub" — TODO that was not done in 07-09).

Threat scenario: An attacker who obtains the host JWT (via XSS in an old VS
Code window, malicious extension, leaked log line) can not just listen as the
host — they can **replace** the host, install their own verifySecret, and
issue forged joiner JWTs that the relay will validate against THEIR secret.
The original host is silently disconnected (close code 1008 'host-replaced'
maps to `'relay-unreachable'` and the original host's CloudTransport begins
reconnecting, hitting the same overwrite race).

**Fix:**
Populate `hostMemberId` from `claims.sub` on first `register()`, and on every
subsequent register call, verify the new claims' `sub` matches the stored
`hostMemberId`. Reject (close 4403) on mismatch. Document the lifecycle
in 07-CONTEXT under T-07-09.

---

### HI-06 — Relay test-mode (`requireAuth: 'test'`) ships in production bundle, accepts client-supplied JWT claims via headers

**File:** `relay/src/server.ts:48`, `relay/src/server.ts:119-136`
**Category:** security

**Issue:**
The `requireAuth: 'test'` branch reads synthetic JWT claims from
`x-test-role`, `x-test-aud`, `x-test-sub` request headers and stashes them on
`info.req.claims` — bypassing the entire JWT verify path. This code path is
compiled into the production `relay/dist/server.js`. While `requireAuth` is
not reachable via env-var (`RELAY_REQUIRE_AUTH=test` is not parsed — the env
parser only accepts boolean `'false'`), it IS programmatically reachable by
anyone with `import('./server.js')` access on the running process — for
example a Fly.io machine SSH session, a misconfigured operator script, or an
RCE in the same container.

The defense is "production callers MUST set `requireAuth: true`" — a
discipline-only guarantee. The blast radius is high: an attacker with this
flag flipped to 'test' can attach to any session by setting headers; they
don't even need a valid JWT.

**Fix:**
Wrap the test-mode branch behind a compile-time flag (`process.env.NODE_ENV
=== 'test'` check at module-load that throws if 'test' is later requested but
NODE_ENV is not 'test'). Better: extract `requireAuth: 'test'` into a
separate test-only entry point (`relay/src/server.test-helper.ts`) that the
production bundle excludes via `tsconfig.json` includes/excludes.

Source-grep test: assert `relay/dist/` contains no `'x-test-role'` literal
on every production build.

---

## MEDIUM

### MD-01 — `CloudHostTransport.handleInbound` has dead error-handling branches and an unused `deserialize` import

**File:** `src/network/CloudHostTransport.ts:63-67`, `src/network/CloudHostTransport.ts:347-382`
**Category:** correctness / quality

**Issue:**
The comment block at lines 359-362 says the inbound stream is "*payload-only*
bytes (NOT wrapped envelope)" — so the implementation just calls `JSON.parse(text)`
and never invokes `deserialize()` from `CloudEnvelope`. As a result:

1. The `deserialize` import (line 64) is dead — confirmed via grep.
2. The catch-block branches at lines 368-378:
   ```ts
   } catch (err) {
     if (err instanceof EnvelopeEncryptedNotSupportedError) { … }
     else if (err instanceof EnvelopeShapeError) { … }
   }
   ```
   are UNREACHABLE — `JSON.parse` throws `SyntaxError`, never an envelope
   error class. The "future L3 encrypted-skew" detection path documented at
   the top of the file is silently broken: an encrypted envelope arrives at
   the host's demux as a payload with no `memberId` and is dispatched to
   `systemMessageHandlers` — no error surface, no instanceof catch.
3. The `EnvelopeShapeError` import is similarly dead.

**Fix:**
Either remove the dead imports + dead catch branches, OR (preferred — preserves
the L3 forward-compat seam) restore the design: call `deserialize(text)` here
instead of plain `JSON.parse`. The CloudTransport already round-trips payload
re-serialization (lines 244-248), so an extra unwrap call doesn't materially
change the round-trip behavior. Then the encrypted-skew catch becomes live.

---

### MD-02 — Auth-fail logger leaks attacker-chosen `sessionId` (unverified JWT aud) into log stream

**File:** `relay/src/auth.ts:51-58`, `relay/src/auth.ts:97`
**Category:** security / logging discipline

**Issue:**
`verifyToken` logs failure with `{event:'auth-fail', sessionId, reason}` —
where `sessionId` comes from `decodeJwt(token).aud` BEFORE signature
verification. An unauthenticated attacker can construct any JWT with any
`aud` value (no signing required because decodeJwt skips verification) and
trigger arbitrary `sessionId` strings to be written to the relay's log stream.

The logger's redact paths do not strip `sessionId` (intentional — see
`relay/src/logger.ts:67-74`). So an attacker can:
- Poison log search (inject sentinel sessionIds to confuse ops)
- Inject control characters into log lines (Fly.io's pipeline may render them)
- Inflate log volume (every auth-fail emits a line)

The relay also doesn't validate that the unverified `aud` is a syntactically
reasonable session id (e.g. `vc-` prefix, length ≤ 64, alphanum + dash).

**Fix:**
Before logging the unverified aud, validate it matches the expected sessionId
shape (e.g. `/^vc-[a-z0-9]{1,32}$/`). On mismatch, log
`{event:'auth-fail', reason:'malformed-aud'}` WITHOUT echoing the
attacker-controlled string. Add a unit test that feeds a JWT with
`aud='\x00CONTROLCHARS\n…'` and asserts the log line is benign.

---

### MD-03 — `wireClientEvents` callback shared between LAN-mode SessionClient and Cloud-mode SessionClient, but `JoinPanel.handleJoinConnect` cloud branch passes empty `''` JWT to CloudTransport

**File:** `src/ui/JoinPanel.ts:324-336`
**Category:** correctness

**Issue:**
The cloud branch of `handleJoinConnect` constructs a CloudTransport with an
empty token:
```ts
const transport = new CloudTransport(relayUrl, sessionId, '');
```
Comment (lines 324-330) says: "Token is empty for now — Phase 7 D-06 has the
host issue the joiner's JWT in response to the auth-request frame. ... We
currently pass '' and let the relay (when it exists) bounce the connection".

But the relay's `verifyToken` (`relay/src/auth.ts:60-76`) rejects empty-token
requests as `'malformed'` and the connection is closed with 401 BEFORE the
WSS upgrade completes. So the joiner cannot connect AT ALL in cloud mode;
they never get a chance to receive the auth-response that would carry the
host-issued JWT.

This is a chicken-and-egg deadlock: the joiner needs the JWT to connect to
the relay, but the host issues the JWT only after receiving the joiner's
auth-request, which requires being connected to the relay.

The plan's intended fix would be a two-stage join: stage-1 the joiner connects
to a public "bootstrap" relay endpoint (anonymous, no JWT) and sends an
auth-request; the host issues the JWT; the joiner re-connects with the JWT.
That bootstrap path is not implemented anywhere in Phase 7.

**Fix:**
Either implement the bootstrap path (relay accepts unauthenticated upgrades on
a specific `/bootstrap` route, forwards auth-request to host, returns
auth-response with token; joiner then upgrades on `/` with Bearer header), OR
have the WizardPanel host issue the joiner JWTs out-of-band (deep-link
includes a host-signed pre-issued JWT) — but the latter requires a different
deep-link contract.

This finding overlaps HI-01 (relay-side memberId injection) — both must be
resolved for cloud joining to work end-to-end.

---

### MD-04 — `CloudHostTransport.sendRaw` parses + re-wraps JSON on every broadcast frame; field-order preservation across JSON round-trip is V8-specific, not guaranteed

**File:** `src/network/CloudHostTransport.ts:196-207`
**Category:** correctness

**Issue:**
`SessionHost.broadcast` pre-serializes the message once via
`JSON.stringify(msg)` and writes the same bytes to every member via
`transport.sendRaw(cm.ws, data)`. In cloud mode, sendRaw does:
```ts
const msg = JSON.parse(data) as ProtocolMessage;
const ok = this.cloudTransport.send(msg, conn.memberId);
return ok ? Buffer.byteLength(data, 'utf-8') : 0;
```
This defeats the broadcast amortization entirely (parse + wrap + re-stringify
per member). More concerning, the returned byte count is the **payload** byte
count, not the wire (envelope-wrapped) byte count — the BandwidthMonitor is
fed wrong numbers in cloud mode.

The round-trip parse→stringify field order preservation is V8 implementation
behavior; not strictly guaranteed by the ECMA spec for object property keys
that look like integer indices.

**Fix:**
Skip the JSON.parse cycle for cloud broadcasts: serialize the envelope once
in CloudHostTransport.broadcast (already supported, line 316-318), and have
SessionHost.broadcast call a cloud-aware fan-out helper when
`this.transport.isCloud?.()`. Track wire bytes separately so BandwidthMonitor
reflects envelope-overhead.

---

### MD-05 — `CloudTransport.connect()` exposed via promise but `this.ws` overwrite races with previous attempt's pending handlers

**File:** `src/network/CloudTransport.ts:191-326`
**Category:** correctness

**Issue:**
Every call to `connect()` does `this.ws = new this.WebSocketCtor(...)` (line
202). If `connect()` is invoked while a previous attempt is mid-flight (e.g.
the user clicks "Reconnect" while a scheduled reconnect is also firing — see
HI-03 for the duplicate-scheduler bug), the new ws overwrites the old one.
The OLD ws's event handlers (`'open'`, `'message'`, `'close'`, `'error'`,
`'pong'`) are still wired and will fan-out into the same per-class handler
arrays (`messageHandlers`, `closeHandlers`, etc.). Two parallel sockets can
emit interleaved events, including possibly TWO 'open' events into the same
openHandlers list — SessionClient will then issue auth-request twice.

The per-attempt `resolved` flag is a closure-local guard for the connect()
return Promise, but does NOT prevent the handler fan-outs above.

**Fix:**
Idempotency guard at the top of `connect()`: if `this.ws` is non-null and not
`CLOSING`/`CLOSED`, refuse the new attempt (return the in-flight Promise via
a memoized field, or reject with a typed error). Defensive cleanup on the
old ws (`this.ws.removeAllListeners(); this.ws.terminate();`) before
overwrite.

---

### MD-06 — Relay route() ignores envelope.sessionId mismatch with authenticated session — silent drop without diagnostic

**File:** `relay/src/server.ts:264-275`
**Category:** security / defense-in-depth

**Issue:**
For frames after the first, server.ts parses `obj.sessionId` from the envelope
and passes it directly to `route(registry, sessionId, ws, raw)`. The router
then either matches the fromSocket against `session.hostSocket` /
`session.memberSocketIds` (success) or silently no-ops. An authenticated host
or member sending a frame with `envelope.sessionId` set to a DIFFERENT session
id is a silent drop — no log, no close. The relay does not enforce that
`obj.sessionId === attachedSessionId` (the value captured at auth time).

This is benign in terms of confidentiality (frame doesn't reach another
session) but masks a defective or malicious client. It also means a member
who learned another session's id can cause the relay to do extra lookup work
per-frame with no rate-limit awareness.

**Fix:**
In server.ts after parsing `sessionId` from the envelope, assert
`sessionId === attachedSessionId`; if not, close the WSS with
4400 'session-id-mismatch-post-attach' (or log + drop if the close would
violate UX expectations). A single line check; no perf cost.

---

### MD-07 — `attachCloudIssuer` doc claims idempotency but actually rejects double-call by throwing — misleading + brittle

**File:** `src/host/SessionHost.ts:294-309`
**Category:** quality / documentation

**Issue:**
The JSDoc says "Idempotent guard: throws if a cloud issuer is already attached
— protects against accidental double-call from the factory." Throwing on
double-call is the OPPOSITE of idempotent. The current factory only calls it
once, but if a test or future refactor re-invokes `createCloud` against an
already-wired host, the unhandled throw will crash with a non-obvious
"attachCloudIssuer: cloud issuer already attached" deep inside an
otherwise-unrelated test harness.

**Fix:**
Either rename the doc claim to "single-shot guard" and document the
non-idempotency, or change the implementation: if the same `tokenService` and
`sessionId` are passed (object identity check), silently return; otherwise
throw with a clearer message.

---

### MD-08 — `TokenService.verify` does not validate the JWT `iss` claim — defense-in-depth gap

**File:** `src/auth/TokenService.ts:63-73` and `relay/src/auth.ts:104-129`
**Category:** security / defense-in-depth

**Issue:**
Both the host-side `TokenService.verify` and the relay-side `verifyToken`
validate `aud`, `exp`, `alg`, and `role`/`sub`. Neither validates `iss`.
The `TokenClaims` interface explicitly carries `iss: string`, and the issuer
(SessionHost / SessionHostFactory.createCloud) faithfully sets it to the host's
memberId. A compromised co-host (where multi-host is a future feature) or a
JWT recovered from a different relay deployment could be replayed — `aud`
checks fail when sessions differ, but if two sessions share a sessionId
across deployments (e.g. a recycled `vc-abc123`), the JWT from deployment A
could authenticate on deployment B.

**Fix:**
On the relay side, populate `Session.hostMemberId` on register (currently the
TODO at SessionRegistry.ts:38 is open) and validate `payload.iss ===
session.hostMemberId` inside `verifyToken`'s success branch. On the host
side, less critical — but adding an optional `expectedIssuer` parameter to
`verify` enables future client-side trust extensions.

---

### MD-09 — JoinPanel cloud branch persists `relayUrl` as `hostIp` in SessionHistory — pollutes recents and breaks future LAN quick-connect

**File:** `src/ui/JoinPanel.ts:338-345`
**Category:** correctness

**Issue:**
After a successful cloud connection:
```ts
await this.sessionHistory.addEntry({
  hostIp: relayUrl,        // <-- 'wss://...' as 'hostIp'
  port: 0,
  sessionName,
  displayName,
});
```
A subsequent LAN quick-connect against this history entry would invoke
`SessionClient(relayUrl, 0, …)` with a wss-URL-shaped hostIp and port 0.
The recents UI also renders this in `join.js:35` as
`${session.hostIp}:${session.port}` → `wss://relay.test:0` — clearly broken
display. There is no `mode` field on `SavedSession` to distinguish cloud
sessions, and no cloud-aware quick-connect path.

**Fix:**
Extend the `SavedSession` type with a `mode: 'lan'|'cloud'` discriminator and
`{relayUrl, sessionId, inviteCode?}` for cloud entries; gate quick-connect on
mode; render appropriately in the webview.

---

## LOW

### LO-01 — `CloudTransport.mapCloseCodeToState` treats 4429 as transient → tight reconnect loop on member-cap

**File:** `src/network/CloudTransport.ts:109-122`
**Category:** correctness

**Issue:**
`mapCloseCodeToState` maps everything not in {1000, 4404} to `'relay-unreachable'`,
including 4429 (rate-limit / member-cap). The CloudTransport then schedules a
reconnect via `ReconnectManager`. The relay accepts the new connection (the
sliding-window has space because previous attempt was rejected BEFORE counting?
— it does count; check rate-limit first), but rejects again with the same code.
The exponential backoff helps, but pinning a busy session at 50 members will
have every new joiner spin in this loop indefinitely.

**Fix:**
Add 4429 → terminal mapping (perhaps a new state `'member-cap-reached'`), OR
introduce a longer backoff schedule for 4429 specifically (e.g., 60s minimum).
See HI-04 for the broader differentiated-close-code design.

---

### LO-02 — `relay/src/server.ts` first-frame handler accepts envelope with envelope.sessionId ≠ payload.sessionId (host-register branch)

**File:** `relay/src/server.ts:199-233`
**Category:** correctness / defense-in-depth

**Issue:**
In the host-role first-frame branch, the relay reads `env.payload.sessionId`
and validates it against `claims.aud`, but does NOT validate that the
envelope-level `env.sessionId` matches. If the host sends an envelope with
`{v:1, sessionId:'OTHER', encrypted:false, payload:{type:'session-register',
sessionId:'AUD', verifySecret:…}}`, the relay registers under `claims.aud` —
but any subsequent host frames addressed to the same logical session will use
envelope.sessionId for routing (read at line 268). If `envelope.sessionId !==
claims.aud`, those frames silently drop.

**Fix:**
Validate `env.sessionId === claims.aud` for the host-role first frame, close
with 4400 on mismatch.

---

### LO-03 — `CloudEnvelope.unwrap` accepts `payload === Array` (only excludes object/null check above)

**File:** `src/network/CloudEnvelope.ts:171-177`
**Category:** correctness

**Issue:**
```ts
if (r.payload === undefined || r.payload === null || typeof r.payload !== 'object') {
  throw new EnvelopeShapeError('Envelope missing payload');
}
```
Arrays have `typeof === 'object'`, so `payload: []` or `payload: [1,2,3]`
passes this check. Downstream code reads `payload.type` on what it assumes is
a ProtocolMessage; for an array it gets `undefined`. Defensive — at worst
silent drop downstream, but the envelope shape check is the contract owner.

**Fix:**
```ts
if (typeof r.payload !== 'object' || r.payload === null || Array.isArray(r.payload)) {
  throw new EnvelopeShapeError('Envelope payload must be a non-null object');
}
```

---

### LO-04 — `CloudHostTransport.handleInbound` collision branch routes message to existing virtConn AFTER logging — comment says "DROP" but code dispatches

**File:** `src/network/CloudHostTransport.ts:417-433`
**Category:** correctness / spec deviation

**Issue:**
The plan (07-05b §threat-model T-07-mid) requires: "log + DROP" on collision.
The code logs but THEN dispatches to the existing virtConn's messageHandlers
(lines 425-432). The reconciliation comment at lines 419-423 admits this is a
deliberate deviation: "log on every subsequent observed arrival, then routing
the message to the bound virtConn."

This means a member who learned (or guessed) another member's id can RIDE on
their virtConn: their auth-request would be processed by the existing virtConn
binding, potentially seen as the bound member's traffic at the host level
unless SessionHost's per-frame validation catches the spoof at the protocol
level (which it does for chat/review via T-04-01-01 server-trust). For
auth-request and other protocol frames, however, the host has no
ws-bound-identity yet on this virtConn — collision dispatch lets an attacker
send messages that appear to come from a bound member.

**Fix:**
Match the plan literally: log + DROP (no dispatch). Add a test that asserts
the message is NOT delivered to the existing virtConn's messageHandlers on
collision.

---

### LO-05 — `VersionConUriHandler.handleUri` uses string-split for scheme extraction; logs scheme but `relay.split(':')[0]` returns full URL for relay like `foo`

**File:** `src/extension.ts:289-296`
**Category:** quality

**Issue:**
```ts
const scheme = relay.split(':')[0] ?? '<unknown>';
channel.appendLine(`[${ts}] Deep-link rejected: relay must use wss:// (got ${scheme}://)`);
```
If `relay` is `'foo'` (no colon), `split(':')[0]` returns `'foo'`, and the log
reads `(got foo://)` — confusing. Worse, the user-facing error message says
"Invalid invite link — relay must use wss://." with no scheme detail
— acceptable UX. But the log entry's misleading scheme could waste an
operator's time.

**Fix:**
```ts
const sep = relay.indexOf(':');
const scheme = sep > 0 ? relay.slice(0, sep) : '<no-scheme>';
```

---

### LO-06 — `getDeepLinkOutputChannel` push-to-subscriptions logic has a subtle init race when called twice during a single activation

**File:** `src/extension.ts:202-219`
**Category:** correctness

**Issue:**
The module-level `deepLinkOutputChannel` and `deepLinkChannelPushedToSubs`
flags persist across activations in an extension host that doesn't tear down
module state on reload (common in dev). On the second `activate()`, the
channel reference is from the previous activation (already disposed via the
previous `context.subscriptions`). The push flag is `true`, so it doesn't
re-add. The first deep-link call gets the disposed channel — `appendLine`
throws.

**Fix:**
Reset module-level state inside `activate()`:
```ts
deepLinkOutputChannel = null;
deepLinkChannelPushedToSubs = false;
```
Or move the channel into a class instance owned by activate().

---

### LO-07 — `WizardPanel.runTestConnection` uses `.replace('wss://', 'https://')` — case-sensitive single-replace, doesn't handle stray whitespace

**File:** `src/ui/webview/wizard/wizard.js:28-42`
**Category:** correctness

**Issue:**
The `runTestConnection` helper performs `relayUrl.replace('wss://', 'https://')`.
`.replace` is case-sensitive (single match). The wizard's `validateRelayUrl`
helper requires lowercase 'wss://' prefix, but if the user types
`Wss://relay.test/` the helper rejects — so the case mismatch is gated.
However:
- `validateRelayUrl` returns `true` for `'wss://relay.test/path?token=foo'`
  (the `try { new URL(url) }` succeeds). The healthz check then GETs
  `'https://relay.test/path?token=foo/healthz'` — appending `/healthz` to a
  path. This is invalid and the test will fail with a 404, surfaced as
  "Cannot reach relay" without diagnostic.

**Fix:**
Construct the healthz URL via `new URL('/healthz', relayUrl.replace(/^wss:/i, 'https:'))`
which respects URL semantics. Validate that the input URL has only `/` as
its path before sending the GET.

---

### LO-08 — `attachMember` in SessionRegistry resets `lastActivity` to Date.now() but doesn't on host-side `register()` re-attach branch when `verifySecret` rotates — minor consistency issue

**File:** `relay/src/SessionRegistry.ts:60-78`, `relay/src/SessionRegistry.ts:109-118`
**Category:** quality

**Issue:**
Both methods set `lastActivity = Date.now()`. Consistent. But on the
re-attach branch (host returns after grace), the verifySecret is overwritten
unconditionally — if the host re-issues a fresh secret on every register, all
joiners issued tokens under the OLD secret are now invalid (same root issue
as HI-05 but from a different angle). This is the host-replay-key-rotation
gap.

**Fix:**
Same as HI-05 — bind host identity on first register; reject second register
unless the iss/sub match, in which case the verifySecret rotation IS valid
(host chose to rotate). Add `lastActivity` reset only on success.

---

## INFO

### IN-01 — `TokenService.constructor` reads `VERSIONCON_TOKEN_TTL` at construct time; multi-instance TokenServices in the same process can have different TTLs

**File:** `src/auth/TokenService.ts:43-49`
**Category:** quality

The env var is read in the constructor, so two TokenServices instantiated at
different times under different env can have different TTLs. Currently only
one TokenService is created per host process (in `createCloud`), so this is
theoretical. Document the env-var-at-construct semantic, or move the read to
module-load.

---

### IN-02 — `CloudTransport.WebSocketCtor` typed as `any` despite eslint-disable comment — type seam loses inference

**File:** `src/network/CloudTransport.ts:139`
**Category:** quality

The `// eslint-disable-next-line @typescript-eslint/no-explicit-any` precedes
two `any` declarations. The structural type seam (test injects a stub) could
be modeled as a constructor type:
```ts
type WebSocketCtorLike = new (
  url: string,
  opts?: { headers?: Record<string,string>; maxPayload?: number; perMessageDeflate?: boolean }
) => WebSocket;
```
which preserves type inference at the construction call site. Cosmetic.

---

### IN-03 — `LanHostTransport.findFreePort` reject path closes srv but doesn't await close — minor race on test teardown

**File:** `src/network/LanTransport.ts:210-226`
**Category:** quality

The promise rejects via `srv.on('error', reject)` before the close completes,
or the srv stays open if `srv.address()` returns null (rare). Tests sometimes
exit before close fires. Minor — no impact in production.

---

### IN-04 — `SessionHost.broadcast` (cloud path) hands serialized bytes back to CloudHostTransport which JSON.parse → JSON.stringify them again — comment "preserved verbatim" no longer accurate

**File:** `src/host/SessionHost.ts:2143-2162` and `src/network/CloudHostTransport.ts:196-207`
**Category:** documentation

The "BandwidthMonitor records exact wire bytes (pre-refactor behavior at line
2009-2017 — preserved verbatim through the seam)" claim is no longer accurate
in cloud mode. See MD-04. Update the doc.

---

_Reviewed: 2026-05-18_
_Reviewer: gsd-code-reviewer (Claude Opus 4.7 — 1M context)_
_Depth: standard_
