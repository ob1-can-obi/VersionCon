import * as assert from 'assert';

import {
  DEFAULT_MAX_FILE_BYTES,
  SKIP_PATH_PATTERNS,
  shouldSkip,
} from '../../ast/skipPolicy.js';

// -----------------------------------------------------------------------------
// Phase 5 Wave 1 (Plan 05-01) — skipPolicy unit tests.
//
// Mitigates T-05-04 (DoS via memory bloat from large repos): the host gates
// every file through shouldSkip(relativePath, sizeBytes) BEFORE adding it to
// the AnalyzePayload. Wave 4 worker enforces the same gate at the IPC
// boundary; these unit tests pin the contract at the Wave 1 layer so a future
// refactor cannot silently change the cap or the path-pattern list.
//
// Source: 05-SPEC.md SC-4 ("files >500KB are skipped; node_modules / dist /
// build / target / out / .min. paths are skipped").
// -----------------------------------------------------------------------------

suite('Phase 5 Wave 1 — skipPolicy (T-05-04 mitigation)', () => {
  // ---------- normal file under the cap ----------
  test('shouldSkip("foo.ts", 1234) returns false — normal file under the cap', () => {
    assert.strictEqual(shouldSkip('foo.ts', 1234), false);
  });

  // ---------- path patterns: node_modules ----------
  test('shouldSkip("node_modules/lodash/index.js", 100) returns true — node_modules at top level', () => {
    assert.strictEqual(shouldSkip('node_modules/lodash/index.js', 100), true);
  });

  test('shouldSkip("src/foo/node_modules/x.js", 100) returns true — nested node_modules', () => {
    assert.strictEqual(shouldSkip('src/foo/node_modules/x.js', 100), true);
  });

  // ---------- path patterns: dist / build / target / out ----------
  test('shouldSkip("dist/extension.js", 100) returns true — dist directory', () => {
    assert.strictEqual(shouldSkip('dist/extension.js', 100), true);
  });

  test('shouldSkip("build/output.js", 100) returns true — build directory', () => {
    assert.strictEqual(shouldSkip('build/output.js', 100), true);
  });

  test('shouldSkip("target/x.class", 100) returns true — target directory (Java/Rust)', () => {
    assert.strictEqual(shouldSkip('target/x.class', 100), true);
  });

  test('shouldSkip("out/x.js", 100) returns true — out directory (Java/TS)', () => {
    assert.strictEqual(shouldSkip('out/x.js', 100), true);
  });

  // ---------- path patterns: .min. infix ----------
  test('shouldSkip("jquery.min.js", 100) returns true — .min. JS infix', () => {
    assert.strictEqual(shouldSkip('jquery.min.js', 100), true);
  });

  test('shouldSkip("foo.min.css", 100) returns true — .min. CSS infix (path skip regardless of ext)', () => {
    assert.strictEqual(shouldSkip('foo.min.css', 100), true);
  });

  test('shouldSkip("Min.txt", 100) returns false — bare "min" without literal dots on both sides does not match', () => {
    assert.strictEqual(shouldSkip('Min.txt', 100), false);
  });

  test('shouldSkip("foo.minify.js", 100) returns false — ".min." literal NOT matched by ".minify."', () => {
    assert.strictEqual(shouldSkip('foo.minify.js', 100), false);
  });

  // ---------- size cap (SC-4: 500_000 bytes hard cap) ----------
  test('shouldSkip("foo.ts", 499_999) returns false — exactly under cap', () => {
    assert.strictEqual(shouldSkip('foo.ts', 499_999), false);
  });

  test('shouldSkip("foo.ts", 500_000) returns true — exactly at cap (>= cap is rejected)', () => {
    assert.strictEqual(shouldSkip('foo.ts', 500_000), true);
  });

  test('shouldSkip("foo.ts", 600_000) returns true — well over cap', () => {
    assert.strictEqual(shouldSkip('foo.ts', 600_000), true);
  });

  // ---------- size optional / undefined ----------
  test('shouldSkip("foo.ts") returns false — undefined size means skip-by-path-only', () => {
    assert.strictEqual(shouldSkip('foo.ts'), false);
  });

  test('shouldSkip("node_modules/foo.ts") returns true — path skip wins regardless of undefined size', () => {
    assert.strictEqual(shouldSkip('node_modules/foo.ts'), true);
  });

  // ---------- case insensitivity on path patterns ----------
  test('shouldSkip("SRC/Node_Modules/X.JS", 100) returns true — case-insensitive on the path segment', () => {
    assert.strictEqual(shouldSkip('SRC/Node_Modules/X.JS', 100), true);
  });

  // ---------- windows backslash separator defense ----------
  test('shouldSkip("src\\\\node_modules\\\\x.js", 100) returns true — backslash separator normalized', () => {
    assert.strictEqual(shouldSkip('src\\node_modules\\x.js', 100), true);
  });

  // ---------- exported constants pinned ----------
  test('DEFAULT_MAX_FILE_BYTES is exactly 500_000 — no future refactor may silently raise the cap', () => {
    assert.strictEqual(DEFAULT_MAX_FILE_BYTES, 500_000);
  });

  test('SKIP_PATH_PATTERNS contains all 6 canonical patterns in lowercase form', () => {
    assert.deepStrictEqual(Array.from(SKIP_PATH_PATTERNS), [
      'node_modules/',
      'dist/',
      'build/',
      'target/',
      'out/',
      '.min.',
    ]);
  });
});
