import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';
import { EventEmitter } from 'events';
import { CloudTransport, type CloudConnectionState } from '../../network/CloudTransport.js';

// -----------------------------------------------------------------------------
// Phase 7 Plan 07-14 — CloudTransport.swapToken tests
//
// MD-03 / SC-2 closure step 2 of 2 (CloudTransport-side mechanism). After the
// host issues a real per-joiner JWT in auth-response.token, SessionClient
// calls CloudTransport.swapToken(newToken) which atomically:
//
//   1. marks swapInProgress = true (suppresses state-change emit + reconnect)
//   2. closes the bootstrap socket with code 1000 'bootstrap-swap'
//   3. resets this.hadOpened = false
//   4. atomically replaces this.token = newToken
//   5. awaits this.connect() — new socket carries the new JWT in Authorization
//   6. finally: swapInProgress = false BEFORE the on-open's emitStateChange
//      fires, so `connected` is emitted exactly once
//
// Pins:
//   - Authorization Bearer changes from bootstrap-jwt to real-jwt (test 1)
//   - swapInProgress suppresses state-change emit during swap (test 2)
//   - swapInProgress suppresses ReconnectManager during swap (test 3)
//   - swap before connect → returns false (test 4)
//   - idempotent overlap → second call no-ops (test 5)
//   - swap after intentional close → returns false (test 6)
//   - T-07-23 — state-change handler NEVER receives JWT (test 7)
//   - source-grep gates (test 8)
// -----------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stub WebSocket harness — supports MULTIPLE constructions (swap creates
// a second socket). Tests inspect StubWebSocket.instances[1] for the
// post-swap construction.
// ---------------------------------------------------------------------------

interface StubConstructionArgs {
  url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any;
}

class StubWebSocket extends EventEmitter {
  static instances: StubWebSocket[] = [];
  static constructionCount = 0;
  public readyState = 0;
  public lastSendCall: string | null = null;
  public constructionArgs: StubConstructionArgs;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(url: string, options: any) {
    super();
    this.constructionArgs = { url, options };
    StubWebSocket.instances.push(this);
    StubWebSocket.constructionCount++;
  }
  send(data: string): void { this.lastSendCall = data; }
  ping(): void { /* noop */ }
  close(code?: number, _reason?: string): void {
    this.readyState = 3;
    this.emit('close', code ?? 1000, Buffer.alloc(0));
  }
  terminate(): void { this.emit('close', 1006, Buffer.alloc(0)); }
}

