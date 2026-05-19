import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';

// Phase 7 Plan 07-06 — JoinPanel cloud branch
//
// Source-grep + functional tests for the LAN/Cloud Connection-method radio,
// Cloud-branch fields (Relay URL, Session ID), and the mode-dispatch path
// through handleJoinConnect that constructs a CloudTransport-backed
// SessionClient.
//
// Pattern: file-as-string source-grep tests matching the Phase 4.1
// wizardValidation.test.ts precedent. No VS Code mounting required.

suite('Phase 7 — join cloud branch (Plan 07-06)', () => {
  const joinPanelPath = path.resolve(process.cwd(), 'src/ui/JoinPanel.ts');
  const joinJsPath = path.resolve(process.cwd(), 'src/ui/webview/join/join.js');
  const joinCssPath = path.resolve(process.cwd(), 'src/ui/webview/join/join.css');

  test('JoinPanel state widens to carry mode/relayUrl/sessionId', () => {
    const src = fsSync.readFileSync(joinPanelPath, 'utf-8');
    assert.match(src, /mode:\s*['"]lan['"]\s*\|\s*['"]cloud['"]/,
      'JoinState.mode union type present');
    assert.match(src, /relayUrl:\s*string/, 'JoinState.relayUrl present');
    assert.match(src, /sessionId:\s*string/, 'JoinState.sessionId present');
    assert.match(src, /openPrefilled/,
      'public static openPrefilled() entry point exposed for UriHandler');
  });

  test('join.js renders Connection method radio with UI-SPEC copy', () => {
    const src = fsSync.readFileSync(joinJsPath, 'utf-8');
    assert.match(src, /Connection method/, 'fieldset legend literal present');
    assert.match(src, /LAN \(host on same network\)/, 'LAN radio label literal');
    assert.match(src, /Cloud \(via relay\)/, 'Cloud radio label literal');
    assert.match(src, /Use this if your teammates are on the same Wi-Fi or office network\./,
      'LAN description literal');
    assert.match(src, /Use this if your team is on different networks\. You'll need a relay URL\./,
      'Cloud description literal');
    assert.match(src, /name="connection-mode"/, 'radios share a name attribute');
    assert.match(src, /data-mode="lan"/, 'LAN radio data-mode');
    assert.match(src, /data-mode="cloud"/, 'Cloud radio data-mode');
    assert.match(src, /id="relay-url"/, 'Relay URL input rendered in Cloud branch');
    assert.match(src, /id="session-id"/, 'Session ID input rendered in Cloud branch');
    assert.match(src, /placeholder="wss:\/\/your-relay\.fly\.dev"/,
      'Relay URL placeholder UI-SPEC literal');
    assert.match(src, /placeholder="vc-7f3a92"/, 'Session ID placeholder UI-SPEC literal');
    assert.match(src, /Join Cloud Session/, 'Cloud-branch CTA copy');
  });

  test('join.js escapes all rendered state fields via escapeHtml() (XSS defense — T-07-10a)', () => {
    const src = fsSync.readFileSync(joinJsPath, 'utf-8');
    // Every dynamic value site uses escapeHtml(...) — no raw template-literal
    // interpolation of state.* values without escapeHtml wrapping.
    assert.match(src, /escapeHtml\(state\.relayUrl\)/, 'relayUrl rendered via escapeHtml');
    assert.match(src, /escapeHtml\(state\.sessionId\)/, 'sessionId rendered via escapeHtml');
    assert.match(src, /escapeHtml\(state\.inviteCode\)/, 'inviteCode rendered via escapeHtml');
    assert.match(src, /escapeHtml\(state\.displayName\)/, 'displayName rendered via escapeHtml');
  });

  test('JoinPanel.handleJoinConnect branches on mode === cloud and constructs CloudTransport', () => {
    const src = fsSync.readFileSync(joinPanelPath, 'utf-8');
    assert.match(src, /mode\s*===\s*['"]cloud['"]/, 'cloud-mode dispatch present in handleJoinConnect');
    assert.match(src, /CloudTransport/, 'CloudTransport referenced for the cloud connect path');
    assert.match(src, /Relay URL must start with wss:\/\//, 'wss:// validation literal');
    assert.match(src, /Session ID is required\./, 'sessionId-empty literal');
  });

  test('join.css declares radio-group styles using only VS Code theme variables (no hex)', () => {
    const src = fsSync.readFileSync(joinCssPath, 'utf-8');
    assert.match(src, /\.radio-group\s*\{/, '.radio-group rule present');
    assert.match(src, /\.radio-option\s*\{/, '.radio-option rule present');
    // No hex color literals introduced in the new Phase 7 CSS block.
    const newCssBlock = src.substring(src.indexOf('.radio-group'));
    assert.doesNotMatch(newCssBlock, /#[0-9a-fA-F]{3,8}\b/,
      'No hex colors in new Phase 7 CSS — only var(--vscode-*) tokens');
  });

  test('package.json activationEvents includes onUri', () => {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const src = fsSync.readFileSync(pkgPath, 'utf-8');
    assert.match(src, /"activationEvents"\s*:\s*\[[^\]]*"onUri"/,
      'activationEvents array contains the literal "onUri"');
  });

  test('join.js posts join-mode-change message on radio change', () => {
    const src = fsSync.readFileSync(joinJsPath, 'utf-8');
    assert.match(src, /join-mode-change/, 'webview emits join-mode-change message on radio toggle');
  });

  test('JoinPanel.handleMessage routes join-mode-change to mode setter', () => {
    const src = fsSync.readFileSync(joinPanelPath, 'utf-8');
    assert.match(src, /join-mode-change/, 'extension handles join-mode-change message type');
  });
});
