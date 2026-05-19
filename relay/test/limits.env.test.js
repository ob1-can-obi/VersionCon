// relay/test/limits.env.test.js
//
// Plan 07-10 — env-var override coverage for the relay defensive-minimum module.
//
// CONTRACT: limits.ts reads its caps from process.env at module-load time
// (top-level `parseEnvInt(key, fallback)` calls). To exercise the override
// reliably, we set process.env BEFORE any import — that's why this test lives
// in its OWN file. The main `limits.test.js` (no env-var overrides) imports
// the module at the default values; if we tried to override in the same
// file, the module would already be cached at the defaults.
//
// Single test: VERSIONCON_MAX_CONNECTIONS_PER_MIN_PER_IP=5 makes the 6th
// connection from a given IP fail. This proves the env-var schema is wired.

// MUST be set BEFORE the dynamic import below — Node caches the module the
// first time any importer touches it, and limits.ts reads env at that moment.
process.env.VERSIONCON_MAX_CONNECTIONS_PER_MIN_PER_IP = '5';

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

test('env-var override: VERSIONCON_MAX_CONNECTIONS_PER_MIN_PER_IP=5 makes 6th connection fail', async () => {
  // Dynamic import so the env-var assignment above runs first.
  const { checkConnection, __resetForTesting } = await import('../dist/limits.js');
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  __resetForTesting();
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal(checkConnection('7.7.7.7'), true, `connection ${i + 1} should be allowed`);
    }
    assert.equal(checkConnection('7.7.7.7'), false, '6th connection must be rejected under override');
  } finally {
    __resetForTesting();
    mock.timers.reset();
  }
});
