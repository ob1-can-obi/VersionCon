/**
 * CloudTransport — the second ClientTransport implementation (Phase 7 Plan
 * 07-04). Wraps an outbound `wss://` connection to a relay server, carries
 * the JWT (issued by TokenService — 07-03) in the
 * `Authorization: Bearer <jwt>` HTTP header on the WSS upgrade, wraps every
 * outbound ProtocolMessage in a CloudEnvelope (07-02), unwraps every inbound
 * envelope back to a ProtocolMessage, maps WSS close codes to cloud-mode
 * lifecycle states for StatusBarManager (07-07), and reuses ReconnectManager
 * from src/network/heartbeat.ts (PATTERNS Pattern C — do NOT re-implement
 * exponential backoff).
 *
 * Seam discipline:
 *   - CloudTransport implements the ClientTransport interface from 07-01
 *     (src/network/Transport.ts) — drop-in alongside LanClientTransport.
 *   - CloudTransport is byte-shape-only: it NEVER inspects payload semantics
 *     (no `msg.type === ...` discrimination). Protocol logic stays in
 *     SessionHost / SessionClient. The unwrap → re-serialize round-trip is
 *     deliberate so the upstream `parseMessage(raw.toString())` call site
 *     in SessionClient is identical for LAN and Cloud transports.
 *   - One class (NOT a host/client pair) handles BOTH host and member roles
 *     in cloud mode — D-04: both endpoints open outbound, no port-forwarding.
 *     The role is communicated via the JWT's `role` claim (set by 07-03);
 *     CloudTransport itself is role-agnostic.
 *   - CloudTransport is RELAY-PORTABLE: no imports from `vscode`, `../ui/`,
 *     or `../client/SessionClient`. Relay-server packages (07-09) can
 *     consume this module verbatim if a future need arises.
 *
 * Threat-model anchors:
 *   - T-07-03 (Bearer-token leak via URL): JWT rides in the Authorization
 *     header via the `ws` library's `headers` option. The relay URL is used
 *     verbatim — CloudTransport never mutates / appends. Source-grep gates
 *     (cloudTransport.test.ts Test #13) forbid query-string credential
 *     parameters in this file and any wss URL with a query string.
 *   - T-07-08 (Oversized inbound frame): `maxPayload: 1024 * 1024` (1 MiB)
 *     passed to `new WebSocket(...)`. ws library rejects oversized frames
 *     with close code 1009; our close handler maps that to 'relay-unreachable'.
 *   - T-07-envelope-shape (Malformed envelope crashes ws loop): the
 *     ws.on('message') body is wrapped in try/catch; any throw routes to
 *     onError handlers — the ws event loop never sees an uncaught throw.
 *   - T-07-encrypted-skew (Future L3 peer sends encrypted:true to a v1
 *     CloudTransport): 07-02's `unwrap` throws EnvelopeEncryptedNotSupportedError;
 *     our catch block surfaces via onError — loud failure, not silent drop.
 *     The DISTINCT error class is preserved at the throw site so future L3
 *     clients can `instanceof`-discriminate.
 *   - T-07-reconnect-loop (4404 burns CPU on hopeless retries):
 *     `mapCloseCodeToState` returns 'session-not-found' for 4404; reconnect
 *     is scheduled ONLY when state === 'relay-unreachable'. 4404 / 1000 are
 *     terminal.
 */

import { WebSocket } from 'ws';
import { ReconnectManager } from './heartbeat.js';
import {
  wrap,
  serialize,
  deserialize,
} from './CloudEnvelope.js';
import type { ProtocolMessage } from './protocol.js';
import type { ClientTransport } from './Transport.js';

/**
 * The three cloud-mode lifecycle states surfaced to StatusBarManager (07-07),
 * plus 'disconnected' for intentional shutdown. CloudTransport emits these
 * via `onStateChange` — never the relay URL, never the session id, never
 * the token (T-07-state-leak — handlers receive ONLY the enum value).
 *
 * Mapping anchored in 07-CONTEXT D-10 + 07-RESEARCH §Open Q 5:
 *   - 'connected'         — WSS socket opened cleanly
 *   - 'session-not-found' — relay closed with 4404 (custom application code)
 *   - 'relay-unreachable' — 1006 abnormal close OR pre-open TCP/TLS failure
 *                           OR any other non-1000/4404 close code
 *   - 'disconnected'      — 1000 normal closure (intentional or relay-side
 *                           graceful)
 */
