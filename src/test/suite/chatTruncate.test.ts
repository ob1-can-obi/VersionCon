import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { ChatLog } from '../../filesystem/ChatLog.js';
import type { ChatRecord } from '../../types/chat.js';

suite('ChatLog truncation', () => {
  let tmpDir: string;
  let chatLog: ChatLog;

  setup(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `versioncon-chat-trunc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    chatLog = new ChatLog(tmpDir);
    await chatLog.load();
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // Helpers (same shape as chatLog.test.ts)
  const userMsg = (id: string, ts: number): ChatRecord => ({
    id,
    kind: 'user',
    memberId: 'm1',
    memberDisplayName: 'Alice',
    body: 'msg' + id,
    timestamp: ts,
  });
  const sysMsg = (id: string, ts: number): ChatRecord => ({
    id,
    kind: 'system',
    subKind: 'push',
    memberId: 'm1',
    memberDisplayName: 'Alice',
    body: 'pushed',
    timestamp: ts,
  });

  test('clearAll() empties the records and persists empty array', async () => {
    await chatLog.append(userMsg('a', 1));
    await chatLog.append(sysMsg('s1', 2));
    await chatLog.clearAll();
    assert.strictEqual(chatLog.getRecords().length, 0);
    const fresh = new ChatLog(tmpDir);
    await fresh.load();
    assert.deepStrictEqual(fresh.getRecords(), []);
  });

  test('truncateKeepLast100PlusActivity() keeps all system events + last 100 user messages', async () => {
    // Add 5 system events at timestamps 10..50
    for (let i = 1; i <= 5; i++) {
      await chatLog.append(sysMsg('s' + i, i * 10));
    }
    // Add 150 user messages at timestamps 1001..1150
    for (let i = 1; i <= 150; i++) {
      await chatLog.append(userMsg('u' + i, 1000 + i));
    }
    await chatLog.truncateKeepLast100PlusActivity();
    const remaining = chatLog.getRecords();
    const sysCount = remaining.filter(r => r.kind === 'system').length;
    const userCount = remaining.filter(r => r.kind === 'user').length;
    assert.strictEqual(sysCount, 5, 'all 5 system events kept');
    assert.strictEqual(userCount, 100, 'last 100 user messages kept');
    // Verify the kept user messages are the LATEST (u51..u150)
    const userIds = remaining.filter(r => r.kind === 'user').map(r => r.id);
    assert.ok(userIds.includes('u150'), 'newest user kept');
    assert.ok(userIds.includes('u51'), 'oldest of the 100 kept');
    assert.ok(!userIds.includes('u50'), 'u50 (the 51st-from-newest) is dropped');
    assert.ok(!userIds.includes('u1'), 'oldest user is dropped');
    // Chronological order
    for (let i = 1; i < remaining.length; i++) {
      assert.ok(
        remaining[i].timestamp >= remaining[i - 1].timestamp,
        `chronological order preserved at index ${i}`,
      );
    }
  });

  test('truncateKeepLast100PlusActivity() with fewer than 100 user msgs keeps them all', async () => {
    await chatLog.append(sysMsg('s1', 1));
    for (let i = 1; i <= 50; i++) {
      await chatLog.append(userMsg('u' + i, 100 + i));
    }
    await chatLog.truncateKeepLast100PlusActivity();
    assert.strictEqual(chatLog.getRecords().length, 51);
  });

  test('truncateActivityOnly() removes all user messages but keeps every system event', async () => {
    await chatLog.append(sysMsg('s1', 1));
    await chatLog.append(userMsg('u1', 2));
    await chatLog.append(sysMsg('s2', 3));
    await chatLog.append(userMsg('u2', 4));
    await chatLog.truncateActivityOnly();
    const remaining = chatLog.getRecords();
    assert.strictEqual(remaining.length, 2);
    assert.ok(remaining.every(r => r.kind === 'system'));
    assert.deepStrictEqual(remaining.map(r => r.id), ['s1', 's2']);
  });

  test('truncateActivityOnly() with no system events leaves empty', async () => {
    await chatLog.append(userMsg('u1', 1));
    await chatLog.append(userMsg('u2', 2));
    await chatLog.truncateActivityOnly();
    assert.strictEqual(chatLog.getRecords().length, 0);
  });

  test('truncations persist to disk', async () => {
    await chatLog.append(sysMsg('s1', 1));
    await chatLog.append(userMsg('u1', 2));
    await chatLog.truncateActivityOnly();
    const fresh = new ChatLog(tmpDir);
    await fresh.load();
    assert.strictEqual(fresh.getRecords().length, 1);
    assert.strictEqual(fresh.getRecords()[0].id, 's1');
  });

  test('truncateKeepLast100PlusActivity produces deterministic order for identical timestamps (tiebreaker on id)', async () => {
    // All same timestamp on purpose — without the id tiebreaker the order is implementation-defined.
    await chatLog.append(sysMsg('s_b', 1000));
    await chatLog.append(sysMsg('s_a', 1000));
    await chatLog.append(userMsg('u_b', 1000));
    await chatLog.append(userMsg('u_a', 1000));
    await chatLog.truncateKeepLast100PlusActivity();
    const ids = chatLog.getRecords().map(r => r.id);
    // Lexicographic order on id when timestamps tie:
    assert.deepStrictEqual(
      ids,
      ['s_a', 's_b', 'u_a', 'u_b'],
      'tiebreaker on id.localeCompare must produce lexicographic order when timestamps are equal',
    );
    // Re-run on a fresh ChatLog to confirm the same output (idempotence across reloads):
    const fresh = new ChatLog(tmpDir);
    await fresh.load();
    assert.deepStrictEqual(
      fresh.getRecords().map(r => r.id),
      ids,
      'output must be deterministic across reloads',
    );
  });

  test('clearAll() on already-empty log is a no-op (persists empty array)', async () => {
    await chatLog.clearAll();
    assert.strictEqual(chatLog.getRecords().length, 0);
    const fresh = new ChatLog(tmpDir);
    await fresh.load();
    assert.deepStrictEqual(fresh.getRecords(), []);
  });
});
