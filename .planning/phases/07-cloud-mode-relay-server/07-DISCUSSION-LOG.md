# Phase 7: Cloud Mode + Relay Server - Discussion Log

**Conducted:** 2026-05-17
**Command:** /gsd-discuss-phase 7 (default mode)
**Status:** Complete — CONTEXT.md written

This log captures the conversation that produced `07-CONTEXT.md`. Audit reference only — downstream agents read CONTEXT.md, not this file.

---

## Setup

Phase 7 had no prior CONTEXT.md or SPEC.md. Phase directory `.planning/phases/07-cloud-mode-relay-server/` did not exist before this session.

Prior context loaded:
- `ROADMAP.md` Phase 7 goal + 3 SCs + NET-06 requirement
- `PROJECT.md` requirements + key decisions
- `REQUIREMENTS.md` NET-06 (cloud mode same UX as LAN)
- `STATE.md` — flagged "Cloud relay operational model (hosting platform, cost model, self-host option) is not yet decided — needs decision before Phase 7 planning"
- `04-CONTEXT.md` (most recent CONTEXT in scope) for prior decision patterns
- Codebase scout: `src/host/SessionHost.ts` (2130 lines, runs WebSocketServer directly), `src/client/SessionClient.ts` (564 lines, hardcodes `ws://hostIp:port`), `src/host/AuthHandler.ts` (invite code + rate limit), `src/network/protocol.ts` + `discovery.ts` + `heartbeat.ts`
- Confirmed Phase 7 is greenfield — no existing relay / cloud transport / JWT code

## Gray areas presented

User selected all 4:
1. Relay operational model (the STATE.md blocker)
2. Transport architecture (host-as-server-tunneled vs host-as-client-to-relay)
3. Auth + join flow (JWT shape + deep-link URL vs manual entry)
4. Trust + encryption model (E2E vs trust-the-relay)

## Conversation flow

### Q1 attempt — relay operational model + deployment shape

Asked: self-host / managed / phased / both? AND deployment shape (Docker+Fly.io / Node+systemd / Cloudflare Workers / source-only).

User asked clarifying questions before answering — wanted to understand the system end-to-end first:

