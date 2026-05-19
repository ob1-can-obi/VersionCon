// -----------------------------------------------------------------------------
// Phase 7 Plan 07-05b — CloudHostTransport demultiplexer tests.
//
// CloudHostTransport is the host-side adapter that wraps a connected
// CloudTransport (ClientTransport from 07-04) and exposes the HostTransport
// surface (07-01) to SessionHost. Inbound stream demultiplexed by
// payload.memberId into per-member VirtualConnections; outbound unicast sets
// envelope.target; outbound broadcast omits target (byte-identical to 07-02's
// snapshot).
//
// Tests use a fake ClientTransport (sends captured, inbound synthesized) so
// no real WSS connection is needed. The 07-02 byte-shape snapshot test is
// re-validated here for the broadcast path — if it fails, JSON.stringify is
// emitting the target field even when undefined.
// -----------------------------------------------------------------------------

import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';
import {
  CloudHostTransport,
  _setDemuxLoggerForTest,
} from '../../network/CloudHostTransport.js';
import { wrap, serialize } from '../../network/CloudEnvelope.js';
import type { ClientTransport } from '../../network/Transport.js';
import type { ProtocolMessage } from '../../network/protocol.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class FakeClientTransport implements ClientTransport {
  public readonly sentFrames: ProtocolMessage[] = [];
  public readonly sentTargets: Array<string | undefined> = [];
  private openHandlers: Array<() => void> = [];
  private messageHandlers: Array<(raw: Buffer | ArrayBuffer | Buffer[]) => void> = [];
  private closeHandlers: Array<(code: number, reason: Buffer) => void> = [];
  private errorHandlers: Array<() => void> = [];
  private pongHandlers: Array<() => void> = [];
  private opened = true;

  async connect(): Promise<boolean> {
    this.opened = true;
    return true;
  }
  onOpen(handler: () => void): void { this.openHandlers.push(handler); }
  onMessage(handler: (raw: Buffer | ArrayBuffer | Buffer[]) => void): void {
    this.messageHandlers.push(handler);
  }
  onClose(handler: (code: number, reason: Buffer) => void): void {
    this.closeHandlers.push(handler);
  }
  onError(handler: () => void): void { this.errorHandlers.push(handler); }
  onPong(handler: () => void): void { this.pongHandlers.push(handler); }
  send(msg: ProtocolMessage, target?: string): boolean {
    this.sentFrames.push(msg);
    this.sentTargets.push(target);
    return this.opened;
  }
  ping(): void {}
  isOpen(): boolean { return this.opened; }
  close(_code?: number, _reason?: string): void { this.opened = false; }

  _simulateRaw(raw: Buffer): void {
    for (const h of this.messageHandlers) {
      try { h(raw); } catch { /* ignore */ }
    }
  }
  /**
   * Mirror CloudTransport's onMessage contract: handlers receive the PAYLOAD
   * bytes (env.payload re-serialized), NOT the full envelope. CloudTransport
   * does `Buffer.from(JSON.stringify(env.payload))` before fan-out. The fake
   * does the same so CloudHostTransport.handleInbound sees the same shape it
   * would see in production.
   */
  _simulateEnvelope(_sessionId: string, payload: object): void {
    this._simulateRaw(Buffer.from(JSON.stringify(payload), 'utf-8'));
  }
  _simulateClose(code: number, reason: Buffer): void {
    this.opened = false;
    for (const h of this.closeHandlers) {
      try { h(code, reason); } catch { /* ignore */ }
    }
  }
}

