import * as assert from 'assert';
import * as path from 'path';
import { computeFileOverlap } from '../../utils/fileOverlap.js';

/**
 * Pure-function unit tests for computeFileOverlap (Phase 4 Plan 04-06).
 *
 * Tests fake the `platform` argument so darwin/linux/win32 branches are all
 * exercised regardless of which OS the test suite runs on. The win32 test
 * uses `path.win32`-style absolute open-tab paths because the function
 * internally selects `path.win32` for relative-path computation when
 * `platform === 'win32'`.
 *
 * Coverage maps to RESEARCH §"Edge cases":
 *   - case sensitivity (darwin / linux / win32)
 *   - workspace boundary check (rel starts with `..`)
 *   - empty inputs (pushed empty, openTabs empty)
 *   - overlap categories (none / full / partial with original-case preservation)
 *   - deduplication of duplicate openTab entries
 *   - order preservation in `overlapping`
 */
suite('computeFileOverlap', () => {
  // POSIX root used for darwin / linux tests (path.posix.relative is exercised).
  const wsPosix = '/Users/dev/proj';
  // Win32 root used for the win32 test (path.win32.relative is exercised).
  const wsWin = 'C:\\Users\\dev\\proj';

  suite('case sensitivity', () => {
    test('darwin: case-insensitive match (Foo.ts == foo.ts)', () => {
      const result = computeFileOverlap(
        ['src/Foo.ts'],
        [path.posix.join(wsPosix, 'src/foo.ts')],
        wsPosix,
        'darwin',
      );
      assert.deepStrictEqual(result.overlapping, ['src/Foo.ts']);
      assert.strictEqual(result.unaffected.length, 0);
    });

    test('linux: case-sensitive miss (Foo.ts != foo.ts)', () => {
      const result = computeFileOverlap(
        ['src/Foo.ts'],
        [path.posix.join(wsPosix, 'src/foo.ts')],
        wsPosix,
        'linux',
      );
      assert.strictEqual(result.overlapping.length, 0);
      assert.deepStrictEqual(result.unaffected, ['src/Foo.ts']);
    });

    test('win32: case-insensitive + backslash separator normalizes', () => {
      const result = computeFileOverlap(
        ['src/foo.ts'],
        ['C:\\Users\\dev\\proj\\src\\Foo.ts'],
        wsWin,
        'win32',
      );
      assert.deepStrictEqual(result.overlapping, ['src/foo.ts']);
      assert.strictEqual(result.unaffected.length, 0);
    });
  });

  suite('workspace boundary', () => {
    test('open tab outside workspace is excluded', () => {
      const result = computeFileOverlap(
        ['src/foo.ts'],
        ['/some/other/path/foo.ts'], // outside wsPosix
        wsPosix,
        'darwin',
      );
      assert.strictEqual(result.overlapping.length, 0);
      assert.deepStrictEqual(result.unaffected, ['src/foo.ts']);
    });

    test('open tab inside workspace is included', () => {
      const result = computeFileOverlap(
        ['src/foo.ts'],
        [path.posix.join(wsPosix, 'src/foo.ts')],
        wsPosix,
        'darwin',
      );
      assert.deepStrictEqual(result.overlapping, ['src/foo.ts']);
    });
  });

  suite('empty inputs', () => {
    test('empty pushedFiles produces both arrays empty', () => {
      const result = computeFileOverlap([], [], wsPosix, 'darwin');
      assert.deepStrictEqual(result.overlapping, []);
      assert.deepStrictEqual(result.unaffected, []);
    });

    test('empty openTabPaths sends all pushed to unaffected', () => {
      const result = computeFileOverlap(['a.ts', 'b.ts'], [], wsPosix, 'darwin');
      assert.deepStrictEqual(result.overlapping, []);
      assert.deepStrictEqual(result.unaffected, ['a.ts', 'b.ts']);
    });
  });

  suite('overlap categories', () => {
    test('no overlap: all pushed go to unaffected', () => {
      const result = computeFileOverlap(
        ['a.ts', 'b.ts'],
        [path.posix.join(wsPosix, 'c.ts')],
        wsPosix,
        'darwin',
      );
      assert.deepStrictEqual(result.overlapping, []);
      assert.deepStrictEqual(result.unaffected, ['a.ts', 'b.ts']);
    });

    test('full overlap: all pushed go to overlapping', () => {
      const result = computeFileOverlap(
        ['a.ts', 'b.ts'],
        [path.posix.join(wsPosix, 'a.ts'), path.posix.join(wsPosix, 'b.ts')],
        wsPosix,
        'darwin',
      );
      assert.deepStrictEqual(result.overlapping, ['a.ts', 'b.ts']);
      assert.deepStrictEqual(result.unaffected, []);
    });

    test('partial overlap preserves original-case in overlapping', () => {
      const result = computeFileOverlap(
        ['src/Auth.ts', 'src/Util.ts', 'src/Index.ts'],
        [path.posix.join(wsPosix, 'src/auth.ts')], // lowercase open path
        wsPosix,
        'darwin', // case-insensitive — match should hit
      );
      assert.deepStrictEqual(
        result.overlapping,
        ['src/Auth.ts'],
        'overlapping preserves original case "Auth.ts", not the lowercased "auth.ts" from openTabFsPaths',
      );
      assert.deepStrictEqual(result.unaffected, ['src/Util.ts', 'src/Index.ts']);
    });
  });

  suite('deduplication', () => {
    test('same file appearing twice in openTabPaths still produces one match', () => {
      const result = computeFileOverlap(
        ['src/foo.ts'],
        [
          path.posix.join(wsPosix, 'src/foo.ts'),
          path.posix.join(wsPosix, 'src/foo.ts'),
        ],
        wsPosix,
        'darwin',
      );
      assert.strictEqual(result.overlapping.length, 1);
      assert.deepStrictEqual(result.overlapping, ['src/foo.ts']);
    });
  });

  suite('order preservation', () => {
    test('overlapping array preserves pushedFiles input order', () => {
      const pushed = ['z.ts', 'a.ts', 'm.ts'];
      const open = pushed.map((f) => path.posix.join(wsPosix, f));
      const result = computeFileOverlap(pushed, open, wsPosix, 'darwin');
      assert.deepStrictEqual(result.overlapping, ['z.ts', 'a.ts', 'm.ts']);
    });
  });
});
