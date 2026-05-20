// -----------------------------------------------------------------------------
// Phase 7 Plan 07-13 — gap-closure (BLOCKER 2 / MD-03 / Option A) — Task 3.
//
// WizardPanel + wizard.js plumb the bootstrap JWT into the share-screen
// deep-link via a new `bt` query parameter.
//
// Pipeline:
//   1. SessionHostFactory.createCloud mints the bootstrap JWT and attaches it
//      to the SessionHost (Task 2 — already landed).
//   2. WizardPanel.handleWizardComplete cloud branch reads
//      host.getBootstrapToken() into WizardState.bootstrapToken.
//   3. WizardPanel.sendStateUpdate posts the full state (including the new
//      bootstrapToken field) to the webview.
//   4. wizard.js renders the share-screen via buildDeepLink (extended to
//      4-arg signature); appends `&bt=<URLencoded jwt>` when bootstrapToken
//      is non-empty. When omitted or empty (LAN mode + legacy 3-arg callers),
//      the deep-link is byte-identical to today's 3-arg output.
//
// Test file is webview-pure where possible (buildDeepLink is embedded for
// direct unit testing — mirrors wizardCloudStep.test.ts pattern). Tests
// 1-2 (WizardPanel state pickup) are source-grep gates over WizardPanel.ts
// to keep the assertion below the cost of a full vscode-test harness.
// -----------------------------------------------------------------------------

import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';

const wizardJsPath = path.resolve(process.cwd(), 'src/ui/webview/wizard/wizard.js');
const wizardTsPath = path.resolve(process.cwd(), 'src/ui/WizardPanel.ts');

// ---------------------------------------------------------------------------
// Embedded helper — mirrors the production buildDeepLink in wizard.js.
//
// The production helper lives in the webview-only wizard.js file (calls
// acquireVsCodeApi at module top level, cannot be imported from Node). This
// test file embeds the SAME body for direct unit testing AND source-greps
// wizard.js to assert the production helper ships with equivalent logic. The
// two MUST stay in lockstep — wizardCloudStep.test.ts uses the same pattern.
// ---------------------------------------------------------------------------

function buildDeepLink(
  relayUrl: string,
  sessionId: string,
  inviteCode: string,
  bootstrapToken?: string,
): string {
  const base =
    'vscode://versioncon.versioncon/join?relay=' +
    encodeURIComponent(relayUrl) +
    '&session=' +
    sessionId +
    '&code=' +
    inviteCode;
  if (bootstrapToken && bootstrapToken.length > 0) {
    return base + '&bt=' + encodeURIComponent(bootstrapToken);
  }
  return base;
}

// ---------------------------------------------------------------------------
// Suite — wizard deep-link bootstrap (MD-03 Option A — Task 3 of 3)
// ---------------------------------------------------------------------------

