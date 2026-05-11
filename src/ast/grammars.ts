/**
 * Phase 5 Wave 2 (Plan 05-02) — grammar loader for tree-sitter WASMs.
 *
 * Single owner of:
 *   - Parser.init()  — must be called exactly once per process. web-tree-sitter
 *                      installs its own emscripten module on init; calling
 *                      init() twice double-installs and leaks linear memory.
 *   - Language.load(path) — loads a grammar WASM, memoized per cache key. The
 *                      same WASM loaded twice would leak ~300KB of Wasm linear
 *                      memory per leak, so the cache is mandatory, not an
 *                      optimization.
 *   - locateFile resolver — web-tree-sitter's emscripten runtime needs to find
 *                      web-tree-sitter.wasm at runtime. We point it at
 *                      dist/vendor/tree-sitter/ (mirrors the chat asset
 *                      pattern in esbuild.config.mjs).
 *
 * T-05-01 mitigation: Parser.init() failure throws synchronously. The Wave 4
 * worker catches that throw and re-forks. Once init succeeds, getParserFor
 * (id, relativePath) is safe to call repeatedly across files of the same
 * language without paying re-init cost.
 *
 * T-05-02 (slowloris parse) is enforced at the worker level, NOT here — see
 * src/ast/types.ts {@link AstAdapter} docs. The Parser instance is sync; the
 * worker wraps each extract* call in a Promise.race with a 5s timer.
 *
 * SC-2 (extension host responsiveness): NO host-process code should import
 * this module. Loading a Wasm module on the host thread blocks the UI for ~10s
 * on a cold start. This module's only legitimate caller is the Wave 4
 * AstWorker process. Wave 5 host-side coordinator code (AstAnalyzer.ts) MUST
 * NOT import grammars.ts even indirectly — that's why the adapter registry
 * (AstFactory) is split off into its own module.
 *
 * __dirname caveat: esbuild bundles to CJS (target node18 + format cjs), so
 * __dirname resolves to the directory of dist/extension.js or dist/worker.js
 * at runtime. The Wave 4 worker MUST also be bundled as CJS — deferred to
 * Plan 05-04 but noted here.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Parser, Language } from 'web-tree-sitter';
import type { LanguageId } from './types.js';

/**
 * One-shot init promise — null until first call, then the resolution of
 * Parser.init(). Subsequent calls reuse the same promise (resolved or pending).
 */
let initPromise: Promise<void> | null = null;

/**
 * Per-language Language cache. Key is either a LanguageId or the synthetic
 * 'typescript-tsx' marker so .ts and .tsx don't share a Language instance.
 */
const LANGUAGE_CACHE = new Map<string, Language>();

/**
 * Per-language Parser cache. One Parser per (languageId, .tsx-or-not) tuple
 * for the worker's lifetime. Parsers are reused across files of the same
 * language — see https://tree-sitter.github.io/tree-sitter/using-parsers
 * for why constructing a new Parser per file is wasteful.
 */
const PARSER_CACHE = new Map<string, Parser>();

/**
 * Compute the absolute path to dist/vendor/tree-sitter/. The challenge: this
 * module ships in two different layouts depending on the build mode:
 *
 *   - esbuild bundle (host runtime + Wave 4 worker): one file under dist/,
 *     so __dirname === dist/ and vendor/tree-sitter/ is `dist/vendor/...`.
 *
 *   - tsc emit (test runner — vscode-test compiles each .ts to its own .js
 *     under dist/test/... and dist/ast/...): __dirname === dist/ast/, so
 *     "../vendor/tree-sitter/" is the correct relative path.
 *
 * We walk up from __dirname looking for the first ancestor that contains a
 * `vendor/tree-sitter/` directory. The walk is bounded (max 6 levels) so a
 * pathological setup can't loop forever — bail out with the bundle-mode
 * default if not found.
 *
 * Cached so the filesystem scan happens at most once per process.
 */
let _distVendorDirCache: string | null = null;
function distVendorDir(): string {
  if (_distVendorDirCache) return _distVendorDirCache;
  let cur = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(cur, 'vendor', 'tree-sitter');
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        _distVendorDirCache = candidate;
        return candidate;
      }
    } catch {
      // ignore — keep walking up
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Bundle-mode default. The eventual Language.load call will error with a
  // clear ENOENT if this guess is wrong — surfacing the misconfiguration
  // immediately instead of returning a phantom directory.
  _distVendorDirCache = path.resolve(__dirname, 'vendor', 'tree-sitter');
  return _distVendorDirCache;
}

/** Test-only: clear the distVendorDir cache so tests can pin a fresh resolve. */
function _resetDistVendorDirForTests(): void {
  _distVendorDirCache = null;
}

