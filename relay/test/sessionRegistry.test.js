// relay/test/sessionRegistry.test.js
//
// SessionRegistry lifecycle + structural-defense + 07-10 reaper-seam tests.
// Runs against compiled output at ../dist/SessionRegistry.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from '../dist/SessionRegistry.js';

function fakeSocket() {
  return { send: () => {}, readyState: 1, close: () => {} };
}

test('register creates a session and getSession returns it', () => {
  const reg = new SessionRegistry();
  const host = fakeSocket();
  const secret = new Uint8Array(32);
  reg.register('vc-A', host, secret);
  const s = reg.getSession('vc-A');
  assert.ok(s, 'session should exist after register');
  assert.equal(reg.hostOf('vc-A'), host);
  assert.deepEqual(reg.membersOf('vc-A'), []);
  assert.equal(reg.activeSessionCount(), 1);
});

test('getSession returns undefined for unknown sessionId', () => {
  const reg = new SessionRegistry();
  assert.equal(reg.getSession('nope'), undefined);
  assert.equal(reg.hostOf('nope'), undefined);
  assert.deepEqual(reg.membersOf('nope'), []);
});

test('attachMember adds to memberSockets in order', () => {
  const reg = new SessionRegistry();
  const host = fakeSocket();
  const m1 = fakeSocket();
  const m2 = fakeSocket();
  reg.register('vc-B', host, new Uint8Array(32));
  reg.attachMember('vc-B', 'mem-1', m1);
  reg.attachMember('vc-B', 'mem-2', m2);
  assert.deepEqual(reg.membersOf('vc-B'), [m1, m2]);
});

test('attachMember on unknown sessionId is a no-op (does not auto-create)', () => {
  const reg = new SessionRegistry();
  const m1 = fakeSocket();
  reg.attachMember('vc-ghost', 'mem-1', m1);
  assert.equal(reg.getSession('vc-ghost'), undefined);
  assert.equal(reg.activeSessionCount(), 0);
});

test('detach by host socket clears host slot but leaves session record (07-10 grace seam)', () => {
  const reg = new SessionRegistry();
  const host = fakeSocket();
  reg.register('vc-C', host, new Uint8Array(32));
  reg.detach('vc-C', host);
  // Host detach should clear host slot; the session record stays for the grace window.
  // 07-10 owns the 60s timer policy; this plan only verifies the seam exists.
  const s = reg.getSession('vc-C');
  assert.ok(s, 'session must remain during host grace window');
  assert.equal(reg.hostOf('vc-C'), undefined, 'host socket cleared but session not yet evicted');
});

test('detach by member socket removes only that member', () => {
  const reg = new SessionRegistry();
  const host = fakeSocket();
  const m1 = fakeSocket();
  const m2 = fakeSocket();
  reg.register('vc-D', host, new Uint8Array(32));
  reg.attachMember('vc-D', 'mem-1', m1);
  reg.attachMember('vc-D', 'mem-2', m2);
  reg.detach('vc-D', m1);
  assert.deepEqual(reg.membersOf('vc-D'), [m2]);
  assert.equal(reg.hostOf('vc-D'), host);
});

test('register vs attachMember are distinct API paths — no connection-order role assignment (T-07-09)', () => {
  // This test pins the structural defense: role comes from API call, NOT connection order.
  // (Phase 4.1 invariant preserved into cloud mode.)
  const reg = new SessionRegistry();
  const firstSocket = fakeSocket();
  const secondSocket = fakeSocket();
  // Even if `firstSocket` connected first, the relay calls attachMember (not register)
  // because the JWT role claim is 'member'. There is NO code path where connection
  // order alone causes register() to be invoked.
  reg.register('vc-E', secondSocket, new Uint8Array(32)); // host registers via JWT role
  reg.attachMember('vc-E', 'mem-1', firstSocket);
  assert.equal(
    reg.hostOf('vc-E'),
    secondSocket,
    'host is whoever called register(), not whoever connected first'
  );
});

test('activeSessionCount reflects register/closeAll lifecycle', () => {
  const reg = new SessionRegistry();
  reg.register('vc-1', fakeSocket(), new Uint8Array(32));
  reg.register('vc-2', fakeSocket(), new Uint8Array(32));
  assert.equal(reg.activeSessionCount(), 2);
  reg.closeAll('shutdown');
  assert.equal(reg.activeSessionCount(), 0);
});

test('onLastActivity updates timestamp seam (07-10 reaper hook)', () => {
  const reg = new SessionRegistry();
  reg.register('vc-act', fakeSocket(), new Uint8Array(32));
  const s1 = reg.getSession('vc-act');
  const t0 = s1?.lastActivity ?? 0;
  const before = Date.now();
  reg.onLastActivity('vc-act');
  const s2 = reg.getSession('vc-act');
  assert.ok(
    (s2?.lastActivity ?? 0) >= before,
    'lastActivity must advance on onLastActivity()'
  );
  assert.ok(
    (s2?.lastActivity ?? 0) >= t0,
    'lastActivity must not regress'
  );
});
