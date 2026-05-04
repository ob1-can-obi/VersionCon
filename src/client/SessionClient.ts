import { WebSocket } from 'ws';
import { ConnectionStateMachine } from './ConnectionState.js';
import { HeartbeatManager, ReconnectManager } from '../network/heartbeat.js';
import {
  parseMessage,
  sendMessage,
  createTimestamp,
} from '../network/protocol.js';
import type { ProtocolMessage } from '../network/protocol.js';
import type { Member, ConnectionStatus } from '../types/session.js';
import type {
  SessionEventEmitter,
  SessionEvent,
  SessionEventMap,
} from '../types/events.js';

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
  private ws: WebSocket | null = null;
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

  constructor(
    hostIp: string,
    port: number,
    inviteCode: string,
    displayName: string,
  ) {
    this.hostIp = hostIp;
    this.port = port;
    this.inviteCode = inviteCode;
    this.displayName = displayName;
    this.connectionState = new ConnectionStateMachine();
    this.heartbeat = new HeartbeatManager();
    this.reconnect = new ReconnectManager();
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
   */
  async connect(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let resolved = false;

      try {
        this.ws = new WebSocket(`ws://${this.hostIp}:${this.port}`);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws.on('open', () => {
        // Send auth-request as the first message
        if (this.ws) {
          sendMessage((d) => this.ws!.send(d), {
            type: 'auth-request',
            inviteCode: this.inviteCode,
            displayName: this.displayName,
            timestamp: createTimestamp(),
          });
        }
      });

      this.ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const data = raw.toString();
          const msg = parseMessage(data);
          if (!msg) {
            return; // Malformed message -- drop silently
          }

          this.handleMessage(msg, (success) => {
            if (!resolved) {
              resolved = true;
              resolve(success);
            }
          });
        } catch {
          // Message handling errors should not crash the client
        }
      });

      this.ws.on('close', (_code: number, _reason: Buffer) => {
        this.heartbeat.stop();

        if (!resolved) {
          // Connection closed before auth completed
          resolved = true;
          resolve(false);
          return;
        }

        // If we were connected, try to reconnect (D-11)
        if (this.connectionState.current === 'connected') {
          this.attemptReconnect();
        }
      });

      this.ws.on('error', () => {
        // Error will be followed by close -- handle reconnect there
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
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
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          sendMessage((d) => this.ws!.send(d), {
            type: 'heartbeat-pong',
            timestamp: createTimestamp(),
          });
        }
        break;

      case 'error':
        // Log and emit -- do not crash
        this.emit('connection-changed', {
          status: this.connectionState.current,
          error: msg.message,
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
    this.heartbeat.start(
      () => {
        // Send a heartbeat-ping to the server
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          sendMessage((d) => this.ws!.send(d), {
            type: 'heartbeat-ping',
            timestamp: createTimestamp(),
          });
        }
      },
      () => {
        // Dead connection detected -- trigger reconnect
        if (this.ws) {
          this.ws.close();
        }
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

  /** Clean up all resources. */
  dispose(): void {
    this.disconnect();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Close the WebSocket and transition to disconnected without triggering reconnect. */
  private disconnectInternal(): void {
    this.heartbeat.stop();

    const ws = this.ws;
    this.ws = null; // Prevent close handler from triggering reconnect

    if (ws) {
      try {
        ws.close(1000, 'Client disconnected');
      } catch {
        // Already closed
      }
    }

    this.connectionState.transition('disconnected');
    this.emit('connection-changed', { status: 'disconnected' });
  }
}
