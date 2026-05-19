// relay/test/serverAuthIntegration.test.js
//
// Phase 7 VERIFICATION BLOCKER 1 hotfix — integration tests for the
// production auth path (requireAuth: true). These tests exercise verifyClient
// + first-frame carve-out + JWT signature verification end-to-end with REAL
// signed JWTs (not the test-mode x-test-* header carve-out).
//
// Covers:
//   1. Host bootstrap happy path: signs host JWT with secret S, opens WSS
//      with Bearer JWT, sends session-register with verifySecret=base64(S).
//      Assertion: registry contains the session; ws stays open.
//   2. Host bootstrap signature mismatch: signs JWT with secret A, sends
//      session-register with verifySecret=base64(B). Assertion: ws closes
//      4401 'host-bootstrap-signature-fail'; registry empty.
//   3. Member auth happy path: pre-registers a session (via the host
//      bootstrap of test 1), then signs a member JWT with the same secret
//      and opens a second WSS. Assertion: member ws stays open.
//   4. No Authorization header: assertion the upgrade is rejected (401).
//   5. Malformed Bearer: assertion the upgrade is rejected (401).
//   6. Bad role shape in JWT: assertion the upgrade is rejected (401).
//
// Runs via `node --test test/serverAuthIntegration.test.js`. Uses the
// `jose` library directly to sign JWTs that match the TokenService format.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { SignJWT } from 'jose';
import { WebSocket } from 'ws';

import { startServer } from '../dist/server.js';

const SESSION_ID = 'vc-itg-test-1';
const HOST_MEMBER_ID = 'host-itg-1';

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

function buildEnvelope(sessionId, payload, target) {
  const env = { v: 1, sessionId, encrypted: false, payload };
  if (target !== undefined) env.target = target;
  return Buffer.from(JSON.stringify(env), 'utf-8');
}

/**
 * Open a WSS client with a real Bearer token. Resolves once the socket
 * either opens OR closes. Returns {ws, closeCode, opened}.
 */
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
    ws.on('error', () => {
      // Errors during upgrade fire alongside 'close' — handled there.
    });
    // Belt-and-suspenders timeout.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('1. host bootstrap happy path: real-signed JWT + matching verifySecret', async () => {
  const server = await startServer({ port: 0, requireAuth: true });
  try {
    const secret = crypto.randomBytes(32);
    const jwt = await signHostJwt(secret);
    const { ws, opened, closeCode } = await openClient(server.port, jwt);
    assert.equal(opened, true, `host bootstrap WSS upgrade rejected (closeCode=${closeCode})`);

    // Send the session-register frame with the matching verifySecret.
    ws.send(buildEnvelope(SESSION_ID, {
      type: 'session-register',
      sessionId: SESSION_ID,
      verifySecret: secret.toString('base64'),
      timestamp: Date.now(),
    }));

    // Allow the async jwtVerify + registry.register to commit.
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(
      server.registry.activeSessionCount(),
      1,
      'session must be registered after valid bootstrap',
    );
    const session = server.registry.getSession(SESSION_ID);
    assert.ok(session, 'session lookup must succeed after bootstrap');
    assert.equal(session.hostMemberId, HOST_MEMBER_ID, 'hostMemberId must be bound from JWT.sub');

    ws.close();
  } finally {
    await server.close();
  }
});

test('2. host bootstrap signature mismatch: forged verifySecret rejected with 4401', async () => {
  const server = await startServer({ port: 0, requireAuth: true });
  try {
    const realSecret = crypto.randomBytes(32);
    const forgedSecret = crypto.randomBytes(32); // attacker-controlled
    const jwt = await signHostJwt(realSecret);
    const { ws, opened, closeCode } = await openClient(server.port, jwt);
    assert.equal(opened, true, `WSS upgrade rejected before first-frame (closeCode=${closeCode})`);

    // Attacker sends a session-register with a DIFFERENT verifySecret than
    // the one the JWT was signed with. The relay must:
    //   1. compute jwtVerify(token, forgedSecret) — fails
    //   2. close 4401 host-bootstrap-signature-fail
    //   3. NOT register the session
    ws.send(buildEnvelope(SESSION_ID, {
      type: 'session-register',
      sessionId: SESSION_ID,
      verifySecret: forgedSecret.toString('base64'),
      timestamp: Date.now(),
    }));

    const { code, reason } = await waitForClose(ws);
    assert.equal(code, 4401, 'expected 4401 close code on signature mismatch');
    assert.match(reason, /host-bootstrap-signature-fail/);
    assert.equal(
      server.registry.activeSessionCount(),
      0,
      'registry must remain empty on signature-fail',
    );
  } finally {
    await server.close();
  }
});

test('3. member auth happy path: pre-registered session + member-JWT signed with same secret', async () => {
  const server = await startServer({ port: 0, requireAuth: true });
  try {
    const secret = crypto.randomBytes(32);
    // Step A: host bootstraps the session.
    const hostJwt = await signHostJwt(secret);
    const hostCli = await openClient(server.port, hostJwt);
    assert.equal(hostCli.opened, true, 'host bootstrap precondition failed');
    hostCli.ws.send(buildEnvelope(SESSION_ID, {
      type: 'session-register',
      sessionId: SESSION_ID,
      verifySecret: secret.toString('base64'),
      timestamp: Date.now(),
    }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.registry.activeSessionCount(), 1, 'host must register session first');

    // Step B: member opens a WSS with a real member-JWT signed with the
    // same per-session secret. This goes through the verifyToken (07-09)
    // path because the session now exists.
    const memberJwt = await signMemberJwt(secret, SESSION_ID, 'member-itg-1');
    const memberCli = await openClient(server.port, memberJwt);
    assert.equal(
      memberCli.opened,
      true,
      `member WSS upgrade rejected (closeCode=${memberCli.closeCode})`,
    );

    hostCli.ws.close();
    memberCli.ws.close();
  } finally {
    await server.close();
  }
});

test('4. no Authorization header → 401', async () => {
  const server = await startServer({ port: 0, requireAuth: true });
  try {
    const { opened, closeCode } = await openClient(server.port, null);
    assert.equal(opened, false);
    // ws library reports HTTP-level upgrade rejections as 1006 (abnormal
    // closure) on the close event rather than the HTTP status. The raw
    // HTTP-401 path is asserted in test/server.test.js. Here we just
    // confirm the upgrade did NOT succeed.
    assert.notEqual(closeCode, null, 'ws must close (not open) without Bearer');
  } finally {
    await server.close();
  }
});

test('5. malformed Bearer (random string, not a JWT) → 401', async () => {
  const server = await startServer({ port: 0, requireAuth: true });
  try {
    const { opened } = await openClient(server.port, 'not-a-jwt-just-random-bytes');
    assert.equal(opened, false, 'malformed JWT must be rejected');
  } finally {
    await server.close();
  }
});

test('6. bad role shape (role:"admin") → 401', async () => {
  const server = await startServer({ port: 0, requireAuth: true });
  try {
    const secret = crypto.randomBytes(32);
    const badRoleJwt = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(HOST_MEMBER_ID)
      .setSubject(HOST_MEMBER_ID)
      .setAudience(SESSION_ID)
      .setIssuedAt()
      .setExpirationTime('1h')
      .setJti(crypto.randomUUID())
      .sign(secret);
    const { opened } = await openClient(server.port, badRoleJwt);
    assert.equal(opened, false, 'role:"admin" must be rejected by verifyClient');
  } finally {
    await server.close();
  }
});
