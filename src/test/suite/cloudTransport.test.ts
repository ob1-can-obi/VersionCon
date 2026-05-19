import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';
import { EventEmitter } from 'events';
import {
  CloudTransport,
  mapCloseCodeToState,
  type CloudConnectionState,
} from '../../network/CloudTransport.js';
import type { ProtocolMessage } from '../../network/protocol.js';

// -----------------------------------------------------------------------------
// Phase 7 Plan 07-04 — CloudTransport
//
// CloudTransport is the second ClientTransport implementation alongside
// LanClientTransport (07-01). It opens an outbound wss:// connection to a
// relay, carries the JWT in the Authorization: Bearer HTTP header on the WSS
// upgrade, wraps every outbound ProtocolMessage in a CloudEnvelope (07-02),
// unwraps every inbound envelope back to a ProtocolMessage, maps WSS close
// codes to cloud-mode lifecycle states for StatusBarManager (07-07), and
// reuses ReconnectManager from src/network/heartbeat.ts (Pattern C — never
// re-implement backoff).
//
// Tests use a stubbed WebSocket constructor (passed via the constructor's
// discretionary WebSocketCtor injection point). The stub is an EventEmitter
// that captures construction arguments and exposes emit(event, ...args) for
// the test to synthesize 'open' / 'message' / 'close' / 'error' / 'pong'.
// -----------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface StubConstructionArgs {
  url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any;
}

class StubWebSocket extends EventEmitter {
  static instances: StubWebSocket[] = [];
  static constructionCount = 0;
  public readyState = 0; // CONNECTING by default; tests set 1 for OPEN
  public lastSendCall: string | null = null;
  public constructionArgs: StubConstructionArgs;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(url: string, options: any) {
    super();
    this.constructionArgs = { url, options };
    StubWebSocket.instances.push(this);
    StubWebSocket.constructionCount++;
  }

  // Mirror ws.WebSocket.send shape — the production code calls ws.send(data).
  send(data: string): void {
    this.lastSendCall = data;
  }

  ping(): void {
    // Test hook — exercised by Task 2 only via interface contract.
    this.emit('__test:ping');
  }

  close(code?: number, _reason?: string): void {
    // Synchronous close emission lets tests observe state transitions
    // without microtask plumbing.
    this.emit('close', code ?? 1000, Buffer.alloc(0));
  }

  terminate(): void {
    this.emit('close', 1006, Buffer.alloc(0));
  }
}

// Reset stub static state between tests.
function resetStub(): void {
  StubWebSocket.instances = [];
  StubWebSocket.constructionCount = 0;
}

// Cast the stub class to the ws.WebSocket constructor shape that the
// production constructor's WebSocketCtor parameter expects. The cast is
// load-bearing because the runtime stub doesn't implement every ws.WebSocket
// method — only the ones CloudTransport actually calls.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const StubCtor = StubWebSocket as unknown as any;

class SpyReconnectManager {
  public scheduleCalls: Array<{
    connect: () => Promise<boolean>;
    onFailed: () => void;
  }> = [];
  public aborted = false;

  scheduleReconnect(
    connect: () => Promise<boolean>,
    onFailed: () => void,
  ): void {
    if (this.aborted) return;
    this.scheduleCalls.push({ connect, onFailed });
  }
  reset(): void {
    /* no-op for tests */
  }
  abort(): void {
    this.aborted = true;
  }
  get currentAttempt(): number {
    return this.scheduleCalls.length;
  }
}

// Cast to ReconnectManager-shaped value. Production code accepts a
// `ReconnectManagerLike` shape on this constructor parameter (see Task 2
// Discretion call) so a structural cast suffices.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asReconnect = (spy: SpyReconnectManager): any => spy;