/**
 * Pick the correct grammar cache key. The TS grammar parses plain .ts but
 * rejects JSX; the TSX grammar parses both, but plain .ts files don't need
 * the TSX-specific overhead. We route on relativePath extension.
 *
 * Returns a synthetic 'typescript-tsx' marker for .tsx files. Never exposed
 * outside this module — the public API still takes LanguageId.
 */
function cacheKeyFor(languageId: LanguageId, relativePath?: string): string {
  if (languageId === 'typescript' && relativePath?.endsWith('.tsx')) {
    return 'typescript-tsx';
  }
  return languageId;
}

/**
 * Resolve the grammar WASM file path for a (languageId, relativePath) tuple.
 *
 *   javascript        → javascript.wasm
 *   typescript + .ts  → typescript.wasm
 *   typescript + .tsx → tsx.wasm
 *   python            → python.wasm
 *   java              → java.wasm   (Wave 3 stub — falls back at adapter level
 *                                    so this path is never reached in v1)
 *   cpp               → cpp.wasm    (same)
 */
function wasmPathFor(languageId: LanguageId, relativePath?: string): string {
  if (languageId === 'typescript' && relativePath?.endsWith('.tsx')) {
    return path.join(distVendorDir(), 'tsx.wasm');
  }
  const fileName = languageId === 'typescript'
    ? 'typescript.wasm'
    : `${languageId}.wasm`;
  return path.join(distVendorDir(), fileName);
}

/**
 * Initialize the web-tree-sitter Wasm runtime. Idempotent — safe to call
 * before every {@link loadGrammar} / {@link getParserFor} call (those wait on
 * this internally). The actual init runs at most once per process.
 *
 * The `locateFile` callback tells the emscripten loader where to find
 * web-tree-sitter.wasm — the parser engine itself, distinct from language
 * grammars. esbuild copies it into dist/vendor/tree-sitter/ at build time.
 */
export async function initParser(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = Parser.init({
    locateFile: (file: string) => path.join(distVendorDir(), file),
  });
  return initPromise;
}

/**
 * Load (and memoize) a tree-sitter Language for a (languageId, relativePath)
 * tuple. Lazy: the WASM is only read on first call for each cache key.
 *
 * Cache hit ratio in production is ~100% — a typical session has at most 5
 * distinct grammar variants (js, ts, tsx, py, fallback) loaded once each.
 *
 * Rejects on:
 *   - missing WASM file (build-time error — esbuild should have copied)
 *   - ABI mismatch (grammar built against a newer tree-sitter CLI than the
 *     runtime supports). Symptom: "Incompatible language version" error.
 */
export async function loadGrammar(
  languageId: LanguageId,
  relativePath?: string,
): Promise<Language> {
  await initParser();
  const key = cacheKeyFor(languageId, relativePath);
  let lang = LANGUAGE_CACHE.get(key);
  if (!lang) {
    lang = await Language.load(wasmPathFor(languageId, relativePath));
    LANGUAGE_CACHE.set(key, lang);
  }
  return lang;
}

/**
 * Get a Parser pre-configured for a (languageId, relativePath) tuple.
 *
 * One Parser per cache key, reused across files. The worker's "parse this
 * file" flow is:
 *
 *   const parser = await getParserFor('typescript', 'foo.tsx');
 *   const tree = parser.parse(source);  // sync after this point
 *
 * The Parser is NEVER `delete()`d during the worker's lifetime — delete frees
 * the underlying tree-sitter state, which would force re-init. The cache
 * holds Parsers until {@link _resetGrammarsForTests} is called or the
 * process exits.
 */
export async function getParserFor(
  languageId: LanguageId,
  relativePath?: string,
): Promise<Parser> {
  await initParser();
  const key = cacheKeyFor(languageId, relativePath);
  let parser = PARSER_CACHE.get(key);
  if (!parser) {
    const language = await loadGrammar(languageId, relativePath);
    parser = new Parser();
    parser.setLanguage(language);
    PARSER_CACHE.set(key, parser);
  }
  return parser;
}

/**
 * Test-only: reset every cache so unit tests start from a clean state. Calls
 * `parser.delete()` on each cached Parser to free Wasm linear memory between
 * test files — without this, the test runner accumulates ~300KB per parser
 * across the suite and eventually OOMs.
 *
 * Production code MUST NOT call this — the caches are populated lazily and
 * reused for the worker's lifetime. Same defensive pattern as
 * `_resetRegistryForTests` in AstFactory.ts.
 */
export function _resetGrammarsForTests(): void {
  initPromise = null;
  LANGUAGE_CACHE.clear();
  for (const p of PARSER_CACHE.values()) {
    try {
      p.delete();
    } catch {
      // Best-effort cleanup — if delete throws (e.g. already deleted), ignore.
    }
  }
  PARSER_CACHE.clear();
  _resetDistVendorDirForTests();
}
