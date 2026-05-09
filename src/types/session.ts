// Connection status per D-10: three states
export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

// Role in a session
export type SessionRole = 'host' | 'member';

// Member info visible to all per D-16
export interface Member {
  id: string;               // Server-assigned UUID (not display name)
  displayName: string;      // User-chosen display name per D-05
  role: SessionRole;
  isOnline: boolean;
  joinedAt: number;         // Unix timestamp ms
}

// Session configuration per D-01 (3-step wizard output)
export interface SessionConfig {
  sessionName: string;       // Step 1
  port: number;              // Step 2, auto-detected or manual per D-02
  networkInterface: string;  // Step 2, auto-detected or manual per D-02
  maxPayloadBytes: number;   // Step 2 bandwidth limit per NET-08
  inviteCode: string;        // Step 3, generated per D-05
}

/**
 * Phase 4.1 (host-identity-and-creation-wizard): pre-allocated host identity
 * passed to SessionHost's constructor BEFORE the WebSocket listener starts.
 *
 * The session creator's WizardPanel allocates this triple:
 *   - `memberId`         — `crypto.randomUUID()` for the host's member id
 *   - `displayName`      — user-confirmed display name from wizard step 1
 *   - `hostAuthSecret`   — `crypto.randomUUID()` separate from memberId; the
 *                          loopback SessionClient passes this in its
 *                          auth-request to claim role:'host'. NEVER leaves
 *                          the host process for any non-loopback client.
 *
 * SessionHost.start() (post-Plan 04.1-02) sets `this.hostMemberId` and
 * `this.hostAuthSecret` from this struct BEFORE binding the WebSocket
 * listener — closing the "first-authenticated wins host role" race surfaced
 * during Phase 4 multi-window UAT (2026-05-08). See ROADMAP Phase 4.1.
 *
 * Security: a remote attacker who guesses the host's memberId UUID still
 * cannot claim role:'host' without the matching hostAuthSecret. UUID
 * guessing is statistically improbable; the explicit secret check makes
 * the boundary obvious to auditors and protects against unknown UUID
 * leakage paths (e.g. logs, stack traces).
 */
export interface HostIdentity {
  memberId: string;
  displayName: string;
  hostAuthSecret: string;
}

// Full session state (host-side source of truth per SAFE-01)
export interface Session {
  config: SessionConfig;
  hostDisplayName: string;
  members: Map<string, Member>;
  createdAt: number;
  isActive: boolean;
}

// Saved session for history per D-08 (last 3-5 sessions)
export interface SavedSession {
  hostIp: string;
  port: number;
  sessionName: string;
  displayName: string;
  lastConnected: number;
}

// Transport abstraction (same protocol, different transport)
// LAN uses WebSocket directly; Cloud (Phase 7) implements this with relay per NET-06
// This is the Phase 1 interface definition only; full cloud transport is Phase 7
export interface TransportAdapter {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (error: Error) => void): void;
  close(): void;
  readonly readyState: number;
}
