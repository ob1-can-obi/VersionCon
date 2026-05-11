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

// -----------------------------------------------------------------------------
// Backlog 999.2 closure — wizard step-2 Next button must stay enabled.
//
// Surfaced during Phase 4.1 UAT 2026-05-10 and again during Phase 4 multi-window
// UAT 2026-05-10. Root cause: attachListeners() called updateNextDisabled()
// unconditionally after every render. On step 2 the step-1 inputs (#session-name,
// #display-name) don't exist, so nameOk/dispOk both evaluated false, and the
// shared #btn-next element got its `disabled` attribute set to true on every
// step beyond 1. Fix: short-circuit updateNextDisabled() when nameInput or
// dispInput is null (i.e. not on step 1), leaving the rendered HTML's
// already-enabled Next button untouched on later steps.
// -----------------------------------------------------------------------------
suite('Backlog 999.2 — wizard step-2 Next button stays enabled', () => {
  const wizardJsPath = path.resolve(process.cwd(), 'src/ui/webview/wizard/wizard.js');

  test('updateNextDisabled short-circuits when step-1 inputs are absent', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    assert.match(src, /function updateNextDisabled\(\)\s*\{[\s\S]{0,600}?if\s*\(\s*!nameInput\s*\|\|\s*!dispInput\s*\)\s*return;/,
      'updateNextDisabled() returns early when step-1 inputs are missing (no false disabling on step 2+)');
  });

  test('step-2 Next button rendered without disabled attribute', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    // Locate renderStep2 body and assert the Next button literal does NOT carry a disabled attribute.
    const step2Match = src.match(/function renderStep2\(state\)\s*\{[\s\S]*?return `([\s\S]*?)`;\s*\}/);
    assert.ok(step2Match, 'renderStep2 template literal extractable');
    const step2Body = step2Match[1];
    assert.match(step2Body, /id="btn-next"[^>]*>Next</, 'step 2 renders Next button');
    assert.doesNotMatch(step2Body, /id="btn-next"[^>]*\bdisabled\b/,
      'step 2 Next button has no disabled attribute at render time');
  });

  test('step-1 Next-button gating logic still present (no regression)', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    assert.match(src, /const nameOk = !!nameInput\.value\.trim\(\);/,
      'step-1 sessionName non-empty check preserved');
    assert.match(src, /const dispOk = !!dispInput\.value\.trim\(\);/,
      'step-1 displayName non-empty check preserved');
    assert.match(src, /btn\.disabled = !\(nameOk && dispOk\);/,
      'step-1 Next button still gated on both fields being non-empty');
  });
});
