// -----------------------------------------------------------------------------
// SessionHostFactory — Phase 7 Plan 07-05b
//
// Bootstraps a cloud-mode SessionHost end-to-end:
//
//   1. Generate a fresh 32-byte JWT verify secret via TokenService.newSecret().
//   2. Issue the host's self-JWT with role:'host' claims.
//   3. Open the WSS connection to the relay (CloudTransport, 07-04). Bearer
//      header carries the host self-JWT.
//   4. Emit ONE session-register envelope on the open connection BEFORE wrapping
//      it in a CloudHostTransport. The relay's first-frame carve-out (07-05b
//      relay/src/server.ts) reads sessionId + verifySecret from the payload and
//      calls SessionRegistry.register(). This is the ONE envelope whose payload
//      the relay reads (named carve-out — see relay/src/server.ts).
//   5. Wrap the connected CloudTransport in a CloudHostTransport (host-side
//      demultiplexer adapter — 07-05b).
//   6. Construct a SessionHost with that HostTransport (07-01 seam) and attach
//      the JWT issuer via attachCloudIssuer(). SessionHost stays
//      transport-agnostic; no `cloudMode` flag, no `setCloudMode` setter, no
//      `handleCloudInboundFrame` stub anywhere in this file or SessionHost.ts.
//
// Threat model anchors:
//   - T-07-05 (invite-code locality): this file NEVER references the invite
//     code (source-grep gated by hostCloudWiring.test.ts). The invite code
//     stays in AuthHandler (extension-internal); the relay only sees the
//     JWT, which carries role + sub + aud but no invite-code material.
//   - T-07-09 (host-by-claim, not by-order): the host's self-JWT carries
//     role:'host' so the relay's verifyClient (07-09) assigns role from the
//     JWT claim, never from connection order. The session-register carve-out
//     on the relay is restricted to host-role sockets — member-role sockets
//     that attempt session-register are closed with 4400.
//   - T-07-secret-leak: the raw verify secret is base64-encoded for wire
//     transit once and never logged. 07-11's redact paths cover `verifySecret`
//     and `secret` keys; this file emits no `console.log`/`logger` calls that
//     would touch the secret.
//   - T-07-RX (transport-decorator seam): SessionHost is constructed with the
//     CloudHostTransport via the 07-01 constructor seam. No setter pattern.
// -----------------------------------------------------------------------------

import { SessionHost } from './SessionHost.js';
import { CloudTransport } from '../network/CloudTransport.js';
import { CloudHostTransport } from '../network/CloudHostTransport.js';
import { TokenService } from '../auth/TokenService.js';
import type { ClientTransport } from '../network/Transport.js';
import type { HostIdentity, SessionConfig } from '../types/session.js';

export interface CreateCloudOpts {
  config: SessionConfig;
  hostIdentity: HostIdentity;
  relayUrl: string;
  sessionId: string;
  /**
   * Test-only seam — injects a fake ClientTransport in place of constructing
   * a real `new CloudTransport(relayUrl, sessionId, jwt)`. The fake must
   * already be ready to accept .connect() + .send() + handler subscription.
   * Production callers omit this field.
   */
  _testClientTransport?: ClientTransport;
}

export async function createCloud(opts: CreateCloudOpts): Promise<SessionHost> {
  // 1. Per-session JWT verify secret. 32 raw bytes; never base64'd in memory.
  const secret = TokenService.newSecret();
  const tokenService = new TokenService(secret);

  // 2. Host self-token. role:'host' so the relay's 07-09 verifyClient
  //    classifies this socket as the host. The relay reads role from JWT,
  //    NEVER from connection order (T-07-09).
  const hostJwt = await tokenService.issue({
    iss: opts.hostIdentity.memberId,
    sub: opts.hostIdentity.memberId,
    aud: opts.sessionId,
    role: 'host',
  });

  // 3. Outbound WSS to relay. Bearer header carries the host self-JWT.
  //    `_testClientTransport` is the test-only injection seam: when supplied,
  //    we skip the real `new CloudTransport(...)` ctor so the test can drive
  //    inbound/outbound via the fake. In production, the fake is undefined
  //    and we instantiate a real CloudTransport.
  const cloudTransport: ClientTransport =
    opts._testClientTransport ??
    new CloudTransport(opts.relayUrl, opts.sessionId, hostJwt);

  const opened = await cloudTransport.connect();
  if (!opened) {
    throw new Error(
      `createCloud: failed to open WSS to relay at ${opts.relayUrl}`,
    );
  }

  // 4. Emit the session-register envelope. This is the FIRST frame on the
  //    wire. The relay's first-frame carve-out reads:
  //      - envelope.payload.type === 'session-register'
  //      - envelope.payload.sessionId === claims.aud (from the host JWT)
  //      - envelope.payload.verifySecret (base64 of 32 bytes)
  //    then calls SessionRegistry.register(sessionId, ws, decodedSecret).
  //
  //    The base64 wire encoding is the only mutation we do on the secret.
  //    The raw 32 bytes stay in-memory inside the TokenService — they never
  //    leave the host process again. The 07-11 redact config strips the
  //    `verifySecret` and `secret` keys from every log line; this function
  //    emits no log calls that touch the secret.
  const sent = cloudTransport.send({
    type: 'session-register',
    sessionId: opts.sessionId,
    verifySecret: Buffer.from(secret).toString('base64'),
    timestamp: Date.now(),
  });
  if (!sent) {
    throw new Error('createCloud: failed to send session-register frame');
  }

  // 5. Wrap the connected CloudTransport in a CloudHostTransport adapter.
  //    SessionHost sees a HostTransport — it does NOT know it's cloud.
  const hostTransport = new CloudHostTransport(cloudTransport, opts.sessionId);

  // 6. Construct SessionHost via the 07-01 transport-via-constructor seam.
  //    Then attach the JWT issuer for per-joiner token issuance in
  //    handleAuthRequest. NOT named setCloudMode — that's a rejected pattern.
  const host = new SessionHost(opts.config, opts.hostIdentity, hostTransport);
  host.attachCloudIssuer(tokenService, opts.sessionId);

  // Expose the host self-JWT via a test-only field for the
  // 'createCloud issues host JWT with claims' assertion. Production code
  // never reads this — the relay validates the JWT during verifyClient.
  // The field is `_testHostJwt` (underscore prefix marks it test-only).
  (host as unknown as { _testHostJwt?: string })._testHostJwt = hostJwt;

  return host;
}
