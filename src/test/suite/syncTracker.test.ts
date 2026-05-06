import * as assert from 'assert';
import { SyncTracker } from '../../filesystem/SyncTracker.js';

suite('SyncTracker', () => {
  let tracker: SyncTracker;

  setup(() => {
    tracker = new SyncTracker();
  });

  test('isInSync() returns true when no pushes have been received', () => {
    assert.strictEqual(tracker.isInSync(), true);
  });

  test('isInSync() returns false after onRemotePush() is called', () => {
    tracker.onRemotePush('push-abc');
    assert.strictEqual(tracker.isInSync(), false);
  });

  test('isInSync() returns true after onRemotePush() then onSync()', () => {
    tracker.onRemotePush('push-abc');
    tracker.onSync();
    assert.strictEqual(tracker.isInSync(), true);
  });

  test('onLocalPush() sets both ids so isInSync() returns true', () => {
    tracker.onLocalPush('push-xyz');
    assert.strictEqual(tracker.isInSync(), true);
    assert.strictEqual(tracker.getLatestPushId(), 'push-xyz');
  });

  test('multiple remote pushes — only the last push id matters; onSync() after second push makes it in-sync', () => {
    tracker.onRemotePush('push-1');
    tracker.onRemotePush('push-2');
    assert.strictEqual(tracker.isInSync(), false);
    assert.strictEqual(tracker.getLatestPushId(), 'push-2');
    tracker.onSync();
    assert.strictEqual(tracker.isInSync(), true);
  });

  test('reset() clears all state back to initial (isInSync() returns true)', () => {
    tracker.onRemotePush('push-abc');
    assert.strictEqual(tracker.isInSync(), false);
    tracker.reset();
    assert.strictEqual(tracker.isInSync(), true);
    assert.strictEqual(tracker.getLatestPushId(), null);
  });

  test('getLatestPushId() returns null initially, returns the push id after onRemotePush', () => {
    assert.strictEqual(tracker.getLatestPushId(), null);
    tracker.onRemotePush('push-abc');
    assert.strictEqual(tracker.getLatestPushId(), 'push-abc');
  });

  test('recordRemoteFiles accumulates paths into the out-of-sync set (deduped)', () => {
    tracker.recordRemoteFiles(['src/a.ts', 'src/b.ts']);
    tracker.recordRemoteFiles(['src/b.ts', 'src/c.ts']);
    const paths = tracker.getOutOfSyncPaths().sort();
    assert.deepStrictEqual(paths, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  test('getOutOfSyncPaths returns an empty array initially', () => {
    assert.deepStrictEqual(tracker.getOutOfSyncPaths(), []);
  });

  test('clearPath removes a single path from the set, leaves others', () => {
    tracker.recordRemoteFiles(['src/a.ts', 'src/b.ts']);
    tracker.clearPath('src/a.ts');
    assert.deepStrictEqual(tracker.getOutOfSyncPaths(), ['src/b.ts']);
  });

  test('onSync() clears the out-of-sync set as well as the pushId pointers', () => {
    tracker.onRemotePush('push-1');
    tracker.recordRemoteFiles(['src/a.ts', 'src/b.ts']);
    tracker.onSync();
    assert.strictEqual(tracker.isInSync(), true);
    assert.deepStrictEqual(tracker.getOutOfSyncPaths(), []);
  });

  test('reset() clears the out-of-sync set', () => {
    tracker.recordRemoteFiles(['src/a.ts']);
    tracker.reset();
    assert.deepStrictEqual(tracker.getOutOfSyncPaths(), []);
  });

  test('returned array from getOutOfSyncPaths is a copy — mutating it does not affect the tracker', () => {
    tracker.recordRemoteFiles(['src/a.ts']);
    const snap = tracker.getOutOfSyncPaths();
    snap.push('src/b.ts');
    assert.deepStrictEqual(tracker.getOutOfSyncPaths(), ['src/a.ts']);
  });
});
