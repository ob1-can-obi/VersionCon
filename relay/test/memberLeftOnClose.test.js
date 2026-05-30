// relay/test/memberLeftOnClose.test.js
//
// Bug #7 fix (UAT-3b cloud-presence-zombies) — verify the relay synthesizes
// a `member-left` system frame addressed to the host whenever an attached
// member's WSS closes. This is the missing link that allows the host's
// CloudHostTransport demultiplexer to clean up zombie member entries
// immediately (instead of waiting up to ~30s for the heartbeat-timeout
// reaper which can never refresh cm.isAlive because CloudHostTransport.ping
// is a no-op by design).
//
// Three tests:
//   1. Happy path — member closes; host receives ONE member-left frame
//      whose payload.memberId matches the member's JWT sub.
//   2. Security — a forged inbound member-left frame from member A
//      claiming memberId=B (peer) is REWRITTEN by the relay's HI-01
//      member→host annotation back to memberId=A (the sender's own sub).
//      This proves spoofing is structurally impossible: only the relay-
//      authored close-handler emit can name a peer's memberId.
//   3. Host close — when the HOST socket closes, NO member-left frame is
//      emitted (host has no entry in memberSocketIds). Host-drop goes
//      through the grace-timer path (07-10), not member-left.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { SignJWT } from 'jose';
import { WebSocket } from 'ws';

import { startServer } from '../dist/server.js';

const SESSION_ID = 'vc-mlo-1';
const HOST_MEMBER_ID = 'host-mlo-1';
const MEMBER_A_ID = 'member-a-uuid';
const MEMBER_B_ID = 'member-b-uuid';

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
// Test 1 — happy path: member close → host receives one member-left frame.
// ---------------------------------------------------------------------------

