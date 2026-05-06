import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { PushHistory } from '../../filesystem/PushHistory.js';
import type { PushRecord } from '../../types/push.js';

suite('PushHistory', () => {
  let tmpDir: string;
  let history: PushHistory;

  setup(async () => {
    tmpDir = path.join(os.tmpdir(), `versioncon-push-history-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    history = new PushHistory(tmpDir);
    await history.load();
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('load returns empty array when no history file exists', async () => {
    const records = history.getRecords();
    assert.strictEqual(records.length, 0);
  });

  test('addRecord persists and retrieves a push record', async () => {
    const record: PushRecord = {
      id: 'push-1',
      memberId: 'member-1',
      memberDisplayName: 'Alice',
      message: 'Initial push',
      branch: 'main',
      files: [{ relativePath: 'src/app.ts', status: 'added', addedLines: 10, removedLines: 0 }],
      timestamp: Date.now(),
      reverted: false,
    };

    await history.addRecord(record);
    const records = history.getRecords();
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].id, 'push-1');
    assert.strictEqual(records[0].message, 'Initial push');
  });

  test('getRecords returns newest first', async () => {
    await history.addRecord({
      id: 'push-1', memberId: 'm', memberDisplayName: 'A', message: 'first',
      branch: 'main', files: [], timestamp: 1000, reverted: false,
    });
    await history.addRecord({
      id: 'push-2', memberId: 'm', memberDisplayName: 'A', message: 'second',
      branch: 'main', files: [], timestamp: 2000, reverted: false,
    });

    const records = history.getRecords();
    assert.strictEqual(records[0].id, 'push-2');
    assert.strictEqual(records[1].id, 'push-1');
  });

  test('getRecord returns specific record by ID', async () => {
    await history.addRecord({
      id: 'push-x', memberId: 'm', memberDisplayName: 'A', message: 'test',
      branch: 'main', files: [], timestamp: 1000, reverted: false,
    });

    const record = history.getRecord('push-x');
    assert.ok(record);
    assert.strictEqual(record!.message, 'test');
  });

  test('markReverted sets reverted flag', async () => {
    await history.addRecord({
      id: 'push-r', memberId: 'm', memberDisplayName: 'A', message: 'to revert',
      branch: 'main', files: [], timestamp: 1000, reverted: false,
    });

    await history.markReverted('push-r');
    const record = history.getRecord('push-r');
    assert.strictEqual(record!.reverted, true);
  });

  test('saveSnapshot and readSnapshot round-trip content', async () => {
    await history.saveSnapshot('push-s', 'src/app.ts', 'original content');
    const content = await history.readSnapshot('push-s', 'src/app.ts');
    assert.strictEqual(content, 'original content');
  });

  test('readSnapshot returns null for missing snapshot', async () => {
    const content = await history.readSnapshot('nonexistent', 'file.ts');
    assert.strictEqual(content, null);
  });

  test('hasSnapshot returns true/false correctly', async () => {
    await history.saveSnapshot('push-h', 'exists.ts', 'data');
    assert.strictEqual(await history.hasSnapshot('push-h', 'exists.ts'), true);
    assert.strictEqual(await history.hasSnapshot('push-h', 'nope.ts'), false);
  });

  test('persistence survives reload', async () => {
    await history.addRecord({
      id: 'push-p', memberId: 'm', memberDisplayName: 'A', message: 'persist',
      branch: 'main', files: [], timestamp: 1000, reverted: false,
    });

    // Create new instance and reload
    const history2 = new PushHistory(tmpDir);
    await history2.load();
    const record = history2.getRecord('push-p');
    assert.ok(record);
    assert.strictEqual(record!.message, 'persist');
  });
});
