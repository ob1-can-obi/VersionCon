import { createServer } from 'net';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { AuthHandler } from './AuthHandler.js';
import { BandwidthMonitor } from './BandwidthMonitor.js';
import {
  parseMessage,
  sendMessage,
  createTimestamp,
} from '../network/protocol.js';
import type { ProtocolMessage } from '../network/protocol.js';
import type { Member, SessionConfig } from '../types/session.js';
import type {
  SessionEventEmitter,
  SessionEvent,
  SessionEventMap,
} from '../types/events.js';
import type { PushRecord } from '../types/push.js';
import type { BranchInfo } from '../types/branch.js';

/** Internal tracking for each connected member's WebSocket and status. */
interface ConnectedMember {
  ws: WebSocket;
  member: Member;
  isAlive: boolean;
}

/**
 * WebSocket server that manages a VersionCon session.
 *
 * Handles:
 * - Server lifecycle (start, stop, dispose)
 * - Client authentication via AuthHandler (T-01-03)
 * - Member tracking and broadcasting (member join/leave/kick)
 * - Heartbeat monitoring at 15-second intervals (T-01-04)
 * - Bandwidth tracking via BandwidthMonitor (NET-08, T-01-08)
 * - maxPayload enforcement via ws library (T-01-04)
 * - Admin commands restricted to host role (T-01-06)
 */
export class SessionHost implements SessionEventEmitter {
  private wss: WebSocketServer | null = null;
  private readonly members: Map<string, ConnectedMember> = new Map();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private readonly authHandler: AuthHandler;
  private readonly bandwidthMonitor: BandwidthMonitor;
  private readonly config: SessionConfig;
  private readonly hostDisplayName: string;
  private hostMemberId: string | null = null;

  /**
   * Map of memberId -> tracked file paths. Populated from tracked-paths-update
   * messages and host-side setHostTrackedPaths calls. Drives PUSH-03 file-level
   * affected-member computation.
   */
  private memberTracking = new Map<string, string[]>();

  /**
   * Optional permissions checker for relay validation (T-03-05). When set, the
   * host validates canPushToBranch before relaying push-notification messages.
   */
  private permissions: { canPushToBranch: (memberId: string, branchName: string) => boolean } | null = null;

  /**
   * Optional push history reference. When set, sync-response includes
   * latestPushId so reconnecting clients can seed sync state correctly.
   */
  private pushHistory: { getLatestRecord: () => { id: string } | undefined } | null = null;

  /** Typed event listeners. */
  private readonly listeners: Map<
    SessionEvent,
    Set<(data: never) => void>
  > = new Map();

