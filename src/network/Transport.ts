/**
 * Transport abstraction — the architectural seam from 07-CONTEXT.md D-05.
 *
 * SessionHost and SessionClient depend on these two interfaces (HostTransport
 * and ClientTransport), NOT on the `ws` library directly. The LAN
 * implementation lives in src/network/LanTransport.ts; future Wave 2 work
 * adds CloudTransport (07-04) which wraps an outbound WSS to a relay server,
 * and a future security phase adds CryptoTransport (L3 E2E body encryption)
 * as a decorator. None of those touch SessionHost / SessionClient.
 *
 * Two interfaces (not one) mirror the existing `WebSocketServer` vs
 * `WebSocket` asymmetry in the codebase:
 *   - HostTransport accepts MANY inbound connections (LAN: WebSocketServer
 *     bound to a port; future Cloud: a fanout layered on a single relay
 *     socket).
 *   - ClientTransport opens ONE outbound connection (LAN: ws:// to host;
 *     future Cloud: wss:// to relay).
 *
 * The TransportConnection handle returned by HostTransport.onConnection is
 * `unknown` on purpose: SessionHost MUST go through HostTransport.send /
 * .closeConnection / .isOpen / .ping rather than reaching into a concrete
 * WebSocket. This pre-pays the L3 CryptoTransport decorator story (T-07-RX
 * mitigation in PLAN frontmatter): the decorator can wrap any Transport
 * without exposing the wrapped socket to controllers.
 *
 * NOTE: Heartbeat / reconnect machinery in src/network/heartbeat.ts is
 * reused unchanged. The Transport surface exposes ping() and onPong() so
 * HeartbeatManager can drive liveness through the seam without
 * re-implementation (PATTERNS.md Pattern C / D-05 quality bar).
 */

import type { IncomingMessage } from 'http';
import type { ProtocolMessage } from './protocol.js';

/**
 * Opaque per-connection handle returned by HostTransport.onConnection and
 * passed back into every per-connection method (send, ping, isOpen, etc.).
 * Implementations choose the concrete type:
 *   - LanHostTransport: `WebSocket` from the `ws` library
 *   - future CloudHostTransport: a wrapper around a relay-routed pseudo-socket
 *
 * Callers MUST NOT cast this to a concrete type. All wire I/O routes through
 * the HostTransport surface so a future CryptoTransport decorator can
 * intercept reads/writes without changes to SessionHost.
 */
export type TransportConnection = unknown;

/**
 * Host-side transport: accepts inbound peer connections, sends/receives
 * protocol messages per connection, and drives heartbeat ping/pong + close
 * lifecycle. Asymmetric with ClientTransport because the host listens for
 * many peers while a client opens a single socket.
 */
export interface HostTransport {
  /**
   * Begin accepting connections. Resolves with the actual port bound (LAN:
   * `findFreePort()` is internal to LanHostTransport when port === 0; future
   * Cloud: returns 0 because no local port is bound).
   *
   * @param port - Preferred port (0 = ephemeral)
   * @param maxPayloadBytes - Per-frame ceiling, forwarded to the underlying
   *                          WebSocketServer (T-01-04 mitigation preserved).
   */
  listen(port: number, maxPayloadBytes: number): Promise<number>;

  /**
   * Register a handler invoked when a new peer connects. The handler
   * receives the opaque TransportConnection plus the underlying
   * IncomingMessage so the host can read req.socket.remoteAddress for rate
   * limiting (T-01-03). Multiple handlers can be registered; all fire.
   */
  onConnection(handler: (conn: TransportConnection, req: IncomingMessage) => void): void;

  /**
   * Register a handler for transport-level errors that occur AFTER
   * `listen()` has resolved. Startup errors (bind failure) cause listen()
   * to reject — they do NOT call this handler.
   */
  onError(handler: (err: Error) => void): void;

  /**
   * Send a protocol message to a specific peer connection. Returns false
   * if the connection is not in OPEN state — mirrors the existing
   * `if (ws.readyState === WebSocket.OPEN)` guard pattern used throughout
   * SessionHost (lines 1600, 1853, 2009 pre-refactor).
   */
  send(conn: TransportConnection, msg: ProtocolMessage): boolean;

  /**
   * Send a raw, already-serialized string to a specific peer. Used by the
   * SessionHost.broadcast path which pre-serializes once and writes the
   * same bytes to every member to amortize JSON.stringify cost AND to feed
   * the BandwidthMonitor accurate per-member counters (existing behavior
   * at line 2011-2013 pre-refactor — preserved verbatim).
   *
   * Returns the number of bytes written, or 0 if the connection is closed.
   */
  sendRaw(conn: TransportConnection, data: string): number;

  /**
   * Register a per-connection inbound-message handler. Caller invokes this
   * once per connection inside its onConnection handler (mirrors today's
   * `ws.on('message', ...)` per-connection binding).
   */
  onMessage(
    conn: TransportConnection,
    handler: (raw: Buffer | ArrayBuffer | Buffer[]) => void,
  ): void;

