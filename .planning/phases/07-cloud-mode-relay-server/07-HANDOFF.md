---
phase: 07-cloud-mode-relay-server
status: blocked-on-design-decision
created: 2026-05-19T13:30:00Z
remaining_blocker: BLOCKER 2 / MD-03 — joiner JWT bootstrap path
---

# Phase 7 Handoff — Resume Point

Read in this order: `07-VERIFICATION.md` (current state) → `07-REVIEW.md` (original 6 HIGH / 9 MEDIUM findings) → `07-REVIEW-FIX.md` (HIGH+MEDIUM autofix report) → this file.

## Where we left off

| | Status |
|---|---|
| 13 plans executed across 4 waves | ✓ Complete |
| Code review (`/gsd-code-review 7`) | ✓ Complete — 6 HIGH / 9 MEDIUM / 8 LOW / 4 INFO |
| Code review fix (`/gsd-code-review-fix 7`) | ✓ Complete — 6 HIGH + 7 MEDIUM applied, 1 partial, 3 deferred |
| First verifier pass | ❌ gaps_found — 1/3 SC (SC-3 only); BLOCKER 1 + BLOCKER 2 |
| BLOCKER 1 hotfix (`4413071`) | ✓ Applied — `verifyToken` wired into `verifyClient` with host-bootstrap defer |
| Second verifier pass (`2f75174`) | ⚠ gaps_found — 2/3 SC (SC-1 + SC-3); BLOCKER 2 still open |
| Phase mark-complete | ⛔ NOT done — blocked on BLOCKER 2 |

**Test counts:** 996/996 extension + 77/77 relay = 1073 tests passing, 0 failing, 66 pending.

## What's still broken

**SC-2 — Member on a different network can join a cloud session.**

`src/ui/JoinPanel.ts:331` still constructs `new CloudTransport(relayUrl, sessionId, '')` — empty bearer. The relay's `verifyClient` correctly rejects this with 401 (post-BLOCKER 1 fix; behavior was 503 before). The joiner has no way to obtain a valid JWT pre-WSS-connect because:

1. Member JWTs are issued by the host (`SessionHost.handleAuthRequest`) in `auth-response`.
2. To send `auth-request`, the joiner must first establish a WSS connection.
3. To establish WSS, the joiner needs a valid JWT.
4. Chicken-and-egg.

The verifier called this MD-03 / BLOCKER 2 and explicitly tagged it "plan-level redesign required". The 07-REVIEW-FIX agent agreed and deferred it.

## Design options for BLOCKER 2 (you decide)

### Option A — Bootstrap token in deep-link
Host issues a short-lived (15 min) bootstrap JWT via `TokenService` after `session-register` completes. Deep-link embeds the bootstrap-token alongside `relay/session/code`. Joiner uses it to WSS-connect; first frame is `auth-request` with invite code; host issues a real per-joiner JWT in `auth-response`; joiner reconnects with the real JWT.

**Pros:** No new relay endpoints. Uses existing JWT verify path. Per-deeplink unique `sub` avoids HI-01 demux collision.
**Cons:** Bootstrap-token visible in deep-link URL (clipboard, browser history). Host must regenerate the deep-link after each successful join (single-use semantics) OR accept multi-joiner collision risk if `sub` is shared.
**Threads through:** `SessionHostFactory.createCloud`, `WizardPanel` state, `wizard.js buildDeepLink`, `UriHandler`, `JoinPanel`.

### Option B — Relay `/bootstrap` HTTP endpoint
Joiner does `POST /bootstrap { sessionId }` to relay. Relay checks `registry.getSession(sessionId)` exists, signs a short-lived bootstrap JWT with the session's `verifySecret`, returns it. Joiner uses the JWT to WSS-connect. Auth-request flow proceeds as usual.

**Pros:** Bootstrap-token never in URL. Joiner-side flow is mostly self-contained.
**Cons:** New HTTP endpoint = new attack surface (rate-limit target T-07-06-like). Relay signs tokens autonomously — requires explicit security review. Adds an HTTP round-trip to every join.

### Option C — Anonymous member window
Relay allows WSS upgrades with NO Authorization header IF `?sessionId=<existing>` query param matches. Anonymous sockets can send EXACTLY ONE `auth-request` frame. Relay accepts inbound `auth-response` from host to that socket (no payload read — still T-07-02 compliant). After 1 outbound + 1 inbound, socket closes with code 4200 `bootstrap-complete-reconnect`. Joiner reads the JWT from `auth-response` and reconnects with it.

**Pros:** No token in URL. No new endpoints. Smallest extension-side delta.
**Cons:** New socket lifecycle state ("anonymous-pending"). DoS surface — anonymous sockets fill the per-IP rate limit. Two-connection bootstrap costs latency on every fresh join.

## Recommended next step

`/clear`, then `/gsd-plan-phase 7 --gaps`. The orchestrator reads `07-VERIFICATION.md`, sees the open gap, and creates a `gap_closure: true` plan. The plan author will pick A/B/C based on your input and write proper threat-model + test scaffolding before code lands.

Alternatively, if you want to commit to an option without a plan-phase pass: A is cleanest IMO but A has the multi-joiner collision concern (unique `sub` requires per-share regenerate UX). B is the most "production" design. C is the smallest delta.

## Cleanup notes

- `08e2475` (or thereabouts) onward are NOT part of phase 7 (those would be future phases).
- The handoff document you're reading lives at `.planning/phases/07-cloud-mode-relay-server/07-HANDOFF.md` — it's a one-shot resume-aid; safe to delete once BLOCKER 2 closes.
- All HIGH-fix commits (`789a994` → `cdb1318`) preserved; only `d6e97e6` and `47b0c72` were MEDIUM. None reverted.

## Source-grep invariants (all still PASSING)

| Gate | Invariant | Last verified |
|---|---|---|
| T-07-02 | `relay/src/router.ts` has 0 `.payload` references | post-BLOCKER 1 fix |
| T-07-05 | `relay/src/` has 0 `inviteCode` references | post-BLOCKER 1 fix |
| T-07-11 | `relay/src/auth.ts` contains `algorithms: ['HS256']` | post-BLOCKER 1 fix |
| 07-11 | `relay/src/` has 0 `console.*` calls | post-BLOCKER 1 fix |
| 07-01 | `src/host/SessionHost.ts` + `src/client/SessionClient.ts` have 0 `new WebSocket(Server)(` | post-BLOCKER 1 fix |
| 07-02 | Broadcast envelope byte-shape snapshot (literal JSON) | post-BLOCKER 1 fix |

## Human-verification items deferred to UAT

| ID | Description | Expected outcome |
|---|---|---|
| UAT-1 | `docker build relay/` smoke test (daemon was offline locally) | Image builds clean on first try |
| UAT-2 | End-to-end Fly.io deploy quickstart in ≤5 min | Following relay/README.md works |
| UAT-3a | Host-side single-machine cloud session (start session via wizard, see status bar) | PASS post-BLOCKER 1 fix |
| UAT-3b | Two-machine live cloud session (host A + joiner B different networks) | FAIL on joiner side until BLOCKER 2 closes |
| SC-3-live | StatusBar state-transition visual verification (`connecting → connected → relay-unreachable → reconnecting`) | PASS post-BLOCKER 1 fix; verify manually after BLOCKER 2 closes |
