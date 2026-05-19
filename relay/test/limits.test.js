// relay/test/limits.test.js
//
// Plan 07-10 — relay defensive-minimum tests. Covers limits.ts pure-policy
// surface (sliding-window rate limit, session/member caps, frame-byte cap,
// idle-reap and host-drop grace constants) plus the grace-timer lifecycle
// that SessionRegistry orchestrates with limits.getHostDropGraceMs().
//
// IMPORT PATH MAY NEED ADJUSTMENT TO MATCH 07-08's tsconfig outDir — currently
// assumes `../dist/limits.js` (flat dist tree per 07-08 SUMMARY decision:
// rootDir=./src ⇒ relay/src/limits.ts compiles to relay/dist/limits.js).
//
// All time-dependent tests use Node's `node:test` MockTimers API
// (`mock.timers.enable({ apis: [...] })` + `mock.timers.tick(ms)`).
// Each test wraps state-mutating calls in try/finally with mock.timers.reset()
// AND calls limits.__resetForTesting() to clear the per-IP timestamp map.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkConnection,
  canRegisterSession,
  canAttachMember,
  getMaxPayloadBytes,
  getIdleReapInterval,
  getHostDropGraceMs,
  __resetForTesting,
} from '../dist/limits.js';

// ---------- Rate limit tests (1-3) ----------

test('rate limit: 30 connections in window pass; 31st rejected', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  __resetForTesting();
  try {
    for (let i = 0; i < 30; i++) {
      assert.equal(checkConnection('1.2.3.4'), true, `connection ${i + 1} should be allowed`);
    }
    assert.equal(checkConnection('1.2.3.4'), false, '31st connection must be rejected');
  } finally {
    __resetForTesting();
    mock.timers.reset();
  }
});

test('rate limit: window slides — 30 connections at t=0, advance 61s, 31st succeeds', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  __resetForTesting();
  try {
    for (let i = 0; i < 30; i++) {
      assert.equal(checkConnection('5.6.7.8'), true, `connection ${i + 1} should be allowed at t=0`);
    }
    // Advance 60s + 1ms past the sliding window.
    mock.timers.tick(60_001);
    assert.equal(
      checkConnection('5.6.7.8'),
      true,
      '31st connection after window slides should succeed'
    );
  } finally {
    __resetForTesting();
    mock.timers.reset();
  }
});

test('rate limit: per-IP isolation — flood from one IP does not affect another', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  __resetForTesting();
  try {
    // Flood IP A — first 30 allowed, 31st rejected.
    for (let i = 0; i < 30; i++) {
      assert.equal(checkConnection('9.9.9.9'), true);
    }
    assert.equal(checkConnection('9.9.9.9'), false, 'IP A 31st must be rejected');
    // IP B should still be allowed — independent timestamp array.
    assert.equal(checkConnection('10.10.10.10'), true, 'IP B must be unaffected by IP A flood');
  } finally {
    __resetForTesting();
    mock.timers.reset();
  }
});

// ---------- Session cap test (4) ----------

test('session cap: canRegisterSession returns true for counts 0..999, false at 1000', () => {
  for (let count = 0; count < 1000; count += 100) {
    assert.equal(canRegisterSession(count), true, `count ${count} should permit register`);
  }
  // Boundary check — exactly 999 still ok, 1000 rejects.
  assert.equal(canRegisterSession(999), true, 'count 999 (last allowed) should permit register');
  assert.equal(canRegisterSession(1000), false, 'count 1000 (cap reached) must reject register');
  assert.equal(canRegisterSession(1001), false, 'count 1001 (over cap) must reject register');
});

// ---------- Member cap test (5) ----------

test('member cap: canAttachMember returns true for counts 0..49, false at 50', () => {
  for (let count = 0; count < 50; count++) {
    assert.equal(canAttachMember(count), true, `count ${count} should permit attach`);
  }
  assert.equal(canAttachMember(50), false, 'count 50 (cap reached) must reject attach');
  assert.equal(canAttachMember(51), false, 'count 51 (over cap) must reject attach');
});

// ---------- Constant accessors (6, 7, 8) ----------

test('maxPayload: getMaxPayloadBytes returns 1048576', () => {
  assert.equal(getMaxPayloadBytes(), 1024 * 1024);
  assert.equal(getMaxPayloadBytes(), 1048576);
});

test('idle reaper interval: getIdleReapInterval returns 30 minutes in ms', () => {
  assert.equal(getIdleReapInterval(), 30 * 60 * 1000);
  assert.equal(getIdleReapInterval(), 1_800_000);
});

test('host-drop grace: getHostDropGraceMs returns 60 seconds in ms', () => {
  assert.equal(getHostDropGraceMs(), 60 * 1000);
  assert.equal(getHostDropGraceMs(), 60_000);
});