  /**
   * Per-connection close handler (mirrors today's `ws.on('close', ...)`).
   */
  onClose(
    conn: TransportConnection,
    handler: (code: number, reason: Buffer) => void,
  ): void;

  /**
   * Per-connection error handler (mirrors today's `ws.on('error', ...)`).
   * Errors are typically followed by 'close'; this hook lets SessionHost
   * mirror the existing "error is followed by close — clean up there"
   * posture without crashing.
   */
  onErrorPerConnection(conn: TransportConnection, handler: (err: Error) => void): void;

  /**
   * Send a heartbeat ping to a specific peer. No-op if the connection is
   * not OPEN (mirrors the existing `try { cm.ws.ping() } catch {}` pattern
   * at SessionHost line 2038).
   */
  ping(conn: TransportConnection): void;

  /**
   * Per-connection native-pong handler (mirrors today's
   * `ws.on('pong', ...)` at SessionHost line 592). HeartbeatManager hooks
   * into this so liveness detection survives the refactor.
   */
  onPong(conn: TransportConnection, handler: () => void): void;

  /**
   * True if the per-connection socket is OPEN (replaces the
   * `ws.readyState === WebSocket.OPEN` pattern at SessionHost lines 1600,
   * 1853, 2009).
   */
  isOpen(conn: TransportConnection): boolean;

  /**
   * Forcibly terminate a single peer connection (no graceful close frame).
   * Mirrors the existing `ws.terminate()` call at SessionHost line 2032
   * (heartbeat-timeout cleanup).
   */
  terminate(conn: TransportConnection): void;

  /**
   * Close a single peer connection with a code + reason. Mirrors today's
   * `ws.close(code, reason)` at SessionHost lines 323, 367, 633, 646, 776,
   * 815.
   */
  closeConnection(conn: TransportConnection, code: number, reason: string): void;

  /**
   * Shut down the whole listener; existing connections are forced-closed
   * by the underlying WebSocketServer.close() at line 331 pre-refactor.
   */
  close(): void;
}

/**
 * Client-side transport: opens a single outbound connection (LAN:
 * `ws://host:port`; future Cloud: `wss://relay`), sends protocol messages,
 * drives heartbeat ping/pong + reconnect lifecycle.
 *
 * Operates on a single implicit connection — no per-connection handle
 * threading (unlike HostTransport).
 */
export interface ClientTransport {
  /**
   * Open the socket. Resolves true if the underlying transport-level
   * connection opened successfully (LAN: WebSocket fired 'open'), false on
   * transport-level failure (LAN: 'error' or 'close' before 'open' fired).
   *
   * NOTE: SessionClient layers an additional auth-response wait above
   * transport.connect() — the outer `SessionClient.connect()` Promise
   * resolves on auth-response, not on transport open. This is a deliberate
   * separation of concerns (transport = wire; SessionClient = protocol).
   */
  connect(): Promise<boolean>;

  /** Register the "socket opened" handler (replaces `ws.on('open', ...)`). */
  onOpen(handler: () => void): void;

  /** Register the inbound-message handler (replaces `ws.on('message', ...)`). */
  onMessage(handler: (raw: Buffer | ArrayBuffer | Buffer[]) => void): void;

  /** Register the close handler (replaces `ws.on('close', ...)`). */
  onClose(handler: (code: number, reason: Buffer) => void): void;

  /** Register the error handler (replaces `ws.on('error', ...)`). */
  onError(handler: () => void): void;

  /**
   * Send a protocol message. No-op (returns false) if the socket is not
   * OPEN — mirrors the existing
   * `if (this.ws && this.ws.readyState === WebSocket.OPEN) sendMessage(...)`
   * pattern at SessionClient lines 271, 459, 531.
   */
  send(msg: ProtocolMessage): boolean;

  /**
   * Send a heartbeat ping (mirrors `this.ws.ping()` at SessionClient
   * line 460). No-op if the socket is not OPEN.
   */
  ping(): void;

  /** Native-pong handler (mirrors `this.ws.on('pong', ...)` at line 451). */
  onPong(handler: () => void): void;

  /**
   * True if the socket is OPEN (replaces `this.ws.readyState ===
   * WebSocket.OPEN` at lines 271, 459, 531).
   */
  isOpen(): boolean;

  /**
   * Close the socket. Mirrors `this.ws.close()` at SessionClient lines
   * 466 + 555. Defaults match the existing call sites: code defaults to
   * 1000 (normal closure), reason is optional.
   *
   * SessionClient signals intentional-close to its own close handler via
   * an internal flag — the Transport surface itself does NOT need a
   * separate "markIntentionalClose" hook because the close() call is the
   * intentional signal.
   */
  close(code?: number, reason?: string): void;
}
