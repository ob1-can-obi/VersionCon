// Phase 5 Wave 4 (Plan 05-04) — canary worker for AstAnalyzer path-validation
// tests. If this stub EVER receives a message, the test must fail — its only
// purpose is to write a sentinel file proving the analyzer did fork it
// despite all paths in the payload being unsafe (which would be a bug).
//
// Set CANARY_SENTINEL_PATH in the fork's env; the canary writes that path
// on the first message it receives. Tests check existence after the call.
'use strict';
const fs = require('node:fs');
const sentinel = process.env.CANARY_SENTINEL_PATH;

process.on('message', () => {
  if (sentinel) {
    try {
      fs.writeFileSync(sentinel, '1');
    } catch {
      // ignore — the test will see the absence
    }
  }
});

process.on('disconnect', () => process.exit(0));
