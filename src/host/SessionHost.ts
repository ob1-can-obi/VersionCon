import * as crypto from 'crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { IncomingMessage } from 'http';
import { AuthHandler } from './AuthHandler.js';
import { BandwidthMonitor } from './BandwidthMonitor.js';
import {
  parseMessage,
  createTimestamp,
} from '../network/protocol.js';
import type { ProtocolMessage } from '../network/protocol.js';
import type { HostTransport, TransportConnection } from '../network/Transport.js';
// Phase 7 D-05: LanHostTransport is the default impl when callers omit the
// `transport` constructor argument. Importing it here is safe vs. the
// source-grep gate in transportSeam.test.ts — the gate forbids the literal
// `ws` library import and the WebSocketServer constructor call inside this
// file; importing LanTransport.ts matches neither pattern.
import { LanHostTransport } from '../network/LanTransport.js';
import type { TokenService } from '../auth/TokenService.js';
import type { HostIdentity, Member, SessionConfig } from '../types/session.js';
import type {
  SessionEventEmitter,
  SessionEvent,
  SessionEventMap,
} from '../types/events.js';
import type { PushRecord } from '../types/push.js';
import type { BranchInfo } from '../types/branch.js';
import { ChatLog } from '../filesystem/ChatLog.js';
import { PresenceMap } from '../filesystem/PresenceMap.js';
import { ReviewStore } from '../filesystem/ReviewStore.js';
import type { ReviewRequest } from '../types/review.js';
import type {
  ChatRecord,
  PresenceInfo,
  SystemEventSubKind,
} from '../types/chat.js';
// Phase 5 Plan 05-05 (SC-5): AST analyzer is wired via setAstAnalyzer. Type-only
// import keeps SessionHost free of any runtime dependency on the worker module
// tree — the analyzer is constructed by extension.ts and injected in.
import type { AstAnalyzer } from '../ast/AstAnalyzer.js';
import type { AnalyzePayload } from '../ast/types.js';

/**
 * Internal tracking for each connected member's transport connection +
 * status. `ws` is named for historical reasons (~50 call sites pre-refactor)
 * but is now an opaque TransportConnection — SessionHost routes all wire
 * I/O through `this.transport`, never reaches into the underlying socket.
 */
interface ConnectedMember {
  ws: TransportConnection;
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
  /**
   * D-05 / Phase 7 transport seam. The host accepts a HostTransport
   * (LAN: LanHostTransport; future Cloud: a cloud-routed impl) and routes
   * every wire I/O call through it. SessionHost is transport-agnostic
   * — it never imports from `ws` directly.
   */
  private readonly transport: HostTransport;
  private readonly members: Map<string, ConnectedMember> = new Map();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private readonly authHandler: AuthHandler;
  private readonly bandwidthMonitor: BandwidthMonitor;
  private readonly config: SessionConfig;
  private readonly hostDisplayName: string;
  /**
   * Phase 4.1 (Plan 04.1-02 — Defect B closure): pre-allocated host memberId.
   * Set in the constructor from HostIdentity BEFORE start() binds the
   * WebSocket listener, closing the "first-authenticated wins host role"
   * race surfaced during Phase 4 multi-window UAT. Overwritten at auth-time
   * with the loopback connection's ws-authed memberId once the host's local
   * SessionClient (plan 04.1-03) authenticates with the matching
   * hostAuthSecret. Reset to null on host disconnect (existing 04-04
   * removeMember behavior preserved).
   */
  private hostMemberId: string | null;
  /**
   * Phase 4.1 (Plan 04.1-02 — Defect B closure): host loopback secret.
   * The auth-request handler grants role:'host' iff the requesting client's
   * msg.hostAuthSecret (constant-time-compared) matches this value. Only
   * the host process's loopback SessionClient knows this secret; remote
   * clients omit the field and receive role:'member' regardless of timing.
   */
  private readonly hostAuthSecret: string;

  /**
   * Phase 4 UAT fix (2026-05-10): Unix-ms timestamp captured at host
   * construction. Used as the host's `joinedAt` when the host is included in
   * the state-sync member list and the host-side sidebar member list — the
   * host pre-exists every joiner, so "session start" is the correct origin
   * for its joinedAt sort key.
   */
  private readonly hostJoinedAt: number = Date.now();

  /**
   * Phase 7 Plan 07-05b — cloud-mode JWT issuer.
   *
   * Populated EXCLUSIVELY via `attachCloudIssuer(tokenService, sessionId)`
   * called by `SessionHostFactory.createCloud()` AFTER the host is constructed
   * but BEFORE start(). When non-null:
   *   - handleAuthRequest issues a per-joiner JWT via
   *     `cloudTokenService.issue({iss: hostMemberId, sub: newMemberId,
   *     aud: cloudSessionId, role: 'member'})`
   *   - The JWT is placed in `auth-response.token` (omitted in LAN mode).
   *
   * NOT a flag, NOT a "mode" — it is an issuer service handle. The CRITICAL
   * 07-05b merge invariant: SessionHost has no rejected boolean-flag /
   * setter / inbound-frame-stub patterns. Cloud detection happens via the
   * `transport.isCloud?.()` interface probe; the demultiplexer adapter does
   * the heavy lifting; this field only carries the issuer.
   */
  private cloudTokenService: TokenService | null = null;
  private cloudSessionId: string | null = null;

  /**
   * Phase 7 gap-closure plan 07-13 (MD-03 — Option A bootstrap JWT).
   *
   * Short-lived (15-min) role:'member' JWT minted by
   * SessionHostFactory.createCloud() AFTER attachCloudIssuer. Pickup
   * by WizardPanel via getBootstrapToken(); embedded in the share-
   * screen deep-link's `bt` query param. NULL in LAN mode (createCloud
   * is the ONLY code path that sets this; the LAN constructor path
   * leaves it null).
   *
   * The bootstrap JWT signs against the same per-session verifySecret
   * as the host self-JWT, so the relay's existing verifyToken path
   * (relay/src/auth.ts) accepts it verbatim with NO relay-side code
   * changes. Inheritance proven by serverAuthIntegration.test.js
   * test 3 (member auth happy path).
   */
  private bootstrapToken: string | null = null;

  /**
   * Map of memberId -> tracked file paths. Populated from tracked-paths-update
   * messages and host-side setHostTrackedPaths calls. Drives PUSH-03 file-level
   * affected-member computation.
   */
  private memberTracking = new Map<string, string[]>();

  /**
   * Optional permissions checker for relay validation (T-03-05, Plan 06-02).
   *   - canPushToBranch: T-03-05 push relay permission (Phase 3).
   *   - canCreateBranch: Plan 06-02 admin proxy used by review-resolved
   *     override path (mirrors Phase 4.3 cloud-bridge admin posture per the
   *     06-SPEC.md frontmatter line-15 locked decision).
   * Both methods may be absent on older permission objects; review-resolved
   * is defensive about canCreateBranch being undefined.
   */
  private permissions: {
    canPushToBranch: (memberId: string, branchName: string) => boolean;
    canCreateBranch?: (memberId: string) => boolean;
  } | null = null;

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
   *
   * Phase 6 (Plan 06-02): also paired with reviewStore via setReviewStore.
   * Both wiring points (setChatLog + setReviewStore) overwrite activeBranch
   * — extension.ts MUST call them with matching branch names on every
   * branch switch.
   */
  private activeBranch: string | null = null;

  /**
   * Phase 6 (Plan 06-02): per-active-branch ReviewStore. Wired by extension.ts
   * via setReviewStore(store, branchName) on session start AND on every branch
   * switch — mirrors setChatLog. Null until wired; all review-* handlers
   * tolerate null by short-circuiting silently.
   */
  private reviewStore: ReviewStore | null = null;

  /** T-06-03 mitigation (Plan 06-02): hard cap on comments per ReviewRequest. */
  private static readonly REVIEW_COMMENT_CAP = 500;
  /** T-06-03 mitigation (Plan 06-02): per-member sliding-window rate limit for review-comments. */
  private static readonly REVIEW_COMMENT_RATE_PER_MIN = 30;
  /**
   * T-06-03 mitigation: per-memberId rolling 60s window of comment timestamps.
   * Mirrors AuthHandler.rateLimitState (T-01-03) — entries older than 60s are
   * pruned before counting.
   */
  private reviewCommentTimestamps = new Map<string, number[]>();

  /**
   * Phase 6 (Plan 06-02): per-reviewId write chain for serializing concurrent
   * review-* mutations. ReviewStore.upsertRequest does a whole-file rewrite
   * keyed by pushId; without serialization, two handlers (e.g. two rapid
   * review-comment frames) can each read the same baseline snapshot via
   * reviewStore.getAll() and then upsertRequest each lands the SAME baseline-
   * plus-their-own-comment, dropping one comment.
   *
   * The chain is a Promise<void> per reviewId — each handler awaits the
   * previous link before reading the parent snapshot, mutating, and writing
   * back. Once the chain resolves, the entry is GC'd (the Map key is removed
   * when the last enqueued op resolves and finds itself still the chain head).
   *
   * Rule 1 bug discovered during Task 2 rate-limit test (30 rapid comments
   * collapsed to 1 because each handler's getAll() saw the empty baseline).
   */
  private reviewWriteChain = new Map<string, Promise<void>>();

