// -----------------------------------------------------------------------------
// Phase 7 Plan 07-05b — host cloud wiring tests (RED → GREEN).
//
// SessionHostFactory.createCloud() bootstraps a fully-wired SessionHost whose
// transport is a CloudHostTransport demultiplexer over a connected
// CloudTransport. This file pins:
//   1. createCloud roundtrip — returns SessionHost wired with CloudHostTransport
//   2. TokenService.newSecret invoked exactly once per createCloud
//   3. JWT issuance with the correct {iss, sub, aud, role:'host'} claims
//   4. session-register frame emitted exactly once BEFORE the Promise resolves
//   5. session-register is the FIRST frame on the wire
//   6. cloud-mode handleAuthRequest issues per-joiner JWT in auth-response.token
//   7. LAN-mode handleAuthRequest does NOT include token (byte-identical regression)
//   8. Invite code NEVER reaches CloudTransport.send
//   9-11. Source-grep gates against rejected dead-code patterns in SessionHost.ts
//        AND against inviteCode references in CloudHostTransport/SessionHostFactory.
//
// Tests use a stubbed CloudTransport (the same EventEmitter approach as
// cloudTransport.test.ts) to avoid opening real WSS sockets. The stub records
// every send() call in order so the FIRST-frame and ONE-call invariants are
// observable from the test code.
// -----------------------------------------------------------------------------

import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';
import { decodeJwt } from 'jose';
import { EventEmitter } from 'events';
import { createCloud } from '../../host/SessionHostFactory.js';
import { CloudHostTransport } from '../../network/CloudHostTransport.js';
import { SessionHost } from '../../host/SessionHost.js';
import { TokenService } from '../../auth/TokenService.js';
import type { ProtocolMessage } from '../../network/protocol.js';
import type { ClientTransport } from '../../network/Transport.js';
import type { HostIdentity, SessionConfig } from '../../types/session.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Fake ClientTransport that captures every send() call in order and exposes
 * inbound-message simulation via _simulateMessage. Used to drive
 * CloudHostTransport from the test without opening a real WSS connection.
 *
 * NOTE: createCloud passes this through new CloudTransport(...) in production.
 * For these tests, we inject the fake at the seam by patching the
 * CloudTransport ctor — see makeFactoryHarness below.
 */
class FakeClientTransport implements ClientTransport {
  public readonly sentFrames: ProtocolMessage[] = [];
  public readonly sentFrameTargets: Array<string | undefined> = [];
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
    this.sentFrameTargets.push(target);
    return this.opened;
  }

  ping(): void { /* no-op */ }
  isOpen(): boolean { return this.opened; }
  close(_code?: number, _reason?: string): void { this.opened = false; }

  // Test seam — synthesize an inbound envelope by raw bytes.
  _simulateRaw(raw: Buffer): void {
    for (const h of this.messageHandlers) {
      try { h(raw); } catch { /* ignore */ }
    }
  }

  // Helper: simulate inbound payload bytes. Mirrors CloudTransport's
  // onMessage contract (handlers receive env.payload re-serialized, NOT the
  // full envelope) so CloudHostTransport.handleInbound sees the production
  // shape.
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

function makeConfig(): SessionConfig {
  return {
    sessionName: 'test session',
    port: 0,
    networkInterface: '0.0.0.0',
    maxPayloadBytes: 1024 * 1024,
    inviteCode: 'ABC234',
  };
}

function makeHostIdentity(): HostIdentity {
  return {
    memberId: 'host-mid-fixed-for-test',
    displayName: 'Test Host',
    hostAuthSecret: 'host-secret-fixed-for-test',
  };
}

// ---------------------------------------------------------------------------
// Suite 1 — host cloud wiring (createCloud + per-joiner JWT)
// ---------------------------------------------------------------------------

