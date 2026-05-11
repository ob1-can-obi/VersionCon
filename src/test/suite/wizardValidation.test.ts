import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';

// -----------------------------------------------------------------------------
// Phase 4.1 UAT Test 3 closure — displayName validation reachability
//
// Background: src/ui/WizardPanel.ts handleWizardNext already validates displayName
// for empty, >64, and control-char cases (lines 386-450). Phase 4.1 multi-window
// UAT (Test 3 in 04.1-HUMAN-UAT.md) flagged that two of those error paths were
// unreachable from the live UI because:
//   (a) wizard.js had a hard maxlength="64" on the displayName <input>, blocking
//       typing past 64 chars.
//   (b) <input type="text"> in webviews silently drops control characters on
//       paste before they reach .value.
//
// This suite pins the fix: maxlength relaxed to 256 (defense-in-depth ceiling
// against pathological pastes) and a paste handler that reads clipboardData
// directly so control chars survive into postMessage.
//
// Pattern: source-grep tests on wizard.js + WizardPanel.ts. Matches the
// convention established in src/test/suite/host.test.ts:2037 (Phase 4.1
// cross-cutting regression, Test 1) — per STATE.md '[Plan 04-11]: UI-SPEC
// literal verification via source-grep tests'.
// -----------------------------------------------------------------------------

suite('Phase 4.1 UAT Test 3 — displayName validation reachability', () => {
  const wizardJsPath = path.resolve(process.cwd(), 'src/ui/webview/wizard/wizard.js');
  const wizardTsPath = path.resolve(process.cwd(), 'src/ui/WizardPanel.ts');

  test('wizard.js relaxes maxlength on #display-name so >64 validation is reachable', () => {
    assert.ok(fsSync.existsSync(wizardJsPath), `wizard.js not found at ${wizardJsPath}`);
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');

    assert.match(src, /id="display-name"[\s\S]{0,200}maxlength="256"/,
      'displayName input has relaxed maxlength="256"');
    assert.doesNotMatch(src, /id="display-name"[\s\S]{0,200}maxlength="64"/,
      'hard maxlength="64" on displayName input has been removed (UAT Test 3 fix)');
    assert.match(src, /id="session-name"[\s\S]{0,200}maxlength="100"/,
      'sessionName input maxlength unchanged at 100');

    const cap256Hits = (src.match(/maxlength="256"/g) || []).length;
    assert.strictEqual(cap256Hits, 1, 'maxlength="256" appears exactly once (only on displayName)');
  });

  test('wizard.js paste handler preserves control characters', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    assert.match(src, /addEventListener\(['"]paste['"]/, 'paste event listener registered');
    assert.match(src, /clipboardData/, 'reads from event.clipboardData (bypasses default <input> filter)');
    assert.match(src, /getData\(['"]text['"]\)/, 'reads plain text from clipboard');
    assert.match(src, /preventDefault/, 'suppresses the default paste so control chars are not stripped');
    assert.match(src, /updateNextDisabled\(\)/,
      'paste handler re-evaluates Next button state after splice');
  });

  test('WizardPanel.ts displayName error literals remain present (no regression)', () => {
    assert.ok(fsSync.existsSync(wizardTsPath), `WizardPanel.ts not found at ${wizardTsPath}`);
    const src = fsSync.readFileSync(wizardTsPath, 'utf-8');

    assert.match(src, /Display name is required\./, 'empty-displayName literal present');
    assert.match(src, /Display name must be 64 characters or fewer\./, '>64 literal present');
    assert.match(src, /Display name cannot contain control characters\./, 'control-char literal present');
    assert.match(src, /displayName\.length > 64/, '>64 guard present');
    assert.match(src, /\/\[\\u0000-\\u001F\\u007F\]\//,
      'control-char regex in unambiguous escape form (pins Plan 04.1-03 decision)');
  });

  test('wizard.js step-1 postMessage payload shape unchanged', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    assert.match(src, /type:\s*['"]wizard-next['"]/, 'wire frame type unchanged');
    assert.match(src, /payload:\s*\{\s*sessionName,\s*displayName\s*\}/,
      'payload shape { sessionName, displayName } preserved so handleWizardNext case 1 still receives displayName');
  });
});
