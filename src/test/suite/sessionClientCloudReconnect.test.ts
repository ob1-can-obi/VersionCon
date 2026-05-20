import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';
import { SessionClient } from '../../client/SessionClient.js';
import type { ClientTransport } from '../../network/Transport.js';
import type { ProtocolMessage } from '../../network/protocol.js';

// -----------------------------------------------------------------------------
// Phase 7 Plan 07-14 — SessionClient cloud reconnect orchestration tests
//
// MD-03 / SC-2 closure step 2 of 2 (SessionClient orchestration). The FIRST
// auth-response over the bootstrap socket carries `token` field = real
// per-joiner JWT. SessionClient must:
//
//   1. Detect msg.token + transport.isCloud() === true + !cloudSwapCompleted
//   2. Invoke (transport as CloudTransport).swapToken(msg.token)
//   3. Set cloudSwapCompleted = true (so the SECOND auth-response is not
//      reprocessed as a swap trigger)
//   4. DEFER `connection-changed: connected` emit until after the swap
//      settles. The SECOND auth-response (over real-JWT socket) carries the
//      canonical memberId and runs the legacy completion which emits.
//
// LAN regression: auth-response without token → byte-identical legacy flow.
//
// Source-grep N-07-14-B: SessionClient does NOT hard-code 'bootstrap-' marker.
// -----------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stub cloud-style transport with swapToken + isCloud (the CloudTransport
// shape). For LAN tests, omit isCloud + swapToken — that's the LAN shape.
// ---------------------------------------------------------------------------
class StubCloudTransport implements ClientTransport {
  public readonly sentFrames: ProtocolMessage[] = [];
  public swapCalls: Array<{ token: string; resolve: (ok: boolean) => void }> = [];
  public swapInvocations = 0;
  public intentionalCloseCalled = false;
  private openHandlers: Array<() => void> = [];
  private messageHandlers: Array<(raw: Buffer | ArrayBuffer | Buffer[]) => void> = [];
  private closeHandlers: Array<(code: number, reason: Buffer) => void> = [];
  private errorHandlers: Array<() => void> = [];
  private pongHandlers: Array<() => void> = [];
  private opened = false;

  async connect(): Promise<boolean> {
    this.opened = true;
    for (const h of this.openHandlers) {
      try { h(); } catch { /* ignore */ }
    }
    return true;
  }
  onOpen(h: () => void): void { this.openHandlers.push(h); }
  onMessage(h: (raw: Buffer | ArrayBuffer | Buffer[]) => void): void { this.messageHandlers.push(h); }
  onClose(h: (code: number, reason: Buffer) => void): void { this.closeHandlers.push(h); }
  onError(h: () => void): void { this.errorHandlers.push(h); }
  onPong(h: () => void): void { this.pongHandlers.push(h); }
  send(msg: ProtocolMessage): boolean {
    this.sentFrames.push(msg);
    return this.opened;
  }
  ping(): void { /* noop */ }
  isOpen(): boolean { return this.opened; }
  close(_code?: number, _reason?: string): void { this.opened = false; }
  isCloud(): boolean { return true; }
  markIntentionalClose(): void { this.intentionalCloseCalled = true; }

  /**
   * Swap-token contract used by SessionClient. Returns a Promise that the
   * test resolves manually so we can observe the "deferred emit" timing.
   */
  swapToken(newToken: string): Promise<boolean> {
    this.swapInvocations++;
    return new Promise<boolean>((resolve) => {
      this.swapCalls.push({ token: newToken, resolve });
    });
  }

