/**
 * LAN transport implementation — the home of all `ws` library usage in this
 * project after the Phase 7 D-05 refactor.
 *
 * LanHostTransport wraps a `WebSocketServer` (host side); LanClientTransport
 * wraps an outbound `new WebSocket(`ws://...`)` (client side). Both
 * implement the interfaces in src/network/Transport.ts so SessionHost and
 * SessionClient can stay transport-agnostic.
 *
 * Behavior is BYTE-IDENTICAL to the pre-refactor inline `ws` usage that
 * lived in SessionHost.ts:286-308 and SessionClient.ts:128-191. The refactor
 * is a pure extraction — no semantics change, no new dependencies, no
 * envelope wrapping (LAN keeps raw protocol.ts messages on the wire per
 * CONTEXT D-06 line 111).
 *
 * Notes:
 *   - `findFreePort()` migrated from SessionHost into LanHostTransport so
 *     SessionHost no longer imports from `net`.
 *   - Heartbeat / reconnect machinery from src/network/heartbeat.ts is
 *     untouched and reused via the Transport surface (ping / onPong /
 *     isOpen).
 *   - No re-implementation of exponential backoff — the delay helper from
 *     heartbeat.ts stays there and is owned by SessionClient (PATTERNS.md
 *     Pattern C / source-grep gate in transportSeam.test.ts Test D).
 */

import { createServer } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { sendMessage } from './protocol.js';
import type { ProtocolMessage } from './protocol.js';
import type {
  HostTransport,
  ClientTransport,
  TransportConnection,
} from './Transport.js';

// ---------------------------------------------------------------------------
// LanHostTransport — wraps WebSocketServer (extracted from SessionHost.ts
// pre-refactor lines 286-308, 321-333).
// ---------------------------------------------------------------------------

/**
 * LAN host transport. Wraps a `ws` `WebSocketServer` bound to a local port
 * (or an ephemeral port via findFreePort when port === 0).
 *
 * Per-connection handlers (onMessage / onClose / onPong / onErrorPerConnection)
 * are routed straight through to `ws.on(...)` so handler ordering and
 * semantics match the pre-refactor code exactly.
 */
export class LanHostTransport implements HostTransport {
  private wss: WebSocketServer | null = null;
  private readonly connectionHandlers: Array<
    (conn: TransportConnection, req: IncomingMessage) => void
  > = [];
  private readonly errorHandlers: Array<(err: Error) => void> = [];

  /**
   * Begin accepting connections. When `port === 0`, `findFreePort()` is
   * used to obtain an ephemeral port (mirrors SessionHost.start() lines
   * 280-282 pre-refactor). The resolved Promise carries the bound port.
   */
  async listen(port: number, maxPayloadBytes: number): Promise<number> {
    const boundPort = port === 0 ? await this.findFreePort() : port;
    return new Promise<number>((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({
          port: boundPort,
          maxPayload: maxPayloadBytes,
          perMessageDeflate: false,
        });

        this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
          for (const handler of this.connectionHandlers) {
            try {
              handler(ws, req);
            } catch {
              // Handler errors must not crash the transport
            }
          }
        });

        this.wss.on('listening', () => {
          resolve(boundPort);
        });

        this.wss.on('error', (err: Error) => {
          // First 'error' before 'listening' rejects the listen() Promise
          // (matches pre-refactor behavior). Subsequent errors after listen
          // resolved fan out via errorHandlers so the host can surface them.
          reject(err);
          for (const handler of this.errorHandlers) {
            try {
              handler(err);
            } catch {
              // ignore
            }
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  onConnection(
    handler: (conn: TransportConnection, req: IncomingMessage) => void,
  ): void {
    this.connectionHandlers.push(handler);
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  send(conn: TransportConnection, msg: ProtocolMessage): boolean {
    const ws = conn as WebSocket;
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      sendMessage((d) => ws.send(d), msg);
      return true;
    } catch {
      return false;
    }
  }

  sendRaw(conn: TransportConnection, data: string): number {
    const ws = conn as WebSocket;
    if (ws.readyState !== WebSocket.OPEN) return 0;
    try {
      ws.send(data);
      return Buffer.byteLength(data, 'utf-8');
    } catch {
      return 0;
    }
  }

  onMessage(
    conn: TransportConnection,
    handler: (raw: Buffer | ArrayBuffer | Buffer[]) => void,
  ): void {
    (conn as WebSocket).on('message', handler);
  }

  onClose(
    conn: TransportConnection,
    handler: (code: number, reason: Buffer) => void,
  ): void {
    (conn as WebSocket).on('close', handler);
  }

  onErrorPerConnection(
    conn: TransportConnection,
    handler: (err: Error) => void,
  ): void {
    (conn as WebSocket).on('error', handler);
  }

  ping(conn: TransportConnection): void {
    const ws = conn as WebSocket;
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.ping();
    } catch {
      // Ping failure -- will be cleaned up next cycle (matches pre-refactor
      // SessionHost.startHeartbeat line 2039 posture)
    }
  }

  onPong(conn: TransportConnection, handler: () => void): void {
    (conn as WebSocket).on('pong', handler);
  }

  isOpen(conn: TransportConnection): boolean {
    return (conn as WebSocket).readyState === WebSocket.OPEN;
  }

  terminate(conn: TransportConnection): void {
    try {
      (conn as WebSocket).terminate();
    } catch {
      // Already closed
    }
  }

  closeConnection(
    conn: TransportConnection,
    code: number,
    reason: string,
  ): void {
    try {
      (conn as WebSocket).close(code, reason);
    } catch {
      // Already closed
    }
  }

  close(): void {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  /**
   * Find a free port by briefly creating a TCP server on port 0. Migrated
   * verbatim from SessionHost.findFreePort (pre-refactor lines 2115-2129)
   * — wire-layer concern, belongs to the transport.
   */
  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.listen(0, () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          const port = addr.port;
          srv.close(() => resolve(port));
        } else {
          srv.close(() =>
            reject(new Error('Could not determine free port')),
          );
        }
      });
      srv.on('error', reject);
    });
  }
}

