// src/test/suite/mcpFixtures.test.ts
// Phase 8 Wave 0 — sanity test that FakeReaders compiles + reads + mutates.
// This is the first MCP-prefixed test file in the project. Downstream plans
// 08-02..08-09 add their own mcp*.test.ts files alongside it.
//
// Test discipline mirrors branchManager.test.ts (setup() builds the fixture
// fresh per test; no teardown needed since there's no on-disk state).
import * as assert from 'assert';
import { FakeReaders } from './fixtures/fakeReaders.js';

suite('Phase 8 — FakeReaders fixture (Wave 0 sanity)', () => {
  let f: FakeReaders;

  setup(() => {
    f = new FakeReaders();
  });

  test('getActiveBranch returns "main" by default', async () => {
    assert.strictEqual(await f.getActiveBranch(), 'main');
  });

  test('getOutOfSyncPaths is [] by default, mutates via _setDirtyFiles', () => {
    assert.deepStrictEqual(f.getOutOfSyncPaths(), []);
    f._setDirtyFiles(['a.ts', 'b.ts']);
    assert.deepStrictEqual(f.getOutOfSyncPaths(), ['a.ts', 'b.ts']);
  });

  test('getRecentPushes returns at least 1 canned PushRecord', () => {
    const pushes = f.getRecentPushes(10);
    assert.ok(pushes.length >= 1, 'expected >= 1 canned push');
    assert.strictEqual(pushes[0].id, 'push-fixture-001');
    // Verify the fixture's PushRecord matches the on-disk PushRecord shape
    // (timestamp is number, files is PushFileEntry[] with status enum).
    assert.strictEqual(typeof pushes[0].timestamp, 'number');
    assert.strictEqual(pushes[0].files[0].relativePath, 'src/auth/TokenService.ts');
    assert.strictEqual(pushes[0].files[0].status, 'modified');
  });

  test('getRecent returns at least 1 canned ChatRecord', () => {
    const chats = f.getRecent(10);
    assert.ok(chats.length >= 1);
    assert.strictEqual(chats[0].id, 'chat-fixture-001');
    assert.strictEqual(chats[0].kind, 'user');
  });

  test('forwardDeps(parseToken) returns the canned symbol+file pair', async () => {
    const r = await f.forwardDeps('parseToken', 1);
    assert.deepStrictEqual(r.symbols, ['verifyClient']);
    assert.deepStrictEqual(r.files, ['src/host/AuthHandler.ts']);
  });

  test('reverseDeps(verifyClient) returns parseToken', async () => {
    const r = await f.reverseDeps('verifyClient', 1);
    assert.deepStrictEqual(r.symbols, ['parseToken']);
  });

  test('forwardDeps(unknown) returns empty arrays (no throw)', async () => {
    const r = await f.forwardDeps('zzz-no-such-symbol', 1);
    assert.deepStrictEqual(r, { symbols: [], files: [] });
  });

  test('getPresenceSnapshot is [] by default, mutates via _setPresenceForFile', () => {
    assert.deepStrictEqual(f.getPresenceSnapshot(), []);
    f._setPresenceForFile('src/foo.ts', 'bob-member-id', 'Bob');
    const snap = f.getPresenceSnapshot();
    assert.strictEqual(snap.length, 1);
    assert.strictEqual(snap[0].memberId, 'bob-member-id');
    assert.strictEqual(snap[0].activeFilePath, 'src/foo.ts');
  });

  test('getMemberTracking reflects _setPresenceForFile', () => {
    f._setPresenceForFile('src/foo.ts', 'bob-member-id');
    const tracking = f.getMemberTracking();
    assert.deepStrictEqual([...(tracking.get('bob-member-id') ?? [])], ['src/foo.ts']);
  });
});
