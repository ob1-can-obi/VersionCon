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
import { ChatLog } from '../filesystem/ChatLog.js';
import { PresenceMap } from '../filesystem/PresenceMap.js';
import type {
  ChatRecord,
  PresenceInfo,
  SystemEventSubKind,
} from '../types/chat.js';

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

  /**
   * Phase 4: Chat persistence for the active branch. Set by extension.ts via
   * setChatLog when the active branch resolves on session start AND on every
   * branch switch. Null until wired — the chat-message handler tolerates this.
   */
  private chatLog: ChatLog | null = null;

  /**
   * Phase 4: Active branch name paired with chatLog. Stamped onto outbound
   * chat-history messages (Plan 04-04 Task 3) so joining members know which
   * branch the replay belongs to. Null until setChatLog is called.
   */
  private activeBranch: string | null = null;

  /**
   * Phase 4: Presence map — memberId -> PresenceInfo. Cleared per-member on
   * member-left (mirrors memberTracking lifecycle). Owned by the host as the
   * single source of truth; clients keep their own derivation via
   * SessionClient `presence-update` events.
   */
  private presenceMap = new PresenceMap();

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

    ws.on('message', async (raw: Buffer | ArrayBuffer | Buffer[]) => {
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
        } else if (msg.type === 'chat-message') {
          // CR-03: host-side validation of body / recordId. The 64 KiB cap also
          // exists in ChatPanel.handleMessage (Plan 04-10) but a malicious or
          // modified client can bypass the panel and write the wire directly,
          // so the host MUST defend in depth. Drop silently — same posture as
          // parseMessage returning null. No error response.
          if (typeof msg.body !== 'string' || msg.body.length === 0 || msg.body.length > 65536) return;
          if (typeof msg.recordId !== 'string' || msg.recordId.length === 0 || msg.recordId.length > 128) return;

          // T-04-04-01: trust the ws-bound memberId captured at auth time,
          // NEVER the client-claimed msg.memberId field. This is the chat-
          // impersonation gate — failure here lets any member spoof another.
          // T-04-04-02: stamp host-arrival timestamp; chat ordering is the
          // host's event-loop order, not the client clock (which may drift).
          const cm = this.members.get(memberId);
          const displayName = cm?.member.displayName ?? msg.memberDisplayName;
          const stampedTs = createTimestamp();
          // CR-01 (T-04-13-01): client-authored chat-message frames are ALWAYS
          // user kind. System events are produced by host-internal paths only
          // (handleLocalChatMessage in Plan 04-04, broadcastPush/Revert/BranchCreated
          // in Plan 04-12). Coerce kind/subKind/meta defensively so a malicious
          // member cannot forge push/branch-created activity events that
          // persist to chat-log.json and replay on every future join.
          const sanitized: ProtocolMessage = {
            ...msg,
            kind: 'user',
            subKind: undefined,
            meta: undefined,
            memberId,
            memberDisplayName: displayName,
            timestamp: stampedTs,
          };
          // Persist BEFORE broadcast — chat-log is the source of truth for
          // future joiners' chat-history replay (Plan 04-04 Task 3).
          if (this.chatLog) {
            const record: ChatRecord = {
              id: sanitized.recordId,
              kind: sanitized.kind,            // always 'user' on this path (CR-01)
              memberId,
              memberDisplayName: displayName,
              body: sanitized.body,
              timestamp: stampedTs,
            };
            try {
              await this.chatLog.append(record);
            } catch (err) {
              console.error('[SessionHost] chat-log append failed', err);
              // Continue — broadcast still proceeds so live chat keeps working
              // even if disk write transiently fails.
            }
          }
          // Broadcast to ALL members (no exclude) — sender sees own message
          // after host echo, per RESEARCH Open Q #1.
          this.broadcast(sanitized);
        } else if (msg.type === 'presence-update') {
          // T-04-04-01: server-trusted memberId override (same policy as
          // chat-message). T-04-04-02: stamp host-arrival timestamp.
          const cm = this.members.get(memberId);
          const displayName = cm?.member.displayName ?? msg.displayName;
          const stampedTs = createTimestamp();
          const sanitized: ProtocolMessage = {
            ...msg,
            memberId,
            displayName,
            timestamp: stampedTs,
          };
          const info: PresenceInfo = {
            memberId,
            displayName,
            branch: msg.branch,
            activeFilePath: msg.activeFilePath,
            lastUpdated: stampedTs,
          };
          this.presenceMap.upsert(info);
          // Exclude sender — they already know their own active editor.
          this.broadcast(sanitized, memberId);
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

    // Phase 4 (Plan 04-04): replay last 100 chat records to the new joiner so
    // their chat panel populates immediately. Per RESEARCH Open Q #2 the order
    // is auth-response → state-sync → chat-history. Fire-and-forget: a
    // chat-history failure does not block auth (the method itself logs and
    // swallows). No-op when setChatLog has not yet wired the active branch.
    if (this.chatLog && this.activeBranch) {
      void this.sendChatHistoryToMember(newMemberId, this.activeBranch);
    }

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
  // Phase 4: Chat + Presence public API (Plan 04-04)
  // ---------------------------------------------------------------------------

  /**
   * Wire the active-branch ChatLog reference so the chat-message handler can
   * persist arriving messages and sendChatHistoryToMember can replay them.
   * Called by extension.ts after the active branch resolves on session start
   * AND on every branch switch. Stamps the activeBranch field used by
   * sendChatHistoryToMember (Task 3) so chat-history messages carry the
   * correct branch label.
   */
  setChatLog(chatLog: ChatLog, branchName: string): void {
    this.chatLog = chatLog;
    this.activeBranch = branchName;
  }

  /**
   * Upsert the host's own presence slot. Called by extension.ts when the
   * host's onDidChangeActiveTextEditor fires. Mirror of the path the host
   * takes for remote presence-update messages, but the host does NOT send
   * presence-update messages over the wire to itself; extension.ts calls
   * this directly. Broadcasts to all OTHER members so they see the host's
   * editor position.
   */
  upsertHostPresence(info: PresenceInfo): void {
    this.presenceMap.upsert(info);
    // Broadcast to ALL connected members (host's own presence is news to
    // every connected client). No exclude — there is no ws to skip on the
    // host side; host is not a connected member from the broadcast's
    // perspective.
    this.broadcast({
      type: 'presence-update',
      timestamp: createTimestamp(),
      memberId: info.memberId,
      displayName: info.displayName,
      branch: info.branch,
      activeFilePath: info.activeFilePath,
    });
  }

  /** Returns a defensive copy of all known presence entries (Plan 04-08). */
  getPresenceSnapshot(): PresenceInfo[] {
    return this.presenceMap.getSnapshot();
  }

  /**
   * Broadcast a chat-cleared message to all connected members. Called by
   * Plan 04-11 (manage-chat QuickPick) AFTER the host runs the local
   * `chatLog.clearAll()` — this method does NOT mutate disk. Receiving
   * clients clear their panel and show a toast (UI-SPEC §7.3).
   */
  broadcastChatCleared(hostMemberId: string, hostDisplayName: string): void {
    this.broadcast({
      type: 'chat-cleared',
      timestamp: createTimestamp(),
      hostMemberId,
      hostDisplayName,
    });
  }

  /**
   * Broadcast a chat-truncated message to all connected members. Called by
   * Plan 04-11 (manage-chat QuickPick) AFTER the host runs the local
   * `chatLog.truncateKeepLast100PlusActivity()` or
   * `chatLog.truncateActivityOnly()`. mode discriminates the two flows
   * for client-side toast copy.
   */
  broadcastChatTruncated(
    mode: 'keep-100-and-activity' | 'activity-only',
    hostMemberId: string,
    hostDisplayName: string,
  ): void {
    this.broadcast({
      type: 'chat-truncated',
      timestamp: createTimestamp(),
      mode,
      hostMemberId,
      hostDisplayName,
    });
  }

  /**
   * Send the last 100 chat-log records to a specific member as a chat-history
   * message. Used during the auth handshake (after state-sync) so a joining
   * member's chat panel populates with history. Per RESEARCH Open Q #2:
   * order is auth-response → state-sync → chat-history.
   *
   * Fire-and-forget: failure is logged but does not propagate so the auth
   * handshake never blocks on a chat-history send.
   */
  async sendChatHistoryToMember(memberId: string, branch: string): Promise<void> {
    if (!this.chatLog) {
      return;
    }
    const cm = this.members.get(memberId);
    if (!cm || cm.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const records = this.chatLog.getRecent(100);
    try {
      sendMessage((d) => cm.ws.send(d), {
        type: 'chat-history',
        timestamp: createTimestamp(),
        branch,
        records,
      });
    } catch (err) {
      console.error('[SessionHost] sendChatHistoryToMember failed', err);
    }
  }

  /**
   * Local chat-message path used by Plan 04-10 (chat panel) when the HOST
   * is the user composing a message. Re-uses the SAME chatLog.append +
   * broadcast path as the wire handler so the host's own messages are
   * persisted and fanned out identically to remote messages — single
   * source of truth for persistence and fan-out.
   *
   * The caller (extension.ts) supplies recordId/kind/body/meta; this method
   * stamps a host-arrival timestamp and uses the host's own memberId +
   * displayName (resolved from hostMemberId / hostDisplayName).
   *
   * Plan 04-10 Task 4 calls this from extension.ts via
   * `activeHost.handleLocalChatMessage(msg)` — ownership of this method
   * lives here in Plan 04-04 because the persistence path lives here.
   */
  async handleLocalChatMessage(msg: {
    recordId: string;
    kind: 'user' | 'system';
    subKind?: SystemEventSubKind;
    body: string;
    meta?: { pushId?: string; branch?: string; files?: string[] };
  }): Promise<void> {
    const stampedTs = createTimestamp();
    // Use the host's authenticated id + displayName. If the host has not
    // yet authenticated as a member (hostMemberId still null), fall back to
    // a stable host marker so persistence/broadcast still proceed — the
    // host process is the trusted source whether or not it has self-auth'd.
    const memberId = this.hostMemberId ?? 'host';
    const displayName = this.hostDisplayName;
    if (this.chatLog) {
      const record: ChatRecord = {
        id: msg.recordId,
        kind: msg.kind,
        ...(msg.subKind !== undefined ? { subKind: msg.subKind } : {}),
        memberId,
        memberDisplayName: displayName,
        body: msg.body,
        timestamp: stampedTs,
        ...(msg.meta !== undefined ? { meta: msg.meta } : {}),
      };
      try {
        await this.chatLog.append(record);
      } catch (err) {
        console.error('[SessionHost] handleLocalChatMessage append failed', err);
      }
    }
    // Broadcast to ALL connected members (no exclude). Remote clients can't
    // distinguish a host-local message from any other chat-message; the
    // record shape is identical.
    this.broadcast({
      type: 'chat-message',
      timestamp: stampedTs,
      recordId: msg.recordId,
      kind: msg.kind,
      ...(msg.subKind !== undefined ? { subKind: msg.subKind } : {}),
      memberId,
      memberDisplayName: displayName,
      body: msg.body,
      ...(msg.meta !== undefined ? { meta: msg.meta } : {}),
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
    // Phase 4: clear presence so the departed member disappears from clients'
    // presence panels via the existing member-left broadcast cycle.
    this.presenceMap.removeMember(memberId);

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
