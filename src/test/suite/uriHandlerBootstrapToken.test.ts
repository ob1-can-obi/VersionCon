import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';
import * as vscode from 'vscode';
import { JoinPanel } from '../../ui/JoinPanel.js';

// -----------------------------------------------------------------------------
// Phase 7 Plan 07-14 — UriHandler `bt` (bootstrap token) parsing tests
//
// MD-03 / SC-2 closure step 2 of 2 (joiner-side consume). The host side
// (07-13) landed `&bt=` in the share-screen deep-link. This test file pins
// the joiner-side parsing contract:
//
//   - handleUri reads `params.get('bt')` (URL-decoded by URLSearchParams)
//   - URL-decode handles JWT-safe special chars (+, /, =)
//   - When `bt` is absent (LAN deep-link OR pre-07-13 cloud deep-link),
//     bootstrapToken passes through to JoinPrefill as the empty string
//   - T-07-20 (HIGH) mitigation: OutputChannel.appendLine logs the literal
//     `bt=<redacted>` — the JWT value MUST NEVER appear in the log line
//   - JoinPrefill literal in the openPrefilled call carries bootstrapToken
//   - Source-grep gates pin the redaction literal + the parser literal
// -----------------------------------------------------------------------------

suite('Phase 7 — UriHandler bootstrap token (Plan 07-14)', () => {
  const extensionTsPath = path.resolve(process.cwd(), 'src/extension.ts');

  // -------------------------------------------------------------------------
  // Source-grep gates (N-07-14-A + bt parser literal + redaction)
  // -------------------------------------------------------------------------

  test('extension.ts contains the literal params.get(\'bt\') (bt parser wired)', () => {
    const src = fsSync.readFileSync(extensionTsPath, 'utf-8');
    assert.match(src, /params\.get\(['"]bt['"]\)/,
      'UriHandler must call params.get(\'bt\') to extract the bootstrap JWT from the deep-link');
  });

  test('extension.ts contains the literal bt=<redacted> (T-07-20 redaction)', () => {
    const src = fsSync.readFileSync(extensionTsPath, 'utf-8');
    assert.match(src, /bt=<redacted>/,
      'OutputChannel log line must redact bt to literal bt=<redacted> (T-07-20 HIGH mitigation)');
  });

  test('extension.ts has NO unredacted appendLine site referencing bt= (T-07-20 source-grep)', () => {
    const src = fsSync.readFileSync(extensionTsPath, 'utf-8');
    // Find any appendLine call site that interpolates `bt=` followed by something
    // OTHER than the literal <redacted> token. The redaction-aware site uses
    // the literal `bt=<redacted>`; an unredacted site would look like
    // `bt=${bt}` or `bt=eyJ...`.
    const lines = src.split('\n');
    const offenders: string[] = [];
    for (const line of lines) {
      if (/appendLine/.test(line) && /bt=/.test(line) && !/bt=<redacted>/.test(line)) {
        offenders.push(line.trim());
      }
    }
    assert.strictEqual(offenders.length, 0,
      `OutputChannel must NEVER log bt= without redaction. Offenders: ${JSON.stringify(offenders)}`);
  });

  test('extension.ts threads bootstrapToken into the JoinPrefill literal', () => {
    const src = fsSync.readFileSync(extensionTsPath, 'utf-8');
    assert.match(src, /bootstrapToken\s*:\s*bt\b/,
      'openPrefilled prefill literal must carry bootstrapToken: bt');
  });

  // -------------------------------------------------------------------------
  // Functional — Test 1: bt parsing happy path
  // -------------------------------------------------------------------------
  test('handleUri with bt param → openPrefilled receives bootstrapToken in prefill', async () => {
    const openPrefilledArgs: unknown[] = [];

    const originalShowInfo = vscode.window.showInformationMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showInformationMessage = async () => 'Join';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalOpenPrefilled = (JoinPanel as any).openPrefilled;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (JoinPanel as any).openPrefilled = async (...args: unknown[]) => {
      openPrefilledArgs.push(args);
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { VersionConUriHandler } = (await import('../../extension.js')) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = new (VersionConUriHandler as any)(
        { subscriptions: [] },
        {},
        () => { /* noop */ },
      );

      const uri = vscode.Uri.parse(
        'vscode://versioncon.versioncon/join?relay=wss%3A%2F%2Fr.fly.dev&session=vc-abc&code=XKCDPQ&bt=eyJjustatestjwt',
      );
      await handler.handleUri(uri);

      assert.strictEqual(openPrefilledArgs.length, 1, 'openPrefilled called exactly once');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lastArgs = openPrefilledArgs[0] as any[];
      const prefill = lastArgs[lastArgs.length - 1] as Record<string, unknown>;
      assert.strictEqual(prefill.bootstrapToken, 'eyJjustatestjwt',
        'bootstrapToken populated from bt query param');
      assert.strictEqual(prefill.mode, 'cloud');
      assert.strictEqual(prefill.relayUrl, 'wss://r.fly.dev');
      assert.strictEqual(prefill.sessionId, 'vc-abc');
      assert.strictEqual(prefill.inviteCode, 'XKCDPQ');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).showInformationMessage = originalShowInfo;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (JoinPanel as any).openPrefilled = originalOpenPrefilled;
    }
  });

  // -------------------------------------------------------------------------
  // Functional — Test 2: URL-decoded JWT-shaped value (base64url + period)
  // Real bootstrap JWTs are base64url (alnum + `-` + `_`) joined by `.`
  // separators. None of those require URL-encoding. We assert the realistic
  // pass-through: a JWT-shaped value with periods arrives verbatim.
  // -------------------------------------------------------------------------
  test('handleUri with realistic JWT-shaped bt → bootstrapToken preserved verbatim', async () => {
    const openPrefilledArgs: unknown[] = [];

    const originalShowInfo = vscode.window.showInformationMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showInformationMessage = async () => 'Join';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalOpenPrefilled = (JoinPanel as any).openPrefilled;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (JoinPanel as any).openPrefilled = async (...args: unknown[]) => {
      openPrefilledArgs.push(args);
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { VersionConUriHandler } = (await import('../../extension.js')) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = new (VersionConUriHandler as any)({ subscriptions: [] }, {}, () => { /* noop */ });

      // A realistic 3-segment base64url JWT. base64url = alnum + `-` + `_`;
      // the `.` separator between segments does NOT require URL-encoding.
      // The full JWT string passes through unchanged via URLSearchParams.get().
      const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJib290c3RyYXAtdmMtYWJjIn0.signature-segment_with-base64url-chars';
      const uri = vscode.Uri.parse(
        `vscode://versioncon.versioncon/join?relay=wss%3A%2F%2Fr.fly.dev&session=s&code=c&bt=${JWT}`,
      );
      await handler.handleUri(uri);

      assert.strictEqual(openPrefilledArgs.length, 1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lastArgs = openPrefilledArgs[0] as any[];
      const prefill = lastArgs[lastArgs.length - 1] as Record<string, unknown>;
      assert.strictEqual(prefill.bootstrapToken, JWT,
        'realistic base64url JWT preserved verbatim through URLSearchParams.get()');
      // base64url chars survive the encode/decode cycle.
      assert.ok((prefill.bootstrapToken as string).includes('.'), 'JWT segment separator preserved');
      assert.ok((prefill.bootstrapToken as string).includes('-'), 'base64url `-` preserved');
      assert.ok((prefill.bootstrapToken as string).includes('_'), 'base64url `_` preserved');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).showInformationMessage = originalShowInfo;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (JoinPanel as any).openPrefilled = originalOpenPrefilled;
    }
  });

  // -------------------------------------------------------------------------
  // Functional — Test 3: bt absent (LAN regression / legacy cloud deep-link)
  // -------------------------------------------------------------------------
  test('handleUri without bt param → bootstrapToken in prefill is empty string (LAN/legacy regression)', async () => {
    const openPrefilledArgs: unknown[] = [];

    const originalShowInfo = vscode.window.showInformationMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showInformationMessage = async () => 'Join';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalOpenPrefilled = (JoinPanel as any).openPrefilled;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (JoinPanel as any).openPrefilled = async (...args: unknown[]) => {
      openPrefilledArgs.push(args);
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { VersionConUriHandler } = (await import('../../extension.js')) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = new (VersionConUriHandler as any)({ subscriptions: [] }, {}, () => { /* noop */ });

      // NO bt= in the deep-link — emulates a pre-07-13 cloud deep-link OR a
      // LAN regression that funnels through the same UriHandler.
      const uri = vscode.Uri.parse(
        'vscode://versioncon.versioncon/join?relay=wss%3A%2F%2Fr.fly.dev&session=s&code=c',
      );
      await handler.handleUri(uri);

      assert.strictEqual(openPrefilledArgs.length, 1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lastArgs = openPrefilledArgs[0] as any[];
      const prefill = lastArgs[lastArgs.length - 1] as Record<string, unknown>;
      assert.strictEqual(prefill.bootstrapToken, '',
        'bootstrapToken defaults to empty string when bt is absent (NOT undefined)');
      assert.strictEqual(typeof prefill.bootstrapToken, 'string',
        'bootstrapToken is always a string (never undefined)');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).showInformationMessage = originalShowInfo;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (JoinPanel as any).openPrefilled = originalOpenPrefilled;
    }
  });

  // -------------------------------------------------------------------------
  // Source-grep — Test 4: T-07-20 redaction (HIGH) at the appendLine site
  //
  // Note: a runtime OutputChannel-capture test is NOT viable because the
  // module-scoped lazy singleton (`deepLinkOutputChannel` in extension.ts)
  // is created once per process by `vscode.window.createOutputChannel` and
  // cannot be replaced by stubbing AFTER any earlier test has triggered
  // creation. We rely on source-grep gates — tighter than runtime tests
  // for static literals — to enforce T-07-20.
  // -------------------------------------------------------------------------
  test('source-grep: appendLine site uses literal bt=<redacted> in the deep-link-accepted log line', () => {
    const src = fsSync.readFileSync(extensionTsPath, 'utf-8');
    // Find the "Deep-link accepted" appendLine site.
    const idx = src.indexOf('Deep-link accepted');
    assert.ok(idx >= 0, 'Deep-link accepted log line found');
    // Take a window around the line and the nearby btLog construction.
    const window = src.substring(Math.max(0, idx - 800), idx + 400);
    assert.match(window, /bt=<redacted>/,
      'appendLine window must reference bt=<redacted> literal (T-07-20)');
    // The btLog construction must use the redaction literal — never `${bt}`.
    assert.doesNotMatch(window, /bt=\$\{bt\}/,
      'appendLine window MUST NOT interpolate ${bt} (T-07-20: never log JWT verbatim)');
  });

  // -------------------------------------------------------------------------
  // Source-grep — Test 5: conditional redaction (bt-empty case is silent)
  // -------------------------------------------------------------------------
  test('source-grep: btLog is empty when bt is empty (LAN regression: no extra log noise)', () => {
    const src = fsSync.readFileSync(extensionTsPath, 'utf-8');
    // The btLog computation must conditionally include bt=<redacted> only when
    // bt has length > 0. This preserves byte-identical LAN log output.
    assert.match(src, /bt\.length\s*>\s*0\s*\?\s*['"], bt=<redacted>['"]\s*:\s*['"]['"]/,
      'btLog must be `bt.length > 0 ? \', bt=<redacted>\' : \'\'` (conditional, LAN-regression-clean)');
  });

  // -------------------------------------------------------------------------
  // Functional — Test 6: empty bt= explicit (bt= with no value) → empty string
  // -------------------------------------------------------------------------
  test('handleUri with explicit empty bt= → bootstrapToken is empty string', async () => {
    const openPrefilledArgs: unknown[] = [];

    const originalShowInfo = vscode.window.showInformationMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showInformationMessage = async () => 'Join';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalOpenPrefilled = (JoinPanel as any).openPrefilled;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (JoinPanel as any).openPrefilled = async (...args: unknown[]) => {
      openPrefilledArgs.push(args);
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { VersionConUriHandler } = (await import('../../extension.js')) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = new (VersionConUriHandler as any)({ subscriptions: [] }, {}, () => { /* noop */ });

      const uri = vscode.Uri.parse(
        'vscode://versioncon.versioncon/join?relay=wss%3A%2F%2Fr.fly.dev&session=s&code=c&bt=',
      );
      await handler.handleUri(uri);

      assert.strictEqual(openPrefilledArgs.length, 1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lastArgs = openPrefilledArgs[0] as any[];
      const prefill = lastArgs[lastArgs.length - 1] as Record<string, unknown>;
      assert.strictEqual(prefill.bootstrapToken, '',
        'explicit empty bt= produces empty bootstrapToken (same as absent)');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).showInformationMessage = originalShowInfo;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (JoinPanel as any).openPrefilled = originalOpenPrefilled;
    }
  });
});
