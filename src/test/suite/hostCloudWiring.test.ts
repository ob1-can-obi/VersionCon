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

  // ---------------------------------------------------------------------------
  // Regression: bootstrap-swap-presence-leak (UAT-3b, 2026-05-30)
  //
  // Before the fix, an auth-request arriving on a virtConn whose memberId
  // started with 'bootstrap-' caused handleAuthRequest to register a member
  // entry, broadcast member-joined, and send state-sync — exactly as if the
  // bootstrap WSS were a real joiner. The post-swap connection then arrived
  // with a distinct memberId, ran handleAuthRequest AGAIN, and registered a
  // SECOND member entry for the same logical joiner. Both entries eventually
  // disappeared via heartbeat-timeout (cloud-mode ping is a no-op so
  // cm.isAlive was never refreshed), leaving the joiner invisible in the
  // host's MEMBERS panel despite a live WSS at the relay.
  //
  // The fix gates handleAuthRequest on the bootstrap detection: the bootstrap
  // path mints + sends the per-joiner JWT (so the joiner can swapToken) but
  // does NOT register a member, does NOT broadcast member-joined, and does
  // NOT send state-sync/chat-history/review-state-sync.
  // ---------------------------------------------------------------------------

  test('regression: bootstrap virtConn does NOT register a member or broadcast member-joined', async () => {
    const fake = new FakeClientTransport();
    const sessionId = 'vc-abc234';
    const host = await createCloud({
      config: makeConfig(),
      hostIdentity: makeHostIdentity(),
      relayUrl: 'wss://relay.test',
      sessionId,
      _testClientTransport: fake,
    });
    try {
      await host.start();

      // Capture host-emitted 'member-joined' events. SessionHost extends
      // EventEmitter; the type is opaque from outside so we cast through
      // unknown. The bootstrap path MUST NOT emit this event, the post-swap
      // path MUST emit it exactly once.
      const memberJoinedEventNames: string[] = [];
      (host as unknown as {
        on: (event: string, fn: (data: unknown) => void) => void;
      }).on('member-joined', (data: unknown) => {
        const d = data as { member?: { displayName?: string } };
        memberJoinedEventNames.push(d?.member?.displayName ?? '?');
      });

      // Reach into the host for member-count introspection. getMembers()
      // returns ONLY the joined members (the host itself is tracked
      // separately via hostMemberId, so this count starts at 0 here because
      // there is no loopback host-client wired in this test).
      const getJoinedCount = (): number =>
        (host as unknown as { getMembers: () => unknown[] }).getMembers().length;

      assert.strictEqual(getJoinedCount(), 0, 'precondition: no joined members yet');

      const sentBeforeBootstrap = fake.sentFrames.length;

      // Simulate the joiner's BOOTSTRAP auth-request. payload.memberId is
      // 'bootstrap-' + sessionId — matches the sub claim minted by
      // TokenService.issueBootstrap. The relay annotates payload.memberId
      // from claims.sub on every member->host frame, so this is the
      // production wire shape for the bootstrap socket.
      fake._simulateEnvelope(sessionId, {
        type: 'auth-request',
        inviteCode: 'ABC234',
        displayName: 'Joiner-Bob',
        timestamp: Date.now(),
        memberId: 'bootstrap-' + sessionId,
      });
      // Two microtask drains: one for CloudHostTransport.handleInbound's
      // queueMicrotask first-dispatch + one for handleAuthRequest's await on
      // TokenService.issue (HMAC sign is in-process so a single tick suffices,
      // but two drains is defense in depth across Node minor versions).
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Assertion 1: auth-response WAS sent (joiner needs token for swap).
      const bootstrapAuthResponses = fake.sentFrames
        .slice(sentBeforeBootstrap)
        .filter((f) => f.type === 'auth-response') as Array<ProtocolMessage & {
          type: 'auth-response';
          accepted: boolean;
          token?: string;
        }>;
      assert.strictEqual(
        bootstrapAuthResponses.length,
        1,
        'bootstrap path emits exactly one auth-response (with token for swap)',
      );
      assert.strictEqual(bootstrapAuthResponses[0].accepted, true, 'bootstrap auth accepted');
      assert.ok(
        typeof bootstrapAuthResponses[0].token === 'string' &&
          bootstrapAuthResponses[0].token.length > 0,
        'bootstrap auth-response carries the per-joiner JWT for swapToken',
      );

      // Assertion 2: NO state-sync frame sent on the bootstrap path. The
      // post-swap connection will send the authoritative state-sync.
      const bootstrapStateSyncs = fake.sentFrames
        .slice(sentBeforeBootstrap)
        .filter((f) => f.type === 'state-sync');
      assert.strictEqual(
        bootstrapStateSyncs.length,
        0,
        'bootstrap path MUST NOT send state-sync (post-swap is authoritative)',
      );

      // Assertion 3: NO 'member-joined' EventEmitter event fired. This is
      // the load-bearing assertion — before the fix, this would be 1
      // (causing the UAT-3b symptom: a phantom member entry registered by
      // the bootstrap socket, eventually removed via heartbeat-timeout when
      // cm.isAlive was never refreshed in cloud mode).
      assert.strictEqual(
        memberJoinedEventNames.length,
        0,
        'bootstrap path MUST NOT emit "member-joined" event (the bug: it did)',
      );

      // Assertion 4: members count did NOT increment. The bootstrap virtConn
      // is auth-only and must be invisible to the presence layer.
      assert.strictEqual(
        getJoinedCount(),
        0,
        'bootstrap path MUST NOT add to this.members (the bug: it added one)',
      );

      // ---------------------------------------------------------------------
      // Now simulate the POST-SWAP auth-request with a normal (non-bootstrap)
      // memberId — this MUST behave like a real joiner: members.set fires,
      // state-sync is sent, the 'member-joined' event emits. The post-swap
      // memberId mirrors what the relay would annotate from claims.sub of
      // the per-joiner JWT (a fresh UUID minted by handleAuthRequest's
      // bootstrap path above).
      // ---------------------------------------------------------------------

      const sentBeforeSwap = fake.sentFrames.length;
      fake._simulateEnvelope(sessionId, {
        type: 'auth-request',
        inviteCode: 'ABC234',
        displayName: 'Joiner-Bob',
        timestamp: Date.now(),
        memberId: 'post-swap-uuid-for-test',
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Assertion 5: state-sync IS sent on the post-swap path (joiner gets
      // the authoritative member list).
      const postSwapStateSyncs = fake.sentFrames
        .slice(sentBeforeSwap)
        .filter((f) => f.type === 'state-sync');
      assert.strictEqual(
        postSwapStateSyncs.length,
        1,
        'post-swap path DOES send state-sync (normal joiner flow)',
      );

      // Assertion 6: 'member-joined' EventEmitter event fires exactly once.
      assert.strictEqual(
        memberJoinedEventNames.length,
        1,
        'post-swap path emits "member-joined" event exactly once',
      );
      assert.strictEqual(
        memberJoinedEventNames[0],
        'Joiner-Bob',
        'emitted member-joined carries the joiner displayName',
      );

      // Assertion 7: members count IS exactly 1 after the post-swap auth.
      // Net result across both legs of the swap: ONE member entry (the bug
      // would produce TWO — one from bootstrap, one from post-swap).
      assert.strictEqual(
        getJoinedCount(),
        1,
        'after bootstrap + post-swap, exactly ONE member is registered (the bug: TWO)',
      );
    } finally {
      host.stop();
    }
  });
  // ---------------------------------------------------------------------------
  // Regression: presence-asymmetric-host-blind (UAT-8-5, 2026-05-30)
  //
  // Before the fix, the post-swap joiner connection registered the joiner under
  // a FRESH crypto.randomUUID() in this.members. The relay binds the joiner WSS
  // to the JWT sub (a UUID minted by the bootstrap branch of handleAuthRequest).
  // The auth-response carried the host-minted (fresh) memberId back to the
  // joiner, so SessionClient.memberId held an id that DIFFERED from the relay's
  // claims.sub binding. Every subsequent presence-update frame (which carries
  // payload.memberId per protocol.ts PresenceUpdate) tripped the relay's
  // annotateMemberFrame spoof check (server.ts ~line 392) -- existing !== memberSub
  // -- and closed the WSS with 4400 'malformed-or-spoofed-member-frame'. The
  // joiner's CloudTransport then auto-reconnected, masking the symptom on the
  // MEMBERS panel (which sustained 'online' through the rapid reconnect cycle)
  // while PRESENCE joiner->host stayed silently broken (heartbeat-pong has no
  // memberId field so it passed annotateMemberFrame, sustaining the alive flag).
  //
  // The fix reuses the JWT-bound memberId (carried in the synthetic
  // IncomingMessage header 'x-cloud-virtual-memberid' that CloudHostTransport
  // sets when it allocates the virtConn) as the host-tracked memberId for
  // cloud-mode post-swap connections. LAN connections (no header) keep the
  // pre-fix crypto.randomUUID() path.
  // ---------------------------------------------------------------------------

  test('regression: cloud post-swap auth-response.memberId == relay-bound JWT sub (no spoof close)', async () => {
    const fake = new FakeClientTransport();
    const sessionId = 'vc-presence-asym';
    const host = await createCloud({
      config: makeConfig(),
      hostIdentity: makeHostIdentity(),
      relayUrl: 'wss://relay.test',
      sessionId,
      _testClientTransport: fake,
    });
    try {
      await host.start();

      const sentBeforeSwap = fake.sentFrames.length;

      // Simulate the production-shape POST-SWAP first frame. The relay annotates
      // payload.memberId from claims.sub on every member->host envelope; for a
      // post-swap connection that sub is the UUID minted by the bootstrap branch
      // of handleAuthRequest. Use a UUID-shaped value here to exercise the
      // production cloudPreboundMemberId path (NOT a 'bootstrap-' prefix, which
      // would route to the bootstrap suppression branch).
      const relayBoundMemberId = '11111111-2222-3333-4444-555566667777';
      fake._simulateEnvelope(sessionId, {
        type: 'auth-request',
        inviteCode: 'ABC234',
        displayName: 'Joiner-Bob',
        timestamp: Date.now(),
        memberId: relayBoundMemberId,
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Locate the auth-response that came back over the post-swap virtConn.
      const responses = fake.sentFrames
        .slice(sentBeforeSwap)
        .filter((f) => f.type === 'auth-response') as Array<ProtocolMessage & {
          type: 'auth-response';
          accepted: boolean;
          memberId?: string;
          token?: string;
        }>;
      assert.strictEqual(responses.length, 1, 'exactly one auth-response on the post-swap path');
      assert.strictEqual(responses[0].accepted, true, 'post-swap auth accepted');

      // CORE INVARIANT -- the fix: auth-response.memberId MUST equal the
      // relay-bound JWT sub (which the synthetic req header carries verbatim).
      // Before the fix, this would be a fresh crypto.randomUUID() that the
      // host minted in handleAuthRequest's new-member path -- different from
      // claims.sub -- causing the relay's downstream annotateMemberFrame spoof
      // check to close 4400 on every joiner->host presence-update.
      assert.strictEqual(
        responses[0].memberId,
        relayBoundMemberId,
        'auth-response.memberId MUST equal claims.sub (relay-bound id) so ' +
          'joiner-emitted payload.memberId on presence-update passes the ' +
          'annotateMemberFrame spoof check at the relay',
      );

      // The host-side this.members entry MUST be keyed by the same id so
      // PresenceMap upserts and broadcast iteration target the right key.
      const members = (host as unknown as { getMembers: () => Array<{ id: string }> }).getMembers();
      assert.strictEqual(members.length, 1, 'exactly one member registered on the host');
      assert.strictEqual(
        members[0].id,
        relayBoundMemberId,
        'this.members is keyed by the relay-bound id, not by a fresh UUID',
      );

      // Defensive: confirm the per-joiner JWT issued for the post-swap leg
      // also carries the SAME sub (so a future reconnect with this token
      // binds to the same id). The token is in the legacy post-swap path
      // (joiner-cap path mints role:'member' tokens with sub=newMemberId).
      if (typeof responses[0].token === 'string') {
        const claims = decodeJwt(responses[0].token);
        assert.strictEqual(
          claims.sub,
          relayBoundMemberId,
          'post-swap joiner JWT.sub = relay-bound id (closes the reconnect loop)',
        );
      }
    } finally {
      host.stop();
    }
  });

});