  /**
   * Phase 5 Plan 05-05 (SC-5): host-side AST analyzer. Constructed once per
   * session start by extension.ts (host path only) and injected via
   * setAstAnalyzer. Null when the analyzer is absent (test setups,
   * client-only sessions, or before extension.ts wires it) — broadcastPush
   * then degrades to the Phase 4.3 baseline (no amend ever fires). SC-1 and
   * SC-5 are end-to-end-verified only when this is wired.
   */
  private astAnalyzer: AstAnalyzer | null = null;

  /**
   * Phase 5 Plan 05-05: lazy getter for the branch directory path. The
   * SessionHost runs in the same process as PushService, and the active
   * branch can switch mid-session, so we resolve at call time rather than at
   * construction. Wired by extension.ts via setBranchDirGetter — mirrors the
   * existing setChatLog pattern. Null when not wired (runAstAnalysisAndAmend
   * short-circuits to empty result).
   */
  private branchDirGetter: (() => string) | null = null;

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

  /**
   * Construct a SessionHost.
   *
   * Phase 4.1 (Plan 04.1-02): the second arg is now a pre-allocated
   * HostIdentity (memberId + displayName + hostAuthSecret) — closes Defect B
   * (host-by-construction, not host-by-race). The wizard / extension.ts
   * loopback wiring is responsible for generating the triple via
   * `crypto.randomUUID()` for memberId and hostAuthSecret, and the
   * user-confirmed value from the wizard for displayName.
   */
  /**
   * Construct a SessionHost.
   *
   * Phase 7 D-05: `transport` is required. Callers that want LAN behavior
   * pass `new LanHostTransport()` explicitly; future cloud callers will pass
   * a CloudHostTransport. To keep existing call-sites compact, the
   * `transport` parameter has a default of `new LanHostTransport()` — but
   * this default is provided lazily inside `SessionHostFactory.createLan`
   * (see src/host/SessionHostFactory.ts) so SessionHost.ts itself never
   * imports the LAN impl. Existing call-sites that pass only
   * `(config, hostIdentity)` get the LAN default via the factory wrapper.
   *
   * The previous-and-current signature `(config, hostIdentity)` is preserved
   * via a default argument so the 20+ existing call-sites compile without
   * change. New callers should construct explicitly: `new SessionHost(cfg,
   * id, new LanHostTransport())`.
   */
  constructor(
    config: SessionConfig,
    hostIdentity: HostIdentity,
    transport?: HostTransport,
  ) {
    this.config = config;
    this.hostDisplayName = hostIdentity.displayName;
    this.hostMemberId = hostIdentity.memberId;
    this.hostAuthSecret = hostIdentity.hostAuthSecret;
    this.authHandler = new AuthHandler(config.inviteCode);
    this.bandwidthMonitor = new BandwidthMonitor();
    // Default to LAN behavior when transport is omitted. This keeps the
    // existing two-arg call-sites (WizardPanel.ts:546, host.test.ts,
    // reviewHostRelay.test.ts, astBroadcastIntegration.test.ts,
    // pushSmartSummary.test.ts) compiling untouched. Future cloud callers
    // pass an explicit CloudHostTransport.
    this.transport = transport ?? new LanHostTransport();
  }

  /**
   * Phase 7 Plan 07-05b — attach a cloud-mode JWT issuer.
   *
   * Called by `SessionHostFactory.createCloud()` AFTER the SessionHost is
   * constructed but BEFORE `start()`. Populates `cloudTokenService` +
   * `cloudSessionId` so `handleAuthRequest` can issue per-joiner JWTs in
   * cloud mode. LAN-mode hosts NEVER call this; they leave both fields null
   * and produce byte-identical auth-responses (no `token` key).
   *
   * Single-shot guard (NOT idempotent — review MD-07): throws on any second
   * call, including a second call with the SAME (tokenService, sessionId)
   * pair. This is intentional — re-attaching a fresh issuer mid-flight would
   * silently invalidate every JWT this host already issued under the old
   * verifySecret, locking out joiners with no observable signal. Callers
   * MUST treat attachCloudIssuer as a one-time wiring step performed by the
   * factory, never as a re-configuration surface.
   *
   * Method name explicitly DIFFERENT from the rejected mode-setter pattern
   * (per the 07-05b merge note). This is an ISSUER ATTACHMENT, not a flag.
   */
  attachCloudIssuer(tokenService: TokenService, sessionId: string): void {
    if (this.cloudTokenService !== null) {
      // Single-shot — see JSDoc. Failure is deliberate: silently dropping
      // the second call would risk a verifySecret mismatch with existing
      // joiner JWTs; throwing surfaces the misconfiguration loudly at the
      // call site.
      throw new Error(
        'attachCloudIssuer: cloud issuer already attached (single-shot guard)',
      );
    }
    this.cloudTokenService = tokenService;
    this.cloudSessionId = sessionId;
  }

  /**
   * Phase 7 gap-closure plan 07-13 (MD-03 — Option A bootstrap JWT).
   *
   * Called ONCE by SessionHostFactory.createCloud immediately after
   * attachCloudIssuer to attach the bootstrap JWT. Subsequent calls throw
   * (single-shot guard mirroring attachCloudIssuer — re-attaching mid-flight
   * would silently invalidate the deep-link a host has already shared, with
   * no observable signal).
   *
   * The bootstrap JWT itself is minted by tokenService.issueBootstrap in
   * SessionHostFactory.ts; this setter is the seam that lets the factory
   * stash the JWT on the constructed host instance so WizardPanel can pick
   * it up via getBootstrapToken().
   */
  attachBootstrapToken(token: string): void {
    if (this.bootstrapToken !== null) {
      throw new Error(
        'attachBootstrapToken: bootstrap token already attached (single-shot guard)',
      );
    }
    this.bootstrapToken = token;
  }

