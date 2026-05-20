// -----------------------------------------------------------------------------
// Phase 7 Plan 07-13 — gap-closure (BLOCKER 2 / MD-03 / Option A) — Task 2.
//
// SessionHostFactory.createCloud + SessionHost bootstrap-token wiring.
//
// After this task lands, the host-side cloud path produces:
//   1. A fresh per-session verifySecret (TokenService.newSecret()) — unchanged
//      from 07-05b.
//   2. A host self-JWT with role:'host' (unchanged from 07-05b).
//   3. A NEW bootstrap JWT minted via tokenService.issueBootstrap() — short-
//      lived (15m), role:'member', sub:'bootstrap-<sessionId>'. Attached to
//      the returned SessionHost via SessionHost.attachBootstrapToken().
//   4. WizardPanel picks the bootstrap JWT up via host.getBootstrapToken()
//      (lands in Task 3).
//
// Tests pin:
//   - createCloud attaches a non-empty bootstrap JWT to the returned host
//   - The bootstrap JWT carries the expected member-role claims and signs
//     against the SAME verifySecret as the host self-JWT (extracted from the
//     captured session-register envelope)
//   - LAN-mode SessionHost (constructed without createCloud) returns null
//     from getBootstrapToken() (no regression)
//   - Two sequential createCloud calls produce distinct bootstrap JWTs (jti)
//   - SessionHost.attachBootstrapToken is single-shot (mirrors attachCloudIssuer)
// -----------------------------------------------------------------------------

import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';
import { decodeJwt, jwtVerify } from 'jose';
import { createCloud } from '../../host/SessionHostFactory.js';
import { SessionHost } from '../../host/SessionHost.js';
import { TokenService } from '../../auth/TokenService.js';
import type { ProtocolMessage } from '../../network/protocol.js';
import type { ClientTransport } from '../../network/Transport.js';
import type { HostIdentity, SessionConfig } from '../../types/session.js';

// ---------------------------------------------------------------------------
// Test helpers — copy the FakeClientTransport pattern from hostCloudWiring.test.ts
// ---------------------------------------------------------------------------

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
// Suite — host bootstrap-token wiring (MD-03 Option A — Task 2 of 3)
// ---------------------------------------------------------------------------

