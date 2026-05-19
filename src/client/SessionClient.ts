import { ConnectionStateMachine } from './ConnectionState.js';
import { HeartbeatManager, ReconnectManager } from '../network/heartbeat.js';
import {
  parseMessage,
  createTimestamp,
} from '../network/protocol.js';
import type { ProtocolMessage } from '../network/protocol.js';
import type { ClientTransport } from '../network/Transport.js';
// Phase 7 D-05: LanClientTransport is the default impl when callers omit
// the `transport` constructor argument. Same posture as SessionHost's
// LanHostTransport import — safe vs. the transport-seam grep gate.
import { LanClientTransport } from '../network/LanTransport.js';
import type { Member, ConnectionStatus } from '../types/session.js';
import type {
  SessionEventEmitter,
  SessionEvent,
  SessionEventMap,
} from '../types/events.js';
import type { ChatRecord, PresenceInfo } from '../types/chat.js';

/** Session info received from the host after successful authentication. */
interface SessionInfo {
  name: string;
  memberCount: number;
  hostDisplayName: string;
}

/**
 * WebSocket client that connects to a VersionCon SessionHost.
 *
 * Handles:
 * - Connection and authentication via invite code + display name (NET-03)
 * - Connection state machine with 3 states (NET-05)
 * - Auto-reconnect with exponential backoff on drop (D-11)
 * - Heartbeat ping/pong liveness checks
 * - Member list tracking via state-sync and member-joined/left events
 *
 * IMPORTANT (D-12 / SAFE-02): This class NEVER locks the workspace or blocks
 * editing. Connection state is purely informational -- the user keeps coding
 * locally regardless of connection status.
 */
export class SessionClient implements SessionEventEmitter {
  /**
   * D-05 / Phase 7 transport seam. The client accepts a ClientTransport
   * (LAN: LanClientTransport; future Cloud: CloudClientTransport) and
   * routes every wire I/O call through it. SessionClient is
   * transport-agnostic — it never imports from `ws` directly.
   */
  private readonly transport: ClientTransport;
  /**
   * Phase 7 D-05: replaces the pre-refactor `this.ws = null` sentinel used
   * to distinguish intentional disconnect from a connection drop
   * (SessionClient.ts:177 + 550-551 pre-refactor). Set true by
   * `disconnectInternal()` BEFORE calling `transport.close()` so the
   * onClose handler short-circuits and does NOT trigger reconnect.
   */
  private intentionalClose: boolean = false;
  /**
   * Phase 7 D-05: tracks whether `connect()` is currently inside an active
   * open-wait. The pre-refactor close handler used `if (this.ws === null)
   * return` to distinguish intentional close — after the refactor the
   * intentionalClose flag covers that case, but we also need to guard
   * against the close-handler firing AFTER `connect()` itself has already
   * resolved (the pre-refactor code relied on `resolved = true` being a
   * local closure flag). To preserve the semantics, each new connect()
   * call resets transportHandlersInstalled so handlers are re-registered.
   */
  private transportHandlersInstalled: boolean = false;
  private readonly connectionState: ConnectionStateMachine;
  private readonly heartbeat: HeartbeatManager;
  private readonly reconnect: ReconnectManager;
  private memberId: string | null = null;
  private sessionInfo: SessionInfo | null = null;
  private members: Member[] = [];

  private readonly hostIp: string;
  private readonly port: number;
  private readonly inviteCode: string;
  private readonly displayName: string;

  /** Typed event listeners. */
  private readonly listeners: Map<
    SessionEvent,
    Set<(data: never) => void>
  > = new Map();

  /**
   * Construct a SessionClient.
   *
   * Phase 7 D-05: `transport` is optional and defaults to a new
   * `LanClientTransport(hostIp, port)` so existing call-sites
   * (JoinPanel.ts:229, reviewClientRouting.test.ts:27, client.test.ts:73)
   * compile unchanged. Future cloud callers pass an explicit
   * CloudClientTransport.
   */
  constructor(
    hostIp: string,
    port: number,
    inviteCode: string,
    displayName: string,
    transport?: ClientTransport,
  ) {
    this.hostIp = hostIp;
    this.port = port;
    this.inviteCode = inviteCode;
    this.displayName = displayName;
    this.connectionState = new ConnectionStateMachine();
    this.heartbeat = new HeartbeatManager();
    this.reconnect = new ReconnectManager();
    this.transport = transport ?? new LanClientTransport(hostIp, port);
  }

  // ---------------------------------------------------------------------------
  // EventEmitter implementation
  // ---------------------------------------------------------------------------

