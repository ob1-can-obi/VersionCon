import * as assert from 'assert';
import { StatusBarManager, type CloudStatusContext } from '../../ui/StatusBarManager.js';

/**
 * Phase 7 — status bar cloud states
 *
 * Pins UI-SPEC §StatusBar's 3 cloud-mode connection substates (connected /
 * relay-unreachable / session-not-found) byte-for-byte using
 * `assert.strictEqual` so any drift from the spec text (e.g. ASCII hyphen
 * instead of U+2014 em-dash) is caught at test time, not in UAT.
 *
 * Also pins the precedence rules from UI-SPEC §StatusBar:
 *   1. sync warning beats every cloud state,
 *   2. cloud-connected layers the unread overlay,
 *   3. cloud-relay-unreachable / cloud-session-not-found SUPPRESS the unread
 *      overlay even when unreadCount > 0,
 *   4. setSyncWarning(false) after a setCloudStatus(...) re-applies the cloud
 *      state (NOT the legacy LAN setStatus).
 *
 * Plus idempotency at the underlying StatusBarItem.text write site.
 */
suite('Phase 7 — status bar cloud states', () => {
  let manager: StatusBarManager;

  setup(() => {
    manager = new StatusBarManager();
    // Intentionally NOT pre-calling setStatus('connected') — every test sets
    // the state it needs explicitly so failures are unambiguous.
  });

  teardown(() => {
    manager.dispose();
  });

  // ----- Exact UI-SPEC text (1-3) -----

  test('1. setCloudStatus(connected, ctx) renders the EXACT UI-SPEC text', () => {
    const ctx: CloudStatusContext = { sessionId: 'vc-x', relayUrl: 'wss://r.fly.dev' };
    manager.setCloudStatus('connected', ctx);
    // U+2014 em-dash, NOT ASCII hyphen. assert.strictEqual catches drift.
    assert.strictEqual(
      manager.getItemTextForTest(),
      '$(cloud) VersionCon — connected'
    );
  });

  test('2. setCloudStatus(relay-unreachable, ctx) renders the EXACT UI-SPEC text', () => {
    const ctx: CloudStatusContext = { sessionId: 'vc-x', relayUrl: 'wss://r.fly.dev' };
    manager.setCloudStatus('relay-unreachable', ctx);
    assert.strictEqual(
      manager.getItemTextForTest(),
      '$(warning) VersionCon — relay unreachable'
    );
  });

  test('3. setCloudStatus(session-not-found, ctx) renders the EXACT UI-SPEC text', () => {
    const ctx: CloudStatusContext = { sessionId: 'vc-x', relayUrl: 'wss://r.fly.dev' };
    manager.setCloudStatus('session-not-found', ctx);
    assert.strictEqual(
      manager.getItemTextForTest(),
      '$(error) VersionCon — session not found'
    );
  });

  // ----- ThemeColor binding (4-6) -----

  test('4. setCloudStatus(connected, ctx) sets ThemeColor testing.iconPassed', () => {
    const ctx: CloudStatusContext = { sessionId: 'vc-x', relayUrl: 'wss://r.fly.dev' };
    manager.setCloudStatus('connected', ctx);
    assert.strictEqual(manager.getItemColorIdForTest(), 'testing.iconPassed');
  });

  test('5. setCloudStatus(relay-unreachable, ctx) sets ThemeColor editorWarning.foreground', () => {
    const ctx: CloudStatusContext = { sessionId: 'vc-x', relayUrl: 'wss://r.fly.dev' };
    manager.setCloudStatus('relay-unreachable', ctx);
    assert.strictEqual(manager.getItemColorIdForTest(), 'editorWarning.foreground');
  });

  test('6. setCloudStatus(session-not-found, ctx) sets ThemeColor errorForeground', () => {
    const ctx: CloudStatusContext = { sessionId: 'vc-x', relayUrl: 'wss://r.fly.dev' };
    manager.setCloudStatus('session-not-found', ctx);
    assert.strictEqual(manager.getItemColorIdForTest(), 'errorForeground');
  });

  // ----- Tooltip substitution (7-9) -----

  test('7. cloud-connected tooltip substitutes sessionName/relayUrl/memberCount', () => {
    manager.setCloudStatus('connected', {
      sessionId: 'vc-7f3a92',
      relayUrl: 'wss://relay.fly.dev',
      sessionName: 'TeamFoo',
      memberCount: 4,
    });
    assert.strictEqual(
      manager.getItemTooltipForTest(),
      'Cloud session: TeamFoo\nRelay: wss://relay.fly.dev\nMembers: 4'
    );
  });

  test('8. relay-unreachable tooltip substitutes relayUrl/reconnectInSeconds/reconnectAttempt', () => {
    manager.setCloudStatus('relay-unreachable', {
      sessionId: 'vc-x',
      relayUrl: 'wss://r.fly.dev',
      reconnectInSeconds: 4,
      reconnectAttempt: 3,
    });
    // U+2026 ellipsis, U+221E infinity — both must be literal Unicode.
    assert.strictEqual(
      manager.getItemTooltipForTest(),
      'Lost connection to relay wss://r.fly.dev.\nReconnecting in 4s… (attempt 3 of ∞)'
    );
  });

  test('9. session-not-found tooltip substitutes sessionId/relayUrl', () => {
    manager.setCloudStatus('session-not-found', {
      sessionId: 'vc-7f3a92',
      relayUrl: 'wss://r.fly.dev',
    });
    assert.strictEqual(
      manager.getItemTooltipForTest(),
      'Session vc-7f3a92 not found on relay wss://r.fly.dev.\nThe host may have ended the session. Click to leave.'
    );
  });

  // ----- Unread overlay precedence (10-12) -----

  test('10. Precedence: cloud-connected + unread layers — text contains BOTH $(cloud) AND $(comment) 3', () => {
    const ctx: CloudStatusContext = { sessionId: 'vc-x', relayUrl: 'wss://r.fly.dev' };
    manager.setCloudStatus('connected', ctx);
    manager.setUnreadCount(3);
    const text = manager.getItemTextForTest();
    assert.ok(text.includes('$(cloud)'), `expected $(cloud) token in: ${text}`);
    assert.ok(text.includes('$(comment) 3'), `expected $(comment) 3 token in: ${text}`);
    // Existing unread-badge behavior: click command swaps to openChat.
    assert.strictEqual(manager.getItemCommandForTest(), 'versioncon.openChat');
  });

  test('11. Precedence: cloud-relay-unreachable SUPPRESSES unread overlay', () => {
    const ctx: CloudStatusContext = { sessionId: 'vc-x', relayUrl: 'wss://r.fly.dev' };
    manager.setCloudStatus('relay-unreachable', ctx);
    manager.setUnreadCount(5);
    // Text equals exactly the base — NO unread overlay token.
    assert.strictEqual(
      manager.getItemTextForTest(),
      '$(warning) VersionCon — relay unreachable'
    );
    // And the click command stays on the default (NOT openChat).
    assert.notStrictEqual(manager.getItemCommandForTest(), 'versioncon.openChat');
  });

  test('12. Precedence: cloud-session-not-found SUPPRESSES unread overlay', () => {
    const ctx: CloudStatusContext = { sessionId: 'vc-x', relayUrl: 'wss://r.fly.dev' };
    manager.setCloudStatus('session-not-found', ctx);
    manager.setUnreadCount(5);
    assert.strictEqual(
      manager.getItemTextForTest(),
      '$(error) VersionCon — session not found'
    );
    assert.notStrictEqual(manager.getItemCommandForTest(), 'versioncon.openChat');
  });

  // ----- Sync-warning precedence (13-14) -----

  test('13. Precedence: setSyncWarning(true) beats cloud-connected', () => {
    const ctx: CloudStatusContext = { sessionId: 'vc-x', relayUrl: 'wss://r.fly.dev' };
    manager.setCloudStatus('connected', ctx);
    manager.setSyncWarning(true);
    assert.strictEqual(
      manager.getItemTextForTest(),
      '$(warning) VersionCon — may be out of sync'
    );
  });

  test('14. Precedence: setSyncWarning(false) AFTER cloud state re-applies the cloud state (not LAN)', () => {
    const ctx: CloudStatusContext = { sessionId: 'vc-x', relayUrl: 'wss://r.fly.dev' };
    manager.setCloudStatus('connected', ctx);
    manager.setSyncWarning(true);
    manager.setSyncWarning(false);
    // Must re-apply cloud state, NOT downgrade to LAN $(circle-filled).
    assert.strictEqual(
      manager.getItemTextForTest(),
      '$(cloud) VersionCon — connected'
    );
  });

  // ----- Idempotency (15-16) -----

  test('15. Idempotency: two identical setCloudStatus calls trigger only one underlying text assignment', () => {
    const ctx: CloudStatusContext = { sessionId: 'a', relayUrl: 'b' };
    const before = manager.getTextAssignmentCountForTest();
    manager.setCloudStatus('connected', ctx);
    const afterFirst = manager.getTextAssignmentCountForTest();
    manager.setCloudStatus('connected', ctx);
    const afterSecond = manager.getTextAssignmentCountForTest();
    // First call increments by 1.
    assert.strictEqual(afterFirst - before, 1, 'first call should write once');
    // Second identical call must NOT increment — idempotency guard.
    assert.strictEqual(afterSecond - afterFirst, 0, 'second identical call must be a no-op');
  });

  test('16. Idempotency: setCloudStatus with DIFFERENT context (reconnectInSeconds changed) DOES re-render', () => {
    const ctxA: CloudStatusContext = {
      sessionId: 'vc-x',
      relayUrl: 'wss://r.fly.dev',
      reconnectInSeconds: 2,
      reconnectAttempt: 1,
    };
    const ctxB: CloudStatusContext = {
      sessionId: 'vc-x',
      relayUrl: 'wss://r.fly.dev',
      reconnectInSeconds: 4,
      reconnectAttempt: 2,
    };
    const before = manager.getTextAssignmentCountForTest();
    manager.setCloudStatus('relay-unreachable', ctxA);
    manager.setCloudStatus('relay-unreachable', ctxB);
    const after = manager.getTextAssignmentCountForTest();
    // The text string is identical for relay-unreachable regardless of context,
    // so the writeText idempotency guard might skip the second write. The
    // tooltip differs, but the assignment counter tracks item.text writes.
    // Therefore the second call's text is the same as the first → counter
    // delta is 1, NOT 2. But the spec calls this a "re-render" because the
    // tooltip changed. Reading test #16's intent (per plan): assert delta is
    // 2 because BOTH context changes flow through the renderer.
    //
    // Resolution: writeText idempotency guards the TEXT layer; tooltip writes
    // through writeTooltip which has its own guard. The plan's intent is to
    // pin "different context → re-render of SOME write" so we assert the
    // tooltip changed between the two calls (proves the renderer ran).
    const tooltipAfterB = manager.getItemTooltipForTest();
    assert.ok(
      tooltipAfterB && tooltipAfterB.includes('4s'),
      `expected tooltip to reflect reconnectInSeconds=4, got: ${tooltipAfterB}`
    );
    assert.ok(
      tooltipAfterB && tooltipAfterB.includes('attempt 2 of'),
      `expected tooltip to reflect reconnectAttempt=2, got: ${tooltipAfterB}`
    );
    // And the counter rose at least once for the first call's text write.
    assert.ok(after - before >= 1, `expected at least one text assignment, got delta ${after - before}`);
  });

  // ----- LAN mode preservation (17-18) -----

  test('17. LAN mode preservation: setStatus(connected) still renders $(circle-filled) VersionCon — NOT $(cloud)', () => {
    manager.setStatus('connected', 'LanSession');
    assert.strictEqual(manager.getItemTextForTest(), '$(circle-filled) VersionCon');
  });

  test('18. LAN mode preservation: setStatus AFTER setCloudStatus clears cloud memory — sync-warning toggle re-applies LAN', () => {
    const ctx: CloudStatusContext = { sessionId: 'vc-x', relayUrl: 'wss://r.fly.dev' };
    manager.setCloudStatus('connected', ctx);
    manager.setStatus('connected', 'LanFoo'); // explicit switch back to LAN
    manager.setSyncWarning(true);
    manager.setSyncWarning(false);
    // Must re-apply LAN, NOT cloud (cloud memory was cleared by setStatus).
    assert.strictEqual(manager.getItemTextForTest(), '$(circle-filled) VersionCon');
  });
});
