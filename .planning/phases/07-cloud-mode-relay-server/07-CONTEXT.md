# Phase 7: Cloud Mode + Relay Server - Context

**Gathered:** 2026-05-17
**Status:** Ready for planning
**Source:** /gsd-discuss-phase 7 (default mode)

<domain>
## Phase Boundary

Deliver cloud-mode collaboration so teams not on the same LAN can use VersionCon over the internet, with the same wizard, same protocol, and same UI as LAN mode (NET-06, SC-1/2/3). Adds a relay server that brokers WebSocket traffic between host and members across NAT boundaries.

**In scope:**
- A separate Node TypeScript relay package (`relay/`) that fan-outs messages between host and member sockets — never parses VersionCon payloads
- Transport abstraction (`Transport` interface) refactor: `LanTransport` (today's behavior) + `CloudTransport` (new outbound-WSS-to-relay)
- Standard JWT auth layer (host-issued, relay-verified) layered on top of the existing invite-code model
- TLS in transit (`wss://` end-to-end, Let's Encrypt via Fly.io)
- Wizard updates: LAN/Cloud radio + relay URL field; invite share screen renders deep-link URL + components
- Join flow: `versioncon://` URI handler for deep-link AND manual relay+session+code entry
- Three distinct cloud connection states (`connected` / `relay-unreachable` / `session-not-found`) surfaced via StatusBarManager
- Reconnect on top of existing heartbeat; 60s grace before relay tears session down on host drop
- Deployment artifacts: `relay/Dockerfile`, `relay/fly.toml`, README "Deploy Your Relay" quickstart

**Architectural seams shipped for future security phase (no rewrite required when they land):**
- Wire-level `CloudEnvelope` with `encrypted: boolean` flag (always `false` in v1)
- JWT claim schema is SSO-ready (`sub`, `iss`, `aud`, `exp`)
- Invite code never reaches the relay (host validates locally) — preserves future E2E key derivation
- Transport interface allows `CryptoTransport` decorator later without touching SessionHost/Client

**Out of scope:**
- End-to-end message-body encryption (L3 — AES-GCM body wrapping). Deferred to a dedicated security hardening phase. v1 ships the seam, not the crypto.
- SSO/SAML/SCIM/MFA, audit log, DPA, regional relays, pentest, threat model doc, vuln disclosure (L4 enterprise hardening) — same future phase
- Managed relay service at `versioncon.dev` — Phase 9+ business decision
- Token refresh + revocation flow (4h hard expiry only in v1)
- Per-message rate limiting at relay (connection-level only)
- WebRTC peer-to-peer fallback (disqualified — needs signaling + STUN/TURN, too much code for the same outcome)
- VPN-only deployment posture (disqualified — violates SC-1 "no extra steps vs LAN")

The relay is deliberately a dumb byte-forwarder. All VersionCon protocol logic (chat, presence, push, AST, review, permission gates) stays on the host process. The relay never parses VersionCon messages, never persists, never authenticates VersionCon-level state — only `sessionId`/`role`/JWT validity at WSS handshake.

</domain>

<decisions>
## Implementation Decisions

### Security model: defense-in-depth in layers
**LOCKED.** Phase 7 ships L0 + L1 + L2. L3 + L4 are explicitly deferred to a future security-focused phase. The architectural seams shipped in Phase 7 mean future layers plug in without rewrites.

| Layer | What it protects against | Phase 7 status |
|---|---|---|
| L0 — TLS (`wss://`) | Network sniffers in transit | ✅ Shipped — Let's Encrypt via Fly.io's `force_https` |
| L1 — Standard JWT | Token forgery, role spoofing, replay (via short `exp`) | ✅ Shipped — `jose` library, HMAC-SHA256 |
| L2 — Server-trusted identity | Members spoofing each other's `memberId`/`timestamp` | ✅ Preserved — existing T-04-01-01 / T-06-01 host overrides untouched |
| L3 — End-to-end body encryption | Relay operator reading code/diffs/chat | ⏸ Deferred — seam present (`encrypted` flag in CloudEnvelope) |
| L4 — Enterprise hardening (SSO/MFA/audit/refresh/etc.) | Compliance, corporate identity, accountability | ⏸ Deferred — JWT claim schema is SSO-ready |

User explicitly stated (2026-05-17): "let us build it good if we are building. The rest of the security features, keep it for the final phase ... make the changes in a way that we have gap for that and can do it on demand." Phase 7's primary architectural quality bar is **seam discipline** — every refactored boundary must accept a future crypto layer without breaking shape.

### Operational model
**LOCKED.** Self-host only for v1. Ship the relay as a separate `relay/` top-level Node TypeScript package, plus a Dockerfile and a Fly.io quickstart. No hosted `versioncon.dev` relay in v1. README documents Fly.io as the recommended deploy target.

This closes the STATE.md "Cloud relay operational model not yet decided" blocker.

### Deployment target
**LOCKED.** Fly.io as primary deploy target (free tier covers small teams). Deliverables in this phase:
- `relay/` top-level directory with Node TS source (independent `package.json`, independent `tsconfig`, share no runtime deps with the extension other than `ws` and types)
- `relay/Dockerfile` — multi-stage build, `node:20-alpine`, `CMD ["node", "dist/server.js"]`
- `relay/fly.toml` — minimum viable config, `shared-cpu-1x` machine, `force_https = true`, ports 80→443 wss-ready
- `relay/README.md` — "Deploy Your Relay" with `fly launch` + first-session walkthrough (≤5 min)
- Top-level README updates — "VersionCon for Cloud Teams" section pointing at the relay deploy quickstart, plus a "Deploy elsewhere" footnote covering AWS/Hetzner/DO with the same Docker image

### Transport architecture
**LOCKED.** Host-as-client-to-relay. In cloud mode, `SessionHost` opens an outbound WSS to the relay (instead of binding a `WebSocketServer`). Members open outbound WSS to the same relay. Relay holds `Map<sessionId, { hostSocket, memberSockets[] }>` in memory and fan-outs by role:
- Host → all members
- Member → host only

Host-side message logic (auth gating, broadcast, permission, chat, push relay, presence, review) is **completely unchanged**. The relay is invisible to `SessionHost` and `SessionClient` once the Transport abstraction is in place — they just see "a wire" exactly like LAN.

Rationale: NAT-friendly (both endpoints open outbound, no port-forwarding needed), and it matches the future L3 story (relay always handles the same envelope shape whether `encrypted` is true or false).

### Transport abstraction (the architectural seam)
**LOCKED.** Introduce `Transport` interface in `src/network/Transport.ts` with two implementations:
- `LanTransport` — refactor of today's behavior. Host wraps `WebSocketServer`; client wraps plain `WebSocket`. No behavior change.
- `CloudTransport` — new. Both host and member wrap outbound WSS to relay, including JWT in connect query/header.

`SessionHost` and `SessionClient` constructors accept a `Transport` instance. All `ws.send(...)` and `ws.on('message', ...)` paths route through the transport's `send()` and `onMessage()`. This is the seam that lets future phases add:
- `CryptoTransport` decorator wrapping any `Transport` to add AES-GCM body encryption (Phase 9+ L3)
- Other transports later (QUIC/HTTP3, WebTransport, P2P) without touching SessionHost/Client

**Quality bar:** this MUST be a clean interface refactor, not a parallel codepath with copy-paste. Planner should explicitly call out the refactor scope and verify with source-grep tests that `new WebSocket(...)` and `new WebSocketServer(...)` only appear inside `LanTransport.ts` and `CloudTransport.ts` after the refactor.

### Wire protocol envelope (the most important seam)
**LOCKED.** Every WSS frame sent through CloudTransport is wrapped in a `CloudEnvelope`:

```ts
interface CloudEnvelope {
  v: 1;                       // envelope version (bump only on shape change)
  sessionId: string;          // relay routing key
  encrypted: false;           // ALWAYS false in v1; future security phase ships true
  payload: ProtocolMessage;   // existing protocol.ts union, unchanged
}
```

Relay reads `sessionId` only; forwards the entire envelope verbatim — never inspects `payload`. Host and client read `payload` as the existing `ProtocolMessage` union, unchanged.

When L3 lands in the future security phase:
- `encrypted: true` means `payload` becomes `{ ciphertext: string, iv: string, tag: string }`
- Session key derived from invite code via HKDF (or Argon2 if brute-force resistance demands it)
- Only host + clients with the session key can decrypt — relay sees opaque ciphertext
- **No `v` bump required** — the `encrypted` boolean flag is the discriminator. Existing v1 clients reject `encrypted: true` until they ship the crypto layer; cross-version interop is a known forward-compat scenario, NOT a blocker

LanTransport does NOT use the envelope — LAN keeps its raw `protocol.ts` messages on the wire to avoid churn. Cloud-only construct.

### Auth layer (L1 standard JWT)
**LOCKED.** Standard JWT via `jose` library. Issued by `SessionHost.start()` at session creation, signed with a per-session random 32-byte secret (HMAC-SHA256). Relay receives the verification secret at session register time (over the host's first WSS connection, after host token validation bootstraps trust); verifies all subsequent member tokens at WSS handshake.

Claims:
- `iss` — hostMemberId
- `sub` — bearer's memberId (host's own for host token; UUID generated by host per joiner)
- `aud` — sessionId
- `exp` — 4 hours from issue (configurable via relay env var; refresh flow deferred)
- `role` — `"host"` or `"member"`
- `jti` — unique token id (foundation for future revocation list)

The invite code itself stays local to host — never sent to relay. Host receives an `auth-request` from a joiner (existing wire type from Phase 1), validates the invite code locally via `AuthHandler.validateInviteCode()` (existing constant-time compare + rate limit), then issues the joiner's JWT and sends it back. The joiner reconnects to the relay with the JWT.

This invite-code-stays-local property is what makes the future L3 plug-in viable: the relay can't ever derive the session key because it never sees the source secret.

### Wizard UX
**LOCKED.** New step inserted into the existing wizard between current step 1 (displayName, Phase 4.1) and current step 2 (network configuration, Phase 1):

```
┌─────────────────────────────────────────────────┐
│  Where will your team connect from?             │
│                                                  │
│  ◉ Same network (LAN)                            │
│       Fastest. No internet or relay needed.     │
│                                                  │
│  ○ Different networks (Cloud)                    │
│       Connects via a relay server you deploy.   │
└─────────────────────────────────────────────────┘
```

If LAN: rest of wizard unchanged (existing port/interface/bandwidth fields).
If Cloud: the "network configuration" step swaps port/interface fields for a single **Relay URL** field with:
- Validation: must start with `wss://`, must parse as URL
- Placeholder: `wss://your-relay.fly.dev`
- Help link: "Don't have a relay? Deploy one →" pointing at `relay/README.md`
- "Test connection" button: pings the relay's health endpoint before letting the user advance

After session creation, the "share invite" screen for a Cloud session shows BOTH:
1. A deep-link URL (one-click for joiners): `versioncon://join?relay=...&session=...&code=...`
2. The three components separately (relay URL, session ID, invite code) for paste-into-Slack / manual entry

Same UX pattern as LAN's invite-code display from Phase 4.1, extended.

### Join flow
**LOCKED.** Both paths supported:
1. **Deep-link URL** — register `versioncon:` URI scheme via `package.json` `contributes.uriHandlers`. VS Code dispatches the URL to the extension; extension parses query params, prefills join wizard, prompts user for displayName, connects.
2. **Manual entry** — Join Session command's existing form (Phase 1 JoinPanel) gains a "Connection method" radio:
   - LAN — existing IP + port fields
   - Cloud — Relay URL + Session ID fields
   - Invite code field is shared across both modes

Both paths converge at the same `SessionClient.connect()` entry point, dispatched through the appropriate Transport.

### Connection lifecycle + 3 distinct status states (SC-3)
**LOCKED.** StatusBarManager surfaces three new cloud-specific states:

| State | Icon + text | Trigger |
|---|---|---|
| connected | `$(cloud) VersionCon — connected` | WSS open, JWT valid, host responsive |
| relay-unreachable | `$(warning) VersionCon — relay unreachable` | WSS open attempt failed at TCP/TLS layer, or active socket dropped without WSS close frame |
| session-not-found | `$(error) VersionCon — session not found` | Relay reachable, but returned 4404 close code (session-id unknown to relay) |

Reconnect:
- Existing Phase 1 heartbeat (`src/network/heartbeat.ts`) extends to cloud — same null-ws pattern in SessionClient distinguishes intentional disconnect from drop
- Host-side relay drop: SessionHost attempts reconnect with exponential backoff (1s, 2s, 4s, 8s, 30s cap) — same Transport abstraction handles the retry
- Members see `relay-unreachable` during host's reconnect window
- **60-second grace** before relay tears down the session if host doesn't reconnect (gives Wi-Fi blips a chance to recover before all member sockets are forcibly closed)

### Relay-side defensive minimum (within Phase 7 scope)
**LOCKED.** The relay ships these defenses now (NOT crypto, NOT enterprise — just basic abuse resistance for a self-hosted public-internet box):
- Connection rate limit: 30/min per source IP
- Max sessions per relay process: 1000 (configurable, kill new session-register beyond cap with 4429)
- Max members per session: 50
- Idle session reaper: if a session has had zero message traffic for 30 min, close it (frees memory, forces reconnect-as-fresh-session)
- Inbound message size cap: 1 MiB per frame (matches existing host-side 64 KiB chat cap with headroom for push payloads)
- Structured JSON logging (pino): connection events only (open/auth-success/auth-fail/close). **NEVER log message payloads** — even though L3 isn't shipped, don't burn future-E2E privacy by logging plaintext

Anything more sophisticated (per-message rate limit, slowloris defenses, abuse heuristics, IP banlists) defers to the security phase.

### Claude's Discretion
These are tunable knobs and implementation details the planner can choose:
- JWT signing secret generation mechanics (`crypto.randomBytes(32)` likely)
- Relay's `SessionRegistry` exact data shape (Map vs Record vs WeakMap)
- Exponential backoff number tuning (1/2/4/8/30 above is a starting point)
- 60s grace period for host reconnect — tunable
- Idle-session reaper interval (30 min above is a starting point)
- Whether `jose` is used directly or wrapped in a `TokenService` class (likely wrap for testability + future-key-rotation)
- `versioncon:` URI handler registration mechanics (VS Code `contributes.uriHandlers` exact metadata)
- Status bar icon/color theme variables (use existing VS Code theme vars for consistency)
- Whether to expose the relay's connection count via a `/metrics` endpoint (prometheus shape) — out of scope but the planner can decide if a `/healthz` endpoint goes in v1 (recommended yes, GET that returns `{ ok: true, sessions: N }`)
- pino vs winston vs `console.log` (pino recommended for structured logs)
- Whether the relay binary is published to npm or kept as a "clone this repo" deploy artifact (recommended: keep in-repo, no npm publish in v1 — easier to iterate)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Networking + protocol (Phase 1)
- `src/network/protocol.ts` — current `ProtocolMessage` union. Phase 7 adds CloudEnvelope wrapping ON TOP of the existing types. No changes to the union itself — existing wire types travel inside the envelope unchanged.
- `src/host/SessionHost.ts` — host-side relay logic (2130 lines). Refactor to accept a `Transport` abstraction. Today's `WebSocketServer` becomes one impl among many.
- `src/client/SessionClient.ts` — client-side WSS (564 lines). Refactor to accept a `Transport` abstraction. The hardcoded `new WebSocket(\`ws://${this.hostIp}:${this.port}\`)` at line 128 becomes `await transport.connect()`.
- `src/network/heartbeat.ts` — existing ping/pong machinery. Reused unchanged for cloud transport.
- `src/network/discovery.ts` — mDNS. LAN-only, untouched in Phase 7.

### Auth (Phase 1, Phase 4.1)
- `src/host/AuthHandler.ts` — invite code validation (`crypto.timingSafeEqual` + per-IP rate limit). REUSED. Invite code validation stays at host, never at relay. JWT issuance is a new layer ABOVE invite-code validation.

### Server-trust pattern to preserve (Phase 4, Phase 6)
- T-04-01-01 / T-04-01-04 (chat memberId/timestamp host-override) — preserved exactly.
- T-06-01 (review reviewerMemberId/authorMemberId host-override) — preserved exactly.
- The relay NEVER mutates any field in `payload`. The relay only reads the envelope's `sessionId` for routing and the JWT for connection authz.

### Wizard (Phase 4.1)
- `src/ui/WizardPanel.ts` — step machinery + displayName collection + invite code generation. Phase 7 inserts a new LAN/Cloud radio step between current step 1 and step 2. Existing `WizardPanel.ts:426-429` hostIdentity flow preserved.
- `src/ui/JoinPanel.ts` — joiner form. Phase 7 adds "Connection method" radio + cloud fields.

### Status bar (Phase 4, Phase 4.3)
- `src/ui/StatusBarManager.ts` — existing connection states + Phase 4 unread overlay + Phase 4.3 "N local changes". Phase 7 adds 3 cloud-specific substates without disturbing existing overlays.

### URI handling
- `package.json` `contributes.uriHandlers` (new field) — register `versioncon:` scheme for join-link deep-link.
- `src/extension.ts` — wire `vscode.window.registerUriHandler` in `activate()` to dispatch incoming `versioncon://` URIs to the join flow.

### Phase 4.3 Cloud Bridge — DISTINCT from Phase 7
- `versioncon.exportToGitRemote` (Phase 4.3) is async export to a real Git remote (one-way snapshot to GitHub). NOT the same as Phase 7 cloud mode (real-time collaboration via relay). They coexist — a team can use Phase 7 cloud mode for live collab AND Phase 4.3 export when ready to ship.

### New artifacts (Phase 7 creates)
- `src/network/Transport.ts` — interface (host + client variants)
- `src/network/LanTransport.ts` — refactor of current ws server/client into the interface
- `src/network/CloudTransport.ts` — outbound WSS to relay, JWT in connect handshake, envelope wrap/unwrap
- `src/network/CloudEnvelope.ts` — type + (de)serializer + the `encrypted: false` discriminator
- `src/auth/TokenService.ts` — `jose`-backed JWT issue + verify wrapper (host-side issuer, used by relay for verify too)
- `relay/` — separate top-level Node TS package
  - `relay/package.json` — minimal deps: `ws`, `jose`, `pino`
  - `relay/tsconfig.json`
  - `relay/src/server.ts` — entry point, HTTP /healthz + WSS upgrade handler
  - `relay/src/SessionRegistry.ts` — in-memory `Map<sessionId, Session>`
  - `relay/src/router.ts` — host↔member fan-out, NEVER inspects payload
  - `relay/src/auth.ts` — JWT verification only (NO invite-code logic here — that stays on the host)
  - `relay/src/limits.ts` — connection rate limit, session/member caps, idle reaper
  - `relay/Dockerfile`
  - `relay/fly.toml`
  - `relay/README.md` — deploy quickstart

### Phase 4.1 anti-pattern to preserve
- "First authenticated wins host" is BANNED (Phase 4.1 closed this). In cloud mode this stays banned — host registers their `hostMemberId` BEFORE opening the relay connection, via the JWT's `iss` claim. The relay assigns role purely from the JWT's `role` claim, never from connection order.

### Future security phase will read this CONTEXT's `<deferred>` section as its scope spine.

</canonical_refs>

<specifics>
## Specific Ideas

- **Wizard step copy:** "Where will your team connect from?" with two radios — "Same network (LAN) — fastest, no internet needed" and "Different networks (Cloud) — connects via a relay server you deploy."
- **Join wizard mode toggle:** "Connection method" — "LAN (host on same network)" / "Cloud (via relay)".
- **Relay URL placeholder:** `wss://your-relay.fly.dev` (steers users toward the recommended deploy target).
- **Deep-link URL format:** `versioncon://join?relay=wss%3A%2F%2Frelay.foo.fly.dev&session=vc-7f3a92&code=K8M3PQ` (URL-encode the relay).
- **Status bar formats (cloud-mode-specific):**
  - `$(cloud) VersionCon — connected`
  - `$(warning) VersionCon — relay unreachable`
  - `$(error) VersionCon — session not found`
- **Relay logging discipline:** structured JSON (pino), one line per connection-event (connect / auth-success / auth-fail / disconnect / session-register / session-evict). ZERO logging of message payloads, NOT EVEN sizes if we can help it (metadata leakage analysis is a future-security-phase item, but don't actively pre-poison it now).
- **Token lifetime 4h** — chosen as a reasonable v1 default that covers a typical hackathon / work session. Configurable via relay env var `VERSIONCON_TOKEN_TTL`.
- **"Build it good" interpretation:** the Transport abstraction is a clean interface refactor, not a parallel codepath with copy-paste. After refactor, source-grep tests assert `new WebSocket(` and `new WebSocketServer(` appear ONLY inside `LanTransport.ts` and `CloudTransport.ts`. SessionHost and SessionClient become transport-agnostic.
- **README narrative:** Alice deploys a relay on Fly.io in <5 min → shares a `versioncon://` link with Bob in Slack → Bob clicks it, VS Code opens the join wizard with relay+session pre-filled → Bob types displayName + invite code → connected. Mirrors the Phase 4.3 "Lifecycle Tour" narrative style.
- **Health endpoint:** relay exposes `GET /healthz` returning `{ ok: true, sessions: N, uptime_s: M }`. Used by Fly.io health checks and lets users sanity-check their deploy. No auth on this endpoint — it's a liveness probe, not a metrics dashboard.

</specifics>

<deferred>
## Deferred Ideas

### To a future "Security Hardening" phase (Phase 9 or wherever it lands in v2)
Per user direction 2026-05-17, all of these are explicitly out-of-scope for Phase 7 and will be the dedicated focus of a future security phase. Phase 7 ships the architectural seams (CloudEnvelope `encrypted` flag, JWT claim schema, Transport interface) so these plug in without rewriting.

- **L3 — End-to-end message-body encryption** (AES-GCM body wrapping; session key derived from invite code via HKDF, possibly Argon2 if brute-force resistance demands it). Relay sees ciphertext only. The big one. Seam: `CloudEnvelope.encrypted` flag flips to `true`, `payload` becomes `{ ciphertext, iv, tag }`.
- **L4 — Enterprise hardening:**
  - SSO / SAML / SCIM (JWT claim schema is already SSO-ready)
  - MFA on session creation + join
  - Structured, retained, queryable audit log (relay-side + host-side)
  - DPA + data residency story (multi-region relays)
  - Threat model documentation
  - External penetration test
  - Responsible vulnerability disclosure process (SECURITY.md + intake)
- **JWT refresh flow + revocation list** — current v1 is 4h hard expiry with no revocation; `jti` claim is preserved for future revocation
- **Per-message rate limiting at relay** — current v1 is connection-level only
- **Relay resilience to abuse:** session squatting (one user holding many sessionId namespaces), resource exhaustion, slowloris on the WSS upgrade handshake, fingerprint-based abuse heuristics
- **Metadata leakage analysis** — message sizes / timestamps / connection patterns visible to relay even with E2E; consider message padding / cover traffic if metadata becomes a concern

### To future business / ops phases
- **Managed relay service at `versioncon.dev`** — payment, abuse handling, regional deployment, SLA, status page
- Multi-region relay routing for latency
- Relay monitoring + uptime dashboards (Grafana / Datadog integration)
- Auto-scaling / horizontal relay clustering (single-process limits become a problem at >1000 sessions)

### Considered and disqualified for v1
- **WebRTC peer-to-peer** — still requires a signaling server (we'd be deploying anyway), plus STUN/TURN for NAT, plus a much more complex codepath. Cost: months of work for the same outcome. No.
- **VPN-only deployment posture** (require users to set up Tailscale or similar) — violates SC-1 "no extra steps vs LAN." No.
- **Cloudflare Workers / Durable Objects relay** — would require a major rewrite (`ws` library doesn't exist on Workers; must use Workers WebSocket API + Durable Objects). Not worth the rewrite for v1; Docker-on-Fly.io is good enough.
- **API Gateway WebSocket API (AWS)** — pay-per-message + connection-minute model could be cheap but forces Lambda-backed code (different shape than the EC2/Docker Node process). Not v1-worthy.

</deferred>

## Gap Closure Decision (MD-03) — LOCKED 2026-05-19

**Decision: Option A — Deep-link bootstrap JWT (host-minted, 15m exp, role:'member').**

Selected after evaluating Options A/B/C in 07-13's design_decision block (deep-link JWT vs relay /bootstrap HTTP endpoint vs anonymous WSS carve-out). Decisive factors:

1. **Option A is the ONLY option requiring ZERO relay-side code changes** — preserving T-07-02 (router byte-pass-through), T-07-09 (role from JWT only), T-07-11 (HS256 pin) by construction.
2. **Option C disqualified** by its T-07-02 risk: routing an auth-request frame from an anonymous member socket to the host would require the relay's router to read `envelope.payload.type` — violating the byte-pass-through invariant 07-08 was built to protect.
3. **Option B (relay /bootstrap HTTP)** introduces an asymmetric-trust boundary (relay autonomously mints credentials) — a deliberate v1 non-goal. Every other token in the Phase 7 system is host-minted; deferring this design shift to a dedicated security phase preserves the single-issuer invariant.

**Locked contract:**

| Field | Value |
|---|---|
| Deep-link query-param key | literal `bt` (short for bootstrap-token) — URL-encoded JWT value |
| Bootstrap JWT claims | `{iss: hostMemberId, sub: 'bootstrap-' + sessionId, aud: sessionId, role: 'member', exp: 15m}` |
| Signing key | per-session `verifySecret` (same HMAC secret as regular member JWTs — relay accepts via existing verifyToken path) |
| Relay-side changes | ZERO — bootstrap JWT inherits acceptance from serverAuthIntegration.test.js test 3 |
| UriHandler OutputChannel log redaction | literal `bt=<redacted>` — never log the JWT value (T-07-20) |
| Joiner reconnect | mandatory — bootstrap socket closes with code 1000 after auth-response; new socket reconnects with the per-joiner real JWT issued by the host in auth-response.token (the relay rewrites `payload.memberId = claims.sub` per-frame, so staying on the bootstrap socket would collide all joiners onto the shared `bootstrap-<sessionId>` sub) |
| LAN-mode deep-link | byte-identical to pre-07-13 (no `bt` param) — UriHandler parser handles BOTH presence AND absence |

**Implementation split:**

- **07-13** (host-side mint + share-screen plumbing): TokenService.issueBootstrap, SessionHostFactory.createCloud mints + attaches, WizardPanel state pickup, wizard.js buildDeepLink 4-arg variant appending `&bt=`.
- **07-14** (joiner-side consume + swap + E2E test): UriHandler bt parsing + redaction, JoinPanel state + handleJoinConnect cloud branch using bootstrapToken, CloudTransport.swapToken (close-then-reopen with new token, suppressing state-change emissions during swap), SessionClient orchestration (defer connection-changed:connected until after the swap settles), E2E integration test in relay/test/bootstrapJoinerE2E.test.js.

**Deferred / accepted trade-offs (documented for the future security phase):**

- Bootstrap JWT visible in URL = clipboard + browser history. Mitigated by 15m hard exp + role:'member' scope + invite-code-still-required composition. Not eliminated.
- The swap reconnect causes other members briefly to see "Bob joined → Bob left → Bob joined" within ~50–200ms. Accepted; could be cleaned up later with a `rejoin` protocol message type. SessionClient suppresses its OWN connection-changed emit until after the swap settles, so the joiner's own status bar transitions exactly once.
- The per-joiner real JWT carries the full 4h exp (per existing TokenService.issue). The joiner could in principle stash and replay it within 4h, but the same is already true of every regular member JWT — no new attack surface.

---

*Phase: 07-cloud-mode-relay-server*
*Context gathered: 2026-05-17 via /gsd-discuss-phase 7*
