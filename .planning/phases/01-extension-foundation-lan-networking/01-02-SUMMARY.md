---
phase: 01-extension-foundation-lan-networking
plan: "02"
subsystem: networking
tags: [websocket, host, client, auth, heartbeat, reconnect, bandwidth]
dependency_graph:
  requires: [01-01]
  provides: [SessionHost, AuthHandler, BandwidthMonitor, SessionClient, ConnectionStateMachine, HeartbeatManager, ReconnectManager]
  affects: [01-03, 01-04, 01-05, 01-06]
tech_stack:
  added: [ws (WebSocketServer/WebSocket)]
  patterns: [typed-event-emitter, state-machine, exponential-backoff, constant-time-comparison, rate-limiting]
key_files:
  created:
    - src/host/SessionHost.ts
    - src/host/AuthHandler.ts
    - src/host/BandwidthMonitor.ts
    - src/client/SessionClient.ts
    - src/client/ConnectionState.ts
    - src/network/heartbeat.ts
  modified: []
decisions:
  - "AuthHandler and BandwidthMonitor from previous attempt were complete and correct -- kept as-is rather than rewriting"
  - "Host tracks first authenticated member as 'host' role for admin command authorization"
  - "SessionClient sets ws to null before closing to prevent close handler from triggering reconnect during intentional disconnect"
metrics:
  duration: "5 min"
  completed: "2026-05-04"
---

# Phase 01 Plan 02: WebSocket Host + Client Transport Layer Summary

WebSocket transport infrastructure with ws library: host server (auth + bandwidth + heartbeat) and client (state machine + exponential backoff reconnect)

## What Was Built

### Host Side (Task 1)

**SessionHost** (`src/host/SessionHost.ts`): WebSocket server lifecycle manager that starts on a configured or auto-detected port, authenticates connecting clients through AuthHandler, tracks members with heartbeat monitoring at 15-second intervals, and broadcasts member lifecycle events. Implements `SessionEventEmitter` for typed event notifications. Key security mitigations:
- 10-second auth timeout for unauthenticated connections (T-01-04)
- `maxPayload` enforcement via ws library (T-01-04, T-01-08)
- `perMessageDeflate: false` for LAN optimization
- Host-role-only admin commands (kick, regenerate invite) (T-01-06)
- All messages validated via `parseMessage()` with try/catch wrapping (T-01-05)
- Server-assigned member IDs via `crypto.randomUUID()` (T-01-07)

**AuthHandler** (`src/host/AuthHandler.ts`): Invite code validation using `crypto.timingSafeEqual` for constant-time comparison (T-01-03). Rate limits to 5 attempts per IP per 60 seconds with automatic expiry cleanup. Code regeneration uses `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` alphabet (excludes 0/O/I/1) with `crypto.randomBytes`.

**BandwidthMonitor** (`src/host/BandwidthMonitor.ts`): Per-connection byte tracking with 5-second sampling intervals. Calculates KB/s throughput rates from delta bytes over delta time. Supports per-member stats and aggregate summaries.

### Client Side (Task 2)

**SessionClient** (`src/client/SessionClient.ts`): WebSocket client that connects to a host, authenticates with invite code + display name, handles all protocol message types (auth-response, state-sync, member-joined/left/kicked, heartbeat-ping, invite-regenerated, error). Auto-reconnects on connection drop via ReconnectManager. D-12 compliance: NEVER locks workspace or blocks editing.

**ConnectionStateMachine** (`src/client/ConnectionState.ts`): Deterministic 3-state machine (disconnected, connected, reconnecting) with explicit transition validation. Invalid transitions return false without throwing. Supports status change listeners with unsubscribe functions.

**HeartbeatManager + ReconnectManager** (`src/network/heartbeat.ts`): HeartbeatManager sends periodic pings and fires `onDead` callback when pong is not received within timeout. ReconnectManager implements exponential backoff with jitter (`baseDelay * 2^attempt + random(0..1000)`, capped at 30s) with configurable max attempts (default 10, covering ~30s of retries per D-11). `getReconnectDelay()` exported as a pure function.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 96bcf40 | WebSocket host with auth, bandwidth monitoring, and heartbeat |
| 2 | 0f2b2a0 | WebSocket client with state machine, heartbeat, and auto-reconnect |

## Verification Results

- `npm run lint` (tsc --noEmit): PASS
- `npm run build` (esbuild): PASS
- All acceptance criteria verified via grep checks

## Requirements Addressed

| Requirement | How |
|-------------|-----|
| NET-01 | SessionHost starts WebSocket server on configured or auto-detected port |
| NET-03 | SessionClient connects and authenticates with invite code + display name |
| NET-05 | ConnectionStateMachine tracks 3 states accurately (foundation for status indicator) |
| NET-08 | maxPayload enforced by ws library; BandwidthMonitor tracks per-connection throughput |
| SAFE-02 | SessionClient never locks workspace during disconnect (D-12 compliance verified) |

## Deviations from Plan

None -- plan executed exactly as written. AuthHandler.ts and BandwidthMonitor.ts from a previous attempt were already complete and correct, so they were committed as-is rather than rewritten.

## Decisions Made

1. **Kept existing AuthHandler + BandwidthMonitor**: Both files from a previous attempt were complete, well-documented, and matched all acceptance criteria. Rewriting them would have been wasteful.
2. **Host role assignment**: First authenticated member gets `role: 'host'`, tracked via `hostMemberId` on SessionHost for admin command authorization.
3. **Intentional disconnect pattern**: SessionClient sets `this.ws = null` before calling `ws.close()` so the close handler knows not to trigger reconnect for intentional disconnects.

## Self-Check: PASSED

- All 6 created files verified on disk
- Both commit hashes (96bcf40, 0f2b2a0) verified in git log
