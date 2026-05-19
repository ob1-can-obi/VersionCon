// relay/src/router.ts
//
// Pure byte-pass-through router. Forwards the inbound raw buffer verbatim
// to the appropriate peer(s) for a given session.
//
// CRITICAL INVARIANT (T-07-02 — byte-pass-through; CONTEXT D-01):
// This module MUST NOT inspect the inbound buffer beyond what the caller
// already extracted (sessionId, a plain string). It NEVER reads the envelope
// body field. The source-grep test in relay/test/router.test.js enforces
// that this file contains ZERO references to the envelope body member.
//
// Fan-out rules:
//   - fromSocket === session.hostSocket          → forward to ALL members
//   - fromSocket is a registered member socket   → forward to host ONLY
//   - fromSocket is neither                      → silent no-op
//   - sessionId is unknown                       → silent no-op
//
// The router never deserializes the buffer. server.ts parses just enough
// JSON to learn `sessionId`; the parsed object never reaches this module.

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

  if (session.hostSocket === fromSocket) {
    // Host → all members. Verbatim byte-pass-through.
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
    // Member → host only. Verbatim byte-pass-through.
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