suite('Phase 7 — wizard deep-link bootstrap (MD-03 Option A)', () => {
  // -----------------------------------------------------------------------
  // (A) Unit table — buildDeepLink 4-arg behavior
  // -----------------------------------------------------------------------

  test('buildDeepLink with bootstrapToken appends &bt=<URLencoded jwt>', () => {
    const got = buildDeepLink(
      'wss://r.fly.dev',
      'vc-abc',
      'XKCDPQ',
      'eyJ-bootstrap-jwt',
    );
    assert.strictEqual(
      got,
      'vscode://versioncon.versioncon/join?relay=wss%3A%2F%2Fr.fly.dev&session=vc-abc&code=XKCDPQ&bt=eyJ-bootstrap-jwt',
    );
  });

  test('buildDeepLink without bootstrapToken (3-arg) returns byte-identical-to-today output', () => {
    // LAN-mode regression: 3-arg call must produce the same string the Phase
    // 7 plan 07-05 deep-link spec pinned. NO &bt= suffix.
    const got = buildDeepLink('wss://r.fly.dev', 'vc-abc', 'XKCDPQ');
    assert.strictEqual(
      got,
      'vscode://versioncon.versioncon/join?relay=wss%3A%2F%2Fr.fly.dev&session=vc-abc&code=XKCDPQ',
    );
  });

  test('buildDeepLink with empty-string bootstrapToken omits &bt= (LAN regression)', () => {
    // 4-arg call with empty bootstrap — must produce the same string as the
    // 3-arg call. Defends against LAN-mode WizardState carrying
    // bootstrapToken: '' through to the webview.
    const got = buildDeepLink('wss://r.fly.dev', 'vc-abc', 'XKCDPQ', '');
    assert.strictEqual(
      got,
      'vscode://versioncon.versioncon/join?relay=wss%3A%2F%2Fr.fly.dev&session=vc-abc&code=XKCDPQ',
    );
  });

  test('buildDeepLink URL-encodes special chars in the bootstrap JWT', () => {
    // Real JWTs can contain `+`, `/`, `=` (base64-padded) in their middle
    // segment. encodeURIComponent must escape these so the deep-link parses
    // unambiguously on the joiner side.
    const got = buildDeepLink(
      'wss://r.fly.dev',
      'vc-abc',
      'XKCDPQ',
      'jwt+with/special=chars',
    );
    assert.match(
      got,
      /&bt=jwt%2Bwith%2Fspecial%3Dchars$/,
      'bt= value must URL-encode +, /, =',
    );
  });

  // -----------------------------------------------------------------------
  // (B) Source-grep gates — wizard.js production helper matches embedded
  // -----------------------------------------------------------------------

  test('wizard.js buildDeepLink accepts a 4th bootstrapToken argument', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    // Accept either an explicit "bootstrapToken" 4th-arg name OR an equivalent
    // shape that takes ≥4 positional args. The plan locks the literal name.
    assert.match(
      src,
      /function\s+buildDeepLink\s*\(\s*relayUrl\s*,\s*sessionId\s*,\s*inviteCode\s*,\s*bootstrapToken\s*\)/,
      'wizard.js buildDeepLink must accept 4-arg signature (relayUrl, sessionId, inviteCode, bootstrapToken)',
    );
  });

  test('wizard.js buildDeepLink appends &bt= when bootstrapToken is non-empty', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    assert.match(
      src,
      /'&bt='/,
      "wizard.js must contain the literal '&bt=' (deep-link bootstrap-token query key)",
    );
  });

  test('wizard.js buildDeepLink URL-encodes the bootstrapToken via encodeURIComponent', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    assert.match(
      src,
      /encodeURIComponent\(bootstrapToken\)/,
      'wizard.js must call encodeURIComponent on the bootstrapToken',
    );
  });

  test('wizard.js share-screen render call site passes state.bootstrapToken to buildDeepLink', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    // The Cloud share-screen render block calls buildDeepLink — it must pass
    // a 4th arg derived from state.bootstrapToken. Both renderShareScreenCloud
    // and the copy-deep-link click handler are call sites.
    const callSiteMatches = src.match(
      /buildDeepLink\([^)]*state\.bootstrapToken/g,
    );
    assert.ok(
      callSiteMatches && callSiteMatches.length >= 2,
      `wizard.js must have ≥2 call sites passing state.bootstrapToken to buildDeepLink (got ${callSiteMatches?.length ?? 0})`,
    );
  });

  // -----------------------------------------------------------------------
  // (C) WizardPanel.ts source-grep — state field + pickup wiring
  // -----------------------------------------------------------------------

  test('WizardPanel.ts WizardState includes bootstrapToken: string field', () => {
    const src = fsSync.readFileSync(wizardTsPath, 'utf-8');
    assert.match(
      src,
      /\bbootstrapToken:\s*string\b/,
      'WizardState must declare bootstrapToken: string',
    );
  });

  test('WizardPanel.ts initial state includes bootstrapToken: empty string', () => {
    const src = fsSync.readFileSync(wizardTsPath, 'utf-8');
    assert.match(
      src,
      /bootstrapToken:\s*['"]['"]/,
      "initialState literal must set bootstrapToken: '' (empty string)",
    );
  });

  test('WizardPanel.ts cloud branch calls host.getBootstrapToken() to populate state', () => {
    const src = fsSync.readFileSync(wizardTsPath, 'utf-8');
    assert.match(
      src,
      /getBootstrapToken\(\)/,
      'WizardPanel.ts must invoke host.getBootstrapToken() to populate state',
    );
  });

  test('WizardPanel.ts assigns the bootstrap token onto this.state.bootstrapToken', () => {
    const src = fsSync.readFileSync(wizardTsPath, 'utf-8');
    assert.match(
      src,
      /this\.state\.bootstrapToken\s*=/,
      'WizardPanel.ts must assign to this.state.bootstrapToken',
    );
  });

  // -----------------------------------------------------------------------
  // (D) Globalthis helpers export — buildDeepLink reachable via test seam
  // -----------------------------------------------------------------------

  test('wizard.js still exposes buildDeepLink via __versionConWizardHelpers', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    assert.match(
      src,
      /__versionConWizardHelpers\s*=\s*\{[\s\S]*buildDeepLink/,
      'wizard.js must still expose buildDeepLink on the helpers test seam',
    );
  });
});