suite('Phase 7 — host cloud wiring', () => {
  test('createCloud returns a SessionHost wired with a CloudHostTransport', async () => {
    const fake = new FakeClientTransport();
    const host = await createCloud({
      config: makeConfig(),
      hostIdentity: makeHostIdentity(),
      relayUrl: 'wss://relay.test',
      sessionId: 'vc-abc234',
      _testClientTransport: fake,
    });
    try {
      assert.ok(host instanceof SessionHost, 'must return a SessionHost');
      // CloudHostTransport is set as host.transport — accessed via test-only getter.
      const transport = (host as unknown as { transport: unknown }).transport;
      assert.ok(
        transport instanceof CloudHostTransport,
        'host.transport must be a CloudHostTransport in cloud mode',
      );
    } finally {
      host.stop();
    }
  });

  test('createCloud invokes TokenService.newSecret exactly once', async () => {
    const fake = new FakeClientTransport();
    const original = TokenService.newSecret;
    let calls = 0;
    TokenService.newSecret = (): Uint8Array => {
      calls++;
      return original.call(TokenService);
    };
    try {
      const host = await createCloud({
        config: makeConfig(),
        hostIdentity: makeHostIdentity(),
        relayUrl: 'wss://relay.test',
        sessionId: 'vc-abc234',
        _testClientTransport: fake,
      });
      try {
        assert.strictEqual(calls, 1, 'TokenService.newSecret must be called exactly once');
      } finally {
        host.stop();
      }
    } finally {
      TokenService.newSecret = original;
    }
  });

  test('createCloud issues host JWT with claims {iss, sub, aud, role:host}', async () => {
    const fake = new FakeClientTransport();
    const hostIdentity = makeHostIdentity();
    const host = await createCloud({
      config: makeConfig(),
      hostIdentity,
      relayUrl: 'wss://relay.test',
      sessionId: 'vc-abc234',
      _testClientTransport: fake,
    });
    try {
      // The host JWT is passed to the CloudTransport constructor — the fake
      // exposes it via the _testIssuedHostJwt seam set by createCloud.
      const issuedJwt = (host as unknown as { _testHostJwt?: string })._testHostJwt;
      assert.ok(typeof issuedJwt === 'string' && issuedJwt.length > 0, 'host JWT was issued');
      const claims = decodeJwt(issuedJwt);
      assert.strictEqual(claims.iss, hostIdentity.memberId, 'iss claim = host memberId');
      assert.strictEqual(claims.sub, hostIdentity.memberId, 'sub claim = host memberId');
      assert.strictEqual(claims.aud, 'vc-abc234', 'aud claim = sessionId');
      assert.strictEqual(claims.role, 'host', 'role claim = host');
    } finally {
      host.stop();
    }
  });

  test('createCloud emits exactly ONE session-register envelope BEFORE resolving', async () => {
    const fake = new FakeClientTransport();
    const host = await createCloud({
      config: makeConfig(),
      hostIdentity: makeHostIdentity(),
      relayUrl: 'wss://relay.test',
      sessionId: 'vc-abc234',
      _testClientTransport: fake,
    });
    try {
      const regFrames = fake.sentFrames.filter((f) => f.type === 'session-register');
      assert.strictEqual(regFrames.length, 1, 'exactly one session-register frame');
      const frame = regFrames[0] as ProtocolMessage & {
        type: 'session-register';
        sessionId: string;
        verifySecret: string;
      };
      assert.strictEqual(frame.sessionId, 'vc-abc234', 'session-register.sessionId');
      assert.strictEqual(typeof frame.verifySecret, 'string', 'verifySecret is string');
      const decoded = Buffer.from(frame.verifySecret, 'base64');
      assert.strictEqual(decoded.length, 32, 'verifySecret decodes to 32 bytes');
    } finally {
      host.stop();
    }
  });

  test('session-register is the FIRST frame sent on the CloudTransport', async () => {
    const fake = new FakeClientTransport();
    const host = await createCloud({
      config: makeConfig(),
      hostIdentity: makeHostIdentity(),
      relayUrl: 'wss://relay.test',
      sessionId: 'vc-abc234',
      _testClientTransport: fake,
    });
    try {
      assert.ok(fake.sentFrames.length >= 1, 'at least one frame was sent');
      assert.strictEqual(
        fake.sentFrames[0].type,
        'session-register',
        'first frame must be session-register',
      );
    } finally {
      host.stop();
    }
  });

  test('cloud mode: handleAuthRequest issues per-joiner JWT in auth-response.token', async () => {
    const fake = new FakeClientTransport();
    const hostIdentity = makeHostIdentity();
    const host = await createCloud({
      config: makeConfig(),
      hostIdentity,
      relayUrl: 'wss://relay.test',
      sessionId: 'vc-abc234',
      _testClientTransport: fake,
    });
    try {
      // start() wires SessionHost's onConnection handler into the
      // CloudHostTransport — without this, inbound envelopes will not
      // produce SessionHost.handleConnection calls.
      await host.start();

      // Simulate an inbound auth-request envelope with payload.memberId so the
      // demultiplexer creates a virtual connection for it.
      fake._simulateEnvelope('vc-abc234', {
        type: 'auth-request',
        inviteCode: 'ABC234',
        displayName: 'Joiner',
        timestamp: Date.now(),
        memberId: 'joiner-routing-key-1',
      });
      // The demultiplexer queues the first dispatch in a microtask; allow
      // both the microtask AND the async handleAuthRequest (which awaits
      // TokenService.issue) to complete before we read sent frames.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Auth-response is emitted via cloudTransport.send (unicast w/ target).
      const authResponses = fake.sentFrames.filter((f) => f.type === 'auth-response');
      assert.ok(authResponses.length >= 1, 'auth-response sent');
      const resp = authResponses[0] as ProtocolMessage & {
        type: 'auth-response';
        accepted: boolean;
        memberId?: string;
        token?: string;
      };
      assert.strictEqual(resp.accepted, true, 'auth accepted (valid invite code)');
      assert.ok(typeof resp.token === 'string' && resp.token.length > 0, 'token populated');
      const claims = decodeJwt(resp.token);
      assert.strictEqual(claims.sub, resp.memberId, 'token.sub = newly issued memberId');
      assert.strictEqual(claims.aud, 'vc-abc234', 'token.aud = sessionId');
      assert.strictEqual(claims.role, 'member', 'token.role = member');
    } finally {
      host.stop();
    }
  });

  test('LAN mode: handleAuthRequest does NOT include token in auth-response (regression)', async () => {
    // Use the SessionHost constructor directly (no createCloud path) so no
    // cloudTokenService is attached. Don't call start() — drive handleAuthRequest
    // synthetically by exposing it via a transport-level captured ws.
    const config = makeConfig();
    const hostIdentity = makeHostIdentity();

    // Capture sends on a fake LAN-style transport so we can read the response.
    const sent: ProtocolMessage[] = [];
    const fakeLan = {
      listen: async () => 0,
      onConnection: () => {},
      onError: () => {},
      send: (_conn: unknown, msg: ProtocolMessage) => { sent.push(msg); return true; },
      sendRaw: () => 0,
      onMessage: () => {},
      onClose: () => {},
      onErrorPerConnection: () => {},
      ping: () => {},
      onPong: () => {},
      isOpen: () => true,
      terminate: () => {},
      closeConnection: () => {},
      close: () => {},
    };
    const host = new SessionHost(config, hostIdentity, fakeLan as unknown as never);

    // Use the test seam handleAuthRequestForTest (added by Task 3 GREEN-part-2).
    const fakeWs = {} as unknown;
    await (host as unknown as {
      handleAuthRequestForTest: (
        ws: unknown,
        msg: ProtocolMessage,
        ip: string,
      ) => Promise<void>;
    }).handleAuthRequestForTest(
      fakeWs,
      {
        type: 'auth-request',
        inviteCode: 'ABC234',
        displayName: 'Joiner',
        timestamp: Date.now(),
      } as ProtocolMessage,
      '127.0.0.1',
    );

    const authResp = sent.find((f) => f.type === 'auth-response') as
      | (ProtocolMessage & { type: 'auth-response'; token?: string })
      | undefined;
    assert.ok(authResp, 'auth-response was sent');
    assert.strictEqual(
      authResp!.token,
      undefined,
      'LAN mode auth-response MUST NOT carry token field',
    );
    // Source-grep on serialized JSON: token key must not appear at all.
    assert.ok(
      !JSON.stringify(authResp).includes('"token"'),
      'LAN auth-response serialized JSON contains no "token" key',
    );
  });

  test('Invite code never reaches CloudTransport.send', async () => {
    const fake = new FakeClientTransport();
    const host = await createCloud({
      config: makeConfig(),
      hostIdentity: makeHostIdentity(),
      relayUrl: 'wss://relay.test',
      sessionId: 'vc-abc234',
      _testClientTransport: fake,
    });
    try {
      await host.start();
      // Simulate joiner auth-request so handleAuthRequest runs end-to-end.
      fake._simulateEnvelope('vc-abc234', {
        type: 'auth-request',
        inviteCode: 'ABC234',
        displayName: 'Joiner',
        timestamp: Date.now(),
        memberId: 'joiner-routing-key-1',
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Every outbound frame on CloudTransport must NOT contain inviteCode.
      for (const frame of fake.sentFrames) {
        const s = JSON.stringify(frame);
        assert.strictEqual(
          s.indexOf('inviteCode'),
          -1,
          `frame contains inviteCode (forbidden): ${s.slice(0, 200)}`,
        );
      }
    } finally {
      host.stop();
    }
  });

  test('source-grep: src/network/CloudHostTransport.ts contains zero inviteCode references', () => {
    const filePath = path.resolve(process.cwd(), 'src/network/CloudHostTransport.ts');
    const src = fsSync.readFileSync(filePath, 'utf-8');
    assert.doesNotMatch(
      src,
      /inviteCode/,
      'CloudHostTransport.ts must not reference inviteCode (invite-code locality, T-07-05)',
    );
  });

  test('source-grep: src/host/SessionHostFactory.ts contains zero inviteCode references', () => {
    const filePath = path.resolve(process.cwd(), 'src/host/SessionHostFactory.ts');
    const src = fsSync.readFileSync(filePath, 'utf-8');
    assert.doesNotMatch(
      src,
      /inviteCode/,
      'SessionHostFactory.ts must not reference inviteCode (invite-code locality, T-07-05)',
    );
  });

  test('source-grep: src/host/SessionHost.ts MUST NOT contain cloudMode/setCloudMode/handleCloudInboundFrame', () => {
    const filePath = path.resolve(process.cwd(), 'src/host/SessionHost.ts');
    const src = fsSync.readFileSync(filePath, 'utf-8');
    assert.doesNotMatch(
      src,
      /\bcloudMode\b/,
      'SessionHost.ts must not contain "cloudMode" — 07-05b merge eliminated the mode flag',
    );
    assert.doesNotMatch(
      src,
      /\bsetCloudMode\b/,
      'SessionHost.ts must not contain "setCloudMode" — 07-05b merge eliminated the setter',
    );
    assert.doesNotMatch(
      src,
      /\bhandleCloudInboundFrame\b/,
      'SessionHost.ts must not contain "handleCloudInboundFrame" — 07-05b merge eliminated the stub',
    );
  });
});