// ---------------------------------------------------------------------------
// LanClientTransport — wraps outbound `new WebSocket(`ws://...`)` (extracted
// from SessionClient.ts pre-refactor lines 123-192).
// ---------------------------------------------------------------------------

/**
 * LAN client transport. Wraps an outbound `ws://host:port` WebSocket.
 *
 * connect() resolves on the underlying socket's 'open' (true) or
 * 'error'/'close' before open (false). SessionClient layers auth-response
 * waiting ABOVE this — that is intentional separation of wire vs. protocol
 * concerns.
 *
 * Reconnect IS NOT implemented here. SessionClient owns reconnect via
 * ReconnectManager from heartbeat.ts — the source-grep gate in
 * transportSeam.test.ts (Test D) enforces that this file has no
 * exponential-backoff math nor backoff-delay helper calls.
 */
export class LanClientTransport implements ClientTransport {
  private ws: WebSocket | null = null;
  private readonly openHandlers: Array<() => void> = [];
  private readonly messageHandlers: Array<
    (raw: Buffer | ArrayBuffer | Buffer[]) => void
  > = [];
  private readonly closeHandlers: Array<(code: number, reason: Buffer) => void> = [];
  private readonly errorHandlers: Array<() => void> = [];
  private readonly pongHandlers: Array<() => void> = [];

  constructor(
    private readonly hostIp: string,
    private readonly port: number,
  ) {}

  async connect(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let resolved = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(`ws://${this.hostIp}:${this.port}`);
      } catch {
        // Synchronous construction failure (e.g. invalid URL). Match
        // SessionClient pre-refactor: surface as false rather than throw
        // — SessionClient.connect() previously called reject(err) here, but
        // the only caller (attemptReconnect via ReconnectManager) treated
        // the rejected Promise the same as Promise<false>. The outer
        // SessionClient now handles its own promise plumbing; we just
        // signal "did not open".
        resolve(false);
        return;
      }
      this.ws = ws;

      ws.on('open', () => {
        for (const h of this.openHandlers) {
          try {
            h();
          } catch {
            // ignore handler error
          }
        }
        if (!resolved) {
          resolved = true;
          resolve(true);
        }
      });

      ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        for (const h of this.messageHandlers) {
          try {
            h(raw);
          } catch {
            // ignore handler error — preserve pre-refactor "must not crash"
            // posture from SessionClient.ts:161-162
          }
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        for (const h of this.closeHandlers) {
          try {
            h(code, reason);
          } catch {
            // ignore
          }
        }
        if (!resolved) {
          // Close before open — resolve false so the caller knows the
          // transport-level connect attempt failed.
          resolved = true;
          resolve(false);
        }
      });

      ws.on('error', () => {
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

  send(msg: ProtocolMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      sendMessage((d) => ws.send(d), msg);
      return true;
    } catch {
      return false;
    }
  }

  ping(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.ping();
    } catch {
      // ignore
    }
  }

  onPong(handler: () => void): void {
    this.pongHandlers.push(handler);
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  close(code?: number, reason?: string): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(code ?? 1000, reason);
      } catch {
        // Already closed
      }
    }
  }
}
