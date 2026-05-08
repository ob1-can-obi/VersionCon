import * as assert from 'assert';
import { ActivityLogProvider, formatRelativeTime } from '../../ui/ActivityLogProvider.js';

suite('ActivityLogProvider', () => {
  let provider: ActivityLogProvider;

  setup(() => {
    provider = new ActivityLogProvider();
  });

  test('addPushEntry adds entry and refreshes', () => {
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.addPushEntry({
      timestamp: 1000,
      memberId: 'a',
      memberDisplayName: 'Alice',
      isMine: false,
      files: ['x.ts'],
      pushMessage: 'msg',
      affectsLocal: false,
    });
    assert.strictEqual(provider.getEntries().length, 1);
    assert.strictEqual(fired, true, 'refresh fires onDidChangeTreeData');
  });

  test('ring buffer caps at 200 entries', () => {
    for (let i = 0; i < 250; i++) {
      provider.addPushEntry({
        timestamp: i,
        memberId: 'a',
        memberDisplayName: 'Alice',
        isMine: false,
        files: ['x.ts'],
        affectsLocal: false,
      });
    }
    assert.strictEqual(provider.getEntries().length, 200);
  });

  test('sticky unread row preserved during ring buffer trim', () => {
    provider.setUnread(3);
    for (let i = 0; i < 250; i++) {
      provider.addPushEntry({
        timestamp: i,
        memberId: 'a',
        memberDisplayName: 'Alice',
        isMine: false,
        files: ['x.ts'],
        affectsLocal: false,
      });
    }
    const entries = provider.getEntries();
    const sticky = entries.find(e => e.kind === 'chat-unread');
    assert.ok(sticky, 'sticky unread survived ring buffer trim');
    const nonSticky = entries.filter(e => e.kind !== 'chat-unread');
    assert.strictEqual(nonSticky.length, 200, 'non-sticky still capped at 200');
  });

  test('setUnread(5) inserts sticky row, setUnread(0) removes it', () => {
    provider.setUnread(5);
    const entries1 = provider.getEntries();
    const sticky1 = entries1.find(e => e.kind === 'chat-unread');
    assert.ok(sticky1, 'sticky present after setUnread(5)');
    assert.strictEqual(sticky1!.unreadCount, 5);

    provider.setUnread(0);
    const entries2 = provider.getEntries();
    assert.strictEqual(entries2.find(e => e.kind === 'chat-unread'), undefined);
  });

  test('setUnread replaces existing sticky on second call', () => {
    provider.setUnread(3);
    provider.setUnread(7);
    const stickies = provider.getEntries().filter(e => e.kind === 'chat-unread');
    assert.strictEqual(stickies.length, 1, 'single-sticky invariant');
    assert.strictEqual(stickies[0].unreadCount, 7);
  });

  test('clear removes all entries and refreshes', () => {
    provider.addPushEntry({
      timestamp: 1, memberId: 'a', memberDisplayName: 'Alice',
      isMine: false, files: ['x.ts'], affectsLocal: false,
    });
    provider.setUnread(2);
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.clear();
    assert.strictEqual(provider.getEntries().length, 0);
    assert.strictEqual(fired, true);
  });

  test('getChildren(elem) returns [] for flat tree', async () => {
    provider.addPushEntry({
      timestamp: 1, memberId: 'a', memberDisplayName: 'Alice',
      isMine: false, files: ['x.ts'], affectsLocal: false,
    });
    const child = provider.getEntries()[0];
    const grandchildren = await provider.getChildren(child);
    assert.deepStrictEqual(grandchildren, []);
  });

  test('getChildren returns sticky first, then reverse-chronological', async () => {
    provider.addPushEntry({
      timestamp: 100, memberId: 'a', memberDisplayName: 'Alice',
      isMine: false, files: ['x.ts'], affectsLocal: false,
    });
    provider.addPushEntry({
      timestamp: 200, memberId: 'b', memberDisplayName: 'Bob',
      isMine: false, files: ['y.ts'], affectsLocal: false,
    });
    provider.setUnread(2);
    const children = await provider.getChildren();
    assert.strictEqual(children[0].kind, 'chat-unread', 'sticky first');
    assert.strictEqual(children[1].timestamp, 200, 'newest second');
    assert.strictEqual(children[2].timestamp, 100, 'oldest last');
  });

  test('getEntries returns a defensive copy', () => {
    provider.addPushEntry({
      timestamp: 1, memberId: 'a', memberDisplayName: 'Alice',
      isMine: false, files: ['x.ts'], affectsLocal: false,
    });
    const copy = provider.getEntries();
    copy.push({} as never);
    assert.strictEqual(provider.getEntries().length, 1, 'mutation of returned array does not affect provider');
  });

  suite('label formatting (UI-SPEC §6.3)', () => {
    test('my push label', () => {
      provider.addPushEntry({
        timestamp: 1, memberId: 'me', memberDisplayName: 'Me',
        isMine: true, files: ['a', 'b', 'c'], affectsLocal: false,
      });
      const item = provider.getTreeItem(provider.getEntries()[0]);
      assert.strictEqual(item.label, 'You pushed 3 file(s)');
    });

    test('remote push, no overlap label', () => {
      provider.addPushEntry({
        timestamp: 1, memberId: 'a', memberDisplayName: 'Alice',
        isMine: false, files: ['a'], affectsLocal: false,
      });
      const item = provider.getTreeItem(provider.getEntries()[0]);
      assert.strictEqual(item.label, 'Alice pushed 1 file(s)');
    });

    test('remote push, affects me label', () => {
      provider.addPushEntry({
        timestamp: 1, memberId: 'a', memberDisplayName: 'Alice',
        isMine: false, files: ['a', 'b'], affectsLocal: true,
      });
      const item = provider.getTreeItem(provider.getEntries()[0]);
      assert.strictEqual(item.label, 'Alice pushed 2 file(s) — affects you');
    });

    test('my revert label', () => {
      provider.addRevertEntry({
        timestamp: 1, memberId: 'me', memberDisplayName: 'Me',
        isMine: true, files: ['a'], affectsLocal: false,
      });
      const item = provider.getTreeItem(provider.getEntries()[0]);
      assert.strictEqual(item.label, 'You reverted 1 file(s)');
    });

    test('remote revert label', () => {
      provider.addRevertEntry({
        timestamp: 1, memberId: 'a', memberDisplayName: 'Alice',
        isMine: false, files: ['a', 'b'], affectsLocal: false,
      });
      const item = provider.getTreeItem(provider.getEntries()[0]);
      assert.strictEqual(item.label, 'Alice reverted 2 file(s)');
    });

    test('my branch-create label', () => {
      provider.addBranchCreateEntry({
        timestamp: 1, memberId: 'me', memberDisplayName: 'Me',
        isMine: true, branchName: 'feat-x',
      });
      const item = provider.getTreeItem(provider.getEntries()[0]);
      assert.strictEqual(item.label, "You created branch 'feat-x'");
    });

    test('remote branch-create label', () => {
      provider.addBranchCreateEntry({
        timestamp: 1, memberId: 'a', memberDisplayName: 'Alice',
        isMine: false, branchName: 'feat-y',
      });
      const item = provider.getTreeItem(provider.getEntries()[0]);
      assert.strictEqual(item.label, "Alice created branch 'feat-y'");
    });

    test('chat-unread sticky label', () => {
      provider.setUnread(3);
      const sticky = provider.getEntries().find(e => e.kind === 'chat-unread')!;
      const item = provider.getTreeItem(sticky);
      assert.strictEqual(item.label, '$(circle-filled) 3 unread message(s)');
    });
  });

  suite('TreeItem decoration (UI-SPEC §2.2)', () => {
    test('push (mine) icon + contextValue + click command', () => {
      provider.addPushEntry({
        timestamp: 1, memberId: 'me', memberDisplayName: 'Me',
        isMine: true, files: ['a'], affectsLocal: false,
      });
      const item = provider.getTreeItem(provider.getEntries()[0]);
      assert.strictEqual(item.contextValue, 'activity-push');
      assert.strictEqual(item.command?.command, 'versioncon.activityLog.openEntry');
    });

    test('chat-unread row click opens chat panel', () => {
      provider.setUnread(1);
      const sticky = provider.getEntries().find(e => e.kind === 'chat-unread')!;
      const item = provider.getTreeItem(sticky);
      assert.strictEqual(item.command?.command, 'versioncon.openChat');
      assert.strictEqual(item.contextValue, 'activity-chat-unread');
    });

    test('push tooltip includes ISO timestamp + push message when present', () => {
      provider.addPushEntry({
        timestamp: 1700000000000,
        memberId: 'a', memberDisplayName: 'Alice',
        isMine: false, files: ['a'], pushMessage: 'wire token refresh', affectsLocal: false,
      });
      const item = provider.getTreeItem(provider.getEntries()[0]);
      const tooltip = String(item.tooltip);
      assert.ok(tooltip.startsWith('2023-11-14T'), 'tooltip starts with ISO date');
      assert.ok(tooltip.includes('"wire token refresh"'), 'tooltip includes quoted push message');
    });

    test('chat-unread row has empty description', () => {
      provider.setUnread(2);
      const sticky = provider.getEntries().find(e => e.kind === 'chat-unread')!;
      const item = provider.getTreeItem(sticky);
      assert.strictEqual(item.description, '');
    });
  });

  suite('formatRelativeTime (UI-SPEC §6.3)', () => {
    test('< 10s → "just now"', () => {
      assert.strictEqual(formatRelativeTime(1000, 5000), 'just now');
    });
    test('< 60s → "Ns ago"', () => {
      assert.strictEqual(formatRelativeTime(0, 30 * 1000), '30s ago');
    });
    test('< 60m → "Nm ago"', () => {
      assert.strictEqual(formatRelativeTime(0, 5 * 60 * 1000), '5m ago');
    });
    test('< 24h → "Nh ago"', () => {
      assert.strictEqual(formatRelativeTime(0, 3 * 60 * 60 * 1000), '3h ago');
    });
    test('>= 24h → "Nd ago"', () => {
      assert.strictEqual(formatRelativeTime(0, 2 * 24 * 60 * 60 * 1000), '2d ago');
    });
    test('future timestamp clamps to "just now"', () => {
      // If now < timestamp (clock skew), diff is clamped to 0 → "just now".
      assert.strictEqual(formatRelativeTime(10_000, 5_000), 'just now');
    });
  });
});
