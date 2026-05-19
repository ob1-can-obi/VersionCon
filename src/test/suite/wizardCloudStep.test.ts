import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';

// -----------------------------------------------------------------------------
// Phase 7 Plan 07-05 — Wizard Cloud Step
//
// This plan inserts a new mode-select step (LAN/Cloud radio) between the
// existing wizard step 1 (sessionName + displayName) and the existing wizard
// step 2 (network configuration). When 'cloud' is selected, the network-
// configuration step swaps port + interface fields for a single Relay URL
// field with wss:// validation and a 'Test connection' button. The share
// screen for cloud sessions renders a deep-link of the locked literal shape
//   vscode://versioncon.versioncon/join?relay=<urlencoded>&session=<id>&code=<code>
// plus three separately-copyable rows (relay URL, session ID, invite code).
//
// This suite covers:
//   1. HTML/JS source-grep — radio group, relay URL input, test-connection
//      button, CONTEXT-locked copy literals.
//   2. WizardPanel.ts source-grep — widened state fields, new message types,
//      cloud-branch validation literal.
//   3. validateRelayUrl unit table — rejects ws:// / https:// / '' / 'not a
//      url'; accepts wss://foo.fly.dev (with and without trailing slash, with
//      port + path).
//   4. buildDeepLink unit — exact byte-equality assertion against the locked
//      deep-link literal.
//   5. runTestConnection happy path — stubbed fetch resolves ok=true plus
//      body.ok=true → returns { ok: true, message: '✓ Relay reachable' }.
//   6. runTestConnection failure path — stubbed fetch rejects → returns
//      { ok: false, message: '✗ Cannot reach relay' }.
//
// Phase 4.1 regression buddy: wizardValidation.test.ts. These suites run
// together; never edit one without re-verifying the other.
// -----------------------------------------------------------------------------

const wizardJsPath = path.resolve(process.cwd(), 'src/ui/webview/wizard/wizard.js');
const wizardCssPath = path.resolve(process.cwd(), 'src/ui/webview/wizard/wizard.css');
const wizardHtmlPath = path.resolve(process.cwd(), 'src/ui/webview/wizard/wizard.html');
const wizardTsPath = path.resolve(process.cwd(), 'src/ui/WizardPanel.ts');

// -----------------------------------------------------------------------------
// Pure helpers embedded in the test file for direct unit-testing.
//
// The production copies live inside wizard.js (a webview-only JS file that
// cannot be imported from Node tests because it calls `acquireVsCodeApi()` at
// top-level). Embedding the same bodies here lets the unit table run; the
// suite ALSO source-greps wizard.js to assert the equivalent logic ships in
// the production file. Both must stay in lockstep.
// -----------------------------------------------------------------------------

function validateRelayUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url.startsWith('wss://')) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function buildDeepLink(
  relayUrl: string,
  sessionId: string,
  inviteCode: string,
): string {
  return (
    'vscode://versioncon.versioncon/join?relay=' +
    encodeURIComponent(relayUrl) +
    '&session=' +
    sessionId +
    '&code=' +
    inviteCode
  );
}

type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

async function runTestConnection(
  relayUrl: string,
  fetchImpl: FetchLike,
): Promise<{ ok: boolean; sessions?: number; message: string }> {
  try {
    const url = relayUrl.replace('wss://', 'https://') + '/healthz';
    const res = await fetchImpl(url);
    if (!res || !res.ok) return { ok: false, message: '✗ Cannot reach relay' };
    const body = (await res.json()) as { ok?: boolean; sessions?: number };
    if (body && body.ok === true) {
      return {
        ok: true,
        sessions: body.sessions,
        message: '✓ Relay reachable',
      };
    }
    return { ok: false, message: '✗ Cannot reach relay' };
  } catch {
    return { ok: false, message: '✗ Cannot reach relay' };
  }
}

// -----------------------------------------------------------------------------
// Suite
// -----------------------------------------------------------------------------

