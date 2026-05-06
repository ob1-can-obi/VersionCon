import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { PushHistory } from '../../filesystem/PushHistory.js';
import { SessionHost } from '../../host/SessionHost.js';
import type { PushRecord } from '../../types/push.js';

/**
 * Unit tests for SessionHost.buildLatestPushId, the pure-logic helper that
 * derives the latestPushId field of a SyncResponse from a PushHistory
 * reference. The full sync-request handler is integration-tested elsewhere;
 * here we cover the empty/null/populated transitions in isolation.
 */
suite('SessionHostSync', () => {
  let tmpDir: string;
  let versionconDir: string;
  let history: PushHistory;

  setup(async () => {
    tmpDir = path.join(os.tmpdir(), `versioncon-sessionhostsync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    versionconDir = path.join(tmpDir, '.versioncon');
    await fs.mkdir(versionconDir, { recursive: true });
    history = new PushHistory(versionconDir);
    await history.load();
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('buildLatestPushId returns null when history is empty', () => {
    assert.strictEqual(SessionHost.buildLatestPushId(history), null);
  });

  test('buildLatestPushId returns null when pushHistory reference is null', () => {
    assert.strictEqual(SessionHost.buildLatestPushId(null), null);
  });

  test('buildLatestPushId returns the most recent record id', async () => {
    const rec: PushRecord = {
      id: 'push-test-123',
      memberId: 'm1',
      memberDisplayName: 'Alice',
      message: 'first',
      branch: 'main',
      files: [],
      timestamp: Date.now(),
      reverted: false,
    };
    await history.addRecord(rec);
    assert.strictEqual(SessionHost.buildLatestPushId(history), 'push-test-123');
  });

  test('buildLatestPushId returns the latest of multiple records', async () => {
    const first: PushRecord = {
      id: 'push-001',
      memberId: 'm1',
      memberDisplayName: 'Alice',
      message: 'first',
      branch: 'main',
      files: [],
      timestamp: Date.now(),
      reverted: false,
    };
    const second: PushRecord = {
      id: 'push-002',
      memberId: 'm2',
      memberDisplayName: 'Bob',
      message: 'second',
      branch: 'main',
      files: [],
      timestamp: Date.now() + 1,
      reverted: false,
    };
    await history.addRecord(first);
    await history.addRecord(second);
    assert.strictEqual(SessionHost.buildLatestPushId(history), 'push-002');
  });

  test('buildLatestPushId still returns the latest id when that record is reverted', async () => {
    // Reverted records should still surface as latest -- sync-response is
    // about "what is the most recent push the host knows about", not "what
    // is the most recent unreverted push". A reconnecting client uses this
    // id only to reseed its sync tracker.
    const rec: PushRecord = {
      id: 'push-reverted-1',
      memberId: 'm1',
      memberDisplayName: 'Alice',
      message: 'will be reverted',
      branch: 'main',
      files: [],
      timestamp: Date.now(),
      reverted: false,
    };
    await history.addRecord(rec);
    await history.markReverted('push-reverted-1');
    assert.strictEqual(SessionHost.buildLatestPushId(history), 'push-reverted-1');
  });
});