function resetStub(): void {
  StubWebSocket.instances = [];
  StubWebSocket.constructionCount = 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const StubCtor = StubWebSocket as unknown as any;

class SpyReconnectManager {
  public scheduleCalls: Array<{ connect: () => Promise<boolean>; onFailed: () => void }> = [];
  public aborted = false;
  scheduleReconnect(connect: () => Promise<boolean>, onFailed: () => void): void {
    if (this.aborted) return;
    this.scheduleCalls.push({ connect, onFailed });
  }
  abort(): void { this.aborted = true; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asReconnect = (spy: SpyReconnectManager): any => spy;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
suite('Phase 7 — CloudTransport swapToken (Plan 07-14)', () => {
  setup(() => { resetStub(); });

  // -------------------------------------------------------------------------
  // Test 1 — swapToken happy path: closes old socket, opens new with new JWT
  // -------------------------------------------------------------------------
  test('swapToken happy path → closes bootstrap socket, opens new with new JWT in Authorization header', async () => {
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'bootstrap-jwt',
      StubCtor,
    );
    // Open bootstrap socket.
    void transport.connect();
    const bootstrap = StubWebSocket.instances[0];
    bootstrap.readyState = 1;
    bootstrap.emit('open');

    // Bootstrap socket carries the bootstrap JWT.
    assert.strictEqual(
      bootstrap.constructionArgs.options.headers.Authorization,
      'Bearer bootstrap-jwt',
      'bootstrap socket Authorization carries bootstrap JWT',
    );

    // Trigger swap. The promise resolves when the new socket opens.
    const swapPromise = transport.swapToken('real-jwt');
    // The swapToken implementation closes the old socket synchronously
    // (close() in stub emits 'close' immediately). Then it calls connect()
    // which constructs a new StubWebSocket. We must emit 'open' on the new
    // socket so the swap promise resolves.
    await new Promise((r) => setImmediate(r));
    assert.ok(StubWebSocket.instances.length >= 2,
      `swap must construct a second socket; got ${StubWebSocket.instances.length}`);
    const realSocket = StubWebSocket.instances[1];
    realSocket.readyState = 1;
    realSocket.emit('open');

    const ok = await swapPromise;
    assert.strictEqual(ok, true, 'swapToken resolves true after new socket opens');

    // New socket carries the REAL JWT.
    assert.strictEqual(
      realSocket.constructionArgs.options.headers.Authorization,
      'Bearer real-jwt',
      'new socket Authorization carries real per-joiner JWT (token swapped)',
    );
    assert.strictEqual(
      realSocket.constructionArgs.url,
      'wss://relay.fly.dev',
      'new socket URL unchanged (same relay)',
    );
  });

  // -------------------------------------------------------------------------
  // Test 2 — swapInProgress suppresses state-change emit during swap
  // -------------------------------------------------------------------------
  test('swapToken in progress → close handler does NOT emit relay-unreachable (no flicker)', async () => {
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'bootstrap-jwt',
      StubCtor,
    );
    const observed: CloudConnectionState[] = [];
    transport.onStateChange((s) => observed.push(s));

    void transport.connect();
    const bootstrap = StubWebSocket.instances[0];
    bootstrap.readyState = 1;
    bootstrap.emit('open');

    // observed should be ['connected'] only after bootstrap open.
    assert.deepStrictEqual(observed, ['connected'],
      'state sequence before swap: connected');

    const swapPromise = transport.swapToken('real-jwt');
    await new Promise((r) => setImmediate(r));

    // At this point the bootstrap socket has been closed (synchronously in
    // the stub via close()), and a new socket has been constructed. The
    // observed array MUST NOT contain 'relay-unreachable' (which would be
    // the state mapped from the 1000 close — actually 1000 maps to
    // 'disconnected'; but the suppression must cover BOTH and the no-flicker
    // contract demands neither state appear between the bootstrap close and
    // the new open).
    const observedBeforeNewOpen = [...observed];
    assert.ok(!observedBeforeNewOpen.includes('relay-unreachable'),
      `state MUST NOT include 'relay-unreachable' during swap; got: ${observedBeforeNewOpen.join(',')}`);
    assert.ok(!observedBeforeNewOpen.includes('disconnected'),
      `state MUST NOT include 'disconnected' during swap; got: ${observedBeforeNewOpen.join(',')}`);

    // Emit open on the new socket → second 'connected' state-change.
    const realSocket = StubWebSocket.instances[1];
    realSocket.readyState = 1;
    realSocket.emit('open');
    await swapPromise;

    // Final state sequence: ['connected', 'connected'] — exactly two emissions,
    // both 'connected'. The status bar transition is clean.
    assert.deepStrictEqual(observed, ['connected', 'connected'],
      'final state sequence: connected → connected (no flicker through any other state)');
  });

  // -------------------------------------------------------------------------
  // Test 3 — swapToken does NOT schedule reconnect
  // -------------------------------------------------------------------------
  test('swapToken close does NOT schedule ReconnectManager (swap orchestrates its own reopen)', async () => {
    const spy = new SpyReconnectManager();
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'bootstrap-jwt',
      StubCtor,
      asReconnect(spy),
    );
    void transport.connect();
    const bootstrap = StubWebSocket.instances[0];
    bootstrap.readyState = 1;
    bootstrap.emit('open');

    const swapPromise = transport.swapToken('real-jwt');
    await new Promise((r) => setImmediate(r));
    const realSocket = StubWebSocket.instances[1];
    realSocket.readyState = 1;
    realSocket.emit('open');
    await swapPromise;

    assert.strictEqual(spy.scheduleCalls.length, 0,
      'ReconnectManager.scheduleReconnect MUST NOT be called during swap');
    assert.strictEqual(spy.aborted, false,
      'swap does NOT abort the ReconnectManager (preserved for post-swap reconnect ladder if needed)');
  });

  // -------------------------------------------------------------------------
  // Test 4 — swapToken before connect → returns false
  // -------------------------------------------------------------------------
  test('swapToken before connect → returns false; no new socket constructed', async () => {
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'bootstrap-jwt',
      StubCtor,
    );
    // Do NOT call connect().
    const ok = await transport.swapToken('real-jwt');
    assert.strictEqual(ok, false, 'swapToken before connect returns false');
    assert.strictEqual(StubWebSocket.constructionCount, 0,
      'no socket constructed when swapping pre-connect');
  });

  // -------------------------------------------------------------------------
  // Test 5 — swapToken idempotent overlap (swapInProgress guard)
  // -------------------------------------------------------------------------
  test('swapToken called twice in rapid succession → second call returns false (overlap guard)', async () => {
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'bootstrap-jwt',
      StubCtor,
    );
    void transport.connect();
    const bootstrap = StubWebSocket.instances[0];
    bootstrap.readyState = 1;
    bootstrap.emit('open');

    const firstPromise = transport.swapToken('real-jwt-1');
    // Immediately fire a second swap — must short-circuit because
    // swapInProgress is true.
    const second = await transport.swapToken('real-jwt-2');
    assert.strictEqual(second, false,
      'concurrent swap returns false (swapInProgress overlap guard)');

    // Finish the first swap so we don't leak handlers.
    await new Promise((r) => setImmediate(r));
    if (StubWebSocket.instances.length >= 2) {
      const realSocket = StubWebSocket.instances[1];
      realSocket.readyState = 1;
      realSocket.emit('open');
    }
    await firstPromise;
  });

  // -------------------------------------------------------------------------
  // Test 6 — swap after intentional close → returns false
  // -------------------------------------------------------------------------
  test('swapToken after markIntentionalClose → returns false; no new socket', async () => {
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'bootstrap-jwt',
      StubCtor,
    );
    void transport.connect();
    const bootstrap = StubWebSocket.instances[0];
    bootstrap.readyState = 1;
    bootstrap.emit('open');

    transport.markIntentionalClose();
    const countBefore = StubWebSocket.constructionCount;
    const ok = await transport.swapToken('real-jwt');
    assert.strictEqual(ok, false,
      'swapToken after markIntentionalClose returns false (transport is shutting down)');
    assert.strictEqual(StubWebSocket.constructionCount, countBefore,
      'no new socket constructed after intentional close');
  });

  // -------------------------------------------------------------------------
  // Test 7 — T-07-23: state-change handler NEVER receives a token argument
  // -------------------------------------------------------------------------
  test('T-07-23 — state-change handler receives ONLY the enum value, never a JWT', async () => {
    const transport = new CloudTransport(
      'wss://relay.fly.dev',
      'vc-7f3a92',
      'bootstrap-jwt',
      StubCtor,
    );
    const capturedArgs: unknown[][] = [];
    // Spy that captures ALL arguments (not just the first).
    transport.onStateChange(((...args: unknown[]) => {
      capturedArgs.push(args);
    }) as unknown as (s: CloudConnectionState) => void);

    void transport.connect();
    const bootstrap = StubWebSocket.instances[0];
    bootstrap.readyState = 1;
    bootstrap.emit('open');

    const swapPromise = transport.swapToken('real-jwt-secret-value-XYZ');
    await new Promise((r) => setImmediate(r));
    if (StubWebSocket.instances.length >= 2) {
      const realSocket = StubWebSocket.instances[1];
      realSocket.readyState = 1;
      realSocket.emit('open');
    }
    await swapPromise;

    // EVERY captured invocation must have exactly 1 argument that is a
    // string enum value (NOT a JWT).
    for (const args of capturedArgs) {
      assert.strictEqual(args.length, 1,
        `state-change handler must receive exactly 1 argument; got ${args.length}: ${JSON.stringify(args)}`);
      const stateValue = args[0];
      assert.strictEqual(typeof stateValue, 'string',
        `state value must be a string; got ${typeof stateValue}`);
      // The state value must be one of the documented enum values, NEVER the
      // JWT. We assert NOT-JWT by negative-matching the JWT we passed.
      assert.notStrictEqual(stateValue, 'real-jwt-secret-value-XYZ',
        'state-change MUST NEVER receive the JWT value');
      assert.notStrictEqual(stateValue, 'bootstrap-jwt',
        'state-change MUST NEVER receive the bootstrap JWT value');
    }
  });

  // -------------------------------------------------------------------------
  // Source-grep — swapToken + swapInProgress literals in source
  // -------------------------------------------------------------------------
  test('source-grep: CloudTransport.ts declares swapToken method and swapInProgress field', () => {
    const cloudTransportPath = path.resolve(process.cwd(), 'src/network/CloudTransport.ts');
    const src = fsSync.readFileSync(cloudTransportPath, 'utf-8');

    const swapTokenCount = (src.match(/swapToken/g) || []).length;
    assert.ok(swapTokenCount >= 2,
      `swapToken must appear ≥2 times in CloudTransport.ts (declaration + internal refs); got ${swapTokenCount}`);

    const swapInProgressCount = (src.match(/swapInProgress/g) || []).length;
    assert.ok(swapInProgressCount >= 2,
      `swapInProgress must appear ≥2 times in CloudTransport.ts (field + read sites); got ${swapInProgressCount}`);

    // Signature shape — async method returning Promise<boolean>.
    assert.match(src, /swapToken\s*\(\s*newToken\s*:\s*string\s*\)\s*:\s*Promise<boolean>/,
      'swapToken(newToken: string): Promise<boolean> signature present');

    // The token field is no longer readonly (the swap mutates it).
    assert.doesNotMatch(src, /private readonly token: string/,
      'token field MUST NOT be readonly (swapToken mutates this.token)');
    assert.match(src, /private token: string/,
      'token field declared as private (mutable) string');
  });

  // -------------------------------------------------------------------------
  // Source-grep — close-handler suppresses reconnect when swapInProgress
  // -------------------------------------------------------------------------
  test('source-grep: close handler checks swapInProgress before scheduling reconnect', () => {
    const cloudTransportPath = path.resolve(process.cwd(), 'src/network/CloudTransport.ts');
    const src = fsSync.readFileSync(cloudTransportPath, 'utf-8');

    // The close handler body must reference swapInProgress to gate both
    // emitStateChange AND the ReconnectManager scheduling.
    const closeHandlerIdx = src.indexOf("ws.on('close'");
    assert.ok(closeHandlerIdx >= 0, 'close handler found');
    // Take a generous window covering the close handler body.
    const window = src.substring(closeHandlerIdx, closeHandlerIdx + 2000);
    assert.match(window, /swapInProgress/,
      'close handler must reference swapInProgress to suppress state-emit + reconnect during swap');
  });
});
