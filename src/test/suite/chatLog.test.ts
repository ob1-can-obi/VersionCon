import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { ChatLog } from '../../filesystem/ChatLog.js';
import type { ChatRecord, SystemEventSubKind } from '../../types/chat.js';

suite('ChatLog', () => {
  let tmpDir: string;
  let chatLog: ChatLog;

  setup(async () => {
    tmpDir = path.join(os.tmpdir(), `versioncon-chat-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(tmpDir, { recursive: true });
    chatLog = new ChatLog(tmpDir);
    await chatLog.load();
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // Helpers — fixture builders for user and system records.
  const userMsg = (id: string, ts: number, body: string): ChatRecord => ({
    id,
    kind: 'user',
    memberId: 'm1',
    memberDisplayName: 'Alice',
    body,
    timestamp: ts,
  });
  const sysMsg = (id: string, ts: number, sub: SystemEventSubKind = 'push'): ChatRecord => ({
    id,
    kind: 'system',
    subKind: sub,
    memberId: 'm1',
    memberDisplayName: 'Alice',
    body: 'pushed',
    timestamp: ts,
  });

  test('load() on missing file initializes records to []', async () => {
    assert.deepStrictEqual(chatLog.getRecords(), []);
  });

  test('append() persists to disk and survives reload', async () => {
    const record = userMsg('r1', 1000, 'hello');
    await chatLog.append(record);
    const fresh = new ChatLog(tmpDir);
    await fresh.load();
    assert.deepStrictEqual(fresh.getRecords(), [record]);
  });

  test('getRecords() returns chronological order (oldest first)', async () => {
    await chatLog.append(userMsg('a', 1000, 'first'));
    await chatLog.append(userMsg('b', 2000, 'second'));
    await chatLog.append(userMsg('c', 3000, 'third'));
    const records = chatLog.getRecords();
    assert.strictEqual(records.length, 3);
    assert.strictEqual(records[0].id, 'a');
    assert.strictEqual(records[1].id, 'b');
    assert.strictEqual(records[2].id, 'c');
  });

  test('getRecent(2) returns last 2 records chronologically', async () => {
    for (let i = 1; i <= 5; i++) {
      await chatLog.append(userMsg('r' + i, i * 1000, 'msg' + i));
    }
    const recent = chatLog.getRecent(2);
    assert.strictEqual(recent.length, 2);
    assert.strictEqual(recent[0].id, 'r4');
    assert.strictEqual(recent[1].id, 'r5');
  });

  test('getRecent(100) returns all records when fewer than 100 exist', async () => {
    await chatLog.append(userMsg('only', 1, 'only'));
    const recent = chatLog.getRecent(100);
    assert.strictEqual(recent.length, 1);
    assert.strictEqual(recent[0].id, 'only');
  });

  test('getRecords returns a defensive copy (caller mutation does not affect store)', async () => {
    await chatLog.append(userMsg('a', 1, 'one'));
    const snapshot = chatLog.getRecords();
    snapshot.push(userMsg('b', 2, 'two'));
    assert.strictEqual(chatLog.getRecords().length, 1, 'internal records were not mutated by external push');
  });

  test('exportToFile(json) writes JSON-serialized records', async () => {
    const r = userMsg('r1', 1, 'export-me');
    await chatLog.append(r);
    const target = path.join(tmpDir, 'export.json');
    await chatLog.exportToFile(target, 'json');
    const content = await fs.readFile(target, 'utf-8');
    assert.deepStrictEqual(JSON.parse(content), [r]);
  });

  test('exportToFile(md) writes markdown-formatted records', async () => {
    await chatLog.append(userMsg('r1', 1700000000000, 'hello world'));
    await chatLog.append(sysMsg('s1', 1700000001000));
    const target = path.join(tmpDir, 'export.md');
    await chatLog.exportToFile(target, 'md');
    const content = await fs.readFile(target, 'utf-8');
    // user record renders as a heading section
    assert.match(content, /### Alice/);
    assert.match(content, /hello world/);
    // system event renders as a block-quote
    assert.match(content, /> _Alice/);
    // separator between blocks
    assert.match(content, /\n---\n/);
  });

  test('exportToFile() with hiddenBefore filter excludes older records', async () => {
    await chatLog.append(userMsg('old', 100, 'hidden'));
    await chatLog.append(userMsg('new', 200, 'visible'));
    const target = path.join(tmpDir, 'filtered.json');
    await chatLog.exportToFile(target, 'json', 150);
    const exported = JSON.parse(await fs.readFile(target, 'utf-8'));
    assert.strictEqual(exported.length, 1);
    assert.strictEqual(exported[0].id, 'new');
  });

  test('exportToFile() with hiddenBefore equal to a timestamp keeps that record (>=)', async () => {
    await chatLog.append(userMsg('boundary', 150, 'on the boundary'));
    await chatLog.append(userMsg('after', 200, 'after'));
    const target = path.join(tmpDir, 'boundary.json');
    await chatLog.exportToFile(target, 'json', 150);
    const exported = JSON.parse(await fs.readFile(target, 'utf-8'));
    assert.strictEqual(exported.length, 2, 'boundary record (timestamp === hiddenBefore) is included');
  });

  test('append accepts both user and system records and reloads them in order', async () => {
    await chatLog.append(userMsg('u1', 1, 'hi'));
    await chatLog.append(sysMsg('s1', 2, 'push'));
    await chatLog.append(userMsg('u2', 3, 'cool'));
    const fresh = new ChatLog(tmpDir);
    await fresh.load();
    const ids = fresh.getRecords().map(r => r.id);
    assert.deepStrictEqual(ids, ['u1', 's1', 'u2']);
    assert.strictEqual(fresh.getRecords()[1].kind, 'system');
    assert.strictEqual(fresh.getRecords()[1].subKind, 'push');
  });
});
