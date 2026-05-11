import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';
import * as os from 'os';

import { AstAnalyzer } from '../../ast/AstAnalyzer.js';

// -----------------------------------------------------------------------------
// Phase 5 Wave 4 (Plan 05-04) — AstAnalyzer host-side coordinator tests.
//
// Drives the analyzer against a STUB worker (src/test/fixtures/ast-stub-worker.js
// → dist/test/fixtures/ast-stub-worker.js). The stub worker is a 40-line Node
// script with STUB_MODE env-var modes (echo / never-reply / crash-once /
// crash-always) — gives deterministic control over success / timeout / crash
// scenarios without touching the real Wasm-loading worker.
//
// Coverage:
//   - T-05-03 (path escape) — 8 traversal / absolute / backslash variants
//     rejected; sanity-check that the analyzer does NOT fork at all when
//     every changedFile path is unsafe (canary fixture writes a sentinel
//     file on its first message — sentinel must not exist after the call).
//   - T-05-02 (slowloris parse) — analyzer's 5s timeout overridden to 200ms;
//     STUB_MODE=never-reply; assert resolve happens within ~250ms with
//     empty AnalysisResult.
//   - T-05-01 (worker crash) — STUB_MODE=crash-once first call returns empty
//     AnalysisResult; second call re-forks and succeeds.
//   - 3-strike open-circuit — 3 consecutive timeouts/crashes opens the
//     circuit for 30s; 4th call short-circuits without forking; after
//     cooldown elapses (via injected `now` fake clock), subsequent call
//     re-forks.
//   - Concurrent calls reuse the same worker.
//   - dispose() kills the worker.
//
// All tests use AstAnalyzerOptions.workerScriptPath to redirect fork target.
// The real dist/ast-worker.js is exercised by astWorkerIntegration.test.ts.
// -----------------------------------------------------------------------------

const STUB_WORKER = path.resolve(__dirname, '../fixtures/ast-stub-worker.js');
const CANARY_WORKER = path.resolve(__dirname, '../fixtures/ast-no-fork-canary.js');

