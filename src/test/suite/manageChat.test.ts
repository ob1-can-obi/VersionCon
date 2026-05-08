import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { ChatLog } from '../../filesystem/ChatLog.js';
import type { ChatRecord } from '../../types/chat.js';

/**
 * Plan 04-11 (manage-chat) unit tests.
 *
 * The QuickPick + showWarningMessage modal flow can't be directly unit-tested
 * without launching a VS Code extension host. These tests exercise the
 * behaviour layer underneath the QuickPick:
 *
 *  1. ChatLog dispatch correctness for the three host destructive paths
 *     (clearAll / truncateKeepLast100PlusActivity / truncateActivityOnly).
 *  2. Export-to-file dispatch — both formats and the hiddenBefore filter.
 *  3. UI-SPEC §6.5 literal-copy verification — the manage-chat command's
 *     source MUST contain the exact modal strings + positive-verb buttons,
 *     so a future drift away from spec is caught at test time.
 *  4. Host-gating literal verification — non-host members must see the
 *     "(host only — disabled)" descriptions for items 2-4 and the
 *     "Only the host can run this action." early-return toast.
 */

suite('manageChat — destructive action dispatch (unit-level)', () => {
  let tmpDir: string;
  let chatLog: ChatLog;

  setup(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `versioncon-mgmt-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    chatLog = new ChatLog(tmpDir);
    await chatLog.load();
    // Seed: 5 system events (push), 150 user messages.
    for (let i = 1; i <= 5; i++) {
      await chatLog.append({
        id: `s${i}`,
        kind: 'system',
        subKind: 'push',
        memberId: 'h',
        memberDisplayName: 'Host',
        body: `pushed ${i}`,
        timestamp: i * 10,
      });
    }
    for (let i = 1; i <= 150; i++) {
      await chatLog.append({
        id: `u${i}`,
        kind: 'user',
        memberId: 'a',
        memberDisplayName: 'Alice',
        body: `msg${i}`,
        timestamp: 1000 + i,
      });
    }
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('delete-all dispatch: chatLog.clearAll() leaves no records', async () => {
    await chatLog.clearAll();
    assert.strictEqual(chatLog.getRecords().length, 0);
  });

  test('delete-all dispatch: clearAll persists empty across reload', async () => {
    await chatLog.clearAll();
    const fresh = new ChatLog(tmpDir);
    await fresh.load();
    assert.deepStrictEqual(fresh.getRecords(), []);
  });

  test('truncate-keep-100 dispatch: keeps all 5 system + last 100 user', async () => {
    await chatLog.truncateKeepLast100PlusActivity();
    const records = chatLog.getRecords();
    assert.strictEqual(records.filter(r => r.kind === 'system').length, 5);
    assert.strictEqual(records.filter(r => r.kind === 'user').length, 100);
  });

  test('truncate-keep-100 dispatch: kept user messages are the LAST 100 (u51..u150)', async () => {
    await chatLog.truncateKeepLast100PlusActivity();
    const userIds = chatLog.getRecords()
      .filter(r => r.kind === 'user')
      .map(r => r.id);
    assert.strictEqual(userIds[0], 'u51');
    assert.strictEqual(userIds[userIds.length - 1], 'u150');
  });

  test('truncate-activity-only dispatch: removes all user messages, keeps system', async () => {
    await chatLog.truncateActivityOnly();
    const records = chatLog.getRecords();
    assert.strictEqual(records.length, 5);
    assert.ok(records.every(r => r.kind === 'system'));
  });

  test('truncate-activity-only dispatch: persists across reload', async () => {
    await chatLog.truncateActivityOnly();
    const fresh = new ChatLog(tmpDir);
    await fresh.load();
    assert.strictEqual(fresh.getRecords().length, 5);
    assert.ok(fresh.getRecords().every(r => r.kind === 'system'));
  });

  test('export-json dispatch: writes JSON containing all records (155 total)', async () => {
    const target = path.join(tmpDir, 'export.json');
    await chatLog.exportToFile(target, 'json');
    const content = await fs.readFile(target, 'utf-8');
    const parsed: ChatRecord[] = JSON.parse(content);
    assert.strictEqual(parsed.length, 155);
  });

  test('export-md dispatch: markdown joins records with horizontal rule separator', async () => {
    const target = path.join(tmpDir, 'export.md');
    await chatLog.exportToFile(target, 'md');
    const content = await fs.readFile(target, 'utf-8');
    // Each record is one block; 155 records = 154 separators.
    const separatorCount = (content.match(/\n\n---\n\n/g) ?? []).length;
    assert.strictEqual(separatorCount, 154);
    // System events render as block-quote (lead with `> _`); user messages as H3.
    assert.ok(content.includes('> _Host · '));
    assert.ok(content.includes('### Alice · '));
  });

  test('export with hiddenBefore filter excludes records older than the cutoff', async () => {
    const target = path.join(tmpDir, 'filtered.json');
    // Cutoff at 1100 — system events have ts <= 50 (excluded);
    // user messages u101..u150 have ts >= 1101 → 50 included; u100 has ts=1100,
    // which is the boundary — included by the >= semantics.
    await chatLog.exportToFile(target, 'json', 1100);
    const parsed: ChatRecord[] = JSON.parse(await fs.readFile(target, 'utf-8'));
    assert.strictEqual(parsed.length, 51);
    assert.ok(parsed.every(r => r.timestamp >= 1100));
  });

  test('export with hiddenBefore=undefined includes all records', async () => {
    const target = path.join(tmpDir, 'noFilter.json');
    await chatLog.exportToFile(target, 'json', undefined);
    const parsed: ChatRecord[] = JSON.parse(await fs.readFile(target, 'utf-8'));
    assert.strictEqual(parsed.length, 155);
  });
});

// -----------------------------------------------------------------------------
// UI-SPEC §6.5 literal copy verification
//
// The QuickPick + showWarningMessage modal flow can't be directly unit-tested
// without launching a VS Code extension host. Mocking VS Code's window APIs in
// a Node-only test is brittle. Instead, these tests read extension.ts as a
// string and assert the presence of the literal copy from UI-SPEC §6.5.
// Future drift away from the spec is caught at test time.
// -----------------------------------------------------------------------------

const EXTENSION_PATH = path.join(process.cwd(), 'src', 'extension.ts');

suite('manageChat — UI-SPEC §6.5 literal copy verification', () => {
  let extensionSrc: string;

  suiteSetup(async () => {
    extensionSrc = await fs.readFile(EXTENSION_PATH, 'utf-8');
  });

  test('extension.ts contains literal "Delete entire chat for everyone?" + detail', () => {
    assert.ok(extensionSrc.includes('Delete entire chat for everyone?'));
    assert.ok(extensionSrc.includes(
      "This permanently removes all chat messages and activity events from chat-log.json. Other members' panels will go blank. This cannot be undone.",
    ));
  });

  test('extension.ts contains literal "Truncate chat to last 100 messages?" + detail', () => {
    assert.ok(extensionSrc.includes('Truncate chat to last 100 messages?'));
    assert.ok(extensionSrc.includes(
      'Older user messages will be removed for everyone. Push, revert, and branch-create events will be kept.',
    ));
  });

  test('extension.ts contains literal "Remove all user chat messages?" + detail', () => {
    assert.ok(extensionSrc.includes('Remove all user chat messages?'));
    assert.ok(extensionSrc.includes(
      'Every user message will be removed for everyone. Push, revert, and branch-create events will be kept.',
    ));
  });

  test('extension.ts contains literal "Clear chat from your view?" + detail', () => {
    assert.ok(extensionSrc.includes('Clear chat from your view?'));
    assert.ok(extensionSrc.includes(
      'This hides existing messages from your panel only. Other members are not affected. Future messages will continue to appear.',
    ));
  });

  test('extension.ts contains literal positive-verb confirm buttons (no "OK"/"Yes")', () => {
    assert.ok(extensionSrc.includes("'Delete all'"), 'Delete all button missing');
    assert.ok(extensionSrc.includes("'Truncate'"), 'Truncate button missing');
    assert.ok(extensionSrc.includes("'Remove messages'"), 'Remove messages button missing');
    assert.ok(extensionSrc.includes("'Clear my view'"), 'Clear my view button missing');
  });

  test('extension.ts uses showWarningMessage with { modal: true } for destructive flows', () => {
    // Each destructive action is preceded by a modal: true confirm.
    const modalCount = (extensionSrc.match(/modal: true/g) ?? []).length;
    assert.ok(modalCount >= 4, `expected >=4 modal:true blocks, got ${modalCount}`);
  });
});

suite('manageChat — UI-SPEC §6.4 QuickPick item literals', () => {
  let extensionSrc: string;

  suiteSetup(async () => {
    extensionSrc = await fs.readFile(EXTENSION_PATH, 'utf-8');
  });

  test('extension.ts contains the QuickPick title + placeholder per UI-SPEC §6.4', () => {
    assert.ok(extensionSrc.includes('VersionCon: Manage chat'));
    assert.ok(extensionSrc.includes('Choose an action…'));
  });

  test('extension.ts contains all 5 QuickPick item codicons + labels', () => {
    assert.ok(extensionSrc.includes('$(eye-closed) Clear my view'));
    assert.ok(extensionSrc.includes('$(trash) Delete entire chat'));
    assert.ok(extensionSrc.includes('$(history) Truncate: keep last 100 + activity'));
    assert.ok(extensionSrc.includes('$(filter) Truncate: keep only activity events'));
    assert.ok(extensionSrc.includes('$(export) Export chat to file'));
  });

  test('extension.ts contains "(host only — disabled)" description for non-host gating', () => {
    // T-04-11-06 defense-in-depth: the items remain visible to non-host
    // members but the description signals the gate, AND selection triggers
    // an info toast. Both literal strings must be present.
    assert.ok(extensionSrc.includes('(host only — disabled)'));
    assert.ok(extensionSrc.includes('Only the host can run this action.'));
  });

  test('extension.ts wires broadcastChatCleared + broadcastChatTruncated for destructive actions', () => {
    assert.ok(extensionSrc.includes('broadcastChatCleared'));
    assert.ok(extensionSrc.includes('broadcastChatTruncated'));
    // Both truncation modes must be present as broadcastChatTruncated args.
    assert.ok(extensionSrc.includes("'keep-100-and-activity'"));
    assert.ok(extensionSrc.includes("'activity-only'"));
  });

  test('extension.ts wires showSaveDialog + ChatLog.exportToFile for the export action', () => {
    assert.ok(extensionSrc.includes('showSaveDialog'));
    assert.ok(extensionSrc.includes('exportToFile'));
    // Both file-format filters must be declared.
    assert.ok(extensionSrc.includes("'JSON': ['json']"));
    assert.ok(extensionSrc.includes("'Markdown': ['md']"));
  });

  test('extension.ts wires setChatHiddenBefore for the Clear-my-view path', () => {
    // Clear-my-view sets workspaceState.chatHiddenBefore = Date.now() and
    // refreshes the panel locally — does NOT call any host API.
    assert.ok(extensionSrc.includes('setChatHiddenBefore'));
  });
});