// ---------- Grace + reaper lifecycle (9, 10, 11, 12) ----------
//
// These tests exercise the wiring contract that Task 3 will satisfy in
// SessionRegistry.ts. The fake registry stub here pins the LIFECYCLE shape
// (scheduleGracePeriod + cancelGracePeriod) — Task 3 ports the same shape
// into the real SessionRegistry. The reaper tests pin the server.ts
// setInterval reaper-pass loop using only a fake `allSessions()` iterator.

/**
 * Minimal SessionRegistry test double — supports just enough surface to
 * exercise grace timer scheduling/cancelling and the reaper-pass iterator
 * shape. The real registry (07-08-shipped + Task 3-wired) shares the same
 * lifecycle contract.
 */
function makeFakeRegistry() {
  const sessions = new Map();
  const closeCalls = [];
  return {
    register(sessionId) {
      sessions.set(sessionId, {
        sessionId,
        lastActivity: Date.now(),
        graceTimer: null,
      });
    },
    allSessions() {
      return Array.from(sessions.values());
    },
    closeSession(sessionId, reason) {
      closeCalls.push({ sessionId, reason });
      const s = sessions.get(sessionId);
      if (s && s.graceTimer) {
        clearTimeout(s.graceTimer);
        s.graceTimer = null;
      }
      sessions.delete(sessionId);
    },
    scheduleGracePeriod(sessionId, ms, onExpire) {
      const s = sessions.get(sessionId);
      if (!s) return;
      if (s.graceTimer) clearTimeout(s.graceTimer);
      s.graceTimer = setTimeout(onExpire, ms);
    },
    cancelGracePeriod(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return;
      if (s.graceTimer) {
        clearTimeout(s.graceTimer);
        s.graceTimer = null;
      }
    },
    touch(sessionId) {
      const s = sessions.get(sessionId);
      if (s) s.lastActivity = Date.now();
    },
    closeCalls,
  };
}

test('idle reaper: session with no activity for 30 min is closed', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const reg = makeFakeRegistry();
    reg.register('vc-stale');

    // Reaper pass — mirrors the loop server.ts will run.
    const reaperPass = () => {
      const now = Date.now();
      const cutoff = getIdleReapInterval();
      for (const s of reg.allSessions()) {
        if (now - s.lastActivity > cutoff) {
          reg.closeSession(s.sessionId, 'idle');
        }
      }
    };
    const interval = setInterval(reaperPass, 60_000);

    // Advance 30 min + 1ms — strictly past the cutoff.
    mock.timers.tick(30 * 60 * 1000 + 1);

    assert.equal(reg.closeCalls.length, 1, 'reaper must have closed exactly one session');
    assert.deepEqual(reg.closeCalls[0], { sessionId: 'vc-stale', reason: 'idle' });

    clearInterval(interval);
  } finally {
    mock.timers.reset();
  }
});

test('idle reaper: session with fresh activity at 29 min is NOT closed', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const reg = makeFakeRegistry();
    reg.register('vc-active');

    const reaperPass = () => {
      const now = Date.now();
      const cutoff = getIdleReapInterval();
      for (const s of reg.allSessions()) {
        if (now - s.lastActivity > cutoff) {
          reg.closeSession(s.sessionId, 'idle');
        }
      }
    };
    const interval = setInterval(reaperPass, 60_000);

    // Advance 29 min; touch the session — lastActivity now = 29 min.
    mock.timers.tick(29 * 60 * 1000);
    reg.touch('vc-active');

    // Advance another 2 min — total 31 min wall-clock, but only 2 min since touch.
    mock.timers.tick(2 * 60 * 1000);

    assert.equal(reg.closeCalls.length, 0, 'reaper must NOT close session with fresh activity');

    clearInterval(interval);
  } finally {
    mock.timers.reset();
  }
});

test('host-drop grace: session alive at 59s, closed at 61s', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const reg = makeFakeRegistry();
    reg.register('vc-grace');
    const onExpire = mock.fn();

    reg.scheduleGracePeriod('vc-grace', getHostDropGraceMs(), onExpire);

    mock.timers.tick(59_000);
    assert.equal(onExpire.mock.callCount(), 0, 'grace must not fire at 59s');

    mock.timers.tick(2_000); // total 61s
    assert.equal(onExpire.mock.callCount(), 1, 'grace must fire once at 61s');
  } finally {
    mock.timers.reset();
  }
});

test('host-drop grace: re-attach at 30s clears the timer; no close at 70s', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const reg = makeFakeRegistry();
    reg.register('vc-reattach');
    const onExpire = mock.fn();

    reg.scheduleGracePeriod('vc-reattach', getHostDropGraceMs(), onExpire);
    mock.timers.tick(30_000);
    reg.cancelGracePeriod('vc-reattach');

    mock.timers.tick(40_000); // total 70s
    assert.equal(onExpire.mock.callCount(), 0, 'cancelled grace timer must never fire');
  } finally {
    mock.timers.reset();
  }
});
