// relay/test/bootstrapJoinerE2E.test.js
//
// Phase 7 plan 07-14 — E2E integration test for the FULL bootstrap→real-JWT
// joiner round-trip. Closes SC-2 at the code level (MD-03 Option A).
//
// Test exercises the production code path against `requireAuth: true` (NOT
// `requireAuth: 'test'` — that mode is the HI-06 escape hatch gated to
// NODE_ENV !== production). This proves the bootstrap JWT shape is byte-
// identical-acceptable to the relay's existing verifyToken path (which the
// 07-13 plan claimed by inheritance from serverAuthIntegration.test.js
// test 3 — this file confirms the full round-trip in the same harness).
//
// Flow:
//   1. Host opens WSS with HOST JWT, sends session-register with verifySecret
//   2. Joiner opens WSS with BOOTSTRAP JWT (sub='bootstrap-'+sessionId,
//      role='member', exp='15m', signed with same secret)
//   3. Joiner sends auth-request frame; relay byte-pass-routes to host
//      (T-07-02 preserved)
//   4. Host sends auth-response carrying real per-joiner JWT
//   5. Joiner closes bootstrap socket with code 1000 'bootstrap-swap'
//   6. Joiner reconnects with the REAL per-joiner JWT
//   7. Registry post-swap shows the joiner attached with its REAL uuid;
//      bootstrap-<sessionId> sub is gone from the registry
//
// Source-grep regression gates also run inline in the test body:
//   - T-07-02: relay/src/router.ts has 0 .payload references
//   - T-07-05: relay/src/auth.ts + relay/src/server.ts have 0 inviteCode refs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { SignJWT } from 'jose';
import { WebSocket } from 'ws';

import { startServer } from '../dist/server.js';

const SESSION_ID = 'vc-e2e-bootstrap-1';
const HOST_MEMBER_ID = 'host-e2e-1';

// ---------------------------------------------------------------------------
// JWT signing helpers — mirror serverAuthIntegration.test.js verbatim, plus
// the new signBootstrapJwt helper that mints a sub='bootstrap-' + sessionId
// JWT with exp='15m' (matching TokenService.issueBootstrap from 07-13).
// ---------------------------------------------------------------------------