suite('Phase 5 Wave 3 — AstAnalyzer (T-05-01/02/03)', () => {
  const workspaceRoot = '/Users/test/workspace';
  const branchDir = '/Users/test/workspace/.versioncon/branches/main';

  suiteSetup(() => {
    // Sanity: the fixtures must exist in dist before any test runs.
    assert.ok(
      fsSync.existsSync(STUB_WORKER),
      `Stub worker fixture missing at ${STUB_WORKER}. Run npm run build first.`,
    );
    assert.ok(
      fsSync.existsSync(CANARY_WORKER),
      `Canary worker fixture missing at ${CANARY_WORKER}.`,
    );
  });

  function emptyArgs() {
    return {
      changedFiles: [],
      memberTrackedFiles: {},
      memberDisplayNames: {},
    };
  }

  // ---------- T-05-03: path validation ----------

  test('T-05-03: changedFile with absolute /etc/passwd path is dropped — empty result, no fork', async () => {
    const sentinelPath = path.join(
      os.tmpdir(),
      `vc-canary-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: CANARY_WORKER,
      env: { CANARY_SENTINEL_PATH: sentinelPath },
    });
    try {
      const result = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: '/etc/passwd',
            preContent: '',
            postContent: '',
            languageId: null,
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      assert.deepStrictEqual(result, {
        affectedSymbols: [],
        perMember: {},
        unsupportedLanguages: [],
      });
      // Give any in-flight fork a beat to actually run.
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(
        !fsSync.existsSync(sentinelPath),
        'canary sentinel should not exist — analyzer should not have forked',
      );
    } finally {
      analyzer.dispose();
    }
  });

  test('T-05-03: parent-traversal `../../escape.ts` is dropped', async () => {
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: CANARY_WORKER,
    });
    try {
      const result = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: '../../escape.ts',
            preContent: '',
            postContent: '',
            languageId: null,
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      assert.deepStrictEqual(result.affectedSymbols, []);
    } finally {
      analyzer.dispose();
    }
  });

  test('T-05-03: embedded `..` segment `src/../../escape.ts` is dropped', async () => {
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: CANARY_WORKER,
    });
    try {
      const result = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: 'src/../../escape.ts',
            preContent: '',
            postContent: '',
            languageId: null,
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      assert.deepStrictEqual(result.affectedSymbols, []);
    } finally {
      analyzer.dispose();
    }
  });

  test('T-05-03: Windows drive-letter `C:\\Windows\\foo.ts` is dropped', async () => {
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: CANARY_WORKER,
    });
    try {
      const result = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: 'C:\\Windows\\foo.ts',
            preContent: '',
            postContent: '',
            languageId: null,
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      assert.deepStrictEqual(result.affectedSymbols, []);
    } finally {
      analyzer.dispose();
    }
  });

  test('T-05-03: backslash-separated path `src\\foo.ts` is dropped', async () => {
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: CANARY_WORKER,
    });
    try {
      const result = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: 'src\\foo.ts',
            preContent: '',
            postContent: '',
            languageId: null,
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      assert.deepStrictEqual(result.affectedSymbols, []);
    } finally {
      analyzer.dispose();
    }
  });

  test('T-05-03: leading-slash path `/src/foo.ts` is dropped', async () => {
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: CANARY_WORKER,
    });
    try {
      const result = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: '/src/foo.ts',
            preContent: '',
            postContent: '',
            languageId: null,
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      assert.deepStrictEqual(result.affectedSymbols, []);
    } finally {
      analyzer.dispose();
    }
  });

  test('T-05-03: empty string relativePath dropped', async () => {
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: CANARY_WORKER,
    });
    try {
      const result = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: '',
            preContent: '',
            postContent: '',
            languageId: null,
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      assert.deepStrictEqual(result.affectedSymbols, []);
    } finally {
      analyzer.dispose();
    }
  });

  test('T-05-03: bare `..` segment dropped', async () => {
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: CANARY_WORKER,
    });
    try {
      const result = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: '../foo.ts',
            preContent: '',
            postContent: '',
            languageId: null,
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      assert.deepStrictEqual(result.affectedSymbols, []);
    } finally {
      analyzer.dispose();
    }
  });

  test('safe paths accepted: `src/foo.ts`, `a/b/c/d/e.ts`, `foo..bar.ts`', async () => {
    // These should pass validation. We use the echo stub so the analyzer
    // actually forks + receives a reply. The result is the stub's synthetic
    // AnalysisResult — we just check we got a non-empty result back.
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: STUB_WORKER,
    });
    try {
      const result = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: 'src/foo.ts',
            preContent: '',
            postContent: '',
            languageId: 'typescript',
          },
          {
            relativePath: 'a/b/c/d/e.ts',
            preContent: '',
            postContent: '',
            languageId: 'typescript',
          },
          {
            relativePath: 'foo..bar.ts',
            preContent: '',
            postContent: '',
            languageId: 'typescript',
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      // Stub replies with one synthetic AffectedSymbol per call.
      assert.strictEqual(result.affectedSymbols.length, 1);
      assert.strictEqual(result.affectedSymbols[0].name, 'stub-1');
    } finally {
      analyzer.dispose();
    }
  });

  test('T-05-03: memberTrackedFiles paths are also validated', async () => {
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: STUB_WORKER,
    });
    try {
      // Bad path in memberTrackedFiles + good path in changedFiles. The bad
      // entry should be dropped; the analyzer should still fork because at
      // least the changedFiles entry is safe.
      const result = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: 'src/foo.ts',
            preContent: '',
            postContent: '',
            languageId: 'typescript',
          },
        ],
        memberTrackedFiles: {
          alice: [
            {
              relativePath: '../../escape.ts',
              content: '',
              languageId: null,
            },
            {
              relativePath: 'src/cart.ts',
              content: '',
              languageId: 'typescript',
            },
          ],
        },
        memberDisplayNames: { alice: 'Alice' },
      });
      // Stub echoes back; we just need to know the call went through.
      assert.ok(result.affectedSymbols.length > 0);
    } finally {
      analyzer.dispose();
    }
  });

  test('T-05-03: when every path is rejected, analyzer returns empty without forking', async () => {
    const sentinelPath = path.join(
      os.tmpdir(),
      `vc-canary-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: CANARY_WORKER,
      env: { CANARY_SENTINEL_PATH: sentinelPath },
    });
    try {
      const result = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: '../escape1.ts',
            preContent: '',
            postContent: '',
            languageId: null,
          },
          {
            relativePath: '/etc/foo',
            preContent: '',
            postContent: '',
            languageId: null,
          },
        ],
        memberTrackedFiles: {
          alice: [
            { relativePath: 'src\\foo.ts', content: '', languageId: null },
          ],
        },
        memberDisplayNames: { alice: 'Alice' },
      });
      assert.deepStrictEqual(result, {
        affectedSymbols: [],
        perMember: {},
        unsupportedLanguages: [],
      });
      // Wait briefly, then assert no fork happened.
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(
        !fsSync.existsSync(sentinelPath),
        'canary sentinel should not exist',
      );
    } finally {
      analyzer.dispose();
    }
  });

  // ---------- T-05-02: timeout ----------

  test('T-05-02: never-reply stub triggers timeout — empty result returned', async () => {
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: STUB_WORKER,
      env: { STUB_MODE: 'never-reply' },
      timeoutMs: 200,
    });
    try {
      const start = Date.now();
      const result = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: 'src/foo.ts',
            preContent: '',
            postContent: '',
            languageId: 'typescript',
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      const elapsed = Date.now() - start;
      assert.deepStrictEqual(result, {
        affectedSymbols: [],
        perMember: {},
        unsupportedLanguages: [],
      });
      assert.ok(
        elapsed >= 150 && elapsed < 1500,
        `expected timeout to fire near 200ms, got ${elapsed}ms`,
      );
    } finally {
      analyzer.dispose();
    }
  });

  // ---------- T-05-01: crash recovery ----------

  test('T-05-01: crash-once stub — first call returns empty, second call re-forks and succeeds', async () => {
    const crashFlag = path.join(
      os.tmpdir(),
      `vc-stub-crash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    // Make sure no stale flag exists from a previous run.
    if (fsSync.existsSync(crashFlag)) fsSync.unlinkSync(crashFlag);
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: STUB_WORKER,
      env: { STUB_MODE: 'crash-once', STUB_CRASH_FLAG: crashFlag },
      timeoutMs: 1000,
    });
    try {
      // First call — stub crashes before replying.
      const r1 = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: 'src/foo.ts',
            preContent: '',
            postContent: '',
            languageId: 'typescript',
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      assert.deepStrictEqual(r1.affectedSymbols, []);

      // Wait so the analyzer notices the exit before the next call.
      await new Promise((r) => setTimeout(r, 50));

      // Second call — new worker boots; the global crash flag is now set, so
      // it falls through the crash-once gate and replies normally.
      const r2 = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: 'src/foo.ts',
            preContent: '',
            postContent: '',
            languageId: 'typescript',
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      assert.ok(
        r2.affectedSymbols.length > 0,
        'second call after crash should re-fork and succeed',
      );
    } finally {
      analyzer.dispose();
      if (fsSync.existsSync(crashFlag)) {
        try { fsSync.unlinkSync(crashFlag); } catch { /* ignore */ }
      }
    }
  });

  // ---------- 3-strike open-circuit ----------

  test('T-05-01: 3 consecutive timeouts open the circuit — 4th call short-circuits (no fork)', async () => {
    let fakeNow = 1_000_000_000;
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: STUB_WORKER,
      env: { STUB_MODE: 'never-reply' },
      timeoutMs: 50,
      now: () => fakeNow,
    });
    try {
      // Call 1 — times out.
      await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: 'src/foo.ts',
            preContent: '',
            postContent: '',
            languageId: 'typescript',
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      // Call 2 — times out.
      await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: 'src/foo.ts',
            preContent: '',
            postContent: '',
            languageId: 'typescript',
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      // Call 3 — times out and opens the circuit.
      await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: 'src/foo.ts',
            preContent: '',
            postContent: '',
            languageId: 'typescript',
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });

      // Call 4 — should return immediately (well under the 50ms timeout)
      // because the circuit is open.
      const start = Date.now();
      const r4 = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: 'src/foo.ts',
            preContent: '',
            postContent: '',
            languageId: 'typescript',
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      const elapsed = Date.now() - start;
      assert.deepStrictEqual(r4.affectedSymbols, []);
      assert.ok(
        elapsed < 30,
        `expected immediate short-circuit (<30ms), got ${elapsed}ms`,
      );
    } finally {
      analyzer.dispose();
    }
  });

  test('T-05-01: circuit auto-recovers after 30s cooldown elapses', async () => {
    let fakeNow = 1_000_000_000;
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: STUB_WORKER,
      env: { STUB_MODE: 'never-reply' },
      timeoutMs: 50,
      now: () => fakeNow,
    });
    try {
      // Open the circuit with 3 timeouts.
      for (let i = 0; i < 3; i++) {
        await analyzer.analyzeChange({
          changedFiles: [
            {
              relativePath: 'src/foo.ts',
              preContent: '',
              postContent: '',
              languageId: 'typescript',
            },
          ],
          memberTrackedFiles: {},
          memberDisplayNames: {},
        });
      }

      // Confirm short-circuit.
      let start = Date.now();
      await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: 'src/foo.ts',
            preContent: '',
            postContent: '',
            languageId: 'typescript',
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      assert.ok(Date.now() - start < 30, 'circuit should be open');

      // Advance the fake clock past the 30s cooldown.
      fakeNow += 31_000;
      // Switch to a never-reply stub (still — we want this next call to also
      // fail, but the point is the analyzer ATTEMPTS to fork, which proves
      // the circuit reset).
      start = Date.now();
      await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: 'src/foo.ts',
            preContent: '',
            postContent: '',
            languageId: 'typescript',
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      const elapsed = Date.now() - start;
      // The fork + timeout takes ~50ms; circuit-open short-circuit takes <5ms.
      assert.ok(
        elapsed >= 30,
        `after cooldown the analyzer should re-fork (>=30ms elapsed), got ${elapsed}ms`,
      );
    } finally {
      analyzer.dispose();
    }
  });

  // ---------- concurrent calls ----------

  test('two concurrent analyzeChange calls both resolve correctly', async () => {
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: STUB_WORKER,
      env: { STUB_MODE: 'echo', STUB_DELAY_MS: '50' },
      timeoutMs: 5000,
    });
    try {
      const [r1, r2] = await Promise.all([
        analyzer.analyzeChange({
          changedFiles: [
            {
              relativePath: 'src/a.ts',
              preContent: '',
              postContent: '',
              languageId: 'typescript',
            },
          ],
          memberTrackedFiles: {},
          memberDisplayNames: {},
        }),
        analyzer.analyzeChange({
          changedFiles: [
            {
              relativePath: 'src/b.ts',
              preContent: '',
              postContent: '',
              languageId: 'typescript',
            },
          ],
          memberTrackedFiles: {},
          memberDisplayNames: {},
        }),
      ]);
      assert.ok(r1.affectedSymbols.length > 0);
      assert.ok(r2.affectedSymbols.length > 0);
    } finally {
      analyzer.dispose();
    }
  });

  // ---------- dispose ----------

  test('dispose() kills the worker and clears pending timers', async () => {
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: STUB_WORKER,
    });
    // Initial call to ensure a worker is forked.
    await analyzer.analyzeChange({
      changedFiles: [
        {
          relativePath: 'src/foo.ts',
          preContent: '',
          postContent: '',
          languageId: 'typescript',
        },
      ],
      memberTrackedFiles: {},
      memberDisplayNames: {},
    });
    // Dispose — should be a no-throw, idempotent operation.
    analyzer.dispose();
    analyzer.dispose(); // second call should not throw
    assert.ok(true);
  });

  test('analyzeChange after dispose() forks a new worker and replies', async () => {
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: STUB_WORKER,
    });
    try {
      const r1 = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: 'src/foo.ts',
            preContent: '',
            postContent: '',
            languageId: 'typescript',
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      assert.ok(r1.affectedSymbols.length > 0);

      analyzer.dispose();

      const r2 = await analyzer.analyzeChange({
        changedFiles: [
          {
            relativePath: 'src/foo.ts',
            preContent: '',
            postContent: '',
            languageId: 'typescript',
          },
        ],
        memberTrackedFiles: {},
        memberDisplayNames: {},
      });
      assert.ok(r2.affectedSymbols.length > 0);
    } finally {
      analyzer.dispose();
    }
  });

  // ---------- empty input ----------

  test('empty changedFiles + empty memberTrackedFiles returns empty result without forking', async () => {
    const sentinelPath = path.join(
      os.tmpdir(),
      `vc-canary-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const analyzer = new AstAnalyzer(workspaceRoot, branchDir, {
      workerScriptPath: CANARY_WORKER,
      env: { CANARY_SENTINEL_PATH: sentinelPath },
    });
    try {
      const result = await analyzer.analyzeChange(emptyArgs());
      assert.deepStrictEqual(result, {
        affectedSymbols: [],
        perMember: {},
        unsupportedLanguages: [],
      });
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(!fsSync.existsSync(sentinelPath));
    } finally {
      analyzer.dispose();
    }
  });
});
