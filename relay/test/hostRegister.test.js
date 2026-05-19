// relay/test/hostRegister.test.js
//
// Phase 7 Plan 07-05b — first-frame carve-out + envelope.target unicast tests.
//
// First-frame carve-out (named exception to T-07-02):
//   - host-role + session-register + sessionId == claims.aud → registry.register()
//   - host-role + non-session-register first frame      → close 4400
//   - host-role + session-register + wrong aud          → close 4400
//   - member-role + session-register                    → close 4400
//
// envelope.target unicast routing (this plan's router.ts extension):
//   - host broadcasts (no target)            → all members receive
//   - host unicasts (target=member-id)       → only that member receives
//
// Source-grep contracts (preserve T-07-02 in router.ts; verify this plan adds
// target read in router.ts).
//
// Tests use the `requireAuth: 'test'` mode (test-only seam in server.ts) that
// reads `x-test-role`, `x-test-aud`, `x-test-sub` headers as synthetic JWT claims.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket } from 'ws';

import { startServer } from '../dist/server.js';

const ZEROS32_B64 = Buffer.alloc(32).toString('base64');

/**
 * Open a WSS client with synthetic claim headers (the requireAuth:'test' seam).
 */
function openClient(server, role, aud, sub) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${server.port}/`;
    const ws = new WebSocket(url, {
      headers: {
        'x-test-role': role,
        'x-test-aud': aud,
        'x-test-sub': sub,
      },
    });
    let opened = false;
    ws.on('open', () => {
      opened = true;
      resolve(ws);
    });
    ws.on('error', (err) => {
      if (!opened) reject(err);
    });
    ws.on('close', (code) => {
      if (!opened) reject(new Error(`closed before open (code=${code})`));
    });
  });
}

function waitForClose(ws) {
  return new Promise((resolve) => {
    ws.on('close', (code) => resolve(code));
  });
}

function waitForMessage(ws, timeoutMs = 200) {
  return new Promise((resolve) => {
    let timer;
    const onMsg = (data) => {
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(data);
    };
    ws.on('message', onMsg);
    timer = setTimeout(() => {
      ws.off('message', onMsg);
      resolve(null);
    }, timeoutMs);
  });
}

function buildEnvelope(sessionId, payload, target) {
  const env = { v: 1, sessionId, encrypted: false, payload };
  if (target !== undefined) env.target = target;
  return Buffer.from(JSON.stringify(env), 'utf-8');
}

// ---------------------------------------------------------------------------
// First-frame carve-out tests
// ---------------------------------------------------------------------------

test('host-role + session-register first frame → registry.register called with decoded secret', async () => {
  const server = await startServer({ port: 0, requireAuth: 'test' });
  try {
    const ws = await openClient(server, 'host', 'vc-test-1', 'host-mid-1');
    ws.send(buildEnvelope('vc-test-1', {
      type: 'session-register',
      sessionId: 'vc-test-1',
      verifySecret: ZEROS32_B64,
    }));
    // Allow registry to commit the host socket.
    await new Promise((r) => setTimeout(r, 50));
    const sess = server.registry.getSession('vc-test-1');
    assert.ok(sess, 'session created in registry');
    assert.equal(sess.hostSocket !== null, true, 'host socket bound');
    assert.equal(sess.verifySecret.length, 32, 'verifySecret decoded to 32 bytes');
    // All bytes are zero (matches ZEROS32_B64)
    for (let i = 0; i < 32; i++) {
      assert.equal(sess.verifySecret[i], 0, `byte ${i} is zero`);
    }
    ws.close();
  } finally {
    await server.close();
  }
});

test('host-role + non-register first frame → close 4400', async () => {
  const server = await startServer({ port: 0, requireAuth: 'test' });
  try {
    const ws = await openClient(server, 'host', 'vc-test-2', 'host-mid-2');
    ws.send(buildEnvelope('vc-test-2', { type: 'heartbeat-ping', timestamp: 0 }));
    const code = await waitForClose(ws);
    assert.equal(code, 4400, 'connection closed with 4400');
  } finally {
    await server.close();
  }
});

test('host-role + session-register with wrong aud → close 4400', async () => {
  const server = await startServer({ port: 0, requireAuth: 'test' });
  try {
    const ws = await openClient(server, 'host', 'vc-test-aud-mismatch', 'host-mid-3');
    ws.send(buildEnvelope('vc-some-other-id', {
      type: 'session-register',
      sessionId: 'vc-some-other-id',
      verifySecret: ZEROS32_B64,
    }));
    const code = await waitForClose(ws);
    assert.equal(code, 4400, 'aud mismatch closes 4400');
  } finally {
    await server.close();
  }
});

test('member-role + session-register → close 4400', async () => {
  const server = await startServer({ port: 0, requireAuth: 'test' });
  try {
    const ws = await openClient(server, 'member', 'vc-test-3', 'member-mid-1');
    ws.send(buildEnvelope('vc-test-3', {
      type: 'session-register',
      sessionId: 'vc-test-3',
      verifySecret: ZEROS32_B64,
    }));
    const code = await waitForClose(ws);
    assert.equal(code, 4400, 'member cannot session-register');
  } finally {
    await server.close();
  }
});

test('host registers, then host broadcasts (no target) → all members receive', async () => {
  const server = await startServer({ port: 0, requireAuth: 'test' });
  try {
    // Register host first.
    const host = await openClient(server, 'host', 'vc-bcast', 'host-mid');
    host.send(buildEnvelope('vc-bcast', {
      type: 'session-register',
      sessionId: 'vc-bcast',
      verifySecret: ZEROS32_B64,
    }));
    await new Promise((r) => setTimeout(r, 50));

    // Attach two members.
    const m1 = await openClient(server, 'member', 'vc-bcast', 'mem-1');
    const m2 = await openClient(server, 'member', 'vc-bcast', 'mem-2');
    // First member frame attaches them in registry.
    m1.send(buildEnvelope('vc-bcast', { type: 'heartbeat-ping', timestamp: 0 }));
    m2.send(buildEnvelope('vc-bcast', { type: 'heartbeat-ping', timestamp: 0 }));
    await new Promise((r) => setTimeout(r, 50));

    // Drain any host inbound (from member first frames).
    void waitForMessage(host, 50);

    // Host broadcasts (no target).
    const expected = buildEnvelope('vc-bcast', { type: 'heartbeat-ping', timestamp: 1 });
    const m1Wait = waitForMessage(m1, 500);
    const m2Wait = waitForMessage(m2, 500);
    host.send(expected);
    const [m1Got, m2Got] = await Promise.all([m1Wait, m2Wait]);
    assert.ok(m1Got, 'm1 received broadcast');
    assert.ok(m2Got, 'm2 received broadcast');
    host.close();
    m1.close();
    m2.close();
  } finally {
    await server.close();
  }
});

test('host sends envelope with target=mem-1 → only mem-1 receives, mem-2 does not', async () => {
  const server = await startServer({ port: 0, requireAuth: 'test' });
  try {
    const host = await openClient(server, 'host', 'vc-unicast', 'host-mid');
    host.send(buildEnvelope('vc-unicast', {
      type: 'session-register',
      sessionId: 'vc-unicast',
      verifySecret: ZEROS32_B64,
    }));
    await new Promise((r) => setTimeout(r, 50));

    const m1 = await openClient(server, 'member', 'vc-unicast', 'mem-1');
    const m2 = await openClient(server, 'member', 'vc-unicast', 'mem-2');
    m1.send(buildEnvelope('vc-unicast', { type: 'heartbeat-ping', timestamp: 0 }));
    m2.send(buildEnvelope('vc-unicast', { type: 'heartbeat-ping', timestamp: 0 }));
    await new Promise((r) => setTimeout(r, 50));

    const m1Wait = waitForMessage(m1, 500);
    const m2Wait = waitForMessage(m2, 200);
    // Host unicasts to mem-1.
    host.send(buildEnvelope(
      'vc-unicast',
      { type: 'heartbeat-pong', timestamp: 5 },
      'mem-1',
    ));
    const [m1Got, m2Got] = await Promise.all([m1Wait, m2Wait]);
    assert.ok(m1Got, 'mem-1 received the unicast');
    assert.equal(m2Got, null, 'mem-2 did NOT receive the unicast');
    host.close();
    m1.close();
    m2.close();
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Source-grep contracts on relay/src/router.ts (T-07-02 + this plan's target read)
// ---------------------------------------------------------------------------

test('router.ts STILL does NOT read envelope.payload (T-07-02 invariant preserved)', async () => {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const routerSrcPath = path.join(thisDir, '..', 'src', 'router.ts');
  const src = await readFile(routerSrcPath, 'utf-8');
  // Strip comments and string literals before matching so doc/comment mentions don't count.
  const stripped = src
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/`[^`]*`/g, '""')
    .replace(/'[^']*'/g, '""')
    .replace(/"[^"]*"/g, '""');
  assert.doesNotMatch(
    stripped,
    /\.payload\b/,
    'router.ts must not read envelope.payload (T-07-02 byte-pass-through)',
  );
});

test('router.ts DOES read envelope.target for unicast (this plan extension)', async () => {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const routerSrcPath = path.join(thisDir, '..', 'src', 'router.ts');
  const src = await readFile(routerSrcPath, 'utf-8');
  assert.match(
    src,
    /(envelope\.target|parsed\.target|\.target\b)/,
    'router.ts must read envelope.target for unicast routing',
  );
});