export type CloudConnectionState =
  | 'connected'
  | 'session-not-found'
  | 'relay-unreachable'
  | 'disconnected';

/**
 * Structural-shape interface used by the constructor's discretionary
 * `reconnectManager` injection parameter. Production callers use the
 * concrete `ReconnectManager` from `./heartbeat`; tests inject a spy that
 * structurally satisfies this shape without implementing the full class.
 *
 * Keep this interface NARROW — only the two methods CloudTransport actually
 * uses (scheduleReconnect + abort). Widening it pulls test seams toward the
 * concrete class and erodes the test isolation.
 */
export interface ReconnectManagerLike {
  scheduleReconnect(connect: () => Promise<boolean>, onFailed: () => void): void;
  abort(): void;
}

/**
 * Map a WSS close code (RFC 6455 §7.4 + custom 4xxx range) to the v1
 * three-state lifecycle. Exported for testability + grep auditability —
 * keeps the mapping in ONE place so the threat-model reviewer can scan a
 * single function for the full close-code → state translation.
 *
 * @param code - WSS close code
 * @param hadOpened - True if the 'open' event fired before close (kept as a
 *                    parameter so future "soft close" branches can
 *                    distinguish post-open vs pre-open failures; today both
 *                    paths funnel into 'relay-unreachable' for non-1000/4404
 *                    codes).
 */
export function mapCloseCodeToState(
  code: number,
  hadOpened: boolean,
): CloudConnectionState {
  if (code === 4404) return 'session-not-found';
  if (code === 1000) return 'disconnected';
  // 1006 abnormal closure (no close frame received), 1001 going-away, 1011
  // server error, 4401 invalid token, any other code, or pre-open
  // TCP/TLS failure → relay-unreachable. Pre-open failures arrive at the
  // close handler with code=1006 typically, but we keep the hadOpened
  // parameter so a future "soft close" branch can distinguish.
  void hadOpened;
  return 'relay-unreachable';
}

/**
 * Cloud-mode ClientTransport. Opens ONE outbound wss:// connection to a
 * relay, carries the bearer JWT in the Authorization header, and frames
 * every ProtocolMessage in a CloudEnvelope.
 *
 * Drop-in alongside LanClientTransport. SessionClient does not care which
 * transport it has — the constructor selects via the `transport?` parameter
 * (07-01 seam).
 */
export class CloudTransport implements ClientTransport {
  private ws: WebSocket | null = null;
  private intentionalClose = false;
  private hadOpened = false;
  private readonly reconnect: ReconnectManagerLike;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly WebSocketCtor: any;

  private readonly openHandlers: Array<() => void> = [];
  private readonly messageHandlers: Array<(raw: Buffer | ArrayBuffer | Buffer[]) => void> = [];
  private readonly closeHandlers: Array<(code: number, reason: Buffer) => void> = [];
  private readonly errorHandlers: Array<() => void> = [];
  private readonly pongHandlers: Array<() => void> = [];
  private readonly stateChangeHandlers: Array<(s: CloudConnectionState) => void> = [];

  /**
   * Construct a CloudTransport.
   *
   * @param relayUrl - Full wss:// URL of the relay (e.g. 'wss://relay.fly.dev').
   *                   MUST NOT carry query-string credentials — the caller is
   *                   responsible for passing a clean URL (T-07-03).
   * @param sessionId - Routing key — relay reads ONLY this field of every
   *                    envelope to route bytes between members. Embedded
   *                    in every outbound envelope via `wrap()`.
   * @param token - JWT string issued by TokenService.issue() (07-03). Opaque
   *                to this class; carried verbatim in the Authorization header.
   * @param WebSocketCtor - Discretionary injection seam for testability.
   *                        Defaults to the real `ws.WebSocket`. Tests inject
   *                        a stub that captures construction args + emits
   *                        synthetic events.
   * @param reconnectManager - Discretionary injection seam for testability.
   *                           Defaults to `new ReconnectManager()` (the real
   *                           exponential-backoff machinery from heartbeat.ts).
   *                           Tests inject a spy that records scheduleReconnect
   *                           invocations.
   */
  constructor(
    private readonly relayUrl: string,
    private readonly sessionId: string,
    private readonly token: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    WebSocketCtor: any = WebSocket,
    reconnectManager?: ReconnectManagerLike,
  ) {
    this.WebSocketCtor = WebSocketCtor;
    this.reconnect = reconnectManager ?? new ReconnectManager();
  }