  on<K extends SessionEvent>(
    event: K,
    listener: (data: SessionEventMap[K]) => void,
  ): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (data: never) => void);
  }

  off<K extends SessionEvent>(
    event: K,
    listener: (data: SessionEventMap[K]) => void,
  ): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener as (data: never) => void);
    }
  }

  emit<K extends SessionEvent>(event: K, data: SessionEventMap[K]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const listener of set) {
        try {
          (listener as (data: SessionEventMap[K]) => void)(data);
        } catch {
          // Listener errors must not crash the client
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  /**
   * Connect to the host and authenticate.
   *
   * Resolves true on successful authentication, false on rejection.
   * Rejects on transport-level errors during the initial connection.
   *
   * Phase 7 D-05: pre-refactor this method constructed `new WebSocket(...)`
   * inline. After the refactor:
   *  - transport.connect() opens the underlying socket (returns
   *    Promise<true|false>)
   *  - handlers (onOpen / onMessage / onClose / onError / onPong) are
   *    installed ONCE per SessionClient instance via installTransportHandlers
   *    — LanClientTransport.connect() re-binds them to each new internal
   *    socket so reconnect works without re-registering. The Transport
   *    interface itself is contract-compatible with this pattern (handlers
   *    fan out to ALL registered callbacks; idempotent across reconnects).
   *  - The outer Promise resolves on auth-response success/failure (NOT on
   *    socket open) — preserving the pre-refactor behavior where
   *    `SessionClient.connect()` resolves with the auth verdict, not the
   *    wire-level open.
   */
  async connect(): Promise<boolean> {
    this.intentionalClose = false;
    return new Promise<boolean>((resolve) => {
      let resolved = false;
      const resolveOnce = (success: boolean): void => {
        if (!resolved) {
          resolved = true;
          resolve(success);
        }
      };

      // Install transport-level handlers exactly once per SessionClient
      // instance. LanClientTransport.connect() re-binds the underlying
      // ws's events to the same registered handlers each reconnect, so we
      // do NOT need to re-register on every call.
      if (!this.transportHandlersInstalled) {
        this.transportHandlersInstalled = true;

        this.transport.onOpen(() => {
          // Send auth-request as the first message
          this.transport.send({
            type: 'auth-request',
            inviteCode: this.inviteCode,
            displayName: this.displayName,
            timestamp: createTimestamp(),
          });
        });

        this.transport.onMessage((raw: Buffer | ArrayBuffer | Buffer[]) => {
          try {
            const data = raw.toString();
            const msg = parseMessage(data);
            if (!msg) {
              return; // Malformed message -- drop silently
            }

            this.handleMessage(msg, (success) => {
              resolveOnce(success);
            });
          } catch {
            // Message handling errors should not crash the client
          }
        });

        this.transport.onClose((_code: number, _reason: Buffer) => {
          this.heartbeat.stop();

          if (!resolved) {
            // Connection closed before auth completed
            resolveOnce(false);
            return;
          }

          // Intentional disconnect flips the flag BEFORE calling
          // transport.close() — replaces the pre-refactor null-ws sentinel.
          // If intentional, do not reconnect.
          if (this.intentionalClose) return;

          // If we were connected, try to reconnect (D-11)
          if (this.connectionState.current === 'connected') {
            this.attemptReconnect();
          }
        });

        this.transport.onError(() => {
          // Error will be followed by close -- handle reconnect there
          resolveOnce(false);
        });

        this.transport.onPong(() => {
          this.heartbeat.receivedPong();
        });
      }

      // Fire the transport open. Resolution semantics:
      //  - transport.connect() resolving false → socket failed to open,
      //    resolve outer false (no auth-response is ever coming).
      //  - transport.connect() resolving true → wait for auth-response via
      //    the onMessage handler installed above.
      this.transport.connect().then((opened) => {
        if (!opened) resolveOnce(false);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Message routing
  // ---------------------------------------------------------------------------

  private handleMessage(
    msg: ProtocolMessage,
    onAuth: (success: boolean) => void,
  ): void {
    switch (msg.type) {
      case 'auth-response':
        if (msg.accepted) {
          this.memberId = msg.memberId ?? null;
          this.sessionInfo = msg.sessionInfo ?? null;
          this.connectionState.transition('connected');
          this.emit('connection-changed', { status: 'connected' });
          this.startClientHeartbeat();
          onAuth(true);
        } else {
          this.emit('auth-failed', { reason: msg.reason ?? 'Unknown' });
          onAuth(false);
        }
        break;

      case 'state-sync':
        this.members = msg.members.map((m) => ({
          id: m.id,
          displayName: m.displayName,
          role: m.role as Member['role'],
          isOnline: m.isOnline,
          joinedAt: m.joinedAt,
        }));
        break;

      case 'member-joined': {
        const newMember: Member = {
          id: msg.member.id,
          displayName: msg.member.displayName,
          role: msg.member.role as Member['role'],
          isOnline: msg.member.isOnline,
          joinedAt: msg.member.joinedAt,
        };
        this.members.push(newMember);
        this.emit('member-joined', { member: newMember });
        break;
      }

      case 'member-left':
        this.members = this.members.filter((m) => m.id !== msg.memberId);
        this.emit('member-left', { memberId: msg.memberId, reason: msg.reason });
        break;

      case 'member-kicked':
        // We were kicked -- disconnect without reconnect
        this.emit('member-kicked', {
          memberId: this.memberId ?? '',
          reason: msg.reason,
        });
        this.disconnectInternal();
        break;

      case 'member-list':
        this.members = msg.members.map((m) => ({
          id: m.id,
          displayName: m.displayName,
          role: m.role as Member['role'],
          isOnline: m.isOnline,
          joinedAt: m.joinedAt,
        }));
        break;

      case 'invite-regenerated':
        this.emit('invite-code-regenerated', { newCode: msg.newCode });
        break;

      case 'heartbeat-ping':
        // Respond with heartbeat-pong
        if (this.transport.isOpen()) {
          this.transport.send({
            type: 'heartbeat-pong',
            timestamp: createTimestamp(),
          });
        }
        break;

      case 'heartbeat-pong':
        // Protocol-level pong (defensive — server currently uses native pong frames)
        this.heartbeat.receivedPong();
        break;

      case 'error':
        // Log and emit -- do not crash
        this.emit('connection-changed', {
          status: this.connectionState.current,
          error: msg.message,
        });
        break;

      case 'push-notification':
        this.emit('push-received', {
          pushId: msg.pushId,
          memberId: msg.memberId,
          memberDisplayName: msg.memberDisplayName,
          message: msg.message,
          branch: msg.branch,
          files: msg.files,
        });
        break;

      case 'push-reverted':
        this.emit('push-reverted', {
          pushId: msg.pushId,
          memberId: msg.memberId,
          memberDisplayName: msg.memberDisplayName,
          branch: msg.branch,
          files: msg.files,
        });
        break;

      case 'branch-created':
        this.emit('branch-created', { branch: msg.branch });
        break;

      case 'branch-locked':
        this.emit('branch-locked', { branchName: msg.branchName, locked: msg.locked });
        break;

      case 'permission-changed':
        this.emit('permission-changed', {
          branchName: msg.branchName,
          memberId: msg.memberId,
          action: msg.action,
        });
        break;

      // --- Phase 4: Chat + Presence wire → typed events (Plan 04-05) ---
      // Mirrors the existing push-notification pattern. Field renames documented
      // inline (recordId → id for chat-message; timestamp → lastUpdated for
      // presence-update). memberId/timestamp are host-stamped before broadcast
      // (T-04-01-01, T-04-01-04 — enforced in Plan 04-04 host relay), so we
      // forward the server-trusted values without re-validation.

      case 'chat-message': {
        const record: ChatRecord = {
          id: msg.recordId,
          kind: msg.kind,
          ...(msg.subKind !== undefined ? { subKind: msg.subKind } : {}),
          memberId: msg.memberId,
          memberDisplayName: msg.memberDisplayName,
          body: msg.body,
          timestamp: msg.timestamp,
          ...(msg.meta !== undefined ? { meta: msg.meta } : {}),
        };
        this.emit('chat-received', record);
        break;
      }

      // Phase 5 Plan 05-05 (SC-5): host fires this after the AST analyzer
      // resolves so clients can patch a previously-received chat-message's
      // `meta.affectedSymbols` + `meta.unsupportedLanguages`. Forwarded
      // verbatim — the client/extension layer is responsible for locating
      // the record by id and merging meta.
      case 'chat-message-amend':
        this.emit('chat-message-amend', {
          recordId: msg.recordId,
          affectedSymbols: msg.affectedSymbols,
          unsupportedLanguages: msg.unsupportedLanguages,
        });
        break;

      case 'chat-cleared':
        this.emit('chat-cleared', {
          hostMemberId: msg.hostMemberId,
          hostDisplayName: msg.hostDisplayName,
        });
        break;

      case 'chat-truncated':
        this.emit('chat-truncated', {
          mode: msg.mode,
          hostMemberId: msg.hostMemberId,
          hostDisplayName: msg.hostDisplayName,
        });
        break;

      case 'chat-history':
        this.emit('chat-history', {
          branch: msg.branch,
          records: msg.records,
        });
        break;

      case 'presence-update': {
        // Wire timestamp → PresenceInfo.lastUpdated (host arrival time).
        const info: PresenceInfo = {
          memberId: msg.memberId,
          displayName: msg.displayName,
          branch: msg.branch,
          activeFilePath: msg.activeFilePath,
          lastUpdated: msg.timestamp,
        };
        this.emit('presence-update', info);
        break;
      }

      // --- Phase 6: Review wire → typed events (Plan 06-03) ---
      // Payload shapes match the wire shape exactly — no field renames.
      // Identity + timestamps are host-stamped at relay (Plan 06-02,
      // T-06-01 mitigation). SessionClient is a wire-to-event forwarder;
      // it does not re-validate fields.

      case 'review-opened':
        this.emit('review-opened', { review: msg.review });
        break;

      case 'review-comment':
        this.emit('review-comment', {
          reviewId: msg.reviewId,
          comment: msg.comment,
        });
        break;

      case 'review-vote':
        this.emit('review-vote', {
          reviewId: msg.reviewId,
          vote: msg.vote,
        });
        break;

      case 'review-resolved':
        this.emit('review-resolved', {
          reviewId: msg.reviewId,
          resolvedBy: msg.resolvedBy,
          resolvedReason: msg.resolvedReason,
        });
        break;

      case 'review-state-sync':
        this.emit('review-state-sync', {
          branch: msg.branch,
          reviews: msg.reviews,
        });
        break;

      default:
        // Unknown message types are silently ignored
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  private startClientHeartbeat(): void {
    // The 'pong' handler is wired ONCE in connect() (via
    // transport.onPong → heartbeat.receivedPong) so reconnects don't
    // accumulate listeners. Here we only start the send-ping interval.
    this.heartbeat.start(
      () => {
        // Send a native ping; transport routes through ws.ping() internally
        // when open (no-op otherwise).
        this.transport.ping();
      },
      () => {
        // Dead connection detected -- trigger reconnect by closing the
        // underlying socket. The transport's onClose handler will fire,
        // and (since intentionalClose stays false) attemptReconnect() will
        // run.
        this.transport.close();
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Reconnection (D-11: auto-reconnect with exponential backoff)
  // ---------------------------------------------------------------------------

  private attemptReconnect(): void {
    this.connectionState.transition('reconnecting');
    this.emit('connection-changed', { status: 'reconnecting' });

    this.reconnect.scheduleReconnect(
      async () => {
        return this.connect();
      },
      () => {
        // All attempts exhausted
        this.connectionState.transition('disconnected');
        this.emit('connection-changed', {
          status: 'disconnected',
          error: 'Reconnection failed after maximum attempts',
        });
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Gracefully disconnect from the session. */
  disconnect(): void {
    this.reconnect.abort();
    this.disconnectInternal();
  }

  /** Get the list of current session members. */
  getMembers(): Member[] {
    return [...this.members];
  }

  /** Get the current connection status. */
  getConnectionStatus(): ConnectionStatus {
    return this.connectionState.current;
  }

  /** Get session info received from the host. */
  getSessionInfo(): SessionInfo | null {
    return this.sessionInfo;
  }

  /** Get the server-assigned member ID (null if not yet authenticated). */
  getMemberId(): string | null {
    return this.memberId;
  }

  /**
   * Send a protocol message to the host. No-op when the WebSocket is closed
   * or not yet open; callers should listen for connection-changed before
   * relying on delivery.
   */
  sendMessage(msg: ProtocolMessage): void {
    // Transport.send is internally null-safe / OPEN-guarded — no-op when
    // the underlying socket is not OPEN (mirrors the pre-refactor
    // `if (this.ws && this.ws.readyState === WebSocket.OPEN)` posture).
    this.transport.send(msg);
  }

  /** Clean up all resources. */
  dispose(): void {
    this.disconnect();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Close the transport and transition to disconnected without triggering
   * reconnect. Phase 7 D-05: pre-refactor used `this.ws = null` as the
   * "intentional close" sentinel; after the refactor the
   * `intentionalClose` flag plays the same role — set true BEFORE
   * `transport.close()` so the close-handler short-circuits and does NOT
   * dispatch attemptReconnect().
   */
  private disconnectInternal(): void {
    this.heartbeat.stop();

    // Flip the sentinel BEFORE close to mirror the pre-refactor ordering
    // (`this.ws = null` BEFORE `ws.close()` at line 550-551 pre-refactor).
    this.intentionalClose = true;
    this.transport.close(1000, 'Client disconnected');

    this.connectionState.transition('disconnected');
    this.emit('connection-changed', { status: 'disconnected' });
  }
}
