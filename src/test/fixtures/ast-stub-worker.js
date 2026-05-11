// Phase 5 Wave 4 (Plan 05-04) — deterministic AST stub worker for AstAnalyzer
// unit tests. Loaded directly via child_process.fork(); plain JS (no .ts) so
// tsc / esbuild do not have to compile a test fixture into dist/.
//
// STUB_MODE env vars (set per-test via fork's `env` option):
//   - 'echo'          (default) — reply ok with a synthetic AnalysisResult.
//   - 'never-reply'   — receive message, do nothing. Tests timeout (T-05-02).
//   - 'crash-once'    — first message GLOBALLY (across forks) crashes; subsequent
//                       fork instances reply normally. Tracked via the sentinel
//                       file at STUB_CRASH_FLAG (must be writable). Tests verify
//                       worker re-fork recovery (T-05-01).
//   - 'crash-always'  — every message crashes. Tests circuit (T-05-01).
//   - 'echo-with-delay' — reply ok after STUB_DELAY_MS (default 0).
//
// Replies preserve `requestId` so AstAnalyzer's Map-based dispatch works.
'use strict';

const fs = require('node:fs');
const mode = process.env.STUB_MODE || 'echo';
const delayMs = parseInt(process.env.STUB_DELAY_MS || '0', 10);
const crashFlag = process.env.STUB_CRASH_FLAG;

let callCount = 0;

process.on('message', (msg) => {
  callCount += 1;
  if (mode === 'never-reply') return;
  if (mode === 'crash-once') {
    // Global across forks: crash if the sentinel file does NOT exist yet, then
    // create it so subsequent forks skip the crash path.
    if (crashFlag) {
      let alreadyCrashed = false;
      try {
        alreadyCrashed = fs.existsSync(crashFlag);
      } catch {
        // ignore
      }
      if (!alreadyCrashed) {
        try { fs.writeFileSync(crashFlag, '1'); } catch { /* ignore */ }
        process.exit(1);
        return;
      }
    } else {
      // No flag wired → fall back to per-process crash-on-first-call.
      if (callCount === 1) {
        process.exit(1);
        return;
      }
    }
  }
  if (mode === 'crash-always') {
    process.exit(1);
    return;
  }
  const send = () => {
    if (!process.send) return;
    process.send({
      requestId: msg && msg.requestId,
      ok: true,
      result: {
        affectedSymbols: [
          {
            name: 'stub-' + callCount,
            kind: 'function',
            changedIn: 'stub.ts',
            callers: [
              {
                memberId: 'm1',
                displayName: 'Member1',
                file: 'consumer.ts',
                line: 1,
              },
            ],
          },
        ],
        perMember: {},
        unsupportedLanguages: [],
      },
    });
  };
  if (delayMs > 0) setTimeout(send, delayMs);
  else send();
});

process.on('disconnect', () => process.exit(0));