suite('Phase 7 — wizard cloud step', () => {
  // ---------------------------------------------------------------------------
  // (1) HTML/JS source-grep — element presence + CONTEXT-locked copy
  // ---------------------------------------------------------------------------

  test('wizard.js declares a connection-mode radio group with lan and cloud options', () => {
    assert.ok(
      fsSync.existsSync(wizardJsPath),
      `wizard.js not found at ${wizardJsPath}`,
    );
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');

    assert.match(
      src,
      /name="connection-mode"[^>]*value="lan"|value="lan"[^>]*name="connection-mode"/,
      'LAN radio option present (name="connection-mode" value="lan")',
    );
    assert.match(
      src,
      /name="connection-mode"[^>]*value="cloud"|value="cloud"[^>]*name="connection-mode"/,
      'Cloud radio option present (name="connection-mode" value="cloud")',
    );
  });

  test('wizard.js declares the relay-url input with the locked wss:// placeholder', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    assert.match(
      src,
      /id="relay-url"/,
      'relay URL input has id="relay-url"',
    );
    assert.match(
      src,
      /placeholder="wss:\/\/your-relay\.fly\.dev"/,
      'relay URL input has the locked placeholder',
    );
  });

  test('wizard.js declares the test-connection button with data-test attribute', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    assert.match(
      src,
      /data-test="test-connection"/,
      'test-connection button has data-test="test-connection"',
    );
  });

  test('wizard.js carries the CONTEXT-locked mode-select copy verbatim', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    assert.match(
      src,
      /Where will your team connect from\?/,
      'step heading present',
    );
    assert.match(
      src,
      /Same network \(LAN\)/,
      'LAN radio label present',
    );
    assert.match(
      src,
      /Fastest\. No internet or relay needed\./,
      'LAN radio description present',
    );
    assert.match(
      src,
      /Different networks \(Cloud\)/,
      'Cloud radio label present',
    );
    assert.match(
      src,
      /Connects via a relay server you deploy\./,
      'Cloud radio description present',
    );
  });

  test('wizard.js carries the CONTEXT-locked cloud-branch help link copy', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    assert.match(
      src,
      /Don't have a relay\? Deploy one →/,
      'help link copy present (verbatim)',
    );
  });

  test('wizard.js performs fetch on /healthz with the wss→https transform', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    assert.match(
      src,
      /replace\(['"]wss:\/\/['"],\s*['"]https:\/\/['"]\)/,
      'wss→https URL transform present for /healthz fetch',
    );
    assert.match(
      src,
      /\/healthz/,
      '/healthz endpoint referenced',
    );
  });

  test('wizard.js renders the canonical deep-link literal', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    assert.match(
      src,
      /vscode:\/\/versioncon\.versioncon\/join/,
      'canonical deep-link prefix present',
    );
  });

  test('wizard.html template is preserved (no new script tags)', () => {
    const src = fsSync.readFileSync(wizardHtmlPath, 'utf-8');
    assert.match(src, /%%CSP%%/, 'CSP placeholder preserved');
    assert.match(src, /%%NONCE%%/, 'NONCE placeholder preserved');
    assert.match(src, /%%CSS_URI%%/, 'CSS_URI placeholder preserved');
    assert.match(src, /%%JS_URI%%/, 'JS_URI placeholder preserved');
  });

  test('wizard.css declares additive styles with theme variables only (no hex)', () => {
    const src = fsSync.readFileSync(wizardCssPath, 'utf-8');
    assert.match(
      src,
      /\.mode-select-card/,
      '.mode-select-card style block present',
    );
    assert.match(
      src,
      /\.test-connection-result/,
      '.test-connection-result style block present',
    );
    assert.match(
      src,
      /\.deep-link-box/,
      '.deep-link-box style block present',
    );
    // Find a substring slice from .mode-select-card onward and verify no hex
    // codes appear there (Phase 7 UI-SPEC §Color: theme vars only).
    const additiveStart = src.indexOf('.mode-select-card');
    assert.ok(additiveStart >= 0, 'additive styles begin with .mode-select-card');
    const additiveSrc = src.slice(additiveStart);
    assert.doesNotMatch(
      additiveSrc,
      /#[0-9a-fA-F]{3,8}\b/,
      'no hex color codes in the new additive CSS block',
    );
  });

  // ---------------------------------------------------------------------------
  // (2) WizardPanel.ts source-grep — server-side state + validation
  // ---------------------------------------------------------------------------

  test('WizardPanel.ts carries the cloud-branch validation error literal', () => {
    assert.ok(
      fsSync.existsSync(wizardTsPath),
      `WizardPanel.ts not found at ${wizardTsPath}`,
    );
    const src = fsSync.readFileSync(wizardTsPath, 'utf-8');
    assert.match(
      src,
      /Must be a wss:\/\/ URL/,
      'cloud-branch validation error literal present',
    );
  });

  test('WizardPanel.ts widens WizardState with mode + relayUrl fields', () => {
    const src = fsSync.readFileSync(wizardTsPath, 'utf-8');
    assert.match(
      src,
      /\bmode:\s*['"]lan['"]\s*\|\s*['"]cloud['"]/,
      'mode field declared as "lan" | "cloud"',
    );
    assert.match(
      src,
      /\brelayUrl:\s*string/,
      'relayUrl field declared',
    );
    assert.match(
      src,
      /\brelayUrlReachable:/,
      'relayUrlReachable field declared',
    );
  });

  test('WizardPanel.ts handles the new wizard message types', () => {
    const src = fsSync.readFileSync(wizardTsPath, 'utf-8');
    assert.match(
      src,
      /'wizard-set-mode'/,
      "'wizard-set-mode' message type handled",
    );
    assert.match(
      src,
      /'wizard-test-connection-result'/,
      "'wizard-test-connection-result' message type handled",
    );
  });

  // ---------------------------------------------------------------------------
  // (3) validateRelayUrl unit table
  // ---------------------------------------------------------------------------

  test('validateRelayUrl rejects ws:// URLs', () => {
    assert.strictEqual(validateRelayUrl('ws://foo'), false);
  });

  test('validateRelayUrl rejects https:// URLs', () => {
    assert.strictEqual(validateRelayUrl('https://foo'), false);
  });

  test('validateRelayUrl rejects empty strings', () => {
    assert.strictEqual(validateRelayUrl(''), false);
  });

  test('validateRelayUrl rejects unparseable input', () => {
    assert.strictEqual(validateRelayUrl('not a url'), false);
  });

  test('validateRelayUrl accepts plain wss://host', () => {
    assert.strictEqual(validateRelayUrl('wss://foo.fly.dev'), true);
  });

  test('validateRelayUrl accepts wss://host with trailing slash', () => {
    assert.strictEqual(validateRelayUrl('wss://foo.fly.dev/'), true);
  });

  test('validateRelayUrl accepts wss://host:port/path', () => {
    assert.strictEqual(
      validateRelayUrl('wss://foo.fly.dev:8443/path'),
      true,
    );
  });

  // Cross-check: wizard.js ships an equivalent validator (source-grep gate)
  test('wizard.js ships an equivalent validateRelayUrl helper', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    assert.match(
      src,
      /function\s+validateRelayUrl\b/,
      'validateRelayUrl function declared in wizard.js',
    );
    assert.match(
      src,
      /startsWith\(['"]wss:\/\/['"]\)/,
      'wss:// prefix check present',
    );
    assert.match(
      src,
      /new URL\(/,
      'URL parse fallback present',
    );
  });

  // ---------------------------------------------------------------------------
  // (4) buildDeepLink unit — exact byte equality
  // ---------------------------------------------------------------------------

  test('buildDeepLink returns the exact canonical literal for a known input', () => {
    const got = buildDeepLink('wss://r.fly.dev', 'vc-7f3a92', 'K8M3PQ');
    assert.strictEqual(
      got,
      'vscode://versioncon.versioncon/join?relay=wss%3A%2F%2Fr.fly.dev&session=vc-7f3a92&code=K8M3PQ',
    );
  });

  test('buildDeepLink URL-encodes the relay but not session or code', () => {
    const got = buildDeepLink(
      'wss://relay.foo.fly.dev',
      'vc-abc',
      'CODE99',
    );
    assert.strictEqual(
      got,
      'vscode://versioncon.versioncon/join?relay=wss%3A%2F%2Frelay.foo.fly.dev&session=vc-abc&code=CODE99',
    );
  });

  // Cross-check: wizard.js ships an equivalent helper
  test('wizard.js ships an equivalent buildDeepLink helper', () => {
    const src = fsSync.readFileSync(wizardJsPath, 'utf-8');
    assert.match(
      src,
      /function\s+buildDeepLink\b/,
      'buildDeepLink function declared in wizard.js',
    );
    assert.match(
      src,
      /encodeURIComponent\(/,
      'encodeURIComponent used on relay',
    );
  });

  // ---------------------------------------------------------------------------
  // (5) runTestConnection — happy path
  // ---------------------------------------------------------------------------

  test('runTestConnection returns success when /healthz responds ok=true', async () => {
    const stubFetch: FetchLike = async (url: string) => {
      assert.strictEqual(
        url,
        'https://r.fly.dev/healthz',
        'fetch is called against the https /healthz transform',
      );
      return {
        ok: true,
        json: async () => ({ ok: true, sessions: 0 }),
      };
    };
    const result = await runTestConnection('wss://r.fly.dev', stubFetch);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.message, '✓ Relay reachable');
    assert.strictEqual(result.sessions, 0);
  });

  // ---------------------------------------------------------------------------
  // (6) runTestConnection — failure path
  // ---------------------------------------------------------------------------

  test('runTestConnection returns failure when fetch rejects', async () => {
    const stubFetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await runTestConnection('wss://r.fly.dev', stubFetch);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.message, '✗ Cannot reach relay');
  });

  test('runTestConnection returns failure when /healthz response is not ok', async () => {
    const stubFetch: FetchLike = async () => ({
      ok: false,
      json: async () => ({}),
    });
    const result = await runTestConnection('wss://r.fly.dev', stubFetch);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.message, '✗ Cannot reach relay');
  });

  test('runTestConnection returns failure when body.ok is not true', async () => {
    const stubFetch: FetchLike = async () => ({
      ok: true,
      json: async () => ({ ok: false }),
    });
    const result = await runTestConnection('wss://r.fly.dev', stubFetch);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.message, '✗ Cannot reach relay');
  });
});

// -----------------------------------------------------------------------------
// Phase 4.1 regression buddy (this suite + wizardValidation.test.ts run
// together — never edit one without re-verifying the other). The Phase 4.1
// invariants (displayName resolution chain, control-char regex, paste handler,
// updateNextDisabled short-circuit) are NOT duplicated here — they are
// asserted in wizardValidation.test.ts. The verify command for Plan 07-05
// runs both suites in the same vscode-test invocation, so any regression in
// the Phase 4.1 contract surfaces immediately.
// -----------------------------------------------------------------------------
