// src/test/suite/mcpConsent.test.ts
//
// Phase 8 Plan 05 — first-run consent prompt tests.
//
// Stubs vscode.window.showInformationMessage to assert the four branches of
// ensureConsent():
//   1. already-granted (consent === true) → returns true WITHOUT prompting
//   2. Allow → returns true, persists consent=true (Global)
//   3. Decline → returns false, persists enabled=false (Global)
//   4. dismiss (undefined response) → returns false, persists enabled=false
//      (Global) — dismiss == decline per CONTEXT D-5 / Phase 7 T-07-10
//
// Plus source-grep gates:
//   - literal prompt copy from RESEARCH §1278 is byte-present
//   - ConfigurationTarget.Global (NOT Workspace)
//   - no console.* (N-08-04)
//
// Pattern: PATTERNS.md "src/mcp/consent.ts" section + the stub-showInfo
// idiom from uriHandlerBootstrapToken.test.ts:69-85.

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ensureConsent } from '../../mcp/consent.js';

const REPO_ROOT = process.cwd();
const CONSENT_TS = path.join(REPO_ROOT, 'src', 'mcp', 'consent.ts');

/**
 * Stub vscode.window.showInformationMessage for the duration of one test.
 * Returns a handle with a callCount() accessor and restore() teardown.
 *
 * Mirrors the inline pattern used in uriHandlerBootstrapToken.test.ts:69-85;
 * extracted here as a helper because the consent suite stubs in four tests.
 */
function stubShowInfo<T>(response: T): {
  callCount: () => number;
  lastArgs: () => unknown[];
  restore: () => void;
} {
  const originalShowInfo = vscode.window.showInformationMessage;
  let called = 0;
  let lastArgsCaptured: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscode.window as any).showInformationMessage = async (...args: unknown[]): Promise<T> => {
    called++;
    lastArgsCaptured = args;
    return response;
  };
  return {
    callCount: () => called,
    lastArgs: () => lastArgsCaptured,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vscode.window as any).showInformationMessage = originalShowInfo;
    },
  };
}

suite('Phase 8 — ensureConsent (first-run modal)', () => {
  let originalConsent: boolean | undefined;
  let originalEnabled: boolean | undefined;

  setup(async () => {
    const cfg = vscode.workspace.getConfiguration('versioncon.mcp');
    originalConsent = cfg.get<boolean>('consent');
    originalEnabled = cfg.get<boolean>('enabled');
    // Reset to defaults: consent=false (unprompted), enabled=true (master ON).
    await cfg.update('consent', false, vscode.ConfigurationTarget.Global);
    await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);
  });

  teardown(async () => {
    const cfg = vscode.workspace.getConfiguration('versioncon.mcp');
    await cfg.update('consent', originalConsent, vscode.ConfigurationTarget.Global);
    await cfg.update('enabled', originalEnabled, vscode.ConfigurationTarget.Global);
  });

  test('already-granted consent (consent=true) returns true without prompting', async () => {
    const cfg = vscode.workspace.getConfiguration('versioncon.mcp');
    await cfg.update('consent', true, vscode.ConfigurationTarget.Global);
    const stub = stubShowInfo<'Allow' | 'Decline' | undefined>('Decline');
    try {
      const ok = await ensureConsent();
      assert.strictEqual(ok, true, 'consent=true short-circuit must return true');
      assert.strictEqual(
        stub.callCount(),
        0,
        'showInformationMessage must NOT be called when consent already granted',
      );
    } finally {
      stub.restore();
    }
  });

  test('Allow path returns true and persists consent=true', async () => {
    const stub = stubShowInfo<'Allow'>('Allow');
    try {
      const ok = await ensureConsent();
      assert.strictEqual(ok, true);
      assert.strictEqual(stub.callCount(), 1, 'should have prompted once');
      const cfg = vscode.workspace.getConfiguration('versioncon.mcp');
      assert.strictEqual(
        cfg.get<boolean>('consent'),
        true,
        'Allow path must persist consent=true',
      );
    } finally {
      stub.restore();
    }
  });

  test('Decline path returns false and persists enabled=false', async () => {
    const stub = stubShowInfo<'Decline'>('Decline');
    try {
      const ok = await ensureConsent();
      assert.strictEqual(ok, false);
      assert.strictEqual(stub.callCount(), 1, 'should have prompted once');
      const cfg = vscode.workspace.getConfiguration('versioncon.mcp');
      assert.strictEqual(
        cfg.get<boolean>('enabled'),
        false,
        'Decline path must persist enabled=false so we do not re-prompt on next activation',
      );
    } finally {
      stub.restore();
    }
  });

  test('dismiss (undefined response) returns false and persists enabled=false', async () => {
    const stub = stubShowInfo<undefined>(undefined);
    try {
      const ok = await ensureConsent();
      assert.strictEqual(ok, false, 'dismiss == decline per CONTEXT D-5');
      assert.strictEqual(stub.callCount(), 1, 'should have prompted once');
      const cfg = vscode.workspace.getConfiguration('versioncon.mcp');
      assert.strictEqual(
        cfg.get<boolean>('enabled'),
        false,
        'dismiss path must persist enabled=false (dismiss == decline)',
      );
    } finally {
      stub.restore();
    }
  });

  test('prompt is invoked with Allow + Decline buttons (literal strings)', async () => {
    const stub = stubShowInfo<'Allow'>('Allow');
    try {
      await ensureConsent();
      const args = stub.lastArgs();
      // showInformationMessage signature: (message, options, ...items)
      // We expect at least one of the trailing args to be 'Allow' and 'Decline'.
      const allowFound = args.some((a) => a === 'Allow');
      const declineFound = args.some((a) => a === 'Decline');
      assert.ok(allowFound, `'Allow' button must be passed. Args: ${JSON.stringify(args)}`);
      assert.ok(
        declineFound,
        `'Decline' button must be passed. Args: ${JSON.stringify(args)}`,
      );
    } finally {
      stub.restore();
    }
  });
});

