import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';

// -----------------------------------------------------------------------------
// Phase 7 — transport seam (D-05)
//
// Source-grep gate enforcing the architectural seam from 07-CONTEXT.md D-05:
// "Transport abstraction" — `new WebSocket(` / `new WebSocketServer(` are
// quarantined inside src/network/LanTransport.ts (and, when Wave 2 lands,
// src/network/CloudTransport.ts). SessionHost.ts and SessionClient.ts become
// transport-agnostic: they import the Transport interfaces, NOT the `ws`
// library directly.
//
// All assertions MUST fail BEFORE the refactor (Task 1 RED state) and pass
// AFTER (Task 2 GREEN state). The full existing test suite stays green —
// the refactor is byte-identical, only Transport.ts / LanTransport.ts /
// transportSeam.test.ts are net-new.
//
// Pattern: source-grep tests in the style of
// src/test/suite/wizardValidation.test.ts (Phase 4.1 Test 3) — read the file,
// assert.match / assert.doesNotMatch against literal regexes.
// -----------------------------------------------------------------------------

suite('Phase 7 — transport seam (D-05)', () => {
  const sessionHostPath = path.resolve(process.cwd(), 'src/host/SessionHost.ts');
  const sessionClientPath = path.resolve(process.cwd(), 'src/client/SessionClient.ts');
  const lanTransportPath = path.resolve(process.cwd(), 'src/network/LanTransport.ts');
  const transportPath = path.resolve(process.cwd(), 'src/network/Transport.ts');

  test('Test A — SessionHost.ts no longer constructs WebSocketServer', () => {
    const src = fsSync.readFileSync(sessionHostPath, 'utf-8');
    assert.doesNotMatch(
      src,
      /new WebSocketServer\(/,
      'SessionHost.ts MUST NOT construct WebSocketServer after Phase 7 refactor (D-05). Move the construct to src/network/LanTransport.ts.',
    );
    assert.doesNotMatch(
      src,
      /from ['"]ws['"]/,
      'SessionHost.ts MUST NOT import from "ws" after Phase 7 refactor (D-05). All ws references move to LanTransport.ts.',
    );
  });

  test('Test B — SessionClient.ts no longer constructs WebSocket', () => {
    const src = fsSync.readFileSync(sessionClientPath, 'utf-8');
    assert.doesNotMatch(
      src,
      /new WebSocket\(`ws:\/\//,
      'SessionClient.ts MUST NOT construct `new WebSocket(`ws://...`)` after Phase 7 refactor (D-05). Move to LanClientTransport in src/network/LanTransport.ts.',
    );
    assert.doesNotMatch(
      src,
      /from ['"]ws['"]/,
      'SessionClient.ts MUST NOT import from "ws" after Phase 7 refactor (D-05).',
    );
  });

  test('Test C — LanTransport.ts owns the ws constructs', () => {
    const src = fsSync.readFileSync(lanTransportPath, 'utf-8');
    assert.match(
      src,
      /new WebSocketServer\(/,
      'LanTransport.ts MUST construct WebSocketServer (host-side seam).',
    );
    assert.match(
      src,
      /new WebSocket\(/,
      'LanTransport.ts MUST construct WebSocket (client-side seam).',
    );
  });

  test('Test D — LanTransport.ts does not re-implement reconnect backoff', () => {
    const src = fsSync.readFileSync(lanTransportPath, 'utf-8');
    assert.doesNotMatch(
      src,
      /getReconnectDelay\(/,
      'LanTransport.ts MUST NOT call getReconnectDelay — backoff lives in SessionClient via ReconnectManager (PATTERNS.md Pattern C).',
    );
    assert.doesNotMatch(
      src,
      /Math\.pow\(2,\s*\w+\)/,
      'LanTransport.ts MUST NOT re-implement exponential backoff — reuse ReconnectManager from heartbeat.ts.',
    );
  });

  test('Test E — LanTransport.ts does not use CloudEnvelope', () => {
    const src = fsSync.readFileSync(lanTransportPath, 'utf-8');
    assert.doesNotMatch(
      src,
      /CloudEnvelope/,
      'LanTransport.ts MUST NOT reference CloudEnvelope — LAN keeps raw protocol.ts messages on the wire (CONTEXT.md D-06 line 111).',
    );
  });

  test('Test F — Transport.ts exports HostTransport and ClientTransport interfaces', () => {
    const src = fsSync.readFileSync(transportPath, 'utf-8');
    assert.match(
      src,
      /export interface HostTransport/,
      'Transport.ts MUST export HostTransport interface.',
    );
    assert.match(
      src,
      /export interface ClientTransport/,
      'Transport.ts MUST export ClientTransport interface.',
    );
  });
});