- **"What is this about"** — explained the workflow (gather decisions before planning) and Phase 7's scope.
- **"What happens when it is online"** — walked through the cloud-mode user journey: Alice hosts via wizard (LAN/Cloud radio + relay URL), generates invite code + share link, members join via deep-link or manual entry, relay routes messages between host and members, status bar reflects relay/session states.
- **"What code and why to deploy"** — explained the relay is a ~500-line standalone Node process (not part of the extension), uses `ws` + JWT, deliberately dumb byte-forwarder. Compared deployment targets (Docker+Fly.io, Node+VPS, Cloudflare Workers requiring rewrite, npm-publish-only, managed). Explained why a relay is needed at all (NAT — Alice's home router has no inbound route to her laptop).
- **"How does this relay work"** — stepped through the full mechanical lifecycle: session register, join handshake (auth-request forwarded to host, host validates invite code, returns auth-response), message routing (3-line fan-out core loop), reconnect, lifecycle on host disconnect. Emphasized: relay never parses payloads, never persists, never knows what a "push" is — opaque byte forwarder.
- **"Ok is this very very secure? Like what if big companies like to use this"** — honest assessment that VersionCon is NOT enterprise-ready today and Phase 7 alone won't change that. Walked through the gap analysis (TLS, E2E, SSO, audit log, data residency, SOC 2, threat model, etc.). Reframed: Phase 7's decisions either pave the road to enterprise or close it off. Recommended self-host posture, standard JWT, E2E encryption as the foundations that DON'T have to be ripped out later.

User redirected: **"Ok let us go in the direction that is secure in levels. Also I am ok with the relay and I can host it in AWS for now. Tell me the costs I might incur."**

Locked: layered security model (L0 TLS → L1 JWT → L2 server-trusted identity → L3 E2E → L4 enterprise).

- **AWS cost breakdown** — provided realistic AWS pricing: t4g.nano (~$3/mo), t4g.micro (~$6/mo), Lightsail $3.50-5/mo, free tier covers most for first 12mo. Cautioned against ALB ($16+/mo just sitting there); recommended Caddy on the same instance for free TLS. Compared to Fly.io free tier ($0 for small teams).
- Presented draft decisions for all 4 areas with the layered-security framing, plus 3 small confirmations still needed (token lifetime, reconnect grace, OK with E2E adding ~1 plan of work).

### Decision pivot (final answer)

User: **"N0. I will go with the fly.io path now. Let us build it good if we are building. The rest of the security features, keep it for the final phase. We can do it then after everything is working. For now make the changes in a way that we have gap for that and can do it on demand. We can discuss all security questions then"**

Critical instructions extracted:
1. **Fly.io, not AWS** — switch deploy target. Same Docker image works on AWS too, but Fly.io is primary.
2. **Build it well** — quality is a hard requirement. No stubs, no copy-paste shortcuts.
3. **Defer L3 E2E + L4 enterprise** to a future dedicated security phase.
4. **The seams MUST be there** — the architectural gap for future crypto/auth must be present in Phase 7 code, not retrofitted later. This shaped the most important Phase 7 quality bar.
5. **No more security questions in this discussion** — those go to the future phase.

## Locked decisions (final state)

All written into CONTEXT.md `<decisions>`:

| Area | Decision |
|---|---|
| Operational model | Self-host only for v1 |
| Deployment target | Fly.io primary (Docker image works anywhere) |
| Transport architecture | Host-as-client-to-relay; dumb fan-out relay |
| Transport abstraction | `Transport` interface; `LanTransport` (refactor) + `CloudTransport` (new) |
| Wire envelope (seam) | `CloudEnvelope` with `encrypted: false` flag; future phase flips to true without `v` bump |
| Auth (L1) | Standard JWT via `jose`, host-issued, relay-verifies HMAC-SHA256; standard claim schema (SSO-ready) |
| Wizard UX | New LAN/Cloud radio step; Cloud branch swaps port/IP for relay URL; share screen renders deep-link + components |
| Join flow | Deep-link `versioncon://` URI scheme + manual entry both supported |
| Status states (SC-3) | Three distinct: connected / relay-unreachable / session-not-found |
| Reconnect | Existing heartbeat extends; 1/2/4/8/30s backoff; 60s grace before relay tears down session |
| Security shipped | L0 TLS + L1 JWT + L2 server-trusted identity |
| Relay-side defenses | Conn rate limit 30/min/IP, max 1000 sessions, max 50 members/session, 30-min idle reaper, 1 MiB frame cap, structured JSON logging — NEVER log payloads |
| Deferred to future security phase | L3 E2E encryption, L4 enterprise (SSO/audit/etc.), refresh+revocation, per-message rate limits, metadata leak analysis |

## Scope creep handled

None significant. The "big companies" question redirected priorities toward defense-in-depth architecture but didn't introduce new capabilities outside Phase 7's NET-06 + SC-1/2/3 scope. The deferred items naturally clustered into a future dedicated security phase that the user explicitly named ("the final phase").

## Phase boundary clarifications

- Phase 4.3's `versioncon.exportToGitRemote` (one-way snapshot to GitHub) is DISTINCT from Phase 7 cloud mode (real-time collab via relay). They coexist; CONTEXT.md flags this in `<canonical_refs>` so the researcher doesn't conflate them.
- Phase 4.1's "first-authenticated-wins-host" anti-pattern stays banned in cloud mode — the relay assigns role purely from JWT `role` claim, never from connection order. Called out explicitly in CONTEXT.md.

## Open items intentionally left to planner

(All listed under "Claude's Discretion" in CONTEXT.md — tunable knobs, not architectural):
- JWT signing secret generation mechanics
- Relay's `SessionRegistry` exact shape
- Backoff number tuning
- `versioncon:` URI handler registration mechanics
- Logging library final choice (pino recommended)
- Whether `/metrics` endpoint goes in v1 (recommend just `/healthz`)
- Whether to publish relay to npm (recommend no for v1)

## Result

CONTEXT.md written to `.planning/phases/07-cloud-mode-relay-server/07-CONTEXT.md`. Closes the STATE.md "operational model not yet decided" blocker.

**Next step:** `/gsd-plan-phase 7` to research + plan implementation. Researcher will consume CONTEXT.md and the `<canonical_refs>` files to produce RESEARCH.md.

---

*Discussion conducted: 2026-05-17 via /gsd-discuss-phase 7*