  // Test helper — inject a frame.
  _injectMessage(payload: ProtocolMessage): void {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf-8');
    for (const h of this.messageHandlers) {
      try { h(bytes); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Stub LAN transport (no isCloud, no swapToken) — for LAN regression test.
// ---------------------------------------------------------------------------
class StubLanTransport implements ClientTransport {
  public readonly sentFrames: ProtocolMessage[] = [];
  private openHandlers: Array<() => void> = [];
  private messageHandlers: Array<(raw: Buffer | ArrayBuffer | Buffer[]) => void> = [];
  private closeHandlers: Array<(code: number, reason: Buffer) => void> = [];
  private errorHandlers: Array<() => void> = [];
  private pongHandlers: Array<() => void> = [];
  private opened = false;

  async connect(): Promise<boolean> {
    this.opened = true;
    for (const h of this.openHandlers) {
      try { h(); } catch { /* ignore */ }
    }
    return true;
  }
  onOpen(h: () => void): void { this.openHandlers.push(h); }
  onMessage(h: (raw: Buffer | ArrayBuffer | Buffer[]) => void): void { this.messageHandlers.push(h); }
  onClose(h: (code: number, reason: Buffer) => void): void { this.closeHandlers.push(h); }
  onError(h: () => void): void { this.errorHandlers.push(h); }
  onPong(h: () => void): void { this.pongHandlers.push(h); }
  send(msg: ProtocolMessage): boolean { this.sentFrames.push(msg); return this.opened; }
  ping(): void { /* noop */ }
  isOpen(): boolean { return this.opened; }
  close(_code?: number, _reason?: string): void { this.opened = false; }
  // NO isCloud method — LAN path
  _injectMessage(payload: ProtocolMessage): void {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf-8');
    for (const h of this.messageHandlers) {
      try { h(bytes); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Phase 7 — SessionClient cloud reconnect (Plan 07-14)', () => {
  // -------------------------------------------------------------------------
  // Test 1 — first auth-response with token triggers swap; emit is deferred
  // -------------------------------------------------------------------------
  test('first auth-response with token + isCloud → triggers swapToken; defers connection-changed emit', async () => {
    const transport = new StubCloudTransport();
    const client = new SessionClient('wss://r.fly.dev', 0, 'INV1', 'Bob', transport);
    const emittedEvents: Array<{ status: string }> = [];
    client.on('connection-changed', (data) => emittedEvents.push(data));

    // Kick off connect() — this installs handlers and triggers transport.connect()
    void client.connect();
    await new Promise((r) => setImmediate(r));

    // Inject the FIRST auth-response (over bootstrap socket). It carries
    // memberId='first-uuid' AND token='real-jwt'. SessionClient must NOT
    // emit connection-changed yet; it must invoke transport.swapToken.
    transport._injectMessage({
      type: 'auth-response',
      accepted: true,
      memberId: 'first-uuid',
      sessionInfo: { name: 'test', memberCount: 2, hostDisplayName: 'host' },
      token: 'real-jwt-from-host',
      timestamp: Date.now(),
    });

    // Allow microtasks to flush.
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(transport.swapInvocations, 1,
      'transport.swapToken invoked exactly once on first auth-response with token');
    assert.strictEqual(transport.swapCalls[0].token, 'real-jwt-from-host',
      'swapToken called with the real-JWT from auth-response.token');

    // No 'connection-changed: connected' yet — emit deferred until after swap.
    const connectedEmits = emittedEvents.filter(e => e.status === 'connected');
    assert.strictEqual(connectedEmits.length, 0,
      'connection-changed:connected MUST be deferred until after swap settles');
  });

  // -------------------------------------------------------------------------
  // Test 2 — SECOND auth-response (post-swap) emits connection-changed; canonical memberId
  // -------------------------------------------------------------------------
  test('second auth-response (post-swap) carries canonical memberId and emits connection-changed', async () => {
    const transport = new StubCloudTransport();
    const client = new SessionClient('wss://r.fly.dev', 0, 'INV1', 'Bob', transport);
    const emittedEvents: Array<{ status: string }> = [];
    client.on('connection-changed', (data) => emittedEvents.push(data));

    void client.connect();
    await new Promise((r) => setImmediate(r));

    // FIRST auth-response (bootstrap socket) — triggers swap.
    transport._injectMessage({
      type: 'auth-response',
      accepted: true,
      memberId: 'bootstrap-socket-uuid',
      sessionInfo: { name: 'test', memberCount: 2, hostDisplayName: 'host' },
      token: 'real-jwt',
      timestamp: Date.now(),
    });
    await new Promise((r) => setImmediate(r));

    // Resolve the swap — emulates the new socket opening successfully.
    transport.swapCalls[0].resolve(true);
    await new Promise((r) => setImmediate(r));

    // SECOND auth-response (over real-JWT socket) — carries the canonical
    // memberId. Note: it can ALSO carry a token field (the host always
    // includes one in auth-response.token) — but SessionClient's
    // cloudSwapCompleted guard prevents re-triggering the swap.
    transport._injectMessage({
      type: 'auth-response',
      accepted: true,
      memberId: 'canonical-real-uuid',
      sessionInfo: { name: 'test', memberCount: 2, hostDisplayName: 'host' },
      token: 'real-jwt',  // post-swap token — cloudSwapCompleted blocks re-swap
      timestamp: Date.now(),
    });
    await new Promise((r) => setImmediate(r));

    // NOW connection-changed:connected should have fired.
    const connectedEmits = emittedEvents.filter(e => e.status === 'connected');
    assert.strictEqual(connectedEmits.length, 1,
      'connection-changed:connected emits exactly once (after second auth-response)');

    // Canonical memberId is from the SECOND auth-response.
    assert.strictEqual(client.getMemberId(), 'canonical-real-uuid',
      'getMemberId() returns the SECOND auth-response memberId (NOT the bootstrap one)');

    // swapToken was called only ONCE (the second auth-response did NOT
    // re-trigger swap because cloudSwapCompleted is true).
    assert.strictEqual(transport.swapInvocations, 1,
      'swapToken invoked exactly once total (cloudSwapCompleted prevents re-trigger)');
  });

  // -------------------------------------------------------------------------
  // Test 3 — LAN regression: auth-response without token → byte-identical
  // legacy completion (synchronous emit)
  // -------------------------------------------------------------------------
  test('LAN auth-response without token → emits connection-changed synchronously (legacy path)', async () => {
    const transport = new StubLanTransport();
    const client = new SessionClient('192.168.1.10', 1234, 'INV1', 'Bob', transport);
    const emittedEvents: Array<{ status: string }> = [];
    client.on('connection-changed', (data) => emittedEvents.push(data));

    void client.connect();
    await new Promise((r) => setImmediate(r));

    // LAN auth-response carries memberId but NO token field.
    transport._injectMessage({
      type: 'auth-response',
      accepted: true,
      memberId: 'lan-member-uuid',
      sessionInfo: { name: 'lan-test', memberCount: 2, hostDisplayName: 'host' },
      timestamp: Date.now(),
    });
    await new Promise((r) => setImmediate(r));

    // LAN path fires connection-changed:connected IMMEDIATELY (no deferral).
    const connectedEmits = emittedEvents.filter(e => e.status === 'connected');
    assert.strictEqual(connectedEmits.length, 1,
      'LAN path emits connection-changed:connected synchronously (legacy completion)');
    assert.strictEqual(client.getMemberId(), 'lan-member-uuid',
      'LAN path stores memberId from the first auth-response (no swap)');
  });

  // -------------------------------------------------------------------------
  // Source-grep — N-07-14-B: SessionClient.ts has 0 'bootstrap-' references
  // AND contains swapToken / cloudSwapCompleted symbols
  // -------------------------------------------------------------------------
  test('N-07-14-B: SessionClient does NOT hard-code bootstrap sub marker; has swap orchestration symbols', () => {
    const clientPath = path.resolve(process.cwd(), 'src/client/SessionClient.ts');
    const src = fsSync.readFileSync(clientPath, 'utf-8');

    // N-07-14-B: SessionClient must NEVER hard-code the literal 'bootstrap-'.
    // Role/identity decisions come from the auth-response payload, not from
    // claims introspection.
    const bootstrapCount = (src.match(/bootstrap-/g) || []).length;
    assert.strictEqual(bootstrapCount, 0,
      `N-07-14-B: SessionClient.ts MUST have ZERO 'bootstrap-' references; found ${bootstrapCount}`);

    // swapToken must be referenced (the orchestration call site).
    const swapTokenCount = (src.match(/swapToken/g) || []).length;
    assert.ok(swapTokenCount >= 1,
      `swapToken must appear ≥1 time in SessionClient.ts; got ${swapTokenCount}`);

    // cloudSwapCompleted guard — declared + checked + reset = ≥2 occurrences.
    const cloudSwapCompletedCount = (src.match(/cloudSwapCompleted/g) || []).length;
    assert.ok(cloudSwapCompletedCount >= 2,
      `cloudSwapCompleted must appear ≥2 times (decl + check + reset); got ${cloudSwapCompletedCount}`);

    // Auth-failed fallback when swap fails.
    assert.match(src, /Token swap failed/,
      'SessionClient must surface auth-failed: \'Token swap failed\' when swap rejects');
  });

  // -------------------------------------------------------------------------
  // Test 5 — swap failure → emits auth-failed (no infinite hang)
  // -------------------------------------------------------------------------
  test('swap failure (swapToken resolves false) → emits auth-failed with \'Token swap failed\'', async () => {
    const transport = new StubCloudTransport();
    const client = new SessionClient('wss://r.fly.dev', 0, 'INV1', 'Bob', transport);
    const authFailedEvents: Array<{ reason: string }> = [];
    client.on('auth-failed', (data) => authFailedEvents.push(data));

    void client.connect();
    await new Promise((r) => setImmediate(r));

    transport._injectMessage({
      type: 'auth-response',
      accepted: true,
      memberId: 'first-uuid',
      sessionInfo: { name: 'test', memberCount: 2, hostDisplayName: 'host' },
      token: 'real-jwt',
      timestamp: Date.now(),
    });
    await new Promise((r) => setImmediate(r));

    // Resolve the swap with FALSE — emulates the new WSS handshake failing.
    transport.swapCalls[0].resolve(false);
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(authFailedEvents.length, 1,
      'auth-failed emits exactly once when swap rejects');
    assert.strictEqual(authFailedEvents[0].reason, 'Token swap failed',
      'auth-failed reason is the literal \'Token swap failed\'');
  });
});
