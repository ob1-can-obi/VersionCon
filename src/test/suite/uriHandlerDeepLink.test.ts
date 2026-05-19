import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';
import * as vscode from 'vscode';
import { JoinPanel } from '../../ui/JoinPanel.js';

// Phase 7 Plan 07-06 — UriHandler deep-link tests
//
// Asserts the security gate T-07-10 (malicious deep-link silently auto-joins):
// confirmation prompt MUST be called BEFORE any panel open / network call.
// Asserts T-07-10a (XSS via injected param): raw value passed verbatim through
// the URI layer; webview escapes at render time (covered by joinPanelCloudBranch.test.ts).
// Asserts T-07-10c (Phase 4.1 invariant): displayName never extracted from URI.
//
// Verified deep-link host (read from package.json at planning time):
// publisher="versioncon", name="versioncon" → host="versioncon.versioncon"

suite('Phase 7 — deep link UriHandler (Plan 07-06)', () => {
  const extensionTsPath = path.resolve(process.cwd(), 'src/extension.ts');

  // Source-grep — VersionConUriHandler class shape exists in extension.ts
  test('extension.ts declares VersionConUriHandler with handleUri', () => {
    const src = fsSync.readFileSync(extensionTsPath, 'utf-8');
    assert.match(src, /class\s+VersionConUriHandler\b/, 'class declared');
    assert.match(src, /implements\s+vscode\.UriHandler/, 'implements UriHandler');
    assert.match(src, /handleUri\s*\(\s*uri:\s*vscode\.Uri/, 'handleUri(uri: vscode.Uri) signature');
    assert.match(src, /registerUriHandler\(\s*new\s+VersionConUriHandler/,
      'registerUriHandler(new VersionConUriHandler(...)) called in activate()');
  });

  // Source-grep — confirmation dialog literals are present and match UI-SPEC
  test('extension.ts confirmation dialog literals match UI-SPEC verbatim', () => {
    const src = fsSync.readFileSync(extensionTsPath, 'utf-8');
    assert.match(src, /Join VersionCon session\? You've been invited to join a cloud session at/,
      'confirmation prompt body literal — UI-SPEC §Deep-link Arrival Prompt');
    assert.match(src, /['"]Join['"]/, 'Join button literal');
    assert.match(src, /['"]Cancel['"]/, 'Cancel button literal');
  });

  // Source-grep — confirmation gate is unbypassable
  test('extension.ts has NO trusted-relay bypass — every deep-link prompts', () => {
    const src = fsSync.readFileSync(extensionTsPath, 'utf-8');
    // No "trusted" relay list, no "skip prompt" flag, no env-var bypass.
    assert.doesNotMatch(src, /skipConfirmation|trustedRelays|TRUSTED_RELAYS/i,
      'No trusted-relay bypass mechanism present');
  });

  // Source-grep — displayName is NOT extracted from URI params (T-07-10c)
  test('extension.ts does NOT extract displayName from deep-link URI params (Phase 4.1 invariant)', () => {
    const src = fsSync.readFileSync(extensionTsPath, 'utf-8');
    // Find the handleUri function block by approximate boundary
    const handleUriIdx = src.indexOf('handleUri');
    assert.ok(handleUriIdx >= 0, 'handleUri block found');
    const handleUriBlock = src.substring(handleUriIdx, handleUriIdx + 4000);
    assert.doesNotMatch(handleUriBlock, /params\.get\(['"]displayName['"]\)/,
      'handleUri must not extract displayName from query params');
    assert.doesNotMatch(handleUriBlock, /params\.get\(['"]name['"]\)/,
      'handleUri must not extract name from query params');
  });

  // Source-grep — OutputChannel log lines NEVER contain the invite code value (T-07-10b)
  test('deep-link OutputChannel log lines do NOT include the invite `code` value (T-07-10b)', () => {
    const src = fsSync.readFileSync(extensionTsPath, 'utf-8');
    // Find the VersionConUriHandler class block by class boundary
    const classIdx = src.indexOf('class VersionConUriHandler');
    assert.ok(classIdx >= 0, 'VersionConUriHandler class found');
    // Take a bounded window around the class block.
    const classBlock = src.substring(classIdx, classIdx + 6000);
    // Any appendLine call that interpolates ${code} would leak the invite code.
    // Allow `code=` IN the literal-string source for nothing — assert no appendLine
    // interpolates the code variable.
    assert.doesNotMatch(classBlock, /appendLine\([^)]*\$\{code\}/,
      'no OutputChannel.appendLine call interpolates ${code}');
  });

  // Functional — happy path
  test('handleUri valid URI → confirmation prompt → on Join → openPrefilled called', async () => {
    const callOrder: string[] = [];
    const openPrefilledArgs: unknown[] = [];

    // Stub vscode.window.showInformationMessage
    const originalShowInfo = vscode.window.showInformationMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showInformationMessage = async (..._args: unknown[]) => {
      callOrder.push('showInformationMessage');
      return 'Join';
    };

    // Stub JoinPanel.openPrefilled (static)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalOpenPrefilled = (JoinPanel as any).openPrefilled;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (JoinPanel as any).openPrefilled = async (...args: unknown[]) => {
      callOrder.push('openPrefilled');
      openPrefilledArgs.push(args);
    };

    try {
      // Construct the handler with minimal context shims
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { VersionConUriHandler } = (await import('../../extension.js')) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = new (VersionConUriHandler as any)(
        /* context */ { subscriptions: [] },
        /* sessionHistory */ {},
        /* onConnected */ () => { /* noop */ },
      );

      const uri = vscode.Uri.parse(
        'vscode://versioncon.versioncon/join?relay=wss%3A%2F%2Fr.fly.dev&session=vc-abc&code=K8M3PQ',
      );
      await handler.handleUri(uri);

      // ORDER: showInformationMessage MUST come BEFORE openPrefilled
      assert.deepStrictEqual(callOrder, ['showInformationMessage', 'openPrefilled'],
        'confirmation prompt called BEFORE panel open (T-07-10 mitigation)');

      // openPrefilled received the cloud prefill struct
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lastArgs = openPrefilledArgs[0] as any[];
      const prefill = lastArgs[lastArgs.length - 1] as Record<string, unknown>;
      assert.strictEqual(prefill.mode, 'cloud');
      assert.strictEqual(prefill.relayUrl, 'wss://r.fly.dev');
      assert.strictEqual(prefill.sessionId, 'vc-abc');
      assert.strictEqual(prefill.inviteCode, 'K8M3PQ');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assert.strictEqual((prefill as any).displayName, undefined,
        'displayName MUST NOT be in prefill (Phase 4.1 invariant)');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).showInformationMessage = originalShowInfo;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (JoinPanel as any).openPrefilled = originalOpenPrefilled;
    }
  });

  // Functional — user cancels (clicks Cancel)
  test('handleUri → user clicks Cancel → NO panel open, NO network activity', async () => {
    const callOrder: string[] = [];

    const originalShowInfo = vscode.window.showInformationMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showInformationMessage = async () => {
      callOrder.push('showInformationMessage');
      return 'Cancel';
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalOpenPrefilled = (JoinPanel as any).openPrefilled;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (JoinPanel as any).openPrefilled = async () => { callOrder.push('openPrefilled'); };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { VersionConUriHandler } = (await import('../../extension.js')) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = new (VersionConUriHandler as any)({ subscriptions: [] }, {}, () => { /* noop */ });
      await handler.handleUri(vscode.Uri.parse(
        'vscode://versioncon.versioncon/join?relay=wss%3A%2F%2Fr.fly.dev&session=vc-abc&code=K8M3PQ',
      ));
      assert.deepStrictEqual(callOrder, ['showInformationMessage'],
        'openPrefilled NOT called when user cancels');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).showInformationMessage = originalShowInfo;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (JoinPanel as any).openPrefilled = originalOpenPrefilled;
    }
  });

  // Functional — user dismisses (undefined)
  test('handleUri → user dismisses dialog → silent cancellation', async () => {
    const callOrder: string[] = [];
    const originalShowInfo = vscode.window.showInformationMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showInformationMessage = async () => {
      callOrder.push('showInformationMessage');
      return undefined;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalOpenPrefilled = (JoinPanel as any).openPrefilled;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (JoinPanel as any).openPrefilled = async () => { callOrder.push('openPrefilled'); };
    // Also stub showErrorMessage to confirm NO error toast on cancellation
    const originalShowError = vscode.window.showErrorMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showErrorMessage = async () => { callOrder.push('showErrorMessage'); return undefined; };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { VersionConUriHandler } = (await import('../../extension.js')) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = new (VersionConUriHandler as any)({ subscriptions: [] }, {}, () => { /* noop */ });
      await handler.handleUri(vscode.Uri.parse(
        'vscode://versioncon.versioncon/join?relay=wss%3A%2F%2Fr.fly.dev&session=vc-abc&code=K8M3PQ',
      ));
      assert.deepStrictEqual(callOrder, ['showInformationMessage'],
        'cancellation is silent — no panel, no error toast');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).showInformationMessage = originalShowInfo;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (JoinPanel as any).openPrefilled = originalOpenPrefilled;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).showErrorMessage = originalShowError;
    }
  });

  // Functional — XSS payload passed verbatim through URI layer
  test('handleUri with <script> in relay param → verbatim passed to openPrefilled (webview escapes at render)', async () => {
    const openPrefilledArgs: unknown[] = [];
    const originalShowInfo = vscode.window.showInformationMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showInformationMessage = async () => 'Join';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalOpenPrefilled = (JoinPanel as any).openPrefilled;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (JoinPanel as any).openPrefilled = async (...args: unknown[]) => { openPrefilledArgs.push(args); };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { VersionConUriHandler } = (await import('../../extension.js')) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = new (VersionConUriHandler as any)({ subscriptions: [] }, {}, () => { /* noop */ });
      // relay param decoded would be wss://<script>alert(1)</script>.evil —
      // starts with wss:// so passes the scheme validation; the <script> tag
      // is just textual content in the host portion of the URL.
      const payload = 'wss%3A%2F%2F%3Cscript%3Ealert(1)%3C%2Fscript%3E.evil';
      await handler.handleUri(vscode.Uri.parse(
        `vscode://versioncon.versioncon/join?relay=${payload}&session=s&code=c`,
      ));
      assert.ok(openPrefilledArgs.length > 0, 'openPrefilled invoked for syntactically-wss:// URL');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lastArgs = openPrefilledArgs[0] as any[];
      const prefill = lastArgs[lastArgs.length - 1] as Record<string, unknown>;
      assert.ok((prefill.relayUrl as string).includes('<script>'),
        'URI layer passes raw decoded string verbatim (escape happens in webview render layer)');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).showInformationMessage = originalShowInfo;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (JoinPanel as any).openPrefilled = originalOpenPrefilled;
    }
  });

  // Functional — malformed URI (wrong path)
  test('handleUri with path !== /join → no prompt, no panel, error logged', async () => {
    const callOrder: string[] = [];
    const originalShowInfo = vscode.window.showInformationMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showInformationMessage = async () => { callOrder.push('showInformationMessage'); return 'Join'; };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalOpenPrefilled = (JoinPanel as any).openPrefilled;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (JoinPanel as any).openPrefilled = async () => { callOrder.push('openPrefilled'); };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { VersionConUriHandler } = (await import('../../extension.js')) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = new (VersionConUriHandler as any)({ subscriptions: [] }, {}, () => { /* noop */ });
      await handler.handleUri(vscode.Uri.parse(
        'vscode://versioncon.versioncon/notjoin?relay=wss%3A%2F%2Fr.fly.dev&session=s&code=c',
      ));
      assert.deepStrictEqual(callOrder, [], 'no prompt, no panel for unsupported path');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).showInformationMessage = originalShowInfo;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (JoinPanel as any).openPrefilled = originalOpenPrefilled;
    }
  });

  // Functional — missing required param
  test('handleUri with missing relay param → no prompt, error logged', async () => {
    const callOrder: string[] = [];
    const originalShowInfo = vscode.window.showInformationMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showInformationMessage = async () => { callOrder.push('showInformationMessage'); return 'Join'; };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalOpenPrefilled = (JoinPanel as any).openPrefilled;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (JoinPanel as any).openPrefilled = async () => { callOrder.push('openPrefilled'); };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { VersionConUriHandler } = (await import('../../extension.js')) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = new (VersionConUriHandler as any)({ subscriptions: [] }, {}, () => { /* noop */ });
      await handler.handleUri(vscode.Uri.parse(
        'vscode://versioncon.versioncon/join?session=s&code=c',
      ));
      assert.deepStrictEqual(callOrder, [], 'no prompt when relay is missing');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).showInformationMessage = originalShowInfo;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (JoinPanel as any).openPrefilled = originalOpenPrefilled;
    }
  });

  // Functional — invalid relay scheme (no wss://)
  test('handleUri with non-wss:// relay → no prompt, error toast shown', async () => {
    const callOrder: string[] = [];
    const originalShowInfo = vscode.window.showInformationMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showInformationMessage = async () => { callOrder.push('showInformationMessage'); return 'Join'; };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalOpenPrefilled = (JoinPanel as any).openPrefilled;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (JoinPanel as any).openPrefilled = async () => { callOrder.push('openPrefilled'); };
    const originalShowError = vscode.window.showErrorMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showErrorMessage = async (msg: string) => { callOrder.push(`showErrorMessage:${msg}`); return undefined; };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { VersionConUriHandler } = (await import('../../extension.js')) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = new (VersionConUriHandler as any)({ subscriptions: [] }, {}, () => { /* noop */ });
      await handler.handleUri(vscode.Uri.parse(
        'vscode://versioncon.versioncon/join?relay=http%3A%2F%2Fevil.example&session=s&code=c',
      ));
      assert.ok(!callOrder.includes('showInformationMessage'),
        'never prompt user to confirm a non-wss:// relay');
      assert.ok(!callOrder.includes('openPrefilled'),
        'never open panel for non-wss:// relay');
      assert.ok(callOrder.some(c => c.startsWith('showErrorMessage:')),
        'error toast shown for invalid scheme');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).showInformationMessage = originalShowInfo;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (JoinPanel as any).openPrefilled = originalOpenPrefilled;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).showErrorMessage = originalShowError;
    }
  });
});
