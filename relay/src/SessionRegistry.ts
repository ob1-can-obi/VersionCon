// relay/src/SessionRegistry.ts
//
// In-memory Map<sessionId, Session> registry for the relay.
//
// API surface (locked by Plan 07-08):
//   - register(sessionId, hostSocket, verifySecret)
//   - attachMember(sessionId, memberId, memberSocket)
//   - detach(sessionId, socket)
//   - getSession(sessionId) → Session | undefined
//   - hostOf(sessionId) → WebSocket | undefined
//   - membersOf(sessionId) → WebSocket[]
//   - activeSessionCount() → number
//   - onLastActivity(sessionId)
//   - closeAll(reason)
//
// Structural-defense invariant (T-07-09, Phase 4.1 ban on "first authenticated wins host"):
// `register()` and `attachMember()` are DISTINCT method names. There is NO code path where
// the order of connection events causes register() to be called instead of attachMember();
// 07-09's `auth.ts` reads `role` from the verified JWT claim and routes to the right method.
//
// Hook seams reserved for downstream plans:
//   - 07-10 (limits/reaper): graceTimer field initialized to null; detach(host) clears
//     hostSocket but leaves session record so 07-10 can wire a 60s eviction timer.
//   - 07-09 (auth): hostMemberId field reserved for JWT issuer/subject claim mirror.

import type { WebSocket } from 'ws';

export interface Session {
  sessionId: string;
  hostSocket: WebSocket | null;             // null during grace window after host detach
  memberSockets: WebSocket[];               // insertion-ordered
  memberSocketIds: Map<WebSocket, string>;  // reverse lookup for detach-by-socket
  verifySecret: Uint8Array;                 // host-supplied at register time; jose secret material
  lastActivity: number;                     // ms-since-epoch; 07-10 reaper consults
  graceTimer: NodeJS.Timeout | null;        // SEAM for 07-10's 60s host-drop grace policy
  registeredAt: number;
  hostMemberId?: string;                    // optional — 07-09 may populate from JWT iss/sub
}

export class SessionRegistry {
  private readonly sessions: Map<string, Session> = new Map();

  /**
   * Register a session with the given host socket.
   *
   * If a session for `sessionId` already exists with a live `hostSocket`, the
   * older host socket is closed (1008 host-replaced) — matches Phase 4.1's
   * anti-spoof posture. If it exists with `hostSocket: null` (in a grace
   * window), the new socket is promoted to host and any pending grace timer
   * is cleared.
   *
   * The caller (server.ts via 07-09's auth) is responsible for verifying the
   * JWT `role` claim is `host` BEFORE calling this method. The registry
   * itself performs no auth.
   */
  register(sessionId: string, hostSocket: WebSocket, verifySecret: Uint8Array): void {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.hostSocket !== null) {
      // Duplicate register on a live session — drop the older socket.
      try {
        existing.hostSocket.close(1008, 'host-replaced');
      } catch {
        // already closed
      }
    }
    if (existing) {
      if (existing.graceTimer) {
        clearTimeout(existing.graceTimer);
        existing.graceTimer = null;
      }
      existing.hostSocket = hostSocket;
      existing.verifySecret = verifySecret;
      existing.lastActivity = Date.now();
      return;
    }
    this.sessions.set(sessionId, {
      sessionId,
      hostSocket,
      memberSockets: [],
      memberSocketIds: new Map(),
      verifySecret,
      lastActivity: Date.now(),
      graceTimer: null,
      registeredAt: Date.now(),
    });
  }

  /**
   * Attach a member socket to an existing session. No-op for unknown
   * sessionId — caller is responsible for ensuring the session has been
   * registered (otherwise we'd silently auto-create sessions without a host,
   * a Phase 4.1 invariant violation).
   */
  attachMember(sessionId: string, memberId: string, memberSocket: WebSocket): void {
    const s = this.sessions.get(sessionId);
    if (!s) return; // no auto-create
    s.memberSockets.push(memberSocket);
    s.memberSocketIds.set(memberSocket, memberId);
    s.lastActivity = Date.now();
  }

  /**
   * Detach a socket from a session.
   *
   *   - If `socket` is the session's host: clear the host slot but leave the
   *     session record intact. 07-10 wires the 60s grace timer here that
   *     evicts the session when the timer fires.
   *   - If `socket` is a member: remove it from the members array.
   *   - Otherwise: silently ignore.
   */
  detach(sessionId: string, socket: WebSocket): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.hostSocket === socket) {
      // Host dropped — clear the host slot. 07-10 fills in:
      //   s.graceTimer = setTimeout(() => this.evict(sessionId), 60_000);
      s.hostSocket = null;
      // TODO(07-10): start grace timer; on expiry call closeAll-equivalent for this session.
      return;
    }
    const idx = s.memberSockets.indexOf(socket);
    if (idx >= 0) {
      s.memberSockets.splice(idx, 1);
      s.memberSocketIds.delete(socket);
    }
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  hostOf(sessionId: string): WebSocket | undefined {
    const s = this.sessions.get(sessionId);
    return s?.hostSocket ?? undefined;
  }

  membersOf(sessionId: string): WebSocket[] {
    return this.sessions.get(sessionId)?.memberSockets ?? [];
  }

  activeSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Refresh the last-activity timestamp for the given session. Called by
   * `route()` on every forwarded frame; 07-10's idle-reaper consults this
   * field to evict stale sessions.
   */
  onLastActivity(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.lastActivity = Date.now();
  }

  /**
   * Force-close every socket in every session. Used by server.ts on graceful
   * shutdown. Sends close code 1001 (going away) with the supplied reason.
   */
  closeAll(reason: string): void {
    for (const s of this.sessions.values()) {
      if (s.graceTimer) {
        clearTimeout(s.graceTimer);
        s.graceTimer = null;
      }
      try {
        s.hostSocket?.close(1001, reason);
      } catch {
        // already closed
      }
      for (const m of s.memberSockets) {
        try {
          m.close(1001, reason);
        } catch {
          // already closed
        }
      }
    }
    this.sessions.clear();
  }
}
