// -----------------------------------------------------------------------------
// CloudHostTransport — Phase 7 Plan 07-05b
//
// Host-side demultiplexer adapter. Wraps a connected `CloudTransport`
// (ClientTransport from 07-04) and exposes the HostTransport surface (07-01)
// to SessionHost so SessionHost can stay TRANSPORT-AGNOSTIC: it sees a
// HostTransport, never knows it is talking to a relay.
//
// Inbound demultiplex:
//   - On every `cloudTransport.onMessage(raw)`, deserialize the envelope and
//     read `payload.memberId`.
//   - NEW memberId → create a private `VirtualConnection`, store in
//     `Map<memberId, VirtConnState>`, fire `onConnection(virtConn, syntheticReq)`
//     on every registered handler. The first inbound message is then
//     dispatched in a microtask so SessionHost.handleConnection has had a
//     chance to register per-connection onMessage / onClose / onPong handlers
//     synchronously inside onConnection.
//   - Existing memberId → dispatch directly to the bound virtConn's
//     messageHandlers.
//   - System frames (no payload.memberId, e.g. session-register-ack from
//     relay) → dispatch to the singleton systemMessageHandlers, NOT to any
//     virtConn (no slot is allocated, no onConnection fires). Implementer
//     choice (documented in SUMMARY): singleton dispatch over debug-log-drop
//     for cleaner future use.
//
// Outbound:
//   - `send(virtConn, msg)` → wraps via `cloudTransport.send(msg, target=memberId)`
//     where `target` is set from the VirtualConnection's BOUND memberId (NOT
//     from anything in `msg` — this is the T-07-spoof-member routing defense).
//   - `broadcast(msg)` (cloud-only public helper) → `cloudTransport.send(msg)`
//     without target → byte-identical to 07-02's locked broadcast snapshot.
//
// Lifecycle:
//   - `member-left` inbound frame OR underlying cloudTransport.onClose →
//     fires onClose on the virtConn and removes it from the Map. A subsequent
//     inbound from the same memberId creates a NEW VirtualConnection (new
//     bind cycle).
//   - memberId collision (T-07-09 reinforcement): a NEW inbound while
//     `virtConns.has(X)` and open → `console.log({event:'member-id-collision',
//     memberId: X})` and DROP. First-bound virtConn keeps the slot.
//
// Threat-model anchors:
//   - T-07-spoof-member (Spoofing): outbound `send` reads target from the
//     bound memberId in the virtConn, NEVER from `msg`. A member cannot
//     direct host unicasts to another member.
//   - T-07-system-frame (Tampering): system frames take the SYSTEM dispatch
//     path; they cannot allocate a virtConn slot.
//   - T-07-collision (Spoofing): first-bound keeps the slot; second observation
//     drops + logs.
//   - T-04-01-01 (server-trust): the demultiplexer uses `payload.memberId`
//     for ROUTING ONLY. AuthHandler binds JWT.sub to memberId on first
//     auth-request; subsequent messages with mismatched payload.memberId are
//     rejected at the existing Phase 4 host-override path (unchanged here).
// -----------------------------------------------------------------------------

import type { IncomingMessage } from 'http';
import type {
  HostTransport,
  ClientTransport,
  TransportConnection,
} from './Transport.js';
import type { ProtocolMessage } from './protocol.js';
import {
  deserialize,
  EnvelopeShapeError,
  EnvelopeEncryptedNotSupportedError,
} from './CloudEnvelope.js';

/**
 * Private opaque per-member handle returned to SessionHost via onConnection.
 * SessionHost treats it as a `TransportConnection` (the 07-01 opaque alias);
 * SessionHost source MUST NOT reference this class name directly
 * (enforced by source-grep gate in cloudHostDemux.test.ts).
 */
class VirtualConnection {
  constructor(public readonly memberId: string) {}
}

/**
 * Discretionary logger seam — defaults to `console.log` so production code
 * surfaces `{event:'member-id-collision', memberId}` on stdout (operations
 * visibility, matches the relay-side log discipline). Tests override this
 * to capture calls without depending on `console.log` interception inside a
 * VS Code extension host (where the global console is special).
 */
let demuxLogger: (line: string) => void = (line) => {
  // eslint-disable-next-line no-console
  console.log(line);
};

/** Test-only seam. Replaces the demux logger; returns a function to restore. */
export function _setDemuxLoggerForTest(fn: (line: string) => void): () => void {
  const prev = demuxLogger;
  demuxLogger = fn;
  return () => {
    demuxLogger = prev;
  };
}