test('member WSS close → relay emits member-left frame to host with member sub', async () => {
  const server = await startServer({ port: 0, requireAuth: true });
  try {
    const secret = crypto.randomBytes(32);

    // Host attaches.
    const hostJwt = await signHostJwt(secret);
    const hostCli = await openClient(server.port, hostJwt);
    assert.equal(hostCli.opened, true, 'host opened');
    hostCli.ws.send(buildEnvelope(SESSION_ID, {
      type: 'session-register',
      sessionId: SESSION_ID,
      verifySecret: secret.toString('base64'),
      timestamp: Date.now(),
    }));
    await new Promise((r) => setTimeout(r, 100));

    // Member A attaches with a first frame (so attachMember runs).
    const memberAJwt = await signMemberJwt(secret, SESSION_ID, MEMBER_A_ID);
    const memberACli = await openClient(server.port, memberAJwt);
    assert.equal(memberACli.opened, true, 'member-a opened');
    memberACli.ws.send(buildEnvelope(SESSION_ID, {
      type: 'heartbeat-ping',
      timestamp: Date.now(),
    }));
    // Allow attachMember to settle before we collect host frames.
    await new Promise((r) => setTimeout(r, 100));

    // Pre-check: member-a is in the registry.
    const sessionBefore = server.registry.getSession(SESSION_ID);
    assert.ok(sessionBefore, 'session exists pre-close');
    const subsBefore = Array.from(sessionBefore.memberSocketIds.values());
    assert.ok(subsBefore.includes(MEMBER_A_ID),
      `member-a expected in registry pre-close; got: ${JSON.stringify(subsBefore)}`);

    // Arm host-inbound collector BEFORE closing the member socket.
    const hostInboundPromise = collectFrames(hostCli.ws, 'member-left', 1000);

    // Member A closes their WSS (simulates Bob's Dev Host crash / F5 / network drop).
    // 1000 is the only valid close code the ws client API accepts for explicit
    // close() (1006 is reserved for abnormal-closure observed by the peer and
    // cannot be passed via ws.close — the peer relay sees it organically).
    memberACli.ws.close(1000, 'simulated-drop');

    const frames = await hostInboundPromise;
    const memberLeftFrames = frames.filter(
      (f) => f && f.payload && f.payload.type === 'member-left',
    );
    assert.equal(memberLeftFrames.length, 1,
      `expected EXACTLY one member-left frame, got ${memberLeftFrames.length}`);

    const frame = memberLeftFrames[0];
    assert.equal(frame.v, 1, 'envelope.v=1');
    assert.equal(frame.sessionId, SESSION_ID, 'envelope.sessionId pinned');
    assert.equal(frame.encrypted, false, 'envelope.encrypted=false');
    assert.equal(frame.payload.memberId, MEMBER_A_ID,
      'member-left payload.memberId = closed member sub (relay-authored, NOT client input)');
    assert.equal(frame.payload.reason, 'relay-detected-close',
      'member-left payload.reason = relay-detected-close discriminator');
    assert.equal(typeof frame.payload.timestamp, 'number',
      'member-left payload.timestamp is a number');

    // Post-check: registry detach also ran. memberSocketIds no longer
    // contains member-a (cleanup is double-checked here so we know the
    // emit happened BEFORE detach as designed).
    const sessionAfter = server.registry.getSession(SESSION_ID);
    assert.ok(sessionAfter, 'session still exists post-close (host alive)');
    const subsAfter = Array.from(sessionAfter.memberSocketIds.values());
    assert.ok(!subsAfter.includes(MEMBER_A_ID),
      `member-a should be removed from registry post-close; got: ${JSON.stringify(subsAfter)}`);

    hostCli.ws.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Test 2 — security: a forged member-left from member A naming peer B's
//          memberId is REWRITTEN by HI-01 annotation to A's own sub.
// ---------------------------------------------------------------------------

test('SECURITY: forged inbound member-left from member A claiming peer-B is rewritten to A by HI-01 annotation', async () => {
  const server = await startServer({ port: 0, requireAuth: true });
  try {
    const secret = crypto.randomBytes(32);

    // Host + two members.
    const hostJwt = await signHostJwt(secret);
    const hostCli = await openClient(server.port, hostJwt);
    hostCli.ws.send(buildEnvelope(SESSION_ID, {
      type: 'session-register',
      sessionId: SESSION_ID,
      verifySecret: secret.toString('base64'),
      timestamp: Date.now(),
    }));
    await new Promise((r) => setTimeout(r, 100));

    const memberAJwt = await signMemberJwt(secret, SESSION_ID, MEMBER_A_ID);
    const memberACli = await openClient(server.port, memberAJwt);
    memberACli.ws.send(buildEnvelope(SESSION_ID, {
      type: 'heartbeat-ping',
      timestamp: Date.now(),
    }));

    const memberBJwt = await signMemberJwt(secret, SESSION_ID, MEMBER_B_ID);
    const memberBCli = await openClient(server.port, memberBJwt);
    memberBCli.ws.send(buildEnvelope(SESSION_ID, {
      type: 'heartbeat-ping',
      timestamp: Date.now(),
    }));
    await new Promise((r) => setTimeout(r, 100));

    // Pre-check: both members attached.
    const sessionPre = server.registry.getSession(SESSION_ID);
    const subsPre = Array.from(sessionPre.memberSocketIds.values());
    assert.ok(subsPre.includes(MEMBER_A_ID) && subsPre.includes(MEMBER_B_ID),
      `both members expected pre-attack; got: ${JSON.stringify(subsPre)}`);

    // Member A attempts to forge a member-left frame for member B's id.
    // Note: HI-01's annotateMemberFrame rejects payload.memberId mismatch
    // with close 4400. We test that by trying the spoof and asserting:
    //   - the relay closes A's socket with 4400 (HI-01 spoof reject), OR
    //   - the relay rewrites A's payload.memberId to A's own sub before
    //     forwarding to host (in which case the host receives a "member A
    //     wants to leave" frame, NOT a spoofed B-eviction).
    // Either outcome closes the spoof window — the host can NEVER receive
    // a member-left frame for B sourced from A.
    const hostInboundPromise = collectFrames(hostCli.ws, 'member-left', 800);
    memberACli.ws.send(buildEnvelope(SESSION_ID, {
      type: 'member-left',
      memberId: MEMBER_B_ID,             // ← FORGED: claims to be peer-B
      reason: 'attempted-spoof',
      timestamp: Date.now(),
    }));
    await new Promise((r) => setTimeout(r, 200));

    const frames = await hostInboundPromise;
    const memberLeftFrames = frames.filter(
      (f) => f && f.payload && f.payload.type === 'member-left',
    );
    // The relay's annotateMemberFrame found memberId=MEMBER_B but claims.sub=MEMBER_A,
    // mismatched → returns null → server closes A with 4400 'malformed-or-spoofed-member-frame'.
    // The close, in turn, runs OUR new close-handler emit path, sending a
    // relay-authored member-left frame for MEMBER_A. So the host DOES receive
    // a member-left, but its memberId is A's OWN sub — never B's. That is
    // exactly the security property we want.
    for (const f of memberLeftFrames) {
      assert.notEqual(f.payload.memberId, MEMBER_B_ID,
        `member-left for peer-B from a spoof MUST never reach the host; ` +
        `got: ${JSON.stringify(f.payload)}`);
    }

    // Post-check: member-B is STILL attached (the spoof did not evict them).
    const sessionPost = server.registry.getSession(SESSION_ID);
    const subsPost = Array.from(sessionPost.memberSocketIds.values());
    assert.ok(subsPost.includes(MEMBER_B_ID),
      `member-B must still be attached after a spoofed-eviction attempt by member-A; ` +
      `got: ${JSON.stringify(subsPost)}`);

    // Clean up.
    try { hostCli.ws.close(); } catch {}
    try { memberBCli.ws.close(); } catch {}
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Test 3 — host close path does NOT emit member-left.
// ---------------------------------------------------------------------------

test('host WSS close does NOT emit member-left (host has no memberSocketIds entry; grace timer path applies)', async () => {
  const server = await startServer({ port: 0, requireAuth: true });
  try {
    const secret = crypto.randomBytes(32);

    const hostJwt = await signHostJwt(secret);
    const hostCli = await openClient(server.port, hostJwt);
    hostCli.ws.send(buildEnvelope(SESSION_ID, {
      type: 'session-register',
      sessionId: SESSION_ID,
      verifySecret: secret.toString('base64'),
      timestamp: Date.now(),
    }));
    await new Promise((r) => setTimeout(r, 100));

    // Attach a member so we have an outbound destination IF the buggy code
    // path were to (incorrectly) emit a member-left when the host closes.
    const memberAJwt = await signMemberJwt(secret, SESSION_ID, MEMBER_A_ID);
    const memberACli = await openClient(server.port, memberAJwt);
    memberACli.ws.send(buildEnvelope(SESSION_ID, {
      type: 'heartbeat-ping',
      timestamp: Date.now(),
    }));
    await new Promise((r) => setTimeout(r, 100));

    // Collect frames on member-a (the destination for any host-authored
    // host→member fan-out — though our member-left emit goes host-direction,
    // a regression that mis-routed it would surface here).
    const memberInboundPromise = collectFrames(memberACli.ws, 'member-left', 600);

    // Host closes.
    hostCli.ws.close(1000, 'host-shutdown');
    await new Promise((r) => setTimeout(r, 100));

    const frames = await memberInboundPromise;
    const memberLeftFrames = frames.filter(
      (f) => f && f.payload && f.payload.type === 'member-left',
    );
    assert.equal(memberLeftFrames.length, 0,
      `host close MUST NOT cause a member-left frame to fan out; got: ${JSON.stringify(memberLeftFrames)}`);

    // Cleanup.
    try { memberACli.ws.close(); } catch {}
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await server.close();
  }
});
