/**
 * Phase 5 Wave 1 (Plan 05-01) — file skip policy.
 *
 * Pure module: gates which files the AST analysis layer is allowed to read /
 * parse / index. No file-system I/O — callers pass the pre-stat'd byte count
 * so this module stays trivially unit-testable and can be invoked from both
 * the host process (Wave 5) and the worker process (Wave 4) without
 * environmental coupling.
 *
 * Mitigates T-05-04 (DoS via memory bloat from large repos) by enforcing the
 * SC-4 hard caps at the contract layer:
 *
 *   1. Any file whose `sizeBytes >= DEFAULT_MAX_FILE_BYTES` (500_000) is
 *      skipped. SPEC writes "files >500KB" — we use >= 500_000 for
 *      unambiguous boundary semantics (500KB == 500_000 is the line).
 *
 *   2. Any file whose workspace-relative path contains one of the 6 canonical
 *      substrings — node_modules/, dist/, build/, target/, out/, .min. — is
 *      skipped regardless of size.
 *
 * Comparison is performed against a LOWERCASE, FORWARD-SLASH-NORMALIZED copy
 * of the path:
 *
 *   - Backslash → forward slash normalization defends against Windows callers
 *     who haven't yet posix-normalized their input (a common bug in earlier
 *     phases — see Plan 04-06 fileOverlap path normalization decision).
 *   - Lowercase comparison defends against mixed-case workspaces (e.g.
 *     Windows users with a `Build/` directory). The skip-pattern intent is
 *     "this path goes THROUGH one of these directories" — case-sensitive
 *     matching would miss valid skips on case-insensitive filesystems.
 *
 * Why substring match, not regex anchoring like `^(node_modules|...)/` ?
 * Nested skip dirs are common: `packages/foo/node_modules/x.js` MUST skip.
 * A regex anchored to start-of-string would let that through. Substring on
 * the trailing-slash form ("node_modules/") still correctly rejects bare
 * file names like "node_modules.txt" because it requires the slash.
 *
 * Why ".min." (literal dots both sides) and not just "min" ?
 * "Min.txt" must NOT be skipped (random text file starting with "Min").
 * "jquery.minify.js" must NOT be skipped (a project that named itself
 * "minify" without producing a true `.min.` minified bundle). Only the
 * literal ".min." infix — bracketed by dots — indicates a minified asset.
 *
 * Source: 05-SPEC.md SC-4 + threat T-05-04.
 */

/**
 * SC-4 hard cap. 500KB measured in raw bytes (NOT KB / KiB / character count).
 * Tests pin the literal — a future refactor MUST NOT silently raise this.
 */
export const DEFAULT_MAX_FILE_BYTES = 500_000;

/**
 * The 6 canonical skip-path substrings, in canonical lowercase form. Order
 * matters only for performance (most-likely-to-hit first) — early-return on
 * the first match. Exported as a readonly array so callers (notably Wave 4
 * worker tests) can introspect without re-deriving.
 */
export const SKIP_PATH_PATTERNS: readonly string[] = [
  'node_modules/',
  'dist/',
  'build/',
  'target/',
  'out/',
  '.min.',
];

/**
 * Returns true when `relativePath` (workspace-relative) OR `sizeBytes`
 * (already stat'd by the caller) triggers any of the SC-4 skip conditions.
 *
 * - `relativePath`: workspace-relative; may be posix- or win32-separated;
 *   case is normalized internally. Absolute paths are NOT supported as input
 *   (the caller is expected to have computed a workspace-relative path
 *   already — same precondition as Plan 04-06 fileOverlap).
 * - `sizeBytes`: optional. When omitted, the size cap is not enforced and
 *   the call reduces to a path-pattern test. Wave 4 worker passes the
 *   pre-stat'd size; some unit-test sites omit it.
 *
 * @returns true if the file MUST be skipped (excluded from indexing AND from
 *   change-analysis); false if the file is fair game for the AST pipeline.
 */
export function shouldSkip(relativePath: string, sizeBytes?: number): boolean {
  if (typeof sizeBytes === 'number' && sizeBytes >= DEFAULT_MAX_FILE_BYTES) {
    return true;
  }
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  for (const pattern of SKIP_PATH_PATTERNS) {
    if (normalized.includes(pattern)) return true;
  }
  return false;
}