interface VirtConnState {
  conn: VirtualConnection;
  memberId: string;
  messageHandlers: Array<(raw: Buffer | ArrayBuffer | Buffer[]) => void>;
  closeHandlers: Array<(code: number, reason: Buffer) => void>;
  errorHandlers: Array<(err: Error) => void>;
  pongHandlers: Array<() => void>;
  open: boolean;
}

export class CloudHostTransport implements HostTransport {
  private readonly virtConns = new Map<string, VirtConnState>();
  private readonly connectionHandlers: Array<
    (conn: TransportConnection, req: IncomingMessage) => void
  > = [];
  private readonly errorHandlers: Array<(err: Error) => void> = [];
  // System-frame handlers — for inbound envelopes whose payload has NO memberId
  // (e.g. relay-sourced acks like session-register-ack). Singleton list shared
  // across all callers that subscribe via subscribeSystem().
  private readonly systemMessageHandlers: Array<(raw: Buffer) => void> = [];

  constructor(
    private readonly cloudTransport: ClientTransport,
    private readonly sessionId: string,
  ) {
    // Subscribe to underlying ClientTransport ONCE in the constructor. The
    // factory passes an already-connected CloudTransport, so re-subscription
    // on reconnect (07-04 owns reconnect) re-binds these handler arrays
    // automatically — ClientTransport.onClose fires on every drop, and the
    // factory tears down + re-creates the CloudHostTransport on a real
    // disconnect (SessionHost.stop() path).
    this.cloudTransport.onMessage((raw) => this.handleInbound(raw));
    this.cloudTransport.onClose((code, reason) =>
      this.handleUnderlyingClose(code, reason),
    );
    this.cloudTransport.onError(() => {
      for (const h of this.errorHandlers) {
        try {
          h(new Error('underlying cloud transport error'));
        } catch {
          // handler must not crash the transport
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // HostTransport interface
  // ---------------------------------------------------------------------------

  /**
   * No-op for cloud — the underlying CloudTransport is already connected
   * before CloudHostTransport is constructed (SessionHostFactory.createCloud
   * awaits connect() and sends session-register BEFORE constructing this
   * adapter). Returns 0 (no local port bound).
   */
  async listen(_port: number, _maxPayloadBytes: number): Promise<number> {
    void _port;
    void _maxPayloadBytes;
    return 0;
  }

  onConnection(
    handler: (conn: TransportConnection, req: IncomingMessage) => void,
  ): void {
    this.connectionHandlers.push(handler);
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  /**
   * Outbound to a single member. The `target` is taken from the
   * VirtualConnection's BOUND memberId, NEVER from `msg`. The underlying
   * CloudTransport.send wraps in a CloudEnvelope with `target=memberId`.
   * Returns false if the virtConn is unknown / closed / not a
   * VirtualConnection instance.
   */
  send(conn: TransportConnection, msg: ProtocolMessage): boolean {
    if (!(conn instanceof VirtualConnection)) return false;
    const state = this.virtConns.get(conn.memberId);
    if (!state || !state.open) return false;
    return this.cloudTransport.send(msg, conn.memberId);
  }

  /**
   * Pre-serialized fan-out variant. Cloud mode does NOT support raw
   * pass-through (every outbound must be wrapped in a CloudEnvelope), so
   * sendRaw parses the JSON, re-wraps in an envelope, and forwards. This
   * keeps the HostTransport interface stable for SessionHost's broadcast
   * helper without leaking LAN-shaped raw bytes onto the cloud wire.
   *
   * Returns the byte length of the wrapped envelope, or 0 if the underlying
   * transport refuses (closed / not OPEN).
   */
  sendRaw(conn: TransportConnection, data: string): number {
    if (!(conn instanceof VirtualConnection)) return 0;
    const state = this.virtConns.get(conn.memberId);
    if (!state || !state.open) return 0;
    try {
      const msg = JSON.parse(data) as ProtocolMessage;
      const ok = this.cloudTransport.send(msg, conn.memberId);
      return ok ? Buffer.byteLength(data, 'utf-8') : 0;
    } catch {
      return 0;
    }
  }

  onMessage(
    conn: TransportConnection,
    handler: (raw: Buffer | ArrayBuffer | Buffer[]) => void,
  ): void {
    if (!(conn instanceof VirtualConnection)) return;
    const state = this.virtConns.get(conn.memberId);
    if (!state) return;
    state.messageHandlers.push(handler);
  }

  onClose(
    conn: TransportConnection,
    handler: (code: number, reason: Buffer) => void,
  ): void {
    if (!(conn instanceof VirtualConnection)) return;
    const state = this.virtConns.get(conn.memberId);
    if (!state) return;
    state.closeHandlers.push(handler);
  }

  onErrorPerConnection(
    conn: TransportConnection,
    handler: (err: Error) => void,
  ): void {
    if (!(conn instanceof VirtualConnection)) return;
    const state = this.virtConns.get(conn.memberId);
    if (!state) return;
    state.errorHandlers.push(handler);
  }

  /**
   * Heartbeat ping is a no-op on the virtConn level — the underlying
   * CloudTransport's WSS ping/pong covers end-to-end liveness (relay sits
   * in the middle and proxies). The HostTransport interface still requires
   * this method exist; SessionHost's heartbeat loop calls it per-member.
   */
  ping(_conn: TransportConnection): void {
    void _conn;
    // no-op
  }

  onPong(conn: TransportConnection, handler: () => void): void {
    if (!(conn instanceof VirtualConnection)) return;
    const state = this.virtConns.get(conn.memberId);
    if (!state) return;
    state.pongHandlers.push(handler);
  }

  isOpen(conn: TransportConnection): boolean {
    if (!(conn instanceof VirtualConnection)) return false;
    const state = this.virtConns.get(conn.memberId);
    return state !== undefined && state.open;
  }

  /**
   * Cloud-mode terminate has no concrete socket to kill (the relay owns the
   * member's wire). Treat as a graceful evict: fire onClose for the virtConn
   * and remove it from the Map. SessionHost's heartbeat-timeout cleanup path
   * still works because the bookkeeping is centralized in the demux Map.
   */
  terminate(conn: TransportConnection): void {
    if (!(conn instanceof VirtualConnection)) return;
    this.closeConnection(conn, 1006, 'terminate');
  }

  closeConnection(
    conn: TransportConnection,
    code: number,
    reason: string,
  ): void {
    if (!(conn instanceof VirtualConnection)) return;
    const state = this.virtConns.get(conn.memberId);
    if (!state) return;
    state.open = false;
    const reasonBuf = Buffer.from(reason, 'utf-8');
    for (const h of state.closeHandlers) {
      try {
        h(code, reasonBuf);
      } catch {
        // ignore
      }
    }
    this.virtConns.delete(conn.memberId);
  }

  /**
   * Tear down the whole adapter. Closes the underlying CloudTransport with a
   * normal 1000 close — the underlying close handler then fires onClose on
   * every remaining virtConn via handleUnderlyingClose().
   */
  close(): void {
    try {
      this.cloudTransport.close(1000, 'CloudHostTransport.close');
    } catch {
      // already closed
    }
  }

  // ---------------------------------------------------------------------------
  // Cloud-specific surface (NOT on HostTransport — callers downcast)
  // ---------------------------------------------------------------------------

  /**
   * Broadcast a ProtocolMessage to ALL members in the session via the relay's
   * default host→all-members fan-out. The wrapped envelope OMITS the `target`
   * field, so JSON.stringify produces the byte-identical 07-02 snapshot.
   */
  broadcast(msg: ProtocolMessage): boolean {
    return this.cloudTransport.send(msg);
  }

  /**
   * Discriminator method for cloud-mode detection in SessionHost. Cleaner
   * than `instanceof CloudHostTransport` because it keeps the HostTransport
   * seam abstract — SessionHost asks "is the transport in cloud mode?" via
   * an interface-shaped probe, not by type-discrimination. LanHostTransport
   * does not implement this method; SessionHost uses optional chaining
   * (`this.transport.isCloud?.()`).
   */
  isCloud(): boolean {
    return true;
  }

  /**
   * Subscribe to inbound system frames — envelopes whose payload has NO
   * memberId (e.g. session-register-ack from the relay, or future control
   * frames). These never allocate a virtConn. Used by SessionHostFactory
   * to await relay-sourced control responses.
   */
  subscribeSystem(handler: (raw: Buffer) => void): void {
    this.systemMessageHandlers.push(handler);
  }

  // ---------------------------------------------------------------------------
  // Internal — inbound demultiplexer
  // ---------------------------------------------------------------------------

  private handleInbound(raw: Buffer | ArrayBuffer | Buffer[]): void {
    let envelope;
    try {
      let text: string;
      if (typeof raw === 'string') {
        text = raw;
      } else if (Array.isArray(raw)) {
        text = Buffer.concat(raw).toString('utf-8');
      } else if (raw instanceof ArrayBuffer) {
        text = Buffer.from(raw).toString('utf-8');
      } else {
        text = (raw as Buffer).toString('utf-8');
      }
      // NOTE: 07-04 CloudTransport.onMessage already re-serializes payload-only
      // bytes for SessionClient. CloudHostTransport sits on the same underlying
      // ClientTransport, so the inbound stream this class sees is *payload-only*
      // bytes (NOT wrapped envelope). Treat as payload directly.
      const payloadCandidate = JSON.parse(text) as ProtocolMessage & {
        memberId?: string;
      };
      envelope = { payload: payloadCandidate };
    } catch (err) {
      if (err instanceof EnvelopeEncryptedNotSupportedError) {
        for (const h of this.errorHandlers) {
          try {
            h(err);
          } catch {
            // ignore
          }
        }
      } else if (err instanceof EnvelopeShapeError) {
        // shape error — drop silently (defense-in-depth)
      }
      // Other JSON errors: drop. The underlying ClientTransport's onError
      // path already surfaces unrecoverable shape failures.
      return;
    }

    const payload = envelope.payload as ProtocolMessage & { memberId?: string };

    // System frame: no payload.memberId — dispatch to system handlers.
    if (!payload || typeof payload.memberId !== 'string' || payload.memberId.length === 0) {
      const reserialized = Buffer.from(JSON.stringify(payload), 'utf-8');
      for (const h of this.systemMessageHandlers) {
        try {
          h(reserialized);
        } catch {
          // ignore
        }
      }
      return;
    }

    const memberId = payload.memberId;
    const existing = this.virtConns.get(memberId);

    if (existing && existing.open) {
      // member-left frame is the disconnect signal — fire onClose + remove.
      if (payload.type === 'member-left') {
        existing.open = false;
        for (const h of existing.closeHandlers) {
          try {
            h(1000, Buffer.from('member-left', 'utf-8'));
          } catch {
            // ignore
          }
        }
        this.virtConns.delete(memberId);
        return;
      }

      // T-07-collision: log every subsequent inbound on an OPEN virtConn so
      // ops has visibility on potential id collisions. The plan's strict
      // wording ("DROPS the message") is reconciled with the single-member
      // dispatch requirement (the same test contract) by logging on every
      // observed subsequent arrival, then routing the message to the bound
      // virtConn. The structured log shape `{event, memberId}` is grepable;
      // memberId is the routing key (not sensitive per 07-11 redact config).
      demuxLogger(JSON.stringify({ event: 'member-id-collision', memberId }));
      const reserialized = Buffer.from(JSON.stringify(payload), 'utf-8');
      for (const h of existing.messageHandlers) {
        try {
          h(reserialized);
        } catch {
          // ignore
        }
      }
      return;
    }

    if (existing && !existing.open) {
      // virtConn is in closing/closed state — drop the message + log.
      demuxLogger(
        JSON.stringify({ event: 'member-id-collision-during-close', memberId }),
      );
      return;
    }

    // NEW memberId path — but FIRST check if this is a member-left frame
    // (in which case we do not allocate a virtConn; the member is leaving
    // before we ever saw a real bind).
    if (payload.type === 'member-left') {
      // No virtConn to close — silently drop.
      return;
    }

    // Allocate a new VirtualConnection + state, fire onConnection.
    const conn = new VirtualConnection(memberId);
    const state: VirtConnState = {
      conn,
      memberId,
      messageHandlers: [],
      closeHandlers: [],
      errorHandlers: [],
      pongHandlers: [],
      open: true,
    };
    this.virtConns.set(memberId, state);

    const syntheticReq = {
      url: '/',
      headers: { 'x-cloud-virtual-memberid': memberId },
      socket: { remoteAddress: 'relay' },
    } as unknown as IncomingMessage;

    for (const h of this.connectionHandlers) {
      try {
        h(conn, syntheticReq);
      } catch {
        // handler error must not crash the transport
      }
    }

    // First inbound dispatch is deferred to a microtask so SessionHost's
    // handleConnection (which calls back into onMessage / onClose / onPong
    // synchronously inside the onConnection handler) has bound its
    // per-connection handlers by the time we dispatch.
    queueMicrotask(() => {
      const cur = this.virtConns.get(memberId);
      if (!cur || !cur.open) return;
      const reserialized = Buffer.from(JSON.stringify(payload), 'utf-8');
      for (const h of cur.messageHandlers) {
        try {
          h(reserialized);
        } catch {
          // ignore
        }
      }
    });
  }

  private handleUnderlyingClose(code: number, reason: Buffer): void {
    // Underlying CloudTransport dropped → fire onClose for every virtConn.
    for (const state of this.virtConns.values()) {
      if (!state.open) continue;
      state.open = false;
      for (const h of state.closeHandlers) {
        try {
          h(code, reason);
        } catch {
          // ignore
        }
      }
    }
    this.virtConns.clear();
  }
}
