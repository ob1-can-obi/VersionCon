import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';

// -----------------------------------------------------------------------------
// Phase 7 Plan 07-14 — JoinPanel bootstrap token tests
//
// MD-03 / SC-2 closure: pins the JoinPanel-side consumer contract:
//
//   - JoinPrefill struct carries bootstrapToken: string
//   - JoinState carries bootstrapToken: string with initial '' value
//   - applyPrefill copies prefill.bootstrapToken to state.bootstrapToken
//   - handleJoinConnect cloud branch constructs CloudTransport WITH the
//     bootstrap JWT (not the empty-bearer literal)
//   - Legacy cloud deep-link (bootstrapToken === '' in cloud mode) surfaces
//     an actionable error literal — never hits new CloudTransport()
//   - LAN branch is byte-identical to pre-07-14 (does NOT read bootstrapToken)
//   - N-07-14-C source-grep gate: the empty-bearer literal is GONE
// -----------------------------------------------------------------------------

suite('Phase 7 — JoinPanel bootstrap token (Plan 07-14)', () => {
  const joinPanelPath = path.resolve(process.cwd(), 'src/ui/JoinPanel.ts');

  // -------------------------------------------------------------------------
  // Source-grep — JoinPrefill struct has bootstrapToken field
  // -------------------------------------------------------------------------
  test('JoinPrefill struct has bootstrapToken: string field', () => {
    const src = fsSync.readFileSync(joinPanelPath, 'utf-8');
    // Find the JoinPrefill interface block.
    const idx = src.indexOf('export interface JoinPrefill');
    assert.ok(idx >= 0, 'JoinPrefill interface declared');
    // Take a bounded window — should be small.
    const block = src.substring(idx, idx + 1200);
    assert.match(block, /bootstrapToken\s*:\s*string/,
      'JoinPrefill must have bootstrapToken: string field');
  });

  // -------------------------------------------------------------------------
  // Source-grep — JoinState has bootstrapToken field
  // -------------------------------------------------------------------------
  test('JoinState carries bootstrapToken: string with initial empty', () => {
    const src = fsSync.readFileSync(joinPanelPath, 'utf-8');
    // JoinState interface has bootstrapToken field
    const stateIdx = src.indexOf('interface JoinState');
    assert.ok(stateIdx >= 0, 'JoinState interface declared');
    const stateBlock = src.substring(stateIdx, stateIdx + 1200);
    assert.match(stateBlock, /bootstrapToken\s*:\s*string/,
      'JoinState must have bootstrapToken: string field');
    // Initial state literal in constructor: bootstrapToken: ''
    assert.match(src, /bootstrapToken\s*:\s*['"]['"]/,
      'JoinState initial value must have bootstrapToken: \'\' (empty string)');
  });

  // -------------------------------------------------------------------------
  // Source-grep — applyPrefill copies bootstrapToken to state
  // -------------------------------------------------------------------------
  test('applyPrefill copies prefill.bootstrapToken into state.bootstrapToken', () => {
    const src = fsSync.readFileSync(joinPanelPath, 'utf-8');
    // applyPrefill body should contain this.state.bootstrapToken = prefill.bootstrapToken
    assert.match(src, /this\.state\.bootstrapToken\s*=\s*prefill\.bootstrapToken/,
      'applyPrefill must copy prefill.bootstrapToken to state.bootstrapToken');
  });

  // -------------------------------------------------------------------------
  // Source-grep — handleJoinConnect cloud branch uses bootstrapToken (not '')
  // -------------------------------------------------------------------------
  test('handleJoinConnect cloud branch passes state.bootstrapToken to CloudTransport (N-07-14-C invariant)', () => {
    const src = fsSync.readFileSync(joinPanelPath, 'utf-8');
    assert.match(src, /new CloudTransport\(relayUrl, sessionId, this\.state\.bootstrapToken\)/,
      'CloudTransport constructor MUST pass state.bootstrapToken, not empty string');
    assert.doesNotMatch(src, /new CloudTransport\(relayUrl, sessionId, ''\)/,
      'empty-bearer literal MUST be removed (N-07-14-C invariant)');
    assert.doesNotMatch(src, /new CloudTransport\(relayUrl, sessionId, ""\)/,
      'empty-bearer literal (double-quote variant) MUST be removed (N-07-14-C invariant)');
  });

  // -------------------------------------------------------------------------
  // Source-grep — legacy-deep-link error literal present
  // -------------------------------------------------------------------------
  test('handleJoinConnect surfaces the legacy-deep-link error literal when bootstrapToken is empty', () => {
    const src = fsSync.readFileSync(joinPanelPath, 'utf-8');
    assert.match(src,
      /This invite link is incomplete \(missing bootstrap token\)\. Ask the host to re-share the link\./,
      'JoinPanel must surface the exact legacy-deep-link error literal');
  });

  // -------------------------------------------------------------------------
  // Source-grep — bootstrapToken appears ≥4 times (struct + state field +
  // state init + applyPrefill copy + cloud-branch usage)
  // -------------------------------------------------------------------------
  test('bootstrapToken appears ≥4 times in JoinPanel.ts (struct + state + init + applyPrefill + cloud-branch)', () => {
    const src = fsSync.readFileSync(joinPanelPath, 'utf-8');
    const matches = (src.match(/bootstrapToken/g) || []).length;
    assert.ok(matches >= 4,
      `bootstrapToken must appear ≥4 times in JoinPanel.ts; got ${matches}`);
  });

  // -------------------------------------------------------------------------
  // Source-grep — N-07-14-C explicit cross-check
  // -------------------------------------------------------------------------
  test('N-07-14-C: zero occurrences of empty-bearer literal in JoinPanel.ts', () => {
    const src = fsSync.readFileSync(joinPanelPath, 'utf-8');
    const emptyBearerCount = (src.match(/new CloudTransport\(relayUrl, sessionId, ''\)/g) || []).length;
    assert.strictEqual(emptyBearerCount, 0,
      'N-07-14-C invariant: the empty-bearer literal MUST NOT appear anywhere in JoinPanel.ts');
  });

  // -------------------------------------------------------------------------
  // Source-grep — LAN branch does NOT read state.bootstrapToken
  // -------------------------------------------------------------------------
  test('LAN branch of handleJoinConnect does NOT read state.bootstrapToken (byte-identical to pre-07-14)', () => {
    const src = fsSync.readFileSync(joinPanelPath, 'utf-8');
    // Find the LAN branch boundary: it begins after the `if (mode === 'cloud')`
    // block returns. We use the comment marker "LAN branch — existing behavior"
    // from the source as our boundary.
    const lanBoundary = src.indexOf('LAN branch — existing behavior');
    assert.ok(lanBoundary >= 0, 'LAN branch boundary comment found');
    // Take everything from the LAN boundary until the next method.
    const lanBlock = src.substring(lanBoundary, src.indexOf('private async handleQuickConnect', lanBoundary));
    assert.ok(lanBlock.length > 0, 'LAN block extraction succeeded');
    assert.doesNotMatch(lanBlock, /state\.bootstrapToken/,
      'LAN branch MUST NOT read state.bootstrapToken (byte-identical to pre-07-14)');
    assert.doesNotMatch(lanBlock, /bootstrapToken/,
      'LAN branch MUST NOT reference bootstrapToken at all');
  });
});
