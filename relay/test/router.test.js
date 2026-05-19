// relay/test/router.test.js
//
// Router unit tests + source-grep contracts.
// Tests run on COMPILED output (../dist/router.js + ../dist/SessionRegistry.js)
// after `tsc` produces dist/. Test files themselves are plain ESM JS — not compiled.
//
// Source-grep contracts (Test #4 / #5) read relay/src/*.ts directly from the filesystem
// to enforce structural invariants (T-07-02 byte-pass-through; relay self-containment).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Compiled module imports (test files run from relay/test/, so ../dist/ is relay/dist/).
import { route } from '../dist/router.js';
import { SessionRegistry } from '../dist/SessionRegistry.js';

// Minimal fake WebSocket stub — captures sent buffers for fan-out assertions.
function fakeSocket() {
  const sent = [];
  return {
    sent,
    send: (data) => { sent.push(data); },
    readyState: 1, // ws.OPEN
    close: () => {},
  };
}

test('host frame fans out to all members, not back to host', () => {
  const registry = new SessionRegistry();
  const host = fakeSocket();
  const m1 = fakeSocket();
  const m2 = fakeSocket();
  const sid = 'vc-test-1';

  registry.register(sid, host, new Uint8Array([0]));
  registry.attachMember(sid, 'mem-1', m1);
  registry.attachMember(sid, 'mem-2', m2);

  const raw = Buffer.from(
    '{"v":1,"sessionId":"vc-test-1","encrypted":false,"payload":{"type":"heartbeat-ping","timestamp":0}}'
  );
  route(registry, sid, host, raw);

  assert.equal(m1.sent.length, 1, 'm1 should receive forwarded frame');
  assert.equal(m2.sent.length, 1, 'm2 should receive forwarded frame');
  assert.equal(host.sent.length, 0, 'host should NOT receive its own frame back');
  // Buffer must be forwarded verbatim — same reference or byte-equal
  assert.deepEqual(m1.sent[0], raw, 'forwarded buffer must be byte-identical to inbound');
});

test('member frame fans out to host only, not to other members', () => {
  const registry = new SessionRegistry();
  const host = fakeSocket();
  const m1 = fakeSocket();
  const m2 = fakeSocket();
  const sid = 'vc-test-2';

  registry.register(sid, host, new Uint8Array([0]));
  registry.attachMember(sid, 'mem-1', m1);
  registry.attachMember(sid, 'mem-2', m2);

  const raw = Buffer.from(
    '{"v":1,"sessionId":"vc-test-2","encrypted":false,"payload":{"type":"heartbeat-ping","timestamp":0}}'
  );
  route(registry, sid, m1, raw);

  assert.equal(host.sent.length, 1, 'host should receive the frame');
  assert.equal(m1.sent.length, 0, 'sender should NOT receive its own frame back');
  assert.equal(m2.sent.length, 0, 'sibling member should NOT receive — only host');
  assert.deepEqual(host.sent[0], raw, 'forwarded buffer must be byte-identical to inbound');
});

test('route is a no-op for unknown sessionId', () => {
  const registry = new SessionRegistry();
  const sender = fakeSocket();
  const raw = Buffer.from('{"v":1,"sessionId":"vc-ghost","encrypted":false,"payload":{}}');
  // Must not throw
  route(registry, 'vc-ghost', sender, raw);
  assert.equal(sender.sent.length, 0);
});

test('route is a no-op when fromSocket is neither host nor a known member', () => {
  const registry = new SessionRegistry();
  const host = fakeSocket();
  const m1 = fakeSocket();
  const stranger = fakeSocket();
  const sid = 'vc-test-stranger';

  registry.register(sid, host, new Uint8Array([0]));
  registry.attachMember(sid, 'mem-1', m1);

  const raw = Buffer.from('{"v":1,"sessionId":"vc-test-stranger","encrypted":false,"payload":{}}');
  // stranger socket is not the host and not a registered member
  route(registry, sid, stranger, raw);

  assert.equal(host.sent.length, 0, 'host must not receive frames from strangers');
  assert.equal(m1.sent.length, 0, 'member must not receive frames from strangers');
  assert.equal(stranger.sent.length, 0);
});

test('source-grep contract: router.ts NEVER references .payload (T-07-02)', async () => {
  // Resolve relay/src/router.ts relative to this test file (relay/test/).
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const routerSrcPath = path.join(thisDir, '..', 'src', 'router.ts');
  const src = await readFile(routerSrcPath, 'utf-8');
  // The relay router MUST NOT inspect envelope.payload. Source-grep gate (T-07-02
  // byte-pass-through invariant — CONTEXT D-01).
  assert.doesNotMatch(
    src,
    /\.payload\b/,
    'router.ts must not reference .payload (T-07-02 byte-pass-through invariant)'
  );
});

test('source-grep contract: relay/src/ never imports host-side types or references inviteCode', async () => {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const srcDir = path.join(thisDir, '..', 'src');
  const entries = await readdir(srcDir);
  for (const entry of entries) {
    if (!entry.endsWith('.ts')) continue;
    const text = await readFile(path.join(srcDir, entry), 'utf-8');
    assert.doesNotMatch(
      text,
      /from\s+['"][^'"]*ProtocolMessage[^'"]*['"]/,
      `${entry} must not import ProtocolMessage from host-side code`
    );
    assert.doesNotMatch(
      text,
      /from\s+['"][^'"]*\.\.\/\.\.\/src\/[^'"]+['"]/,
      `${entry} must not import from extension src/ (relay must stay self-contained)`
    );
    assert.doesNotMatch(
      text,
      /\binviteCode\b/,
      `${entry} must not reference inviteCode (lives on host only — preserves future L3 seam)`
    );
  }
});
