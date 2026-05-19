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
import * as limits from './limits.js';

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
   * Register a session with the given host socket. Returns `true` on success,
   * `false` when the session cap (limits.canRegisterSession) is exceeded —
   * caller (server.ts) closes the WSS with code 4429 on `false` (T-07-07).
   *
   * If a session for `sessionId` already exists with a live `hostSocket`, the
   * older host socket is closed (1008 host-replaced) — matches Phase 4.1's
   * anti-spoof posture. If it exists with `hostSocket: null` (in a grace
   * window — 07-10's host-drop grace timer), the new socket is promoted to
   * host and the pending grace timer is cancelled via cancelGracePeriod().
   * Re-attach does NOT count against the session cap.
   *
   * The caller (server.ts via 07-09's auth) is responsible for verifying the
   * JWT `role` claim is `host` BEFORE calling this method. The registry
   * itself performs no auth.
   */
  register(sessionId: string, hostSocket: WebSocket, verifySecret: Uint8Array): boolean {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      // Re-attach branch — does NOT count toward cap. Cancel any pending
      // grace timer and rebind the host slot.
      if (existing.hostSocket !== null) {
        // Duplicate register on a live session — drop the older socket.
        try {
          existing.hostSocket.close(1008, 'host-replaced');
        } catch {
          // already closed
        }
      }
      this.cancelGracePeriod(sessionId);
      existing.hostSocket = hostSocket;
      existing.verifySecret = verifySecret;
      existing.lastActivity = Date.now();
      return true;
    }
    // New session — apply session cap (T-07-07).
    if (!limits.canRegisterSession(this.activeSessionCount())) {
      return false;
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
    return true;
  }

  /**
   * Attach a member socket to an existing session. Returns `true` on success,
   * `false` on reject (caller closes the WSS with code 4429 or 4503).
   *
   * Reject conditions (07-10):
   *   - Unknown sessionId — silent no-op, returns false (no auto-create;
   *     a Phase 4.1 invariant violation prevention).
   *   - Member cap (limits.canAttachMember) reached — T-07-13 mitigation,
   *     caller closes with 4429.
   *   - Session is in host-drop grace window (graceTimer !== null) — T-07-14
   *     mitigation, caller closes with 4503 'grace-period-active'. New joiners
   *     are rejected while existing members wait for the host to return.
   */
  attachMember(sessionId: string, memberId: string, memberSocket: WebSocket): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false; // no auto-create
    if (s.graceTimer !== null) return false; // host in grace; reject new joiners (T-07-14)
    if (!limits.canAttachMember(s.memberSockets.length)) return false; // member cap (T-07-13)
    s.memberSockets.push(memberSocket);
    s.memberSocketIds.set(memberSocket, memberId);
    s.lastActivity = Date.now();
    return true;
  }

  /**
   * Detach a socket from a session.
   *
   *   - If `socket` is the session's host: clear the host slot AND start the
   *     60s host-drop grace timer (07-10 / T-07-14). Session record persists
   *     during the grace window so the host can re-attach via register().
   *     On expiry (host did NOT re-attach), the session is torn down with
   *     reason 'host-grace-expired'.
   *   - If `socket` is a member: remove it from the members array.
   *   - Otherwise: silently ignore.
   */
  detach(sessionId: string, socket: WebSocket): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.hostSocket === socket) {
      // Host dropped — clear the host slot and arm the grace timer.
      s.hostSocket = null;
      this.scheduleGracePeriod(sessionId, limits.getHostDropGraceMs(), () => {
        this.closeSession(sessionId, 'host-grace-expired');
      });
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
   * Iterable view of every active session. Used by 07-10's idle reaper
   * (server.ts setInterval pass) to scan `lastActivity` for stale sessions.
   * Returns an array snapshot so the caller can mutate `sessions` during
   * iteration (closeSession deletes entries).
   */
  allSessions(): Session[] {
    return Array.from(this.sessions.values());
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
   * Schedule a one-shot grace timer for the session. Used by detach() on host
   * drop and by 07-10's lifecycle: if the host re-attaches within `ms`,
   * cancelGracePeriod() clears the timer; otherwise `onExpire` fires.
   *
   * Idempotent — if a graceTimer already exists for this session, the existing
   * one is cleared first (re-arming).
   *
   * The setTimeout handle is .unref()'d so a process holding only grace
   * timers can still exit gracefully (matches the reaper's .unref()
   * discipline). In production the WSS server keeps the process ref'd, so the
   * grace timer still runs to completion. T-07-17 lite — grace timers don't
   * block shutdown.
   */
  scheduleGracePeriod(sessionId: string, ms: number, onExpire: () => void): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.graceTimer) {
      clearTimeout(s.graceTimer);
    }
    const handle = setTimeout(onExpire, ms);
    if (typeof handle === 'object' && handle !== null && typeof handle.unref === 'function') {
      handle.unref();
    }
    s.graceTimer = handle;
  }

  /**
   * Cancel any pending grace timer for the session. Called by register() on
   * host re-attach and by closeSession() as its first step.
   */
  cancelGracePeriod(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.graceTimer) {
      clearTimeout(s.graceTimer);
      s.graceTimer = null;
    }
  }

  /**
   * Close and remove a single session by id. Calls cancelGracePeriod() first
   * so a closed session never has a dangling timer. Sends close code 1001 to
   * every socket with the supplied reason. No-op for unknown sessionId.
   *
   * Called by the idle reaper (server.ts setInterval pass) with reason 'idle'
   * and by the grace-period onExpire callback with reason 'host-grace-expired'.
   */
  closeSession(sessionId: string, reason: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.cancelGracePeriod(sessionId);
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
    this.sessions.delete(sessionId);
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
