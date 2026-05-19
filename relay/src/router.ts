// relay/src/router.ts
//
// Pure byte-pass-through router with envelope.target unicast routing
// (Phase 7 Plan 07-05b extension).
//
// CRITICAL INVARIANT (T-07-02 — byte-pass-through; CONTEXT D-01):
// This module MUST NOT inspect the envelope body member. The router DOES
// read TWO envelope-level routing fields: `sessionId` (extracted upstream
// in server.ts) and `target` (this plan's extension — used for unicast).
// The envelope body member remains opaque to the router.
// Source-grep gate in relay/test/router.test.js + relay/test/hostRegister.test.js
// enforces that this file contains ZERO references to the envelope body
// member.
//
// Fan-out rules:
//   - fromSocket === session.hostSocket
//       + target present  → unicast to ONE member whose memberId === target
//                            (envelope-level target, NOT inside body)
//       + target absent   → broadcast to ALL members
//   - fromSocket is a registered member socket   → forward to host ONLY
//   - fromSocket is neither                      → silent no-op
//   - sessionId is unknown                       → silent no-op
//
// The router never deserializes the buffer beyond reading the envelope-level
// `target` string. server.ts parses just enough JSON to learn `sessionId`;
// this module additionally reads `target` for unicast routing. Neither read
// touches the envelope body.

import type { WebSocket } from 'ws';
import type { SessionRegistry } from './SessionRegistry.js';

// ws.WebSocket.OPEN === 1; inlined to avoid a runtime import of the ws value.
const WS_OPEN = 1;

export function route(
  registry: SessionRegistry,
  sessionId: string,
  fromSocket: WebSocket,
  rawMessageBuffer: Buffer | ArrayBuffer | Buffer[],
): void {
  const session = registry.getSession(sessionId);
  if (!session) return;

  // Refresh activity timestamp — 07-10's idle reaper consults this.
  registry.onLastActivity(sessionId);

  // Plan 07-05b: read envelope.target (envelope-level, NOT inside body) for
  // unicast routing. The body remains opaque — the parse below only touches
  // the envelope's `target` field. A malformed JSON or absent target falls
  // through to default fan-out semantics.
  let target: string | undefined;
  try {
    let text: string;
    if (rawMessageBuffer instanceof Buffer) {
      text = rawMessageBuffer.toString('utf-8');
    } else if (Array.isArray(rawMessageBuffer)) {
      text = Buffer.concat(rawMessageBuffer).toString('utf-8');
    } else {
      // ArrayBuffer
      text = Buffer.from(new Uint8Array(rawMessageBuffer)).toString('utf-8');
    }
    const parsed = JSON.parse(text) as { target?: unknown };
    if (typeof parsed?.target === 'string') target = parsed.target;
  } catch {
    // Malformed envelope — drop silently (existing posture).
    return;
  }

  if (session.hostSocket === fromSocket) {
    // Host → member(s). Envelope.target → unicast; absent → broadcast.
    if (target !== undefined) {
      // Plan 07-05b unicast: find member whose memberId === target.
      for (const memberSocket of session.memberSockets) {
        const mid = session.memberSocketIds.get(memberSocket);
        if (mid === target && memberSocket.readyState === WS_OPEN) {
          try {
            memberSocket.send(rawMessageBuffer);
          } catch {
            // Closed mid-send.
          }
          return;
        }
      }
      // Target not found among current members — silent drop.
      return;
    }
    // No target → broadcast to all members. Verbatim byte-pass-through.
    for (const memberSocket of session.memberSockets) {
      if (memberSocket.readyState === WS_OPEN) {
        try {
          memberSocket.send(rawMessageBuffer);
        } catch {
          // Closed mid-send; member will detach via its own 'close' handler.
        }
      }
    }
    return;
  }

  if (session.memberSocketIds.has(fromSocket)) {
    // Member → host only. Verbatim byte-pass-through. envelope.target is
    // ignored on member→host direction; the only destination is the host.
    if (session.hostSocket && session.hostSocket.readyState === WS_OPEN) {
      try {
        session.hostSocket.send(rawMessageBuffer);
      } catch {
        // Host dropped mid-send; will detach via its own 'close' handler.
      }
    }
    return;
  }

  // fromSocket is registered with neither host slot nor member slot — silent ignore.
  // (Unreachable in practice — server.ts only routes on authenticated sockets.)
}