suite('Phase 7 — host bootstrap token wiring (MD-03 Option A)', () => {
  test('after createCloud resolves, host.getBootstrapToken() returns a non-empty JWT', async () => {
    const fake = new FakeClientTransport();
    const host = await createCloud({
      config: makeConfig(),
      hostIdentity: makeHostIdentity(),
      relayUrl: 'wss://relay.test',
      sessionId: 'vc-abc234',
      _testClientTransport: fake,
    });
    try {
      const bootstrap = host.getBootstrapToken();
      assert.ok(
        typeof bootstrap === 'string' && bootstrap.length > 0,
        'bootstrap token must be a non-empty string after createCloud resolves',
      );
      assert.ok(
        (bootstrap as string).startsWith('eyJ'),
        'bootstrap token must look like a JWT (eyJ-prefixed base64url)',
      );
    } finally {
      host.stop();
    }
  });

  test('bootstrap JWT carries role:"member" and sub:"bootstrap-"+sessionId', async () => {
    const fake = new FakeClientTransport();
    const host = await createCloud({
      config: makeConfig(),
      hostIdentity: makeHostIdentity(),
      relayUrl: 'wss://relay.test',
      sessionId: 'vc-abc234',
      _testClientTransport: fake,
    });
    try {
      const jwt = host.getBootstrapToken();
      assert.ok(jwt !== null, 'jwt non-null');
      const claims = decodeJwt(jwt as string);
      assert.strictEqual(claims.role, 'member', 'role claim = member');
      assert.strictEqual(
        claims.sub,
        'bootstrap-vc-abc234',
        'sub claim = "bootstrap-" + sessionId',
      );
      assert.strictEqual(claims.aud, 'vc-abc234', 'aud claim = sessionId');
      assert.strictEqual(
        claims.iss,
        'host-mid-fixed-for-test',
        'iss claim = host memberId',
      );
    } finally {
      host.stop();
    }
  });

  test('bootstrap JWT signs against the SAME secret as the session-register payload', async () => {
    const fake = new FakeClientTransport();
    const host = await createCloud({
      config: makeConfig(),
      hostIdentity: makeHostIdentity(),
      relayUrl: 'wss://relay.test',
      sessionId: 'vc-abc234',
      _testClientTransport: fake,
    });
    try {
      // Extract the verifySecret base64 from the captured session-register
      // frame and verify the bootstrap JWT against it using the SAME path
      // the relay's verifyToken (relay/src/auth.ts) would take.
      const regFrame = fake.sentFrames.find(
        (f) => f.type === 'session-register',
      ) as
        | (ProtocolMessage & {
            type: 'session-register';
            sessionId: string;
            verifySecret: string;
          })
        | undefined;
      assert.ok(regFrame, 'session-register frame was captured');
      const verifySecret = Buffer.from(regFrame!.verifySecret, 'base64');
      assert.strictEqual(verifySecret.length, 32, 'verifySecret = 32 bytes');

      const jwt = host.getBootstrapToken();
      assert.ok(jwt !== null, 'jwt non-null');
      const { payload } = await jwtVerify(
        jwt as string,
        new Uint8Array(verifySecret),
        {
          algorithms: ['HS256'],
          audience: 'vc-abc234',
          clockTolerance: '30s',
        },
      );
      assert.strictEqual(payload.role, 'member', 'verified payload role=member');
      assert.strictEqual(
        payload.sub,
        'bootstrap-vc-abc234',
        'verified payload sub matches',
      );
    } finally {
      host.stop();
    }
  });

  test('LAN-mode SessionHost (no createCloud) returns null from getBootstrapToken (regression)', () => {
    // LAN constructor path — no createCloud, no attachBootstrapToken call.
    const config = makeConfig();
    const hostIdentity = makeHostIdentity();
    const fakeLan = {
      listen: async () => 0,
      onConnection: () => {},
      onError: () => {},
      send: () => true,
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
    const host = new SessionHost(
      config,
      hostIdentity,
      fakeLan as unknown as never,
    );
    assert.strictEqual(
      host.getBootstrapToken(),
      null,
      'LAN-mode SessionHost MUST return null from getBootstrapToken',
    );
  });

  test('two sequential createCloud calls produce DISTINCT bootstrap JWTs (jti uniqueness)', async () => {
    const fake1 = new FakeClientTransport();
    const host1 = await createCloud({
      config: makeConfig(),
      hostIdentity: makeHostIdentity(),
      relayUrl: 'wss://relay.test',
      sessionId: 'vc-aaa',
      _testClientTransport: fake1,
    });
    const fake2 = new FakeClientTransport();
    const host2 = await createCloud({
      config: makeConfig(),
      hostIdentity: makeHostIdentity(),
      relayUrl: 'wss://relay.test',
      sessionId: 'vc-bbb',
      _testClientTransport: fake2,
    });
    try {
      const jwt1 = host1.getBootstrapToken();
      const jwt2 = host2.getBootstrapToken();
      assert.ok(jwt1 && jwt2, 'both bootstrap JWTs were minted');
      assert.notStrictEqual(jwt1, jwt2, 'different sessions yield different JWTs');
      const c1 = decodeJwt(jwt1 as string);
      const c2 = decodeJwt(jwt2 as string);
      assert.notStrictEqual(c1.jti, c2.jti, 'distinct jti claims');
      assert.notStrictEqual(c1.aud, c2.aud, 'distinct aud claims (different sessionIds)');
    } finally {
      host1.stop();
      host2.stop();
    }
  });

  test('attachBootstrapToken is single-shot (second call throws — mirrors attachCloudIssuer)', () => {
    // Construct a LAN-mode host (no factory) to exercise the setter directly.
    const config = makeConfig();
    const hostIdentity = makeHostIdentity();
    const fakeLan = {
      listen: async () => 0,
      onConnection: () => {},
      onError: () => {},
      send: () => true,
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
    const host = new SessionHost(
      config,
      hostIdentity,
      fakeLan as unknown as never,
    );
    host.attachBootstrapToken('first-jwt-fake');
    assert.strictEqual(host.getBootstrapToken(), 'first-jwt-fake');
    assert.throws(
      () => host.attachBootstrapToken('second-jwt-fake'),
      /single-shot/i,
      'second attachBootstrapToken call MUST throw',
    );
  });

  test('source-grep: SessionHost.ts contains bootstrapToken field + getBootstrapToken + attachBootstrapToken', () => {
    const filePath = path.resolve(process.cwd(), 'src/host/SessionHost.ts');
    const src = fsSync.readFileSync(filePath, 'utf-8');
    assert.match(src, /bootstrapToken/, 'bootstrapToken field present');
    assert.match(
      src,
      /attachBootstrapToken/,
      'attachBootstrapToken method present',
    );
    assert.match(
      src,
      /getBootstrapToken/,
      'getBootstrapToken method present',
    );
  });

  test('source-grep: SessionHostFactory.ts mints + attaches bootstrap token', () => {
    const filePath = path.resolve(
      process.cwd(),
      'src/host/SessionHostFactory.ts',
    );
    const src = fsSync.readFileSync(filePath, 'utf-8');
    assert.match(
      src,
      /issueBootstrap/,
      'SessionHostFactory.ts must call tokenService.issueBootstrap',
    );
    assert.match(
      src,
      /attachBootstrapToken/,
      'SessionHostFactory.ts must call host.attachBootstrapToken',
    );
  });
});
