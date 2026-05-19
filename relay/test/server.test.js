// relay/test/server.test.js
//
// Server-level integration tests for relay/src/server.ts.
//
// Verifies must-have #2 (startServer({port}) factory) and #3 (GET /healthz)
// without depending on 07-09's auth module. The verifyClient stub-rejection
// test pins T-07-16: pre-07-09 deployments cannot accept WSS upgrades when
// RELAY_REQUIRE_AUTH defaults true and auth.js is absent (fail-closed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { startServer } from '../dist/server.js';

test('GET /healthz returns 200 + { ok, sessions, uptime_s }', async () => {
  const server = await startServer({ port: 0, requireAuth: false });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.sessions, 'number');
    assert.equal(typeof body.uptime_s, 'number');
    assert.ok(body.uptime_s >= 0);
  } finally {
    await server.close();
  }
});

test('GET /healthz response has content-type application/json', async () => {
  const server = await startServer({ port: 0, requireAuth: false });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    const ct = res.headers.get('content-type') ?? '';
    assert.ok(ct.includes('application/json'), `expected JSON content-type, got "${ct}"`);
    // Drain body to release the socket
    await res.text();
  } finally {
    await server.close();
  }
});

test('GET /unknown-route returns 404', async () => {
  const server = await startServer({ port: 0, requireAuth: false });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/whatever`);
    assert.equal(res.status, 404);
    await res.text();
  } finally {
    await server.close();
  }
});

test('verifyClient stub rejects WSS upgrade when requireAuth=true and auth.js missing (T-07-16)', async () => {
  const server = await startServer({ port: 0, requireAuth: true });
  try {
    // Issue a raw HTTP upgrade request and assert we get a 503 (auth not wired).
    const result = await new Promise((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1',
        port: server.port,
        path: '/',
        method: 'GET',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      });
      req.on('response', (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      });
      // ws sends 401/503 via the raw socket on the upgrade path — listen for `upgrade`
      // would be the success branch; rejections come back as a regular HTTP response.
      req.on('upgrade', (res) => {
        // Should not happen — auth stub must reject.
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(result.status, 503, 'verifyClient must reject with 503 when auth not wired');
  } finally {
    await server.close();
  }
});

test('startServer allows test-port (port:0) and returns assigned port', async () => {
  const server = await startServer({ port: 0, requireAuth: false });
  try {
    assert.ok(server.port > 0, 'must assign a real ephemeral port when port:0 requested');
    assert.equal(typeof server.close, 'function');
    assert.ok(server.registry, 'startServer result must expose .registry for integration tests');
  } finally {
    await server.close();
  }
});

test('server.ts logger migration complete — no console.* and logger imported (07-11)', async () => {
  // Was: "every console.log carries a TODO(07-11) marker" (07-08 staging gate).
  // Now: 07-11 has swapped console.* for structured pino calls. The assertion
  // FLIPS — there must be ZERO console.* calls and the pino logger MUST be
  // imported. Wider gate ("no console.* anywhere in relay/src/") lives in
  // relay/test/logger.test.js to cover sibling files (auth.ts).
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const serverSrcPath = path.join(thisDir, '..', 'src', 'server.ts');
  const src = await readFile(serverSrcPath, 'utf-8');
  const consoleCalls = src.match(/console\.(log|error|warn|info)\b/g) ?? [];
  assert.equal(
    consoleCalls.length,
    0,
    `07-11 migration incomplete — found ${consoleCalls.length} console.* call(s) in server.ts`,
  );
  assert.match(
    src,
    /from\s+['"]\.\/logger\.js['"]/,
    "server.ts must import logger from './logger.js' post-07-11",
  );
});
