import * as assert from 'assert';
import { PresenceMap } from '../../filesystem/PresenceMap.js';
import type { PresenceInfo } from '../../types/chat.js';

suite('PresenceMap', () => {
  let map: PresenceMap;

  setup(() => {
    map = new PresenceMap();
  });

  const info = (memberId: string, file: string | null = null): PresenceInfo => ({
    memberId,
    displayName: 'User-' + memberId,
    branch: 'main',
    activeFilePath: file,
    lastUpdated: Date.now(),
  });

  test('upsert() inserts a new entry', () => {
    map.upsert(info('m1', 'src/foo.ts'));
    assert.strictEqual(map.has('m1'), true);
    assert.strictEqual(map.getSnapshot().length, 1);
  });

  test('upsert() replaces existing entry for same memberId', () => {
    map.upsert(info('m1', 'src/foo.ts'));
    map.upsert(info('m1', 'src/bar.ts'));
    const snapshot = map.getSnapshot();
    assert.strictEqual(snapshot.length, 1);
    assert.strictEqual(snapshot[0].activeFilePath, 'src/bar.ts');
  });

  test('removeMember() removes the entry', () => {
    map.upsert(info('m1'));
    map.upsert(info('m2'));
    map.removeMember('m1');
    assert.strictEqual(map.has('m1'), false);
    assert.strictEqual(map.has('m2'), true);
    assert.strictEqual(map.getSnapshot().length, 1);
  });

  test('removeMember() on non-existent id is a no-op', () => {
    map.upsert(info('m1'));
    map.removeMember('nonexistent');
    assert.strictEqual(map.has('m1'), true);
    assert.strictEqual(map.getSnapshot().length, 1);
  });

  test('getSnapshot() returns a defensive copy (mutating it does not affect the map)', () => {
    map.upsert(info('m1'));
    const snapshot = map.getSnapshot();
    snapshot.push(info('rogue'));
    assert.strictEqual(map.getSnapshot().length, 1);
    assert.strictEqual(map.has('rogue'), false);
  });

  test('clear() empties the map', () => {
    map.upsert(info('m1'));
    map.upsert(info('m2'));
    map.clear();
    assert.strictEqual(map.getSnapshot().length, 0);
    assert.strictEqual(map.has('m1'), false);
  });

  test('has() returns true after upsert and false after removeMember', () => {
    assert.strictEqual(map.has('m1'), false);
    map.upsert(info('m1'));
    assert.strictEqual(map.has('m1'), true);
    map.removeMember('m1');
    assert.strictEqual(map.has('m1'), false);
  });

  test('iteration order matches insertion order (Map default)', () => {
    map.upsert(info('a'));
    map.upsert(info('b'));
    map.upsert(info('c'));
    assert.deepStrictEqual(map.getSnapshot().map(p => p.memberId), ['a', 'b', 'c']);
  });
});