  /**
   * Open the WSS connection. Resolves true on socket-open, false on
   * pre-open failure (transport-level error or close before open). Mirrors
   * LanClientTransport.connect() semantics from 07-01 — the "first envelope
   * round-trip" / auth-response check is SessionClient's job, layered above.
   *
   * Idempotency: scheduling a reconnect re-invokes connect() through the
   * ReconnectManager closure. The class fields (ws, hadOpened, intentionalClose)
   * are reset on each call so successive reconnect cycles are clean.
   */
  async connect(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let resolved = false;
      // Reset per-attempt state. intentionalClose is NOT reset — once a
      // caller signals intent, future reconnect attempts should not undo it.
      this.hadOpened = false;

      try {
        // maxPayload locked to 1 MiB (T-07-08; ASVS V13.1.4). Inline literal
        // so the threat-model source-grep finds the value at the call site.
        // Mirrors the relay-side cap declared in 07-10.
        this.ws = new this.WebSocketCtor(this.relayUrl, {
          headers: { Authorization: `Bearer ${this.token}` },
          maxPayload: 1024 * 1024,
          perMessageDeflate: false,
        });
      } catch {
        // Synchronous construction failure (e.g. malformed URL). Surface as
        // a pre-open relay-unreachable state — the close handler will not
        // run because the constructor threw before any listener was attached.
        this.emitStateChange('relay-unreachable');
        resolve(false);
        return;
      }

      const ws = this.ws;
      if (!ws) {
        // Defensive — should be unreachable because the constructor above
        // either threw (caught) or returned a non-null object.
        this.emitStateChange('relay-unreachable');
        resolve(false);
        return;
      }

      ws.on('open', () => {
        this.hadOpened = true;
        this.emitStateChange('connected');
        for (const h of this.openHandlers) {
          try {
            h();
          } catch {
            // ignore handler error — preserve event-loop safety
          }
        }
        if (!resolved) {
          resolved = true;
          resolve(true);
        }
      });

      ws.on('message', (raw: Buffer) => {
        try {
          const env = deserialize(raw.toString());
          // env.payload is a ProtocolMessage — re-serialize so upstream
          // contract is identical to LanClientTransport (handler receives
          // raw bytes via Buffer; SessionClient calls parseMessage(raw.toString())
          // on the same shape).
          const payloadBytes = Buffer.from(JSON.stringify(env.payload));
          for (const h of this.messageHandlers) {
            try {
              h(payloadBytes);
            } catch {
              // ignore handler error
            }
          }
        } catch {
          // Both EnvelopeShapeError and EnvelopeEncryptedNotSupportedError
          // surface here uniformly via onError. The DISTINCT error class is
          // preserved at the 07-02 throw site for future L3 clients to
          // `instanceof`-discriminate — v1 just needs the alarm to ring.
          for (const h of this.errorHandlers) {
            try {
              h();
            } catch {
              // ignore
            }
          }
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const state = mapCloseCodeToState(code, this.hadOpened);
        this.emitStateChange(state);
        for (const h of this.closeHandlers) {
          try {
            h(code, reason);
          } catch {
            // ignore
          }
        }
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
        if (this.intentionalClose) return;
        // Schedule reconnect ONLY for transient-state closes. 'session-not-found'
        // is terminal (the session is gone; retrying floods the relay) and
        // 'disconnected' indicates a graceful 1000-close that the caller
        // either initiated or accepted (T-07-reconnect-loop).
        if (state === 'relay-unreachable') {
          this.reconnect.scheduleReconnect(
            () => this.connect(),
            () => this.emitStateChange('relay-unreachable'),
          );
        }
      });

      ws.on('error', () => {
        // ws library typically fires 'error' then 'close' — the close
        // handler does the state-mapping work. We just propagate the error
        // to upstream handlers and ensure connect() resolves false if no
        // 'open' fired first. State emission lands when 'close' arrives.
        for (const h of this.errorHandlers) {
          try {
            h();
          } catch {
            // ignore
          }
        }
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      });

      ws.on('pong', () => {
        for (const h of this.pongHandlers) {
          try {
            h();
          } catch {
            // ignore
          }
        }
      });
    });
  }

  onOpen(handler: () => void): void {
    this.openHandlers.push(handler);
  }

  onMessage(handler: (raw: Buffer | ArrayBuffer | Buffer[]) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: (code: number, reason: Buffer) => void): void {
    this.closeHandlers.push(handler);
  }

  onError(handler: () => void): void {
    this.errorHandlers.push(handler);
  }

  onPong(handler: () => void): void {
    this.pongHandlers.push(handler);
  }

  /**
   * Cloud-specific surface (NOT part of the ClientTransport interface). The
   * caller (SessionClient → StatusBarManager 07-07) downcasts via
   * `instanceof CloudTransport` or a typed property check before registering
   * a state-change handler. LAN transports do not have this surface.
   *
   * Handler receives ONLY the state enum value — never the relay URL,
   * never the session id, never the token (T-07-state-leak).
   */
  onStateChange(handler: (s: CloudConnectionState) => void): void {
    this.stateChangeHandlers.push(handler);
  }

  /**
   * Send a ProtocolMessage wrapped in a CloudEnvelope.
   *
   * Optional `target` argument (07-05b extension): when supplied, the envelope
   * gains a `target` field for unicast routing on the relay. When omitted, the
   * envelope's broadcast byte-shape from 07-02 is preserved exactly
   * (JSON.stringify omits undefined keys).
   *
   * Non-breaking: existing call-sites continue to call `send(msg)` and get
   * broadcast semantics. CloudHostTransport (07-05b) calls `send(msg, target)`
   * for per-member unicast routing.
   */
  send(msg: ProtocolMessage, target?: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      const envelope = wrap(this.sessionId, msg, target);
      this.ws.send(serialize(envelope));
      return true;
    } catch {
      return false;
    }
  }

  ping(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.ping();
    } catch {
      // Ping failure — heartbeat machinery will clean up next cycle
    }
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Signal that the next close is caller-initiated and the reconnect
   * machinery must NOT engage. Defense in depth: sets `intentionalClose`
   * (gates the close-handler reconnect branch) AND calls `reconnect.abort()`
   * so any already-scheduled retry is cancelled. Either guard alone would
   * suffice; both together remove the race between a pending timer and the
   * close handler.
   *
   * NOTE: this method is NOT on the ClientTransport interface from 07-01
   * (07-01's design choice — SessionClient.disconnectInternal sets its own
   * `intentionalClose` flag and uses `transport.close()` as the intentional
   * signal for LAN). CloudTransport adds it as a public method so cloud-mode
   * callers can prove the close is intentional without ambiguity. 07-06's
   * SessionClient.disconnectInternal will call this when the transport is
   * a CloudTransport instance.
   */
  markIntentionalClose(): void {
    this.intentionalClose = true;
    this.reconnect.abort();
  }

  /**
   * Close the WSS connection. Defaults match LanClientTransport — code
   * defaults to 1000 (normal closure). Idempotent — closing an already-closed
   * socket is safe.
   *
   * Does NOT mark the close as intentional — callers wanting that semantic
   * MUST call `markIntentionalClose()` first. This separation lets callers
   * choose between "soft close, allow reconnect" and "hard close, suppress
   * reconnect".
   */
  close(code: number = 1000, reason?: string): void {
    const ws = this.ws;
    if (ws) {
      try {
        ws.close(code, reason);
      } catch {
        // already closed
      }
    }
  }

  private emitStateChange(state: CloudConnectionState): void {
    for (const h of this.stateChangeHandlers) {
      try {
        h(state);
      } catch {
        // ignore handler error
      }
    }
  }
}