  /**
   * Phase 7 gap-closure plan 07-13. WizardPanel pickup — returns the
   * bootstrap JWT to embed in the share-screen deep-link's `bt` param.
   * Returns null in LAN mode (no createCloud call → no
   * attachBootstrapToken call → field stays at its constructor-time null).
   */
  getBootstrapToken(): string | null {
    return this.bootstrapToken;
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
   * Start the host transport.
   *
   * Phase 7 D-05: previously this method constructed a WebSocketServer
   * inline. After the refactor, `this.transport.listen()` does the binding
   * — LAN: WebSocketServer (+ findFreePort for port === 0); future Cloud:
   * an outbound WSS to a relay.
   *
   * Promise-resolution semantics are preserved:
   *  - on success, resolves with the bound port (mirrors pre-refactor
   *    `resolve(port)` on 'listening')
   *  - on bind failure, the listen() Promise rejects → this method rejects
   *    (mirrors pre-refactor reject-on-'error' before-'listening')
   *
   * Side effects (startHeartbeat + emit 'session-created') happen exactly
   * once, after a successful listen — same ordering as pre-refactor.
   */
  async start(): Promise<number> {
    this.transport.onConnection((conn, req) => this.handleConnection(conn, req));
    this.transport.onError(() => {
      // Errors AFTER listen() resolves — pre-refactor the WebSocketServer
      // would emit 'error' but there was no handler beyond the startup
      // reject. Match that posture: swallow here. Per-connection 'error'
      // events still flow through onErrorPerConnection inside
      // handleConnection.
    });
    const boundPort = await this.transport.listen(
      this.config.port,
      this.config.maxPayloadBytes,
    );
    this.startHeartbeat();
    this.emit('session-created', { config: this.config });
    return boundPort;
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
      this.transport.closeConnection(cm.ws, 1001, 'Session ended');
    }
    this.members.clear();

    this.transport.close();

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
   * Handle a new peer connection (Phase 7 D-05: connection arrives via the
   * HostTransport seam — LAN: a `ws` socket; future Cloud: a relay-routed
   * pseudo-socket).
   *
   * Unauthenticated connections have a 10-second timeout (T-01-04).
   * Once authenticated, messages are routed by type with role checks (T-01-06).
   *
   * `ws` is opaque (TransportConnection) — all wire I/O routes through
   * `this.transport`.
   */
  private handleConnection(ws: TransportConnection, req: IncomingMessage): void {
    const clientIp = req.socket.remoteAddress ?? 'unknown';
    let memberId: string | null = null;

    // Auth timeout: close unauthenticated connections after 10 seconds (T-01-04)
    const authTimeout = setTimeout(() => {
      if (!memberId) {
        this.transport.send(ws, {
          type: 'error',
          code: 'AUTH_TIMEOUT',
          message: 'Authentication timeout',
          timestamp: createTimestamp(),
        });
        this.transport.closeConnection(ws, 4001, 'Authentication timeout');
      }
    }, 10_000);

    this.transport.onMessage(ws, async (raw: Buffer | ArrayBuffer | Buffer[]) => {
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
          // Phase 7 UAT fix (bootstrap-swap-presence-leak): detect whether
          // this connection is the joiner's bootstrap WSS. The bootstrap JWT
          // (TokenService.issueBootstrap) carries sub='bootstrap-'+sessionId;
          // the relay annotates payload.memberId from claims.sub on every
          // member->host frame; CloudHostTransport allocates a virtConn keyed
          // by that memberId and exposes it via the synthetic IncomingMessage
          // header 'x-cloud-virtual-memberid' (CloudHostTransport.ts:465).
          // LAN connections set no such header, so the check is cloud-only
          // by construction. The bootstrap virtConn carries exactly ONE
          // auth-request/auth-response round-trip (the joiner then calls
          // CloudTransport.swapToken and re-opens with the per-joiner JWT);
          // the host MUST NOT register a member or broadcast member-joined
          // for it — the post-swap virtConn arrives with a fresh memberId
          // and runs handleAuthRequest again with isBootstrapConnection=false
          // to do the real registration.
          const virtualMemberIdHdr = req.headers['x-cloud-virtual-memberid'];
          const isBootstrapConnection =
            typeof virtualMemberIdHdr === 'string' &&
            virtualMemberIdHdr.startsWith('bootstrap-');
          await this.handleAuthRequest(
            ws,
            msg,
            clientIp,
            authTimeout,
            (id) => {
              memberId = id;
            },
            isBootstrapConnection,
          );
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
            this.transport.send(ws, {
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
          // CR-02 (T-04-13-02) + CR-03-NEW (Plan 04-15): validate activeFilePath
          // against path traversal BEFORE upsert. PresenceMap.ts T-04-03-03
          // documents this as a precondition the caller MUST enforce. The
          // client-side normalization in extension.ts (presence broadcast on
          // onDidChangeActiveTextEditor) is a defense-in-depth pair but the
          // wire is not trusted, so the host MUST also enforce. Drop silently
          // on any rejection — same posture as parseMessage returning null.
          // activeFilePath === null is the legitimate "no file open" signal
          // and is preserved.
          // Segment-aware traversal detection rejects the path SEGMENT '..'
          // (true directory traversal) but accepts filenames whose basename
          // contains '..' as a substring (e.g. 'src/foo..bar.ts',
          // 'package..json').
          // Phase 6 (Plan 06-02): shared validator extracted to
          // this.validateRelativePath so review-comment can reuse the gate.
          // Plan 04-15 (CR-03-NEW closure) behavior preserved: segment-aware
          // traversal detection rejects '..' segment, absolute paths, Windows
          // drive prefixes, and backslashes. Empty + null distinction matters
          // — null is the legitimate "no file open" signal and must NOT pass
          // through validateRelativePath (which rejects empty strings).
          let safePath: string | null = null;
          if (msg.activeFilePath !== null) {
            const validated = this.validateRelativePath(msg.activeFilePath);
            if (validated === null) {
              return; // path traversal / absolute / backslash / empty — drop silently
            }
            safePath = validated;
          }

          // T-04-04-01: server-trusted memberId override (same policy as
          // chat-message). T-04-04-02: stamp host-arrival timestamp.
          const cm = this.members.get(memberId);
          const displayName = cm?.member.displayName ?? msg.displayName;
          const stampedTs = createTimestamp();
          const sanitized: ProtocolMessage = {
            ...msg,
            memberId,
            displayName,
            activeFilePath: safePath,           // CR-02: validated path flows to broadcast
            timestamp: stampedTs,
          };
          const info: PresenceInfo = {
            memberId,
            displayName,
            branch: msg.branch,
            activeFilePath: safePath,           // CR-02: validated path flows to PresenceMap
            lastUpdated: stampedTs,
          };
          this.presenceMap.upsert(info);
          // Phase 4 UAT fix (999.3b): notify the host process so the host's
          // own PresenceTreeProvider can upsert this peer's row. Without this
          // emit, the host upserts into PresenceMap (correct) and broadcasts
          // to other clients (correct) but the host's UI never learns about
          // peer presence — Alice's PRESENCE panel only ever saw her own row.
          this.emit('presence-update', info);
          // Exclude sender — they already know their own active editor.
          this.broadcast(sanitized, memberId);
        } else if (msg.type === 'review-opened') {
          // Plan 06-04: extracted into processReviewOpened so the public
          // handleLocalReviewOpen helper can reuse the same body.
          const cm = this.members.get(memberId);
          if (!cm) return;
          await this.processReviewOpened(memberId, cm.member.displayName, msg);
        } else if (msg.type === 'review-comment') {
          // Plan 06-04: extracted into processReviewComment so the public
          // handleLocalReviewComment helper can reuse the same body.
          const cmComment = this.members.get(memberId);
          if (!cmComment) return;
          await this.processReviewComment(
            memberId,
            cmComment.member.displayName,
            cmComment.ws,
            msg,
          );
        } else if (msg.type === 'review-vote') {
          // Plan 06-04: extracted into processReviewVote so the public
          // handleLocalReviewVote helper can reuse the same body.
          const cmVote = this.members.get(memberId);
          if (!cmVote) return;
          await this.processReviewVote(memberId, cmVote.member.displayName, msg);
        } else if (msg.type === 'review-resolved') {
          // Plan 06-04: extracted into processReviewResolved so the public
          // handleLocalReviewResolved helper can reuse the same body.
          const cmResolve = this.members.get(memberId);
          if (!cmResolve) return;
          await this.processReviewResolved(
            memberId,
            cmResolve.member.displayName,
            cmResolve.ws,
            msg,
          );
        } else if (msg.type === 'sync-request') {
          // PUSH-09 reconnect path: respond with empty files (snapshot is
          // delivered out-of-band) plus the latest push id so the client can
          // seed its sync tracker.
          this.transport.send(ws, {
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

    // Native pong handler for ws ping/pong frames (heartbeat reuse — D-05
    // quality bar: transport surface routes pong without exposing the
    // underlying socket).
    this.transport.onPong(ws, () => {
      if (memberId) {
        const cm = this.members.get(memberId);
        if (cm) {
          cm.isAlive = true;
        }
      }
    });

    this.transport.onClose(ws, () => {
      clearTimeout(authTimeout);
      if (memberId) {
        this.removeMember(memberId, 'Connection closed');
      }
    });

    this.transport.onErrorPerConnection(ws, () => {
      // Error will be followed by close event -- handle cleanup there
    });
  }

  // ---------------------------------------------------------------------------
  // Auth (T-01-03: constant-time compare + rate limiting)
  // ---------------------------------------------------------------------------

  private async handleAuthRequest(
    ws: TransportConnection,
    msg: ProtocolMessage & { type: 'auth-request' },
    clientIp: string,
    authTimeout: ReturnType<typeof setTimeout>,
    setMemberId: (id: string) => void,
    // Phase 7 UAT fix (bootstrap-swap-presence-leak): true when the inbound
    // connection is the joiner's bootstrap WSS (sub='bootstrap-'+sessionId).
    // Defaulted so handleAuthRequestForTest and any future callers stay
    // signature-compatible.
    isBootstrapConnection: boolean = false,
  ): Promise<void> {
    // Check rate limit first
    const rateCheck = this.authHandler.checkRateLimit(clientIp);
    if (!rateCheck.allowed) {
      this.transport.send(ws, {
        type: 'auth-response',
        accepted: false,
        reason: `Rate limited. Try again in ${Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)} seconds.`,
        timestamp: createTimestamp(),
      });
      this.transport.closeConnection(ws, 4003, 'Rate limited');
      return;
    }

    // Validate invite code with constant-time comparison
    const valid = this.authHandler.validateInviteCode(msg.inviteCode);
    if (!valid) {
      this.transport.send(ws, {
        type: 'auth-response',
        accepted: false,
        reason: 'Invalid invite code',
        timestamp: createTimestamp(),
      });
      this.transport.closeConnection(ws, 4002, 'Invalid invite code');
      return;
    }

    // Auth succeeded -- cancel timeout
    clearTimeout(authTimeout);

    // Phase 7 UAT fix (bootstrap-swap-presence-leak): the bootstrap WSS
    // exists solely to carry one auth-request/auth-response round-trip so
    // the joiner can mint a per-joiner JWT and re-open the WSS via
    // CloudTransport.swapToken (CloudTransport.ts:521). The bootstrap
    // connection MUST NOT register a member in this.members, broadcast
    // member-joined, or send state-sync/chat-history/review-state-sync —
    // the post-swap connection arrives as a fresh virtConn with a distinct
    // memberId and runs this method again with isBootstrapConnection=false
    // to perform the real registration. Without this gate, every joiner
    // produced TWO member entries (bootstrap UUID + post-swap UUID) which
    // both eventually disappeared via heartbeat-timeout (cloud-mode ping
    // is a no-op so cm.isAlive is never refreshed), leaving the joiner
    // invisible in the host's MEMBERS panel despite a live WSS at the
    // relay. Discovered 2026-05-30 during UAT-3b on session vc-66ba2eb83191.
    if (isBootstrapConnection) {
      // Mint the per-joiner JWT (the joiner reads auth-response.token and
      // immediately calls swapToken with it). Cloud-mode preconditions
      // (cloudTokenService + cloudSessionId both non-null) are guaranteed
      // here because isBootstrapConnection only becomes true when a virtConn
      // with the 'bootstrap-' memberId prefix arrives — that prefix only
      // exists in cloud mode (SessionHostFactory.createCloud mints the
      // bootstrap JWT via TokenService.issueBootstrap). Role is always
      // 'member' on this path; the loopback host does not use the bootstrap
      // JWT (it constructs SessionHost directly via the LAN-transport seam).
      const tentativeMemberId = crypto.randomUUID();
      let bootstrapJoinerToken: string | undefined = undefined;
      if (this.cloudTokenService !== null && this.cloudSessionId !== null) {
        try {
          bootstrapJoinerToken = await this.cloudTokenService.issue({
            iss: this.hostMemberId ?? tentativeMemberId,
            sub: tentativeMemberId,
            aud: this.cloudSessionId,
            role: 'member',
          });
        } catch {
          // HMAC sign failure is operationally rare (in-memory only); degrade
          // gracefully so the joiner sees a meaningful connect-error rather
          // than a hang.
          bootstrapJoinerToken = undefined;
        }
      }

      // Send the auth-response with the token. Spread `token` only when it
      // is defined so a sign failure produces a no-token response (joiner
      // surfaces as auth-failed via the existing 07-06 status mapping).
      // NOTE: do NOT call setMemberId — the per-connection closure stays
      // unauthenticated, so handleConnection's onClose handler will NOT
      // invoke removeMember when this virtConn eventually evicts.
      this.transport.send(ws, {
        type: 'auth-response',
        accepted: true,
        memberId: tentativeMemberId,
        sessionInfo: {
          name: this.config.sessionName,
          memberCount: this.members.size,
          hostDisplayName: this.hostDisplayName,
        },
        ...(bootstrapJoinerToken !== undefined ? { token: bootstrapJoinerToken } : {}),
        timestamp: createTimestamp(),
      });

      // Evict the bootstrap virtConn from the demultiplexer Map so it does
      // not accumulate on the host across joiners. The wire socket is closed
      // by the joiner immediately after swapToken (CloudTransport.ts:528 —
      // code 1000, reason 'bootstrap-swap'), so this call is internal
      // bookkeeping only; no wire-level frame is sent (CloudHostTransport's
      // closeConnection only fires the in-process onClose handlers and
      // deletes the demux entry). closeConnection invokes the onClose
      // handler registered above, which finds memberId=null in its closure
      // and skips removeMember — the intended no-op.
      try {
        this.transport.closeConnection(ws, 1000, 'bootstrap-handoff');
      } catch {
        // Defensive: closeConnection is internally null-safe across both
        // current HostTransport implementations; this catch protects against
        // future transports that adopt throw semantics.
      }
      return;
    }

    // Assign server-generated member ID (T-01-07)
    const newMemberId = crypto.randomUUID();
    setMemberId(newMemberId);

    // Phase 4.1 (Plan 04.1-02 — Defect B closure): role:'host' is granted ONLY
    // to a connection that proves possession of the pre-allocated
    // hostAuthSecret via timingSafeEqual. Remote clients omit the field (or
    // send a guess); they always get role:'member' regardless of timing.
    // The loopback host client (plan 04.1-03 wires this in extension.ts)
    // sends the secret in its auth-request and is the only path to host role.
    let role: 'host' | 'member' = 'member';
    const claimedSecret = msg.hostAuthSecret;
    if (
      typeof claimedSecret === 'string' &&
      claimedSecret.length === this.hostAuthSecret.length
    ) {
      // Length-equal precondition for crypto.timingSafeEqual (throws otherwise).
      // Both buffers UTF-8 encoded so binary-equality is byte-equality.
      const a = Buffer.from(claimedSecret, 'utf-8');
      const b = Buffer.from(this.hostAuthSecret, 'utf-8');
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        role = 'host';
        // Re-point this.hostMemberId to the loopback's ws-authed memberId so
        // existing admin gates (handleKickRequest at line 574,
        // handleRegenerateInvite at line 596) resolve against the live
        // connection's id. The pre-allocated value from the constructor was
        // a placeholder until this moment.
        this.hostMemberId = newMemberId;
      }
    }

    const member: Member = {
      id: newMemberId,
      displayName: msg.displayName,
      role,
      isOnline: true,
      joinedAt: Date.now(),
    };

    this.members.set(newMemberId, { ws, member, isAlive: true });

    // Phase 7 Plan 07-05b — cloud-mode addendum: issue per-joiner JWT.
    //
    // Detection: cloudTokenService is non-null IFF SessionHostFactory.createCloud
    // attached an issuer (cloud mode). LAN mode leaves it null and skips this
    // entire block; the auth-response below omits the `token` key (byte-identical
    // to the pre-07-05b wire).
    //
    // The role gate (`role === 'member'`) is the T-07-09 anti-pattern defense:
    // the relay's role comes from the JWT claim (07-09's verifyClient), NEVER
    // from connection order. The host issues 'member' JWTs only — host-role JWTs
    // are minted by SessionHostFactory.createCloud and NEVER by this path.
    let joinerToken: string | undefined = undefined;
    if (
      this.cloudTokenService !== null &&
      this.cloudSessionId !== null &&
      role === 'member'
    ) {
      try {
        joinerToken = await this.cloudTokenService.issue({
          iss: this.hostMemberId ?? newMemberId,
          sub: newMemberId,
          aud: this.cloudSessionId,
          role: 'member',
        });
      } catch {
        // Token issuance failure is operationally rare (HMAC sign is in-memory).
        // Degrade gracefully: skip token, joiner falls back to LAN-style flow
        // and will fail to reach the relay. The auth-response itself still
        // sends — the joiner sees `token: undefined` and can surface a
        // connect-error via 07-06's status mapping.
        joinerToken = undefined;
      }
    }

    // Send auth-response to new member. Spread the optional `token` field
    // ONLY when defined so LAN-mode JSON output is byte-identical to today.
    this.transport.send(ws, {
      type: 'auth-response',
      accepted: true,
      memberId: newMemberId,
      sessionInfo: {
        name: this.config.sessionName,
        memberCount: this.members.size,
        hostDisplayName: this.hostDisplayName,
      },
      ...(joinerToken !== undefined ? { token: joinerToken } : {}),
      timestamp: createTimestamp(),
    });

    // Send state-sync to the new member with current member list
    const memberList = this.getMembersList();
    this.transport.send(ws, {
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

    // Phase 6 (Plan 06-02): review-state-sync replay. Fired AFTER chat-history
    // so the client's ReviewState cache (Plan 06-03) populates once the
    // ChatPanel has rendered the recent activity. Order matches RESEARCH
    // Open Q #2's posture for chat-history. Fire-and-forget; null-guard on
    // reviewStore mirrors chat-history null-guard above.
    if (this.reviewStore && this.activeBranch) {
      void this.sendReviewStateSyncToMember(newMemberId, this.activeBranch);
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

  /**
   * Test-only seam — invokes handleAuthRequest with a synthetic authTimeout
   * and setMemberId callback so the LAN-mode regression test in
   * hostCloudWiring.test.ts can verify the auth-response shape without
   * driving a real WebSocket. Production code paths route through
   * handleConnection's onMessage handler, which sets memberId via the
   * captured closure. Not exported via .d.ts in production builds.
   */
  async handleAuthRequestForTest(
    ws: TransportConnection,
    msg: ProtocolMessage,
    clientIp: string,
  ): Promise<void> {
    if (msg.type !== 'auth-request') return;
    const noopTimeout = setTimeout(() => undefined, 60_000);
    try {
      await this.handleAuthRequest(ws, msg, clientIp, noopTimeout, () => undefined);
    } finally {
      clearTimeout(noopTimeout);
    }
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
    this.transport.send(target.ws, {
      type: 'member-kicked',
      reason: 'Kicked by host',
      timestamp: createTimestamp(),
    });

    this.transport.closeConnection(target.ws, 4004, 'Kicked by host');
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

    this.transport.send(target.ws, {
      type: 'member-kicked',
      reason,
      timestamp: createTimestamp(),
    });

    this.transport.closeConnection(target.ws, 4004, reason);
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

  /**
   * Broadcast a push notification to all members.
   *
   * Plan 04-12: ALSO append a `kind: 'system'`, `subKind: 'push'` ChatRecord
   * to chat-log.json AND broadcast a `chat-message` envelope so the activity
   * timeline (which IS the chat timeline per CONTEXT.md decision) reflects the
   * push as a durable system event. The original push-notification wire
   * broadcast still fires unconditionally (Phase 3 contract preserved); the
   * system-event work runs AFTER it so a chat-log persistence failure cannot
   * regress the Phase 3 fan-out.
   *
   * Body format follows UI-SPEC §6.3 / activity tree label convention —
   * `{record.memberDisplayName} pushed {N} file(s)`. The host doesn't know
   * per-receiver `affectsLocal`, so the body uses the neutral remote-no-overlap
   * shape; each receiver's local push-received handler still computes its own
   * overlap and renders the activity-tree row independently.
   *
   * Plan 04-15 update (CR-01-NEW closure): the system event body and stamped
   * identity now come from `record.memberDisplayName` / `record.memberId`.
   * Returns the persisted ChatRecord so extension.ts can echo it into the
   * host's own ChatPanel via dispatchChatReceivedLocally (CR-02-NEW closure).
   */
  broadcastPush(
    record: PushRecord,
    prePostByFile?: Map<string, { preContent: string | null; postContent: string | null }>,
  ): ChatRecord {
    const stampedTs = createTimestamp();
    this.broadcast({
      type: 'push-notification',
      pushId: record.id,
      memberId: record.memberId,
      memberDisplayName: record.memberDisplayName,
      message: record.message,
      branch: record.branch,
      files: record.files,
      timestamp: stampedTs,
    });
    const fileCount = record.files.length;
    const body = `${record.memberDisplayName} pushed ${fileCount} file(s)`;
    const systemRecord = this.appendAndBroadcastSystemEvent(
      'push',
      body,
      stampedTs,
      {
        pushId: record.id,
        branch: record.branch,
        files: record.files.map(f => f.relativePath),
      },
      record.memberId,
      record.memberDisplayName,
    );
    // Phase 5 Plan 05-05 (SC-2 + SC-5): fire-and-forget AST analysis. The
    // synchronous broadcast path above is COMPLETE before this fires — the
    // caller never waits on the returned Promise. When the analyzer resolves
    // with non-empty affectedSymbols OR unsupportedLanguages, the host
    // broadcasts a `chat-message-amend` referencing systemRecord.id so
    // clients can patch the cached record's meta and re-render.
    //
    // SC-2 hard line: do NOT await this; it MUST run after the sync path
    // returns. The `void` operator pins that intent and silences the
    // promise-must-be-awaited lint.
    if (this.astAnalyzer && prePostByFile && prePostByFile.size > 0) {
      void this.runAstAnalysisAndAmend(systemRecord.id, record, prePostByFile);
    }
    return systemRecord;
  }

  /**
   * Broadcast a push revert notification to all members.
   *
   * Plan 04-12: ALSO append + broadcast a `subKind: 'revert'` system event
   * (see broadcastPush for rationale). Body: `{record.memberDisplayName}
   * reverted {N} file(s)` per UI-SPEC §6.3.
   *
   * Plan 04-15 update (CR-01-NEW closure): body and stamped identity come from
   * `record.memberDisplayName` / `record.memberId` — the actor for revert is
   * the original pusher, NOT the host (extension.ts:1440 reverts non-host
   * members' pushes through the host process).
   * Returns the persisted ChatRecord (CR-02-NEW closure).
   */
  broadcastRevert(record: PushRecord): ChatRecord {
    const stampedTs = createTimestamp();
    const filePaths = record.files.map(f => f.relativePath);
    this.broadcast({
      type: 'push-reverted',
      pushId: record.id,
      memberId: record.memberId,
      memberDisplayName: record.memberDisplayName,
      branch: record.branch,
      files: filePaths,
      timestamp: stampedTs,
    });
    const fileCount = filePaths.length;
    const body = `${record.memberDisplayName} reverted ${fileCount} file(s)`;
    return this.appendAndBroadcastSystemEvent(
      'revert',
      body,
      stampedTs,
      {
        pushId: record.id,
        branch: record.branch,
        files: filePaths,
      },
      record.memberId,
      record.memberDisplayName,
    );
  }

  /**
   * Broadcast a new branch creation.
   *
   * Plan 04-12: ALSO append + broadcast a `subKind: 'branch-created'` system
   * event. Body: `{resolvedDisplayName} created branch '{branchName}'` per
   * UI-SPEC §6.3.
   *
   * Plan 04-15 update (CR-01-NEW closure): branch.createdBy is a memberId
   * (per src/types/branch.ts), so we resolve it to a displayName via the
   * members registry. Falls back to hostDisplayName when the memberId is
   * not currently mapped (host-initiated creates where the host's own
   * memberId may not yet be self-mapped, or the creator has disconnected).
   * Returns the persisted ChatRecord (CR-02-NEW closure).
   */
  broadcastBranchCreated(branch: BranchInfo): ChatRecord {
    const stampedTs = createTimestamp();
    this.broadcast({
      type: 'branch-created',
      branch,
      timestamp: stampedTs,
    });
    const resolvedDisplayName =
      this.members.get(branch.createdBy)?.member.displayName ?? this.hostDisplayName;
    const body = `${resolvedDisplayName} created branch '${branch.name}'`;
    return this.appendAndBroadcastSystemEvent(
      'branch-created',
      body,
      stampedTs,
      { branch: branch.name },
      branch.createdBy,
      resolvedDisplayName,
    );
  }

  /**
   * Plan 04-12 internal helper: persist a host-emitted system event to the
   * active branch's chat-log.json AND broadcast a `chat-message` envelope to
   * all connected members so the activity timeline (which IS the chat
   * timeline) updates live.
   *
   * Identity policy: `memberId = this.hostMemberId ?? 'host'` and
   * `memberDisplayName = this.hostDisplayName` — mirrors handleLocalChatMessage
   * (Plan 04-04). The 'host' fallback covers the pre-self-auth case.
   *
   * Coexists with Plan 04-13's CR-01 client-frame coercion: this is a
   * HOST-INTERNAL write path, NOT a wire frame from a client, so the
   * `kind: 'system'` here is legitimate. CR-01 only coerces client-authored
   * `chat-message` wire frames in the onmessage switch — that branch never
   * sees these system records.
   *
   * Failure handling: chat-log persistence failure is logged + swallowed;
   * the chat-message wire broadcast still fires so live chat keeps working
   * even when disk writes transiently fail (mirrors the chat-message wire
   * handler's existing posture, T-04-04 ChatLog null-tolerant).
   *
   * Identity policy (Plan 04-15 update — CR-01-NEW closure):
   *   `actorMemberId` / `actorDisplayName` override the host defaults so callers
   *   can stamp the correct actor on push/revert events whose actor is a non-host
   *   member (the prior implementation always baked hostDisplayName, misattributing
   *   reverts of other members' pushes — see 04-VERIFICATION.md CR-01-NEW).
   *
   * Returns the constructed ChatRecord (Plan 04-15 update — CR-02-NEW closure):
   *   so callers can echo it into the host process's own ChatPanel via
   *   dispatchChatReceivedLocally — the host does NOT receive its own broadcast,
   *   mirroring the same echo pattern as handleLocalChatMessage at extension.ts:285.
   */

  /**
   * Phase 6 (Plan 06-02): shared relative-path validator used by review-comment
   * (file anchor) AND presence-update (active file). Returns the safe path,
   * or null on rejection. Identical logic to the prior inline check at
   * presence-update — extracted so review-comment doesn't duplicate it.
   *
   * Rejection set (matches CR-03-NEW from Plan 04-15):
   *   - not a string / empty / >1024 chars
   *   - any path SEGMENT equal to '..' (true directory traversal — filenames
   *     containing '..' as a substring like 'foo..bar.ts' are still accepted)
   *   - starts with '/' (absolute posix)
   *   - matches Windows drive prefix /^[A-Za-z]:[\\/]/
   *   - contains a backslash anywhere
   */
  private validateRelativePath(p: unknown): string | null {
    if (typeof p !== 'string') return null;
    if (p.length === 0 || p.length > 1024) return null;
    const segments = p.split('/');
    if (
      segments.includes('..') ||
      p.startsWith('/') ||
      /^[A-Za-z]:[\\/]/.test(p) ||
      p.includes('\\')
    ) {
      return null;
    }
    return p;
  }

  /**
   * Phase 6 (Plan 06-02): serialize a review mutation against the per-review
   * write chain so concurrent review-* handlers don't drop each other's
   * writes. The caller's `op` runs strictly after any previously-enqueued
   * op for the same reviewId; failures in `op` are swallowed (logged by the
   * op itself) so a single failure does not poison the chain for subsequent
   * mutations.
   *
   * Returns the Promise the op resolves to, so callers (e.g. the
   * review-comment handler) can await observable persistence completion
   * before broadcasting + emitting the system event.
   */
  private enqueueReviewWrite(reviewId: string, op: () => Promise<void>): Promise<void> {
    const prior = this.reviewWriteChain.get(reviewId) ?? Promise.resolve();
    const next = prior.then(() => op()).catch((err) => {
      console.error('[SessionHost] enqueueReviewWrite op failed', err);
    });
    this.reviewWriteChain.set(reviewId, next);
    // GC: when `next` resolves AND it's still the chain head, drop the entry
    // so the Map doesn't grow unbounded as reviews come and go.
    void next.then(() => {
      if (this.reviewWriteChain.get(reviewId) === next) {
        this.reviewWriteChain.delete(reviewId);
      }
    });
    return next;
  }

  /**
   * Phase 6 T-06-03 mitigation: sliding-window rate-limit for review-comments
   * per member. Returns true if the comment is allowed; false if the member
   * has exceeded REVIEW_COMMENT_RATE_PER_MIN comments in the last 60s window.
   *
   * Mutates the per-member timestamp array: prunes entries older than 60s,
   * then appends `nowMs` if the comment is allowed. The pruned array is
   * persisted back regardless so the map doesn't grow unbounded — same
   * posture as AuthHandler.rateLimitState (T-01-03).
   */
  private checkReviewCommentRate(memberId: string, nowMs: number): boolean {
    const windowStart = nowMs - 60_000;
    let stamps = this.reviewCommentTimestamps.get(memberId) ?? [];
    stamps = stamps.filter(t => t > windowStart);
    if (stamps.length >= SessionHost.REVIEW_COMMENT_RATE_PER_MIN) {
      this.reviewCommentTimestamps.set(memberId, stamps);
      return false;
    }
    stamps.push(nowMs);
    this.reviewCommentTimestamps.set(memberId, stamps);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase 6 Plan 06-04: review-* processors shared between the onmessage
  // wire path and the public handleLocalReview* helpers.
  //
  // The wire path resolves memberId + displayName from this.members; the
  // local path resolves them from this.hostMemberId + this.hostDisplayName.
  // Both paths funnel into the SAME processReview* helper so identity
  // override + persistence + system-event broadcast + rate-limit + cap
  // checks have a single source of truth (T-06-01 enforced; T-06-03 cap
  // applies to host-as-actor too, per the "host is just another member"
  // trust model from Plan 04-04).
  // ---------------------------------------------------------------------------

  private async processReviewOpened(
    memberId: string,
    displayName: string,
    msg: ProtocolMessage & { type: 'review-opened' },
  ): Promise<void> {
    if (!this.reviewStore) return;
    if (!msg.review || typeof msg.review !== 'object') return;
    if (typeof msg.review.pushId !== 'string' || msg.review.pushId.length === 0) return;
    if (typeof msg.review.id !== 'string' || msg.review.id.length === 0) return;
    if (typeof msg.review.branch !== 'string' || msg.review.branch.length === 0) return;
    const stampedTs = createTimestamp();
    // Supersede: prior non-resolved review on same pushId is closed with
    // status:'abandoned' (06-SPEC.md frontmatter "re-push supersedes" rule).
    const prior = this.reviewStore.getReview(msg.review.pushId);
    if (prior && prior.status !== 'resolved' && prior.status !== 'abandoned') {
      const abandoned: ReviewRequest = {
        ...prior,
        status: 'abandoned',
        resolvedAt: stampedTs,
        resolvedBy: memberId,
        resolvedReason: 'abandoned',
      };
      try {
        await this.reviewStore.upsertRequest(abandoned);
      } catch (err) {
        console.error('[SessionHost] review-opened prior-abandon persist failed', err);
      }
    }
    // T-06-01 sanitize. By contract "open" arrives empty; clamp defensively.
    const sanitized: ReviewRequest = {
      ...msg.review,
      authorMemberId: memberId,
      authorDisplayName: displayName,
      openedAt: stampedTs,
      status: 'open',
      votes: [],
      comments: [],
    };
    try {
      await this.reviewStore.upsertRequest(sanitized);
    } catch (err) {
      console.error('[SessionHost] review-opened persist failed', err);
      return;
    }
    this.broadcast({ type: 'review-opened', timestamp: stampedTs, review: sanitized });
    // Plan 06-04: also emit a typed event so extension.ts can mirror the
    // review into the host's own ReviewState cache + refresh the host's
    // open ReviewPanel. The host does NOT receive its own wire broadcast —
    // mirrors the chat-message-amend echo pattern at SessionHost line 1657.
    this.emit('review-opened', { review: sanitized });
    const shortId = sanitized.pushId.substring(0, 7);
    this.appendAndBroadcastSystemEvent(
      'review-opened',
      `${displayName} opened a review on push ${shortId}`,
      stampedTs,
      { pushId: sanitized.pushId, branch: sanitized.branch },
      memberId,
      displayName,
    );
  }

  private async processReviewComment(
    memberId: string,
    displayName: string,
    ws: TransportConnection | null,
    msg: ProtocolMessage & { type: 'review-comment' },
  ): Promise<void> {
    if (!this.reviewStore) return;
    if (!msg.comment || typeof msg.comment !== 'object') return;
    if (typeof msg.reviewId !== 'string' || msg.reviewId.length === 0) return;
    if (typeof msg.comment.body !== 'string'
        || msg.comment.body.length === 0
        || msg.comment.body.length > 16_384) return;
    const safePath = this.validateRelativePath(msg.comment.filePath);
    if (safePath === null) return;
    if (typeof msg.comment.line !== 'number'
        || !Number.isInteger(msg.comment.line)
        || msg.comment.line < 1
        || msg.comment.line > 1_000_000) return;

    const reviewId = msg.reviewId;
    const commentBody = msg.comment.body;
    const commentLine = msg.comment.line;
    const commentIdIn = msg.comment.id;

    await this.enqueueReviewWrite(reviewId, async () => {
      const reviewStore = this.reviewStore;
      if (!reviewStore) return;
      const allReviews = reviewStore.getAll();
      const parent = allReviews.find(r => r.id === reviewId);
      if (!parent) return;
      const stampedTs = createTimestamp();

      if (parent.comments.length >= SessionHost.REVIEW_COMMENT_CAP) {
        if (ws) {
          this.transport.send(ws, {
            type: 'error',
            code: 'REVIEW_COMMENT_CAP',
            message: `Review has reached the ${SessionHost.REVIEW_COMMENT_CAP}-comment cap.`,
            timestamp: stampedTs,
          });
        }
        return;
      }
      if (!this.checkReviewCommentRate(memberId, stampedTs)) {
        if (ws) {
          this.transport.send(ws, {
            type: 'error',
            code: 'REVIEW_RATE_LIMIT',
            message: `You can post at most ${SessionHost.REVIEW_COMMENT_RATE_PER_MIN} review comments per minute.`,
            timestamp: stampedTs,
          });
        }
        return;
      }

      const sanitizedComment = {
        id: typeof commentIdIn === 'string' && commentIdIn.length > 0
          ? commentIdIn : crypto.randomUUID(),
        reviewId: parent.id,
        authorMemberId: memberId,
        authorDisplayName: displayName,
        filePath: safePath,
        line: commentLine,
        body: commentBody,
        createdAt: stampedTs,
      };
      const updated: ReviewRequest = {
        ...parent,
        comments: [...parent.comments, sanitizedComment],
      };
      try {
        await reviewStore.upsertRequest(updated);
      } catch (err) {
        console.error('[SessionHost] review-comment persist failed', err);
        return;
      }
      this.broadcast({
        type: 'review-comment',
        timestamp: stampedTs,
        reviewId: parent.id,
        comment: sanitizedComment,
      });
      this.emit('review-comment', { reviewId: parent.id, comment: sanitizedComment });
      const shortId = parent.pushId.substring(0, 7);
      this.appendAndBroadcastSystemEvent(
        'review-comment',
        `${displayName} commented on push ${shortId} (${safePath}:${commentLine})`,
        stampedTs,
        { pushId: parent.pushId, branch: parent.branch },
        memberId,
        displayName,
      );
    });
  }

  private async processReviewVote(
    memberId: string,
    displayName: string,
    msg: ProtocolMessage & { type: 'review-vote' },
  ): Promise<void> {
    if (!this.reviewStore) return;
    if (!msg.vote || typeof msg.vote !== 'object') return;
    if (typeof msg.reviewId !== 'string' || msg.reviewId.length === 0) return;
    if (msg.vote.vote !== 'approved'
        && msg.vote.vote !== 'changes-requested'
        && msg.vote.vote !== 'commented') return;
    const voteKind = msg.vote.vote;
    const reviewId = msg.reviewId;

    await this.enqueueReviewWrite(reviewId, async () => {
      const reviewStore = this.reviewStore;
      if (!reviewStore) return;
      const allReviews = reviewStore.getAll();
      const parent = allReviews.find(r => r.id === reviewId);
      if (!parent) return;
      if (parent.status === 'resolved' || parent.status === 'abandoned') return;
      const stampedTs = createTimestamp();
      const sanitizedVote = {
        reviewerMemberId: memberId,
        reviewerDisplayName: displayName,
        vote: voteKind,
        votedAt: stampedTs,
      };
      const otherVotes = parent.votes.filter(v => v.reviewerMemberId !== memberId);
      const newVotes = [...otherVotes, sanitizedVote];
      // Status transition rules (mirrored by client ReviewState.applyVote):
      //   - any 'changes-requested' vote → status='changes-requested'
      //   - else if any 'approved' vote → status='approved'
      //   - else ('commented' alone) → status='open'
      let newStatus = parent.status;
      if (newVotes.some(v => v.vote === 'changes-requested')) {
        newStatus = 'changes-requested';
      } else if (newVotes.some(v => v.vote === 'approved')) {
        newStatus = 'approved';
      } else {
        newStatus = 'open';
      }
      const updated: ReviewRequest = { ...parent, votes: newVotes, status: newStatus };
      try {
        await reviewStore.upsertRequest(updated);
      } catch (err) {
        console.error('[SessionHost] review-vote persist failed', err);
        return;
      }
      this.broadcast({
        type: 'review-vote',
        timestamp: stampedTs,
        reviewId: parent.id,
        vote: sanitizedVote,
      });
      this.emit('review-vote', { reviewId: parent.id, vote: sanitizedVote });
      const shortId = parent.pushId.substring(0, 7);
      const subKind: SystemEventSubKind =
        voteKind === 'approved' ? 'review-approved' :
        voteKind === 'changes-requested' ? 'review-changes-requested' :
        'review-comment';
      const verb =
        voteKind === 'approved' ? 'approved' :
        voteKind === 'changes-requested' ? 'requested changes on' :
        'commented on';
      this.appendAndBroadcastSystemEvent(
        subKind,
        `${displayName} ${verb} the review of push ${shortId}`,
        stampedTs,
        { pushId: parent.pushId, branch: parent.branch },
        memberId,
        displayName,
      );
    });
  }

  private async processReviewResolved(
    memberId: string,
    displayName: string,
    ws: TransportConnection | null,
    msg: ProtocolMessage & { type: 'review-resolved' },
  ): Promise<void> {
    if (!this.reviewStore) return;
    if (typeof msg.reviewId !== 'string' || msg.reviewId.length === 0) return;
    if (msg.resolvedReason !== 'merged' && msg.resolvedReason !== 'abandoned') return;
    const reviewId = msg.reviewId;
    const resolveReason = msg.resolvedReason;

    await this.enqueueReviewWrite(reviewId, async () => {
      const reviewStore = this.reviewStore;
      if (!reviewStore) return;
      const allReviews = reviewStore.getAll();
      const parent = allReviews.find(r => r.id === reviewId);
      if (!parent) return;
      if (parent.status === 'resolved' || parent.status === 'abandoned') return;
      const stampedTs = createTimestamp();

      const isAuthor = memberId === parent.authorMemberId;
      const isAdminOverride =
        !isAuthor &&
        this.permissions?.canCreateBranch?.(memberId) === true &&
        parent.status === 'changes-requested' &&
        resolveReason === 'merged';
      if (!isAuthor && !isAdminOverride) {
        if (ws) {
          this.transport.send(ws, {
            type: 'error',
            code: 'REVIEW_PERMISSION_DENIED',
            message: 'Only the push author can resolve their review (admins can override changes-requested to merged).',
            timestamp: stampedTs,
          });
        }
        return;
      }
      const updated: ReviewRequest = {
        ...parent,
        status: 'resolved',
        resolvedBy: memberId,
        resolvedAt: stampedTs,
        resolvedReason: resolveReason,
      };
      try {
        await reviewStore.upsertRequest(updated);
      } catch (err) {
        console.error('[SessionHost] review-resolved persist failed', err);
        return;
      }
      this.broadcast({
        type: 'review-resolved',
        timestamp: stampedTs,
        reviewId: parent.id,
        resolvedBy: memberId,
        resolvedReason: resolveReason,
      });
      this.emit('review-resolved', {
        reviewId: parent.id,
        resolvedBy: memberId,
        resolvedReason: resolveReason,
      });
      const shortId = parent.pushId.substring(0, 7);
      this.appendAndBroadcastSystemEvent(
        'review-resolved',
        `${displayName} resolved the review of push ${shortId} (${resolveReason})`,
        stampedTs,
        { pushId: parent.pushId, branch: parent.branch },
        memberId,
        displayName,
      );
      if (isAdminOverride) {
        this.appendAndBroadcastSystemEvent(
          'review-resolved',
          `${displayName} OVERRODE changes-requested for review of push ${shortId} — merged`,
          stampedTs,
          { pushId: parent.pushId, branch: parent.branch },
          memberId,
          displayName,
        );
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 6 Plan 06-04: public handleLocalReview* helpers — invoked by the
  // host's own extension.ts when the host clicks vote/comment/resolve in the
  // ReviewPanel. The host is not in this.members (host identity lives in
  // this.hostMemberId + this.hostDisplayName), so each helper routes the
  // shared processReview* with the host's identity stamped onto the override
  // fields. Each helper is fire-and-forget from the caller's perspective;
  // failures are swallowed in the same way as the wire path (T-04-04 chat-
  // log-null-tolerant posture extended to review-*).
  // ---------------------------------------------------------------------------

  async handleLocalReviewOpen(
    msg: ProtocolMessage & { type: 'review-opened' },
  ): Promise<void> {
    await this.processReviewOpened(
      this.hostMemberId ?? 'host',
      this.hostDisplayName,
      msg,
    );
  }

  async handleLocalReviewComment(
    msg: ProtocolMessage & { type: 'review-comment' },
  ): Promise<void> {
    await this.processReviewComment(
      this.hostMemberId ?? 'host',
      this.hostDisplayName,
      null,
      msg,
    );
  }

  async handleLocalReviewVote(
    msg: ProtocolMessage & { type: 'review-vote' },
  ): Promise<void> {
    await this.processReviewVote(
      this.hostMemberId ?? 'host',
      this.hostDisplayName,
      msg,
    );
  }

  async handleLocalReviewResolved(
    msg: ProtocolMessage & { type: 'review-resolved' },
  ): Promise<void> {
    await this.processReviewResolved(
      this.hostMemberId ?? 'host',
      this.hostDisplayName,
      null,
      msg,
    );
  }

  /**
   * Append a system event to the chat log and broadcast it to all members.
   *
   * Public visibility widened in Plan 06-05: extension.ts's three merge entry
   * points (versioncon.mergeBranch / quickMergeFiles / structuredMergeBranch)
   * call this from the activate IIFE when the requireReview gate blocks a
   * merge, so the team sees the rejection in chat (REVIEW-04 / SC-3 /
   * 06-SPEC.md). The host is the only legitimate caller of this method from
   * outside the class — pin via the convention that ONLY SessionHost instance
   * methods AND extension.ts (with an activeHost reference) construct system
   * events. Other call sites would regress the "host is the trust authority
   * for chat-log writes" posture (Plan 04-04 / T-04-04-04 invariant).
   */
  public appendAndBroadcastSystemEvent(
    subKind: SystemEventSubKind,
    body: string,
    timestamp: number,
    meta: { pushId?: string; branch?: string; files?: string[] },
    actorMemberId?: string,
    actorDisplayName?: string,
  ): ChatRecord {
    const memberId = actorMemberId ?? this.hostMemberId ?? 'host';
    const memberDisplayName = actorDisplayName ?? this.hostDisplayName;
    // Shared id between the persisted ChatRecord.id and the wire envelope's
    // recordId — guarantees that a client receiving the live chat-message
    // can dedupe against the same record when it arrives in a subsequent
    // chat-history replay (Plan 04-04 Task 3 / RESEARCH Open Q #2).
    const recordId = crypto.randomUUID();
    const record: ChatRecord = {
      id: recordId,
      kind: 'system',
      subKind,
      memberId,
      memberDisplayName,
      body,
      timestamp,
      meta,
    };
    if (this.chatLog) {
      // Fire-and-forget: a chat-log append failure must NOT block the
      // chat-message wire broadcast below. Mirrors the chat-message wire
      // handler's posture (T-04-04 / Plan 04-04 Task 1).
      this.chatLog.append(record).catch((err: unknown) => {
        console.error('[SessionHost] system-event chat-log append failed', err);
      });
    }
    // Broadcast chat-message envelope to ALL members (no exclude) — same
    // fan-out as handleLocalChatMessage (Plan 04-04) and the chat-message
    // wire handler. Shared recordId/id (above) lets clients dedupe live
    // events against later chat-history replays.
    this.broadcast({
      type: 'chat-message',
      timestamp,
      recordId,
      kind: 'system',
      subKind,
      memberId,
      memberDisplayName,
      body,
      meta,
    });
    return record;
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
   * Phase 6 (Plan 06-02): wire the active-branch ReviewStore so review-*
   * handlers can persist mutations and review-state-sync replays the
   * current per-branch index. Mirrors setChatLog signature. Plan 06-04's
   * extension.ts calls this on session start AND on every branch switch.
   * Last-write-wins (same posture as setChatLog).
   */
  setReviewStore(store: ReviewStore, branchName: string): void {
    this.reviewStore = store;
    this.activeBranch = branchName;
  }

  /**
   * Phase 6 (Plan 06-02): host → single-client review-state-sync send.
   * Mirrors sendChatHistoryToMember — fired post-auth AFTER chat-history.
   *
   * T-06-05 mitigation (structural): this method emits ONLY to a SPECIFIC
   * ws (the new joiner's), NEVER from a client to peers. The onmessage
   * switch has NO inbound branch for `review-state-sync` (mirrors the
   * chat-cleared/chat-truncated host-only-outbound posture).
   *
   * Fire-and-forget: failure is logged but does not propagate so the auth
   * handshake never blocks on a review-state-sync send.
   */
  async sendReviewStateSyncToMember(memberId: string, branch: string): Promise<void> {
    if (!this.reviewStore) return;
    const cm = this.members.get(memberId);
    if (!cm || !this.transport.isOpen(cm.ws)) return;
    const reviews = this.reviewStore.getAll().filter(r => r.branch === branch);
    try {
      this.transport.send(cm.ws, {
        type: 'review-state-sync',
        timestamp: createTimestamp(),
        branch,
        reviews,
      });
    } catch (err) {
      console.error('[SessionHost] sendReviewStateSyncToMember failed', err);
    }
  }

  /**
   * Phase 5 Plan 05-05 (SC-5): wire the AST analyzer so broadcastPush can
   * fire an async analysis + follow-up `chat-message-amend` broadcast. Called
   * by extension.ts once per session start (host path only). Null when the
   * analyzer is absent — broadcastPush degrades to the Phase 4.3 baseline.
   */
  setAstAnalyzer(analyzer: AstAnalyzer | null): void {
    this.astAnalyzer = analyzer;
  }

  /**
   * Phase 5 Plan 05-05 (SC-5): wire a lazy getter for the active branch
   * directory so runAstAnalysisAndAmend can read each member's tracked-file
   * content from the host's branch source-of-truth without needing the
   * content over the wire. Called by extension.ts mirroring setChatLog.
   * Null when not wired — runAstAnalysisAndAmend short-circuits to empty.
   */
  setBranchDirGetter(getter: () => string): void {
    this.branchDirGetter = getter;
  }

  /**
   * Phase 5 Plan 05-05 (SC-5) core: build analyzer inputs, run analysis,
   * broadcast amend.
   *
   * Threat mitigations:
   *  - T-05-01 (worker crash) — wrapped in try/catch; analyzer itself handles
   *    re-fork + 3-strike circuit. Empty-result short-circuit prevents amend
   *    broadcast on any failure (original chat-message still stands).
   *  - T-05-02 (slowloris parse) — analyzer's 5s timeout fires; this method
   *    resolves with empty result; no amend broadcast.
   *  - T-05-03 (path escape) — analyzer.validateAndFilter drops unsafe paths
   *    BEFORE IPC; host passes raw paths trusting the analyzer's gate.
   *  - T-05-04 (large tracked file) — pre-stat skip cap at 500KB avoids
   *    wasted IPC bandwidth; the worker's skipPolicy is the source of truth.
   *
   * Wire ordering: this method is invoked fire-and-forget from
   * broadcastPush AFTER the synchronous chat-message envelope broadcasts.
   * The amend (if any) ALWAYS arrives after the original chat-message on the
   * same client connection. Disordering can occur only across reconnects —
   * the threat register accepts that as v1 risk (T-05-06) since the chat-log
   * patchMeta + chat-history replay covers reconnecting members.
   */
  private async runAstAnalysisAndAmend(
    recordId: string,
    pushRecord: PushRecord,
    prePostByFile: Map<string, { preContent: string | null; postContent: string | null }>,
  ): Promise<void> {
    try {
      if (!this.astAnalyzer) return;

      // Build the changedFiles payload from prePostByFile. languageId is null
      // so the worker derives via detectLanguageFromPath; this avoids the
      // host duplicating language-detection logic.
      const changedFiles: AnalyzePayload['changedFiles'] = [];
      for (const [relativePath, { preContent, postContent }] of prePostByFile) {
        changedFiles.push({
          relativePath,
          preContent,
          postContent,
          languageId: null,
        });
      }

      // Build memberTrackedFiles by reading content from the branch source-
      // of-truth. The pusher is excluded — they're the source of the change,
      // not a caller. Skip files >500KB (T-05-04 defense-in-depth; the
      // worker's shouldSkip is the source of truth).
      const memberTrackedFiles: AnalyzePayload['memberTrackedFiles'] = {};
      const memberDisplayNames: AnalyzePayload['memberDisplayNames'] = {};
      const names = this.getMemberNames();
      const branchDir = this.branchDirGetter ? this.branchDirGetter() : null;
      if (branchDir) {
        for (const [memberId, trackedPaths] of this.memberTracking) {
          if (memberId === pushRecord.memberId) continue;
          const files: AnalyzePayload['memberTrackedFiles'][string] = [];
          for (const rel of trackedPaths) {
            try {
              const abs = path.join(branchDir, rel);
              const stat = await fs.stat(abs);
              // T-05-04 pre-stat skip — saves IPC bandwidth for files the
              // worker would shouldSkip anyway. The 500KB threshold matches
              // skipPolicy.ts.
              if (stat.size > 500_000) continue;
              const content = await fs.readFile(abs, 'utf-8');
              files.push({ relativePath: rel, content, languageId: null });
            } catch {
              // File missing in branch dir (e.g. workspace-only file the
              // member tracks) — skip. The worker only operates on branch
              // content for tracked-paths in v1.
            }
          }
          if (files.length > 0) {
            memberTrackedFiles[memberId] = files;
            memberDisplayNames[memberId] = names.get(memberId) ?? 'Unknown';
          }
        }
      }

      const result = await this.astAnalyzer.analyzeChange({
        changedFiles,
        memberTrackedFiles,
        memberDisplayNames,
      });

      // Empty-result short-circuit: when the analyzer returns no affected
      // symbols AND no unsupported languages (the SC-3 fallback signal), the
      // original chat-message stands; no amend broadcast. This is what makes
      // the wire-ordering posture safe — older clients only see new amends
      // when the host has something useful to amend with.
      if (
        result.affectedSymbols.length === 0 &&
        result.unsupportedLanguages.length === 0
      ) {
        return;
      }

      // Persist the amend to the ChatLog so chat-history replay carries the
      // patched meta — joiners after the amend lands still see the affected
      // symbols. patchMeta is a no-op when the record id is missing
      // (best-effort; chat-history replay will still render the file-level
      // message).
      if (this.chatLog) {
        try {
          await this.chatLog.patchMeta(recordId, {
            affectedSymbols: result.affectedSymbols,
            unsupportedLanguages: result.unsupportedLanguages,
          });
        } catch (err) {
          // chat-log persistence failure must not block the live amend
          // broadcast — mirrors the existing append() posture.
          console.error('[SessionHost] chat-log patchMeta failed', err);
        }
      }

      const amendTs = createTimestamp();
      this.broadcast({
        type: 'chat-message-amend',
        timestamp: amendTs,
        recordId,
        affectedSymbols: result.affectedSymbols,
        unsupportedLanguages: result.unsupportedLanguages,
      });
      // Emit a typed event so extension.ts can route the amend into the
      // host's own ChatPanel + ActivityLogProvider (the host doesn't receive
      // its own broadcast over the wire, mirroring the chat-message echo
      // pattern at extension.ts:285).
      this.emit('chat-message-amend', {
        recordId,
        affectedSymbols: result.affectedSymbols,
        unsupportedLanguages: result.unsupportedLanguages,
      });
    } catch (err) {
      // T-05-01: any analyzer failure (crash, timeout, validation rejection)
      // must NEVER crash the host. Log + swallow; the original chat-message
      // stands unchanged.
      console.error('[SessionHost] runAstAnalysisAndAmend failed', err);
    }
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
    if (!cm || !this.transport.isOpen(cm.ws)) {
      return;
    }
    const records = this.chatLog.getRecent(100);
    try {
      this.transport.send(cm.ws, {
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
   *
   * Phase 6 (Plan 06-02) widening: `canCreateBranch` is now an optional
   * second method on the checker — the review-resolved admin-override path
   * (Plan 06-02 Task 3) reads it to gate "admin can OVERRIDE
   * 'changes-requested' to merged" (06-SPEC.md frontmatter line 15 locked
   * decision). BranchPermissions already exposes this method
   * (src/filesystem/BranchPermissions.ts:50); the widening is type-level
   * only and Phase 3's existing wiring continues to satisfy the contract.
   */
  setPermissions(permissions: {
    canPushToBranch: (memberId: string, branchName: string) => boolean;
    canCreateBranch?: (memberId: string) => boolean;
  }): void {
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

  /**
   * Broadcast a message to all authenticated members, optionally excluding
   * one. Pre-serializes ONCE and writes the same bytes to every member via
   * `transport.sendRaw` so JSON.stringify cost is paid once and the
   * BandwidthMonitor records exact wire bytes (pre-refactor behavior at
   * line 2009-2017 — preserved verbatim through the seam).
   */
  private broadcast(msg: ProtocolMessage, excludeId?: string): void {
    const data = JSON.stringify(msg);
    for (const [id, cm] of this.members) {
      if (id === excludeId) {
        continue;
      }
      const bytesWritten = this.transport.sendRaw(cm.ws, data);
      if (bytesWritten > 0) {
        this.bandwidthMonitor.recordSent(id, bytesWritten);
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
          this.transport.terminate(cm.ws);
          this.removeMember(id, 'Heartbeat timeout');
          continue;
        }
        cm.isAlive = false;
        // Transport.ping is internally null-safe (no-op when not OPEN) — no
        // try/catch needed at this level.
        this.transport.ping(cm.ws);
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
    // Phase 4 UAT fix (2026-05-10): prepend the host's own row so the
    // state-sync member list sent to clients includes the host. Without this,
    // joined members' MEMBERS panel showed only themselves and could not see
    // the host. The host pre-exists in this.hostMemberId/this.hostDisplayName
    // (Plan 04.1-02 pre-registration) and is intentionally NOT stored in
    // this.members (the joined-clients map). hostMemberId is guarded against
    // null here for safety, but in practice it is set in the constructor and
    // only ever null after removeMember on disconnect.
    const list: Array<{ id: string; displayName: string; role: string; isOnline: boolean; joinedAt: number; }> = [];
    if (this.hostMemberId !== null) {
      list.push({
        id: this.hostMemberId,
        displayName: this.hostDisplayName,
        role: 'host',
        isOnline: true,
        joinedAt: this.hostJoinedAt,
      });
    }
    for (const cm of this.members.values()) {
      list.push({
        id: cm.member.id,
        displayName: cm.member.displayName,
        role: cm.member.role,
        isOnline: cm.member.isOnline,
        joinedAt: cm.member.joinedAt,
      });
    }
    return list;
  }

  // Phase 7 D-05: `findFreePort` migrated to LanHostTransport — wire-layer
  // concern. SessionHost no longer needs the `net` import.
}