// ---------------------------------------------------------------------------
// Suite — Phase 7 — cloud transport
//
// Suite name MUST be EXACTLY this string so `npx vscode-test --grep "Phase 7.*cloud transport"`
// matches.
// ---------------------------------------------------------------------------
suite('Phase 7 — cloud transport', () => {
  setup(() => {
    resetStub();
  });

  // -------------------------------------------------------------------------
  // Test 1 — Authorization Bearer header on construction, NEVER query string
  // (T-07-03 mitigation; ASVS V2.1.3 / V3.1.1)
  // -------------------------------------------------------------------------
  test('connect — sends Authorization Bearer header, NEVER query string', () => {
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'fake.jwt.token',
      StubCtor,
    );
    // Fire-and-forget — we want to inspect construction args before resolution.
    void transport.connect();

    assert.strictEqual(StubWebSocket.instances.length, 1, 'stub constructed exactly once');
    const args = StubWebSocket.instances[0].constructionArgs;
    assert.strictEqual(
      args.url,
      'wss://relay.fly.dev',
      'URL passed verbatim — no mutation, no query append',
    );
    assert.strictEqual(
      args.options.headers.Authorization,
      'Bearer fake.jwt.token',
      'JWT MUST ride in the Authorization: Bearer header',
    );
    assert.doesNotMatch(
      args.url,
      /[?&]token=/,
      'URL MUST NOT carry a query-string token (T-07-03 / ASVS V2.1.3)',
    );
    assert.doesNotMatch(
      args.url,
      /[?&]jwt=/,
      'URL MUST NOT carry a query-string jwt parameter',
    );

    // Resolve the connect() Promise cleanly so no dangling listeners.
    StubWebSocket.instances[0].readyState = 1;
    StubWebSocket.instances[0].emit('open');
  });

  // -------------------------------------------------------------------------
  // Test 2 — maxPayload 1 MiB + perMessageDeflate false (T-07-08)
  // -------------------------------------------------------------------------
  test('connect — sets maxPayload to 1 MiB (1024 * 1024) on the ws constructor', () => {
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'fake.jwt.token',
      StubCtor,
    );
    void transport.connect();

    const opts = StubWebSocket.instances[0].constructionArgs.options;
    assert.strictEqual(
      opts.maxPayload,
      1024 * 1024,
      'maxPayload literal MUST be 1024*1024 (1 MiB; T-07-08; ASVS V13.1.4)',
    );
    assert.strictEqual(
      opts.perMessageDeflate,
      false,
      'perMessageDeflate disabled — mirror LAN setting (CRIME-class defense)',
    );

    StubWebSocket.instances[0].readyState = 1;
    StubWebSocket.instances[0].emit('open');
  });

  // -------------------------------------------------------------------------
  // Test 3 — close 4404 → 'session-not-found'; NO reconnect (T-07-reconnect-loop)
  // -------------------------------------------------------------------------
  test('close code 4404 → onStateChange("session-not-found"); does NOT trigger reconnect', async () => {
    const spy = new SpyReconnectManager();
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'fake.jwt.token',
      StubCtor,
      asReconnect(spy),
    );
    const observed: CloudConnectionState[] = [];
    transport.onStateChange((s) => observed.push(s));

    void transport.connect();
    const stub = StubWebSocket.instances[0];
    stub.readyState = 1;
    stub.emit('open');

    // Emit a terminal close code (custom 4404 — relay says "session not found").
    stub.readyState = 3; // CLOSED
    stub.emit('close', 4404, Buffer.from('session not found'));

    // Give microtasks a tick.
    await Promise.resolve();

    assert.deepStrictEqual(
      observed,
      ['connected', 'session-not-found'],
      'state sequence must be connected → session-not-found',
    );
    assert.strictEqual(
      spy.scheduleCalls.length,
      0,
      'session-not-found is terminal — reconnect MUST NOT be scheduled',
    );
    assert.strictEqual(
      StubWebSocket.constructionCount,
      1,
      'no new stub ws constructed after 4404 (transport did not retry)',
    );
  });

  // -------------------------------------------------------------------------
  // Test 4 — close 1006 → 'relay-unreachable'; SCHEDULES reconnect
  // -------------------------------------------------------------------------
  test('close code 1006 → onStateChange("relay-unreachable"); SCHEDULES reconnect', async () => {
    const spy = new SpyReconnectManager();
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'fake.jwt.token',
      StubCtor,
      asReconnect(spy),
    );
    const observed: CloudConnectionState[] = [];
    transport.onStateChange((s) => observed.push(s));

    void transport.connect();
    const stub = StubWebSocket.instances[0];
    stub.readyState = 1;
    stub.emit('open');
    stub.readyState = 3;
    stub.emit('close', 1006, Buffer.alloc(0));

    await Promise.resolve();

    assert.deepStrictEqual(
      observed,
      ['connected', 'relay-unreachable'],
      'state sequence must be connected → relay-unreachable',
    );
    assert.strictEqual(
      spy.scheduleCalls.length,
      1,
      'relay-unreachable MUST schedule a reconnect attempt (ReconnectManager reuse)',
    );
  });

  // -------------------------------------------------------------------------
  // Test 5 — pre-open error → relay-unreachable
  // -------------------------------------------------------------------------
  test('pre-open error event (no open fired before close) → onStateChange("relay-unreachable")', async () => {
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'fake.jwt.token',
      StubCtor,
    );
    const observed: CloudConnectionState[] = [];
    transport.onStateChange((s) => observed.push(s));

    const promise = transport.connect();
    const stub = StubWebSocket.instances[0];

    // ws library typical sequence: 'error' fires, then 'close' with 1006.
    stub.emit('error', new Error('ECONNREFUSED'));
    stub.emit('close', 1006, Buffer.alloc(0));

    const opened = await promise;

    assert.strictEqual(opened, false, 'pre-open failure must resolve connect() to false');
    assert.ok(
      observed.includes('relay-unreachable'),
      'state must include relay-unreachable after pre-open failure',
    );
    assert.ok(
      !observed.includes('connected'),
      'state must NEVER include connected when open never fired',
    );
  });

  // -------------------------------------------------------------------------
  // Test 6 — send() wraps in CloudEnvelope; wire byte-shape pinned (07-02)
  // -------------------------------------------------------------------------
  test('send() wraps message in CloudEnvelope — wire bytes are {"v":1,"sessionId":...,"encrypted":false,"payload":...}', async () => {
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'fake.jwt.token',
      StubCtor,
    );
    void transport.connect();
    const stub = StubWebSocket.instances[0];
    stub.readyState = 1;
    stub.emit('open');

    const ok = transport.send({ type: 'heartbeat-ping' } as unknown as ProtocolMessage);
    assert.strictEqual(ok, true, 'send must return true when socket is OPEN');

    assert.ok(stub.lastSendCall, 'wire bytes captured by stub');
    const wire = stub.lastSendCall as string;
    assert.ok(
      wire.startsWith('{"v":1,"sessionId":"vc-7f3a92","encrypted":false,"payload":'),
      `wire bytes must begin with locked envelope prefix, got: ${wire}`,
    );

    const parsed = JSON.parse(wire);
    assert.strictEqual(parsed.v, 1, 'parsed envelope v is 1');
    assert.strictEqual(parsed.sessionId, 'vc-7f3a92', 'sessionId routed verbatim');
    assert.strictEqual(parsed.encrypted, false, 'encrypted literal false (v1)');
    assert.strictEqual(
      parsed.payload.type,
      'heartbeat-ping',
      'payload.type preserved verbatim',
    );
  });

  // -------------------------------------------------------------------------
  // Test 7 — receive: handler invoked with UNWRAPPED payload bytes
  // -------------------------------------------------------------------------
  test('receive — handler is invoked with unwrapped payload bytes (not envelope bytes)', async () => {
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'fake.jwt.token',
      StubCtor,
    );
    const observed: string[] = [];
    transport.onMessage((raw) => observed.push(raw.toString()));

    void transport.connect();
    const stub = StubWebSocket.instances[0];
    stub.readyState = 1;
    stub.emit('open');

    const wire =
      '{"v":1,"sessionId":"vc-7f3a92","encrypted":false,"payload":{"type":"heartbeat-pong"}}';
    stub.emit('message', Buffer.from(wire));

    assert.strictEqual(observed.length, 1, 'exactly one inbound payload reached the handler');
    const payload = JSON.parse(observed[0]);
    assert.strictEqual(
      payload.type,
      'heartbeat-pong',
      'payload type preserved through unwrap',
    );
    assert.ok(
      !observed[0].includes('sessionId'),
      'unwrapped bytes MUST NOT contain envelope fields (sessionId leak)',
    );
    assert.ok(
      !observed[0].includes('encrypted'),
      'unwrapped bytes MUST NOT contain envelope fields (encrypted leak)',
    );
  });

  // -------------------------------------------------------------------------
  // Test 8 — malformed envelope → onError (T-07-envelope-shape)
  // -------------------------------------------------------------------------
  test('receive — malformed envelope surfaces via onError, does NOT crash receive loop', async () => {
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'fake.jwt.token',
      StubCtor,
    );
    let errorCount = 0;
    let messageCount = 0;
    transport.onError(() => errorCount++);
    transport.onMessage(() => messageCount++);

    void transport.connect();
    const stub = StubWebSocket.instances[0];
    stub.readyState = 1;
    stub.emit('open');

    // Malformed JSON — deserialize will throw EnvelopeShapeError.
    stub.emit('message', Buffer.from('{not-json'));

    assert.strictEqual(errorCount, 1, 'onError fires exactly once on malformed envelope');
    assert.strictEqual(messageCount, 0, 'onMessage never fires when envelope is malformed');
  });

  // -------------------------------------------------------------------------
  // Test 9 — encrypted:true → onError (T-07-encrypted-skew; loud forward-compat)
  // -------------------------------------------------------------------------
  test('receive — encrypted:true envelope from future L3 peer surfaces via onError (loud forward-compat failure)', async () => {
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'fake.jwt.token',
      StubCtor,
    );
    let errorCount = 0;
    let messageCount = 0;
    transport.onError(() => errorCount++);
    transport.onMessage(() => messageCount++);

    void transport.connect();
    const stub = StubWebSocket.instances[0];
    stub.readyState = 1;
    stub.emit('open');

    stub.emit(
      'message',
      Buffer.from(
        '{"v":1,"sessionId":"x","encrypted":true,"payload":"opaque-ciphertext"}',
      ),
    );

    assert.strictEqual(errorCount, 1, 'onError must fire on encrypted:true (L3 skew)');
    assert.strictEqual(
      messageCount,
      0,
      'onMessage must NOT fire when envelope cannot be unwrapped',
    );
  });

  // -------------------------------------------------------------------------
  // Test 10 — send() returns false when socket is not open
  // -------------------------------------------------------------------------
  test('send() returns false when socket is not open; does not call ws.send', async () => {
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'fake.jwt.token',
      StubCtor,
    );
    void transport.connect();
    const stub = StubWebSocket.instances[0];
    // Do NOT emit 'open'; readyState stays 0 (CONNECTING).
    stub.readyState = 0;

    const ok = transport.send({ type: 'heartbeat-ping' } as unknown as ProtocolMessage);

    assert.strictEqual(ok, false, 'send must return false when socket is not OPEN');
    assert.strictEqual(stub.lastSendCall, null, 'no wire bytes emitted when not OPEN');
  });

  // -------------------------------------------------------------------------
  // Test 11 — markIntentionalClose aborts ReconnectManager + suppresses retry
  // -------------------------------------------------------------------------
  test('markIntentionalClose() aborts ReconnectManager and prevents reconnect on subsequent close', async () => {
    const spy = new SpyReconnectManager();
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'fake.jwt.token',
      StubCtor,
      asReconnect(spy),
    );
    const observed: CloudConnectionState[] = [];
    transport.onStateChange((s) => observed.push(s));

    void transport.connect();
    const stub = StubWebSocket.instances[0];
    stub.readyState = 1;
    stub.emit('open');

    transport.markIntentionalClose();

    // Emit a normal-closure close. State should be 'disconnected'; reconnect
    // must NEVER be scheduled because of markIntentionalClose.
    stub.readyState = 3;
    stub.emit('close', 1000, Buffer.alloc(0));

    await Promise.resolve();

    assert.ok(
      observed.includes('disconnected'),
      'state must include disconnected after a 1000-close',
    );
    assert.strictEqual(
      spy.scheduleCalls.length,
      0,
      'markIntentionalClose MUST suppress reconnect scheduling',
    );
    assert.strictEqual(spy.aborted, true, 'markIntentionalClose calls reconnect.abort()');
  });

  // -------------------------------------------------------------------------
  // Test 12 — SOURCE-GREP: ReconnectManager reused, never re-implemented
  // (PATTERNS Pattern C invariant)
  // -------------------------------------------------------------------------
  test('SOURCE-GREP — CloudTransport.ts imports ReconnectManager from ./heartbeat (DOES NOT re-implement backoff)', () => {
    const cloudTransportPath = path.resolve(
      process.cwd(),
      'src/network/CloudTransport.ts',
    );
    const src = fsSync.readFileSync(cloudTransportPath, 'utf-8');

    assert.match(
      src,
      /import .* from ['"]\.\/heartbeat(?:\.js)?['"]/,
      'CloudTransport.ts MUST import from ./heartbeat (PATTERNS Pattern C — reuse, do not re-implement)',
    );
    assert.match(
      src,
      /ReconnectManager/,
      'CloudTransport.ts must reference the ReconnectManager class',
    );
    assert.doesNotMatch(
      src,
      /getReconnectDelay\s*\(/,
      'CloudTransport.ts MUST NOT call getReconnectDelay directly (only ReconnectManager wraps it)',
    );
    assert.doesNotMatch(
      src,
      /Math\.pow\(2,\s*\w+\)/,
      'CloudTransport.ts MUST NOT hand-roll exponential backoff (use ReconnectManager)',
    );
  });

  // -------------------------------------------------------------------------
  // Test 13 — SOURCE-GREP: no token query string anywhere in CloudTransport.ts
  // (T-07-03; PATTERNS Pattern G — header, never query)
  // -------------------------------------------------------------------------
  test('SOURCE-GREP — no Bearer token in query string anywhere in CloudTransport.ts', () => {
    const cloudTransportPath = path.resolve(
      process.cwd(),
      'src/network/CloudTransport.ts',
    );
    const src = fsSync.readFileSync(cloudTransportPath, 'utf-8');

    assert.doesNotMatch(
      src,
      /\?token=/,
      'CloudTransport.ts MUST NOT contain a ?token= query parameter (T-07-03 / ASVS V2.1.3)',
    );
    assert.doesNotMatch(
      src,
      /\?jwt=/,
      'CloudTransport.ts MUST NOT contain a ?jwt= query parameter',
    );
    assert.doesNotMatch(
      src,
      /wss:\/\/[^"'\s`]*\?[^"'\s`]+/,
      'No wss:// URL with a query string anywhere in CloudTransport.ts (relay URL must be clean)',
    );
    assert.match(
      src,
      /Authorization.*Bearer/,
      'CloudTransport.ts MUST send the Bearer credential via the Authorization header',
    );
  });

  // -------------------------------------------------------------------------
  // Bonus — mapCloseCodeToState is exported and behaves per the locked mapping
  // (covered indirectly by tests 3-5 but pinned here as a direct unit test)
  // -------------------------------------------------------------------------
  test('mapCloseCodeToState — 4404 / 1000 / 1006 / other → states (canonical mapping)', () => {
    assert.strictEqual(mapCloseCodeToState(4404, true), 'session-not-found');
    assert.strictEqual(mapCloseCodeToState(4404, false), 'session-not-found');
    assert.strictEqual(mapCloseCodeToState(1000, true), 'disconnected');
    assert.strictEqual(mapCloseCodeToState(1006, true), 'relay-unreachable');
    assert.strictEqual(mapCloseCodeToState(1006, false), 'relay-unreachable');
    assert.strictEqual(mapCloseCodeToState(1011, true), 'relay-unreachable');
    assert.strictEqual(mapCloseCodeToState(4401, true), 'relay-unreachable');
  });
});