// Drain any microtask-deferred dispatch in CloudHostTransport.handleInbound.
async function flushMicrotasks(): Promise<void> {
  // Allow queueMicrotask and setImmediate to run.
  await new Promise<void>((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Suite — cloud host demux
// ---------------------------------------------------------------------------

suite('Phase 7 — cloud host demux', () => {
  test('CloudHostTransport implements every HostTransport method', () => {
    const fake = new FakeClientTransport();
    const t = new CloudHostTransport(fake, 'vc-x');
    const required = [
      'listen', 'onConnection', 'onError', 'send', 'sendRaw',
      'onMessage', 'onClose', 'onErrorPerConnection', 'ping',
      'onPong', 'isOpen', 'terminate', 'closeConnection', 'close',
    ];
    for (const m of required) {
      const fn = (t as unknown as Record<string, unknown>)[m];
      assert.strictEqual(
        typeof fn,
        'function',
        `CloudHostTransport must implement HostTransport.${m}() as a function`,
      );
    }
  });

  test('single member: new payload.memberId fires onConnection once + onMessage routes', async () => {
    const fake = new FakeClientTransport();
    const t = new CloudHostTransport(fake, 'vc-x');
    let connFireCount = 0;
    let lastConn: unknown = null;
    const msgsByMember: Record<string, number> = {};
    t.onConnection((conn) => {
      connFireCount++;
      lastConn = conn;
      t.onMessage(conn, () => {
        msgsByMember['mem-1'] = (msgsByMember['mem-1'] ?? 0) + 1;
      });
    });

    fake._simulateEnvelope('vc-x', {
      type: 'heartbeat-ping',
      timestamp: 0,
      memberId: 'mem-1',
    });
    await flushMicrotasks();

    assert.strictEqual(connFireCount, 1, 'onConnection fires exactly once for new memberId');
    assert.ok(lastConn !== null, 'connection handle supplied');
    assert.strictEqual(msgsByMember['mem-1'], 1, 'first inbound dispatched to per-conn handler');

    // Second inbound for same memberId — no new onConnection, same handler fires.
    fake._simulateEnvelope('vc-x', {
      type: 'heartbeat-ping',
      timestamp: 1,
      memberId: 'mem-1',
    });
    await flushMicrotasks();

    assert.strictEqual(connFireCount, 1, 'onConnection still fired only once');
    assert.strictEqual(msgsByMember['mem-1'], 2, 'second inbound also dispatched');
  });

  test('multi-member: distinct memberIds create distinct VirtualConnections', async () => {
    const fake = new FakeClientTransport();
    const t = new CloudHostTransport(fake, 'vc-x');
    const seenConns: unknown[] = [];
    const counters = new Map<unknown, number>();
    t.onConnection((conn) => {
      seenConns.push(conn);
      counters.set(conn, 0);
      t.onMessage(conn, () => {
        counters.set(conn, (counters.get(conn) ?? 0) + 1);
      });
    });

    for (const mid of ['mem-1', 'mem-2', 'mem-3']) {
      fake._simulateEnvelope('vc-x', {
        type: 'heartbeat-ping',
        timestamp: 0,
        memberId: mid,
      });
    }
    await flushMicrotasks();

    assert.strictEqual(seenConns.length, 3, 'three distinct virtConns created');
    const uniq = new Set(seenConns);
    assert.strictEqual(uniq.size, 3, 'all three virtConns are distinct instances');
    for (const c of seenConns) {
      assert.strictEqual(counters.get(c), 1, 'each virtConn received exactly one message');
    }
  });

  test('outbound unicast: send(virtConn, msg) emits envelope with target=memberId', async () => {
    const fake = new FakeClientTransport();
    const t = new CloudHostTransport(fake, 'vc-x');
    let virtConn: unknown = null;
    t.onConnection((conn) => { virtConn = conn; });
    fake._simulateEnvelope('vc-x', {
      type: 'heartbeat-ping',
      timestamp: 0,
      memberId: 'mem-target',
    });
    await flushMicrotasks();
    assert.ok(virtConn !== null, 'virtConn was created');

    const sentCountBefore = fake.sentFrames.length;
    const ok = t.send(virtConn, {
      type: 'heartbeat-pong',
      timestamp: 0,
    } as ProtocolMessage);
    assert.strictEqual(ok, true, 'send returns true for live virtConn');
    assert.strictEqual(fake.sentFrames.length, sentCountBefore + 1, 'one frame emitted');
    assert.strictEqual(
      fake.sentTargets[fake.sentTargets.length - 1],
      'mem-target',
      'envelope.target = virtConn.memberId',
    );
    assert.deepStrictEqual(
      fake.sentFrames[fake.sentFrames.length - 1],
      { type: 'heartbeat-pong', timestamp: 0 },
      'payload deep-equals the message',
    );
  });

  test('outbound broadcast: send/broadcast without virtConn emits envelope WITHOUT target field', () => {
    const fake = new FakeClientTransport();
    const t = new CloudHostTransport(fake, 'vc-x');
    // Use the broadcast() public method.
    const ok = (t as unknown as { broadcast: (msg: ProtocolMessage) => boolean })
      .broadcast({ type: 'heartbeat-ping', timestamp: 0 } as ProtocolMessage);
    assert.strictEqual(ok, true, 'broadcast returns true');
    assert.strictEqual(
      fake.sentTargets[fake.sentTargets.length - 1],
      undefined,
      'broadcast emits envelope with target undefined',
    );
  });

  test('byte-shape preservation: broadcast envelope matches 07-02 snapshot', () => {
    // The 07-02 locked snapshot — must be byte-identical when target is omitted.
    const expected =
      '{"v":1,"sessionId":"vc-7f3a92","encrypted":false,"payload":{"type":"ping"}}';
    const env = wrap('vc-7f3a92', { type: 'ping' } as unknown as ProtocolMessage);
    const actual = serialize(env);
    assert.strictEqual(actual, expected, '07-02 byte-shape snapshot preserved (broadcast)');
  });

  test('member-disconnect frame fires onClose and removes virtConn', async () => {
    const fake = new FakeClientTransport();
    const t = new CloudHostTransport(fake, 'vc-x');
    let firstConn: unknown = null;
    let secondConn: unknown = null;
    let onCloseFired = false;
    let connFireCount = 0;
    t.onConnection((conn) => {
      connFireCount++;
      if (connFireCount === 1) firstConn = conn;
      if (connFireCount === 2) secondConn = conn;
      t.onClose(conn, () => { onCloseFired = true; });
    });

    fake._simulateEnvelope('vc-x', {
      type: 'heartbeat-ping',
      timestamp: 0,
      memberId: 'mem-1',
    });
    await flushMicrotasks();
    assert.ok(firstConn !== null, 'first virtConn created');

    fake._simulateEnvelope('vc-x', {
      type: 'member-left',
      timestamp: 0,
      memberId: 'mem-1',
      reason: 'voluntary',
    });
    await flushMicrotasks();
    assert.strictEqual(onCloseFired, true, 'onClose fired on member-left frame');

    // Subsequent inbound for mem-1 should create a NEW virtConn.
    fake._simulateEnvelope('vc-x', {
      type: 'heartbeat-ping',
      timestamp: 1,
      memberId: 'mem-1',
    });
    await flushMicrotasks();
    assert.ok(secondConn !== null, 'second virtConn created after re-bind');
    assert.notStrictEqual(firstConn, secondConn, 'new virtConn is a distinct instance');
  });

  test('underlying CloudTransport.onClose fires onClose for every virtConn', async () => {
    const fake = new FakeClientTransport();
    const t = new CloudHostTransport(fake, 'vc-x');
    let closes = 0;
    t.onConnection((conn) => {
      t.onClose(conn, () => { closes++; });
    });

    for (const mid of ['mem-1', 'mem-2', 'mem-3']) {
      fake._simulateEnvelope('vc-x', {
        type: 'heartbeat-ping',
        timestamp: 0,
        memberId: mid,
      });
    }
    await flushMicrotasks();
    fake._simulateClose(1006, Buffer.alloc(0));
    assert.strictEqual(closes, 3, 'all three virtConns received onClose on underlying close');
  });

  test('memberId collision: second observation while first is open is dropped + logged', async () => {
    const fake = new FakeClientTransport();
    const t = new CloudHostTransport(fake, 'vc-x');
    let connFireCount = 0;
    t.onConnection(() => { connFireCount++; });

    const logs: string[] = [];
    const restore = _setDemuxLoggerForTest((line) => { logs.push(line); });
    try {
      fake._simulateEnvelope('vc-x', {
        type: 'heartbeat-ping',
        timestamp: 0,
        memberId: 'mem-collide',
      });
      await flushMicrotasks();
      // Second arrival while first virtConn is OPEN — drop + log.
      fake._simulateEnvelope('vc-x', {
        type: 'heartbeat-ping',
        timestamp: 1,
        memberId: 'mem-collide',
      });
      await flushMicrotasks();
    } finally {
      restore();
    }
    assert.strictEqual(connFireCount, 1, 'second observation does NOT fire onConnection');
    const hasCollisionLog = logs.some(
      (l) => l.includes('member-id-collision') && l.includes('mem-collide'),
    );
    assert.ok(hasCollisionLog, 'collision was logged with event=member-id-collision');
  });

  test('system frame (no payload.memberId) does NOT create a virtConn', async () => {
    const fake = new FakeClientTransport();
    const t = new CloudHostTransport(fake, 'vc-x');
    let connFireCount = 0;
    t.onConnection(() => { connFireCount++; });

    fake._simulateEnvelope('vc-x', {
      // No memberId field — system frame.
      type: 'heartbeat-ping',
      timestamp: 0,
    });
    await flushMicrotasks();
    assert.strictEqual(connFireCount, 0, 'system frame does NOT create a virtConn');
  });

  test('source-grep: SessionHost.ts MUST NOT reference VirtualConnection', () => {
    const filePath = path.resolve(process.cwd(), 'src/host/SessionHost.ts');
    const src = fsSync.readFileSync(filePath, 'utf-8');
    assert.doesNotMatch(
      src,
      /VirtualConnection/,
      'SessionHost.ts must NOT reference VirtualConnection (opaque transport handle, D-05)',
    );
  });

  test('source-grep: CloudHostTransport.ts reads payload.memberId for routing', () => {
    const filePath = path.resolve(process.cwd(), 'src/network/CloudHostTransport.ts');
    const src = fsSync.readFileSync(filePath, 'utf-8');
    assert.match(
      src,
      /payload\.memberId/,
      'CloudHostTransport.ts must read payload.memberId for routing',
    );
  });
});
