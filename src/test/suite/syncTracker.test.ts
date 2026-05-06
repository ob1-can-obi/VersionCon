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
});