  constructor(config: SessionConfig, hostDisplayName: string) {
    this.config = config;
    this.hostDisplayName = hostDisplayName;
    this.authHandler = new AuthHandler(config.inviteCode);
    this.bandwidthMonitor = new BandwidthMonitor();
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
          // Listener errors must not crash the host
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Server lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the WebSocket server.
   *
   * If `config.port` is 0, an ephemeral free port is detected first.
   * Returns the actual port the server is listening on.
   */
  async start(): Promise<number> {
    const port = this.config.port === 0
      ? await this.findFreePort()
      : this.config.port;

    return new Promise<number>((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({
          port,
          maxPayload: this.config.maxPayloadBytes,
          perMessageDeflate: false,
        });

        this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
          this.handleConnection(ws, req);
        });

        this.wss.on('listening', () => {
          this.startHeartbeat();
          this.emit('session-created', { config: this.config });
          resolve(port);
        });

        this.wss.on('error', (err: Error) => {
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stop the server gracefully: clear heartbeat, close all connections, shut
   * down the WebSocket server, and emit session-ended.
   */
  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const [, cm] of this.members) {
      try {
        cm.ws.close(1001, 'Session ended');
      } catch {
        // Already closed
      }
    }
    this.members.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.bandwidthMonitor.dispose();
    this.emit('session-ended', { reason: 'Host stopped session' });
  }

  /** Alias for stop(). */
  dispose(): void {
    this.stop();
  }

  // ---------------------------------------------------------------------------
  // Connection handling (T-01-05: all messages validated via parseMessage)
  // ---------------------------------------------------------------------------

  /**
   * Handle a new WebSocket connection.
   *
   * Unauthenticated connections have a 10-second timeout (T-01-04).
   * Once authenticated, messages are routed by type with role checks (T-01-06).
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const clientIp = req.socket.remoteAddress ?? 'unknown';
    let memberId: string | null = null;

    // Auth timeout: close unauthenticated connections after 10 seconds (T-01-04)
    const authTimeout = setTimeout(() => {
      if (!memberId) {
        sendMessage((d) => ws.send(d), {
          type: 'error',
          code: 'AUTH_TIMEOUT',
          message: 'Authentication timeout',
          timestamp: createTimestamp(),
        });
        ws.close(4001, 'Authentication timeout');
      }
    }, 10_000);

    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const data = raw.toString();

        // Track bandwidth for authenticated members
        if (memberId) {
          this.bandwidthMonitor.recordReceived(memberId, Buffer.byteLength(data, 'utf-8'));
        }

        const msg = parseMessage(data);
        if (!msg) {
          return; // Malformed message -- silently drop (T-01-05)
        }

        if (msg.type === 'auth-request') {
          this.handleAuthRequest(ws, msg, clientIp, authTimeout, (id) => {
            memberId = id;
          });
        } else if (!memberId) {
          // No other message type is valid before authentication
          return;
        } else if (msg.type === 'kick-member') {
          this.handleKickRequest(memberId, msg.targetMemberId);
        } else if (msg.type === 'regenerate-invite') {
          this.handleRegenerateInvite(memberId);
        } else if (msg.type === 'heartbeat-pong') {
          const cm = this.members.get(memberId);
          if (cm) {
            cm.isAlive = true;
          }
        } else if (msg.type === 'push-notification') {
          // T-03-05: validate push permission before relaying. The host derives
          // the sender memberId from the authenticated WebSocket connection
          // (memberId, captured in the closure), NOT from the message field --
          // this prevents a malicious client from spoofing another member's id.
          if (this.permissions && !this.permissions.canPushToBranch(memberId, msg.branch)) {
            sendMessage((d) => ws.send(d), {
              type: 'error',
              code: 'PERMISSION_DENIED',
              message: 'No push permission for this branch',
              timestamp: createTimestamp(),
            });
            return;
          }
          this.broadcast(msg, memberId);
        } else if (msg.type === 'push-reverted' ||
                   msg.type === 'branch-created' || msg.type === 'branch-locked' ||
                   msg.type === 'permission-changed') {
          // Admin/allowed actions -- relay to all
          this.broadcast(msg, memberId);
        } else if (msg.type === 'tracked-paths-update') {
          // PUSH-03: member is reporting their current tracked paths.
          // T-03-14: trust the authenticated WebSocket memberId, NOT the
          // message body's memberId field, so a client cannot inject paths
          // for another member.
          this.memberTracking.set(memberId, [...msg.paths]);
          // Metadata only -- do not relay.
        } else if (msg.type === 'sync-request') {
          // PUSH-09 reconnect path: respond with empty files (snapshot is
          // delivered out-of-band) plus the latest push id so the client can
          // seed its sync tracker.
          sendMessage((d) => ws.send(d), {
            type: 'sync-response',
            branch: msg.branch,
            files: [],
            latestPushId: SessionHost.buildLatestPushId(this.pushHistory),
            timestamp: createTimestamp(),
          });
        }
      } catch {
        // Handler errors must not crash the host (T-01-05)
      }
    });

    // Native pong handler for ws ping/pong frames
    ws.on('pong', () => {
      if (memberId) {
        const cm = this.members.get(memberId);
        if (cm) {
          cm.isAlive = true;
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (memberId) {
        this.removeMember(memberId, 'Connection closed');
      }
    });

    ws.on('error', () => {
      // Error will be followed by close event -- handle cleanup there
    });
  }

  // ---------------------------------------------------------------------------
  // Auth (T-01-03: constant-time compare + rate limiting)
  // ---------------------------------------------------------------------------

  private handleAuthRequest(
    ws: WebSocket,
    msg: ProtocolMessage & { type: 'auth-request' },
    clientIp: string,
    authTimeout: ReturnType<typeof setTimeout>,
    setMemberId: (id: string) => void,
  ): void {
    // Check rate limit first
    const rateCheck = this.authHandler.checkRateLimit(clientIp);
    if (!rateCheck.allowed) {
      sendMessage((d) => ws.send(d), {
        type: 'auth-response',
        accepted: false,
        reason: `Rate limited. Try again in ${Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)} seconds.`,
        timestamp: createTimestamp(),
      });
      ws.close(4003, 'Rate limited');
      return;
    }

    // Validate invite code with constant-time comparison
    const valid = this.authHandler.validateInviteCode(msg.inviteCode);
    if (!valid) {
      sendMessage((d) => ws.send(d), {
        type: 'auth-response',
        accepted: false,
        reason: 'Invalid invite code',
        timestamp: createTimestamp(),
      });
      ws.close(4002, 'Invalid invite code');
      return;
    }

    // Auth succeeded -- cancel timeout
    clearTimeout(authTimeout);

    // Assign server-generated member ID (T-01-07)
    const newMemberId = crypto.randomUUID();
    setMemberId(newMemberId);

    // Determine role: first authenticated member is the host
    const role = this.hostMemberId === null ? 'host' as const : 'member' as const;
    if (role === 'host') {
      this.hostMemberId = newMemberId;
    }

    const member: Member = {
      id: newMemberId,
      displayName: msg.displayName,
      role,
      isOnline: true,
      joinedAt: Date.now(),
    };

    this.members.set(newMemberId, { ws, member, isAlive: true });

    // Send auth-response to new member
    sendMessage((d) => ws.send(d), {
      type: 'auth-response',
      accepted: true,
      memberId: newMemberId,
      sessionInfo: {
        name: this.config.sessionName,
        memberCount: this.members.size,
        hostDisplayName: this.hostDisplayName,
      },
      timestamp: createTimestamp(),
    });

    // Send state-sync to the new member with current member list
    const memberList = this.getMembersList();
    sendMessage((d) => ws.send(d), {
      type: 'state-sync',
      sessionName: this.config.sessionName,
      hostDisplayName: this.hostDisplayName,
      members: memberList,
      timestamp: createTimestamp(),
    });

    // Broadcast member-joined to all OTHER members
    this.broadcast(
      {
        type: 'member-joined',
        member: {
          id: member.id,
          displayName: member.displayName,
          role: member.role,
          isOnline: member.isOnline,
          joinedAt: member.joinedAt,
        },
        timestamp: createTimestamp(),
      },
      newMemberId,
    );

    this.emit('member-joined', { member });
  }

  // ---------------------------------------------------------------------------
  // Admin commands (T-01-06: host-role only)
  // ---------------------------------------------------------------------------

  private handleKickRequest(requesterId: string, targetMemberId: string): void {
    // Only the host can kick members
    if (requesterId !== this.hostMemberId) {
      return;
    }

    const target = this.members.get(targetMemberId);
    if (!target) {
      return;
    }

    // Notify the kicked member
    sendMessage((d) => target.ws.send(d), {
      type: 'member-kicked',
      reason: 'Kicked by host',
      timestamp: createTimestamp(),
    });

    target.ws.close(4004, 'Kicked by host');
    // The close event handler will call removeMember
  }

  private handleRegenerateInvite(requesterId: string): void {
    // Only the host can regenerate the invite code
    if (requesterId !== this.hostMemberId) {
      return;
    }

    const newCode = this.authHandler.regenerateCode();

    // Broadcast to all members
    this.broadcast({
      type: 'invite-regenerated',
      newCode,
      timestamp: createTimestamp(),
    });

    this.emit('invite-code-regenerated', { newCode });
  }

  // ---------------------------------------------------------------------------
  // Public admin API
  // ---------------------------------------------------------------------------

  /** Kick a member by ID (host API). */
  kickMember(memberId: string, reason: string): void {
    const target = this.members.get(memberId);
    if (!target) {
      return;
    }

    sendMessage((d) => target.ws.send(d), {
      type: 'member-kicked',
      reason,
      timestamp: createTimestamp(),
    });

    target.ws.close(4004, reason);
  }

  /** Get all current members. */
  getMembers(): Member[] {
    return Array.from(this.members.values()).map((cm) => cm.member);
  }

  /** Get bandwidth stats for all members. */
  getBandwidthStats(): ReturnType<BandwidthMonitor['getAllStats']> {
    return this.bandwidthMonitor.getAllStats();
  }

  /** Regenerate the invite code and broadcast the new code. */
  regenerateInviteCode(): string {
    const newCode = this.authHandler.regenerateCode();
    this.broadcast({
      type: 'invite-regenerated',
      newCode,
      timestamp: createTimestamp(),
    });
    this.emit('invite-code-regenerated', { newCode });
    return newCode;
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Push + Branch broadcasts
  // ---------------------------------------------------------------------------

  /** Broadcast a push notification to all members. */
  broadcastPush(record: PushRecord): void {
    this.broadcast({
      type: 'push-notification',
      pushId: record.id,
      memberId: record.memberId,
      memberDisplayName: record.memberDisplayName,
      message: record.message,
      branch: record.branch,
      files: record.files,
      timestamp: createTimestamp(),
    });
  }

  /** Broadcast a push revert notification to all members. */
  broadcastRevert(record: PushRecord): void {
    this.broadcast({
      type: 'push-reverted',
      pushId: record.id,
      memberId: record.memberId,
      memberDisplayName: record.memberDisplayName,
      branch: record.branch,
      files: record.files.map(f => f.relativePath),
      timestamp: createTimestamp(),
    });
  }

  /** Broadcast a new branch creation. */
  broadcastBranchCreated(branch: BranchInfo): void {
    this.broadcast({
      type: 'branch-created',
      branch,
      timestamp: createTimestamp(),
    });
  }

  /** Broadcast a branch lock/unlock. */
  broadcastBranchLocked(branchName: string, locked: boolean): void {
    this.broadcast({
      type: 'branch-locked',
      branchName,
      locked,
      timestamp: createTimestamp(),
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Member tracking + permission relay + sync handlers
  // ---------------------------------------------------------------------------

  /**
   * Update the host's own tracked paths in the MemberTrackingMap. The host
   * does not send tracked-paths-update messages to itself, so extension.ts
   * calls this directly when the host's WorkspaceTreeProvider fires the
   * onTrackedPathsChanged event.
   */
  setHostTrackedPaths(memberId: string, paths: string[]): void {
    this.memberTracking.set(memberId, [...paths]);
  }

  /**
   * Get a snapshot of the current MemberTrackingMap for affected-member
   * computation (PUSH-03). Returns a copy so callers cannot mutate internal
   * state.
   */
  getMemberTracking(): Map<string, string[]> {
    return new Map(this.memberTracking);
  }

  /** Get a memberId -> displayName map for affected-member labels (PUSH-03). */
  getMemberNames(): Map<string, string> {
    const names = new Map<string, string>();
    for (const m of this.getMembers()) {
      names.set(m.id, m.displayName);
    }
    return names;
  }

  /**
   * Wire a permissions checker so the host can validate canPushToBranch before
   * relaying push-notification messages (T-03-05). Without this wiring, the
   * host relays unconditionally (preserves prior behavior).
   */
  setPermissions(permissions: { canPushToBranch: (memberId: string, branchName: string) => boolean }): void {
    this.permissions = permissions;
  }

  /**
   * Wire a PushHistory reference so sync-response includes latestPushId
   * (PUSH-09 reconnect path). Without this wiring, latestPushId is null.
   */
  setPushHistory(history: { getLatestRecord: () => { id: string } | undefined }): void {
    this.pushHistory = history;
  }

  /**
   * Pure-logic helper: derive the latestPushId field for a SyncResponse from
   * the optional push-history reference. Exposed for unit testing.
   */
  static buildLatestPushId(pushHistory: { getLatestRecord: () => { id: string } | undefined } | null): string | null {
    return pushHistory?.getLatestRecord()?.id ?? null;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Broadcast a message to all authenticated members, optionally excluding one. */
  private broadcast(msg: ProtocolMessage, excludeId?: string): void {
    for (const [id, cm] of this.members) {
      if (id === excludeId) {
        continue;
      }
      if (cm.ws.readyState === WebSocket.OPEN) {
        try {
          const data = JSON.stringify(msg);
          cm.ws.send(data);
          this.bandwidthMonitor.recordSent(id, Buffer.byteLength(data, 'utf-8'));
        } catch {
          // Send failure -- will be caught by close handler
        }
      }
    }
  }

  /**
   * Start the heartbeat interval (15 seconds).
   *
   * Each cycle: terminate members that failed to respond to the previous ping,
   * then mark all members as not-alive and send a new ping.
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const [id, cm] of this.members) {
        if (!cm.isAlive) {
          // Member missed the heartbeat -- terminate
          cm.ws.terminate();
          this.removeMember(id, 'Heartbeat timeout');
          continue;
        }
        cm.isAlive = false;
        try {
          cm.ws.ping();
        } catch {
          // Ping failure -- will be cleaned up next cycle
        }
      }
    }, 15000);
  }

  /** Remove a member from tracking and broadcast their departure. */
  private removeMember(memberId: string, reason: string): void {
    const cm = this.members.get(memberId);
    if (!cm) {
      return;
    }

    this.members.delete(memberId);
    this.bandwidthMonitor.removeMember(memberId);
    this.memberTracking.delete(memberId);

    // If the host left, clear the host tracking
    if (memberId === this.hostMemberId) {
      this.hostMemberId = null;
    }

    // Broadcast member-left to remaining members
    this.broadcast({
      type: 'member-left',
      memberId,
      reason,
      timestamp: createTimestamp(),
    });

    this.emit('member-left', { memberId, reason });
  }

  /** Build a serialisable member list for state-sync / member-list messages. */
  private getMembersList(): Array<{
    id: string;
    displayName: string;
    role: string;
    isOnline: boolean;
    joinedAt: number;
  }> {
    return Array.from(this.members.values()).map((cm) => ({
      id: cm.member.id,
      displayName: cm.member.displayName,
      role: cm.member.role,
      isOnline: cm.member.isOnline,
      joinedAt: cm.member.joinedAt,
    }));
  }

  /** Find a free port by briefly creating a TCP server on port 0. */
  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.listen(0, () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          const port = addr.port;
          srv.close(() => resolve(port));
        } else {
          srv.close(() => reject(new Error('Could not determine free port')));
        }
      });
      srv.on('error', reject);
    });
  }
}