suite('Phase 8 — consent.ts source-grep', () => {
  test('source contains the literal prompt copy from CONTEXT D-5 / RESEARCH §1278', () => {
    const text = fs.readFileSync(CONSENT_TS, 'utf-8');
    assert.match(
      text,
      /VersionCon wants to register an MCP server with this workspace so AI agents/,
      'consent.ts must contain the literal CONSENT_PROMPT copy verbatim',
    );
    assert.match(
      text,
      /local-only and read-only/,
      'consent.ts must mention local-only and read-only in the prompt',
    );
    assert.match(text, /Claude Code/, 'consent.ts prompt must name Claude Code');
    assert.match(text, /Copilot/, 'consent.ts prompt must name Copilot');
    assert.match(text, /Cursor/, 'consent.ts prompt must name Cursor');
  });

  test('source uses ConfigurationTarget.Global (not Workspace)', () => {
    const text = fs.readFileSync(CONSENT_TS, 'utf-8');
    assert.match(
      text,
      /ConfigurationTarget\.Global/,
      'consent.ts must use ConfigurationTarget.Global per RESEARCH Open Questions item 1',
    );
    // Strip comments before scanning for the prohibited Workspace target, so
    // a JSDoc-doc reference (used to DOCUMENT the prohibition) does not trip.
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(
      stripped,
      /ConfigurationTarget\.Workspace/,
      'consent.ts must NOT use ConfigurationTarget.Workspace — grant is per-machine, not per-workspace',
    );
  });

  test('source contains Allow and Decline literal button strings', () => {
    const text = fs.readFileSync(CONSENT_TS, 'utf-8');
    assert.match(text, /['"]Allow['"]/, "consent.ts must include literal 'Allow' button");
    assert.match(text, /['"]Decline['"]/, "consent.ts must include literal 'Decline' button");
  });

  test('source exports ensureConsent function', () => {
    const text = fs.readFileSync(CONSENT_TS, 'utf-8');
    assert.match(
      text,
      /export\s+async\s+function\s+ensureConsent/,
      'consent.ts must export async function ensureConsent()',
    );
  });

  test('source calls showInformationMessage', () => {
    const text = fs.readFileSync(CONSENT_TS, 'utf-8');
    assert.match(
      text,
      /showInformationMessage/,
      'consent.ts must use vscode.window.showInformationMessage for the prompt',
    );
  });

  test('source has no console.* (N-08-04)', () => {
    const text = fs.readFileSync(CONSENT_TS, 'utf-8');
    const offenders = text.split('\n').filter((l) => /^\s*console\./.test(l));
    assert.deepStrictEqual(
      offenders,
      [],
      `N-08-04: console.* in consent.ts: ${JSON.stringify(offenders)}`,
    );
  });

  test('source does not import from src/auth/ (N-08-01)', () => {
    const text = fs.readFileSync(CONSENT_TS, 'utf-8');
    assert.doesNotMatch(
      text,
      /from\s+['"][^'"]*\/auth\//,
      'N-08-01: src/mcp/consent.ts must NOT import from src/auth/',
    );
  });
});