async function signHostJwt(secret, sessionId = SESSION_ID, hostMemberId = HOST_MEMBER_ID) {
  return new SignJWT({ role: 'host' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(hostMemberId)
    .setSubject(hostMemberId)
    .setAudience(sessionId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .setJti(crypto.randomUUID())
    .sign(secret);
}

async function signMemberJwt(secret, sessionId, memberId, hostMemberId = HOST_MEMBER_ID) {
  return new SignJWT({ role: 'member' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(hostMemberId)
    .setSubject(memberId)
    .setAudience(sessionId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .setJti(crypto.randomUUID())
    .sign(secret);
}

/**
 * Sign a BOOTSTRAP JWT — mirrors signMemberJwt but with:
 *   - sub = 'bootstrap-' + sessionId (fixed marker, shared across joiners
 *     by construction — MD-03 Option A locked decision)
 *   - role = 'member' (NEVER 'host' — T-07-15 elevation defense)
 *   - exp = '15m' (matches TokenService.issueBootstrap from 07-13)
 */
async function signBootstrapJwt(secret, sessionId = SESSION_ID, hostMemberId = HOST_MEMBER_ID) {
  return new SignJWT({ role: 'member' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(hostMemberId)
    .setSubject('bootstrap-' + sessionId)
    .setAudience(sessionId)
    .setIssuedAt()
    .setExpirationTime('15m')
    .setJti(crypto.randomUUID())
    .sign(secret);
}

function buildEnvelope(sessionId, payload, target) {
  const env = { v: 1, sessionId, encrypted: false, payload };
  if (target !== undefined) env.target = target;
  return Buffer.from(JSON.stringify(env), 'utf-8');
}

function openClient(port, jwt) {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${port}/`;
    const headers = jwt === null ? {} : { Authorization: `Bearer ${jwt}` };
    const ws = new WebSocket(url, { headers });
    let settled = false;
    ws.on('open', () => {
      if (settled) return;
      settled = true;
      resolve({ ws, opened: true, closeCode: null });
    });
    ws.on('close', (code) => {
      if (settled) return;
      settled = true;
      resolve({ ws, opened: false, closeCode: code });
    });
    ws.on('error', () => { /* close handles it */ });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch { /* noop */ }
        resolve({ ws, opened: false, closeCode: -1 });
      }
    }, 1500);
  });
}

function waitForClose(ws, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let settled = false;
    ws.on('close', (code, reason) => {
      if (settled) return;
      settled = true;
      resolve({ code, reason: reason.toString() });
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ code: -1, reason: 'timeout' });
      }
    }, timeoutMs);
  });
}

/**
 * Collect inbound frames on a ws until either an envelope with
 * `payload.type === untilType` is observed OR the timeout fires.
 */
function collectFrames(ws, untilType, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const frames = [];
    const onMessage = (data) => {
      try {
        const env = JSON.parse(data.toString());
        frames.push(env);
        if (env.payload && env.payload.type === untilType) {
          resolve(frames);
        }
      } catch { /* ignore */ }
    };
    ws.on('message', onMessage);
    setTimeout(() => resolve(frames), timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Test 1 — E2E full round-trip: bootstrap JWT → auth-response → real-JWT
//          reconnect → registry assertions
// ---------------------------------------------------------------------------

test('E2E: bootstrap JWT → auth-response → real-JWT reconnect; registry shows real per-joiner sub, NOT bootstrap sub', async () => {
  const server = await startServer({ port: 0, requireAuth: true });
  try {
    const secret = crypto.randomBytes(32);
    const REAL_JOINER_ID = 'joiner-real-uuid-1';

    // -----------------------------------------------------------------------
    // 1. HOST: open WSS with host JWT + send session-register.
    // -----------------------------------------------------------------------
    const hostJwt = await signHostJwt(secret, SESSION_ID, HOST_MEMBER_ID);
    const hostCli = await openClient(server.port, hostJwt);
    assert.equal(hostCli.opened, true,
      `host bootstrap WSS upgrade rejected (closeCode=${hostCli.closeCode})`);
    hostCli.ws.send(buildEnvelope(SESSION_ID, {
      type: 'session-register',
      sessionId: SESSION_ID,
      verifySecret: secret.toString('base64'),
      timestamp: Date.now(),
    }));
    // Allow async jwtVerify + registry.register to commit.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(server.registry.activeSessionCount(), 1,
      'session must be registered after host bootstrap');
    const sessionPre = server.registry.getSession(SESSION_ID);
    assert.ok(sessionPre, 'session lookup must succeed');
    assert.equal(sessionPre.hostMemberId, HOST_MEMBER_ID, 'hostMemberId bound from host JWT.sub');

    // -----------------------------------------------------------------------
    // 2. JOINER: open BOOTSTRAP socket with the bootstrap JWT.
    //    PRIMARY ASSERTION — proves 07-13's claim that the relay accepts
    //    the bootstrap JWT shape verbatim via the existing verifyToken
    //    path (no relay code changes).
    // -----------------------------------------------------------------------
    const bootstrapJwt = await signBootstrapJwt(secret, SESSION_ID, HOST_MEMBER_ID);
    const joinerBootstrapCli = await openClient(server.port, bootstrapJwt);
    assert.equal(joinerBootstrapCli.opened, true,
      `bootstrap JWT WSS upgrade rejected (closeCode=${joinerBootstrapCli.closeCode}) — ` +
      'this is the PRIMARY assertion 07-13 claimed by inheritance: relay accepts bootstrap JWT verbatim via existing verifyToken path');

    // -----------------------------------------------------------------------
    // 3. JOINER: send auth-request frame; collect inbound on HOST socket.
    //    T-07-02 (router byte-pass-through) — the auth-request payload is
    //    routed through unparsed.
    // -----------------------------------------------------------------------
    const hostInboundPromise = collectFrames(hostCli.ws, 'auth-request', 1500);
    joinerBootstrapCli.ws.send(buildEnvelope(SESSION_ID, {
      type: 'auth-request',
      inviteCode: 'test-invite',
      displayName: 'Bob',
      timestamp: Date.now(),
    }));
    const hostInbound = await hostInboundPromise;
    const authRequest = hostInbound.find(f => f.payload && f.payload.type === 'auth-request');
    assert.ok(authRequest, 'host MUST receive auth-request via byte-pass-through routing (T-07-02)');
    assert.equal(authRequest.payload.displayName, 'Bob', 'displayName preserved through relay');
    assert.equal(authRequest.payload.inviteCode, 'test-invite',
      'inviteCode payload preserved through relay (the relay never reads payload.inviteCode — T-07-05)');

    // -----------------------------------------------------------------------
    // 4. HOST: send auth-response carrying the real per-joiner JWT.
    //    Target the bootstrap sub (= 'bootstrap-' + SESSION_ID) for unicast
    //    routing on the joiner's bootstrap socket.
    // -----------------------------------------------------------------------
    const realJoinerJwt = await signMemberJwt(secret, SESSION_ID, REAL_JOINER_ID, HOST_MEMBER_ID);
    const joinerInboundPromise = collectFrames(joinerBootstrapCli.ws, 'auth-response', 1500);
    hostCli.ws.send(buildEnvelope(SESSION_ID, {
      type: 'auth-response',
      accepted: true,
      memberId: REAL_JOINER_ID,
      sessionInfo: { name: 'e2e-test', memberCount: 2, hostDisplayName: 'host' },
      token: realJoinerJwt,
      timestamp: Date.now(),
    }, 'bootstrap-' + SESSION_ID));

    const joinerInbound = await joinerInboundPromise;
    const authResponse = joinerInbound.find(f => f.payload && f.payload.type === 'auth-response');
    assert.ok(authResponse, 'joiner MUST receive the routed auth-response');
    assert.equal(authResponse.payload.accepted, true, 'auth-response accepted=true');
    assert.equal(authResponse.payload.token, realJoinerJwt,
      'auth-response carries the real per-joiner JWT (this is what CloudTransport.swapToken consumes)');
    assert.equal(authResponse.payload.memberId, REAL_JOINER_ID,
      'auth-response carries the real per-joiner memberId');

    // -----------------------------------------------------------------------
    // 5. JOINER: close the bootstrap socket with code 1000 'bootstrap-swap'.
    //    Emulates CloudTransport.swapToken's intentional close step.
    // -----------------------------------------------------------------------
    joinerBootstrapCli.ws.close(1000, 'bootstrap-swap');
    await waitForClose(joinerBootstrapCli.ws, 1000);

    // -----------------------------------------------------------------------
    // 6. JOINER: re-open WSS with the REAL per-joiner JWT.
    //    Emulates CloudTransport.swapToken's reconnect step.
    // -----------------------------------------------------------------------
    const joinerRealCli = await openClient(server.port, realJoinerJwt);
    assert.equal(joinerRealCli.opened, true,
      `real-JWT WSS upgrade rejected (closeCode=${joinerRealCli.closeCode}) — ` +
      'host-issued per-joiner JWT must verify against the same session.verifySecret');

    // Send a first frame (heartbeat-ping is the minimum viable shape) so the
    // relay's handleFirstFrame member branch runs `registry.attachMember`.
    // Without a first frame, the joiner-real socket sits idle and is not in
    // the registry's memberSocketIds map — which is exactly what the
    // post-swap assertion below verifies.
    joinerRealCli.ws.send(buildEnvelope(SESSION_ID, {
      type: 'heartbeat-ping',
      timestamp: Date.now(),
    }));
    // Allow attachMember to settle.
    await new Promise((r) => setTimeout(r, 150));

    // -----------------------------------------------------------------------
    // 7. REGISTRY ASSERTIONS — the canonical proof that the swap worked.
    // -----------------------------------------------------------------------
    assert.equal(server.registry.activeSessionCount(), 1,
      'still exactly one session after joiner reconnect (no leaks)');
    const sessionPost = server.registry.getSession(SESSION_ID);
    assert.ok(sessionPost, 'session must persist across the joiner reconnect');
    assert.equal(sessionPost.hostMemberId, HOST_MEMBER_ID,
      'host memberId persists across joiner reconnect');

    // The registry's memberSocketIds Map should now contain the REAL joiner
    // uuid. The send-an-auth-request-frame on the bootstrap socket DID NOT
    // attach the joiner as a member (attachMember runs at WSS handshake
    // first-frame for verified member JWTs). After the swap reconnect with
    // the real JWT, the joiner IS in the member set with their canonical sub.
    const memberSubs = Array.from(sessionPost.memberSocketIds.values());
    assert.ok(memberSubs.includes(REAL_JOINER_ID),
      `expected real joiner uuid in registry; got: ${JSON.stringify(memberSubs)}`);

    // The bootstrap socket has been closed (step 5); the bootstrap sub MUST
    // NOT remain in the registry after the swap. The bootstrap-WSS-close
    // path runs registry.detachMember which removes the entry. This is the
    // MD-03 closure assertion: post-swap, NO joiner appears as the shared
    // bootstrap-<sessionId> sub.
    assert.ok(!memberSubs.includes('bootstrap-' + SESSION_ID),
      `bootstrap sub MUST NOT remain in registry post-swap; got: ${JSON.stringify(memberSubs)}`);

    // -----------------------------------------------------------------------
    // 8. INLINE SOURCE-GREP REGRESSION GATES (T-07-02, T-07-05)
    // -----------------------------------------------------------------------

    // T-07-02 router byte-pass-through: relay/src/router.ts has 0 .payload refs.
    const routerSrc = fs.readFileSync('src/router.ts', 'utf-8');
    const payloadMatches = (routerSrc.match(/\.payload/g) || []).length;
    assert.equal(payloadMatches, 0,
      'T-07-02 invariant: relay/src/router.ts must have 0 .payload references');

    // T-07-05 invite-code locality: relay/src/auth.ts + server.ts have 0 inviteCode refs.
    const authSrc = fs.readFileSync('src/auth.ts', 'utf-8');
    const serverSrc = fs.readFileSync('src/server.ts', 'utf-8');
    assert.equal(authSrc.indexOf('inviteCode'), -1,
      'T-07-05 invariant: relay/src/auth.ts must NOT reference inviteCode');
    assert.equal(serverSrc.indexOf('inviteCode'), -1,
      'T-07-05 invariant: relay/src/server.ts must NOT reference inviteCode');

    // T-07-11 HS256 algorithm pin still present.
    assert.match(authSrc, /algorithms: \['HS256'\]/,
      'T-07-11 invariant: relay/src/auth.ts must pin algorithms: [\'HS256\']');

    joinerRealCli.ws.close();
    hostCli.ws.close();
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Test 2 — bootstrap JWT WSS upgrade succeeds at verifyClient
//          (scope-narrow precondition assertion; orthogonal to test 1 which
//          asserts the full round-trip)
// ---------------------------------------------------------------------------

test('E2E precondition: bootstrap JWT alone is accepted by verifyClient (no relay-side changes needed)', async () => {
  const server = await startServer({ port: 0, requireAuth: true });
  try {
    const secret = crypto.randomBytes(32);

    // Register the session via a host bootstrap (precondition).
    const hostJwt = await signHostJwt(secret);
    const hostCli = await openClient(server.port, hostJwt);
    assert.equal(hostCli.opened, true, 'host precondition: bootstrap WSS accepted');
    hostCli.ws.send(buildEnvelope(SESSION_ID, {
      type: 'session-register',
      sessionId: SESSION_ID,
      verifySecret: secret.toString('base64'),
      timestamp: Date.now(),
    }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.registry.activeSessionCount(), 1, 'session registered');

    // Open a joiner socket with ONLY the bootstrap JWT. The relay should
    // accept the WSS upgrade — proving 07-14 needs ZERO relay code changes.
    const bootstrapJwt = await signBootstrapJwt(secret);
    const joinerCli = await openClient(server.port, bootstrapJwt);
    assert.equal(joinerCli.opened, true,
      `bootstrap JWT WSS upgrade rejected (closeCode=${joinerCli.closeCode}) — ` +
      'this proves the inheritance claim from 07-13 (relay accepts bootstrap JWT via existing verifyToken)');

    joinerCli.ws.close();
    hostCli.ws.close();
  } finally {
    await server.close();
  }
});
