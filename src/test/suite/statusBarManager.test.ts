import * as assert from 'assert';
import { StatusBarManager } from '../../ui/StatusBarManager.js';

suite('StatusBarManager — Phase 4', () => {
  let manager: StatusBarManager;

  setup(() => {
    manager = new StatusBarManager();
    manager.setStatus('connected', 'TestSession');
  });

  teardown(() => {
    manager.dispose();
  });

  // ----- flashNoImpact (CONF-08, UI-SPEC §6.2) -----

  test('flashNoImpact sets the green check text with N file count', () => {
    manager.flashNoImpact(3);
    const text = manager.getItemTextForTest();
    assert.match(text, /\$\(check\) VersionCon — no impact \(3 file\(s\) unaffected\)/);
  });

  test('flashNoImpact with N=1 uses singular "1 file unaffected"', () => {
    manager.flashNoImpact(1);
    const text = manager.getItemTextForTest();
    assert.match(text, /1 file unaffected/);
    assert.doesNotMatch(text, /file\(s\)/);
  });

  test('flashNoImpact reverts after duration (use 50ms to keep test fast)', async () => {
    manager.flashNoImpact(2, 50);
    await new Promise(r => setTimeout(r, 80));
    const text = manager.getItemTextForTest();
    assert.doesNotMatch(text, /no impact/);
    assert.match(text, /VersionCon/);
  });

  test('flashNoImpact does NOT fire when syncWarningActive', () => {
    manager.setSyncWarning(true);
    manager.flashNoImpact(5);
    const text = manager.getItemTextForTest();
    assert.match(text, /may be out of sync/);
    assert.doesNotMatch(text, /no impact/);
  });

  // ----- setUnreadCount (UI-SPEC §6.2) -----

  test('setUnreadCount(3) appends $(comment) 3 to connected status', () => {
    manager.setUnreadCount(3);
    const text = manager.getItemTextForTest();
    assert.match(text, /\$\(circle-filled\) VersionCon \$\(comment\) 3/);
  });

  test('setUnreadCount(0) reverts to plain connected status (no $(comment))', () => {
    manager.setUnreadCount(5);
    manager.setUnreadCount(0);
    const text = manager.getItemTextForTest();
    assert.doesNotMatch(text, /\$\(comment\)/);
    assert.match(text, /\$\(circle-filled\) VersionCon$/);
  });

  test('setUnreadCount(N>0) swaps command to versioncon.openChat', () => {
    manager.setUnreadCount(2);
    const cmd = manager.getItemCommandForTest();
    assert.strictEqual(cmd, 'versioncon.openChat');
  });

  test('setUnreadCount during syncWarning is suppressed but value preserved (re-applies on warning clear)', () => {
    manager.setSyncWarning(true);
    manager.setUnreadCount(7);
    // Sync warning text wins immediately.
    const text = manager.getItemTextForTest();
    assert.match(text, /may be out of sync/);
    // Clear the warning -- setStatus runs on the inner branch and re-applies the badge
    // because unreadCount > 0 and status is 'connected'.
    manager.setSyncWarning(false);
    const newText = manager.getItemTextForTest();
    assert.match(newText, /\$\(comment\) 7/);
  });
});
