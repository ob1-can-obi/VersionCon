/**
 * Phase 5 Wave 1 (Plan 05-01) — AST adapter registry + language detection.
 *
 * The factory is the SEAM between language detection (Wave 1) and concrete
 * tree-sitter adapters (Waves 2/3). Wave 1 ships with an empty registry —
 * every {@link getAdapter} call returns null. Waves 2/3 mutate the internal
 * registry through {@link registerAdapter} to wire real adapters without
 * changing this file's public signature.
 *
 * Adapter-registration policy (Wave 2 — Plan 05-02): each adapter module owns
 * its own registerAdapter() call at module-import time. The Wave 4 worker
 * explicitly imports `src/ast/adapters/javascript.js` etc., which triggers
 * the registration as a side effect. This keeps THIS file free of any
 * tree-sitter / web-tree-sitter imports — the host process can safely
 * import AstFactory.ts to call `detectLanguageFromPath`/`getAdapter` without
 * pulling in the heavyweight grammar runtime (SC-2: host stays responsive).
 *
 * SC-3 fallback contract: when {@link getAdapter} returns null, the caller
 * (Wave 4 worker) MUST route to the file-level fallback adapter rather than
 * crashing. Wave 3 implements that fallback in `src/ast/adapters/fallback.ts`.
 * Tier-2 languages (java, cpp) intentionally remain unregistered in v1 —
 * {@link detectLanguageFromPath} returns 'java'/'cpp' so the file flows into
 * the AST pipeline, but `getAdapter('java')` returns null so the caller
 * fallbacks. v1.1 wires the real WASM grammars without changing the contract.
 *
 * The `.h` extension is tagged 'cpp' (not 'c') because the v1 scope is C++
 * only — SC-3 enumerates cpp explicitly and C is out of scope until v2.
 * Mixed-language repos with C headers will route through the cpp fallback,
 * which is fine (file-level analysis still works).
 */
import type { AstAdapter, LanguageId } from './types.js';

/**
 * Module-private registry. Wave 1 keeps it empty; Wave 2 wires JS+TS,
 * Wave 3 wires Python. Java/C++ stay unregistered in v1 — see file header.
 */
const REGISTRY = new Map<LanguageId, AstAdapter>();

/**
 * Look up the registered adapter for a language id.
 *
 * Returns null when (a) the language is unsupported (no adapter ever
 * registered — Wave 1 baseline for every id), or (b) the language is
 * registered but the adapter is the fallback that explicitly defers to
 * file-level analysis (Wave 3 java/cpp stubs do this by NOT being in the
 * registry — {@link detectLanguageFromPath} maps to 'java'/'cpp' but
 * getAdapter returns null, so the caller routes to fallback per SC-3).
 *
 * Wave 4 worker MUST check for null before invoking adapter methods —
 * never assume a non-null return.
 */
export function getAdapter(languageId: LanguageId): AstAdapter | null {
  return REGISTRY.get(languageId) ?? null;
}

/**
 * Register a real adapter for a language id. Idempotent on overwrite — the
 * last call wins. Wave 2 + Wave 3 each call this at module-init time; the
 * registration order between them is not significant because each writes a
 * distinct language id. Tests reset via {@link _resetRegistryForTests}
 * between cases.
 */
export function registerAdapter(languageId: LanguageId, adapter: AstAdapter): void {
  REGISTRY.set(languageId, adapter);
}

/**
 * Test-only: clear the registry so unit tests start from the Wave 1 baseline
 * (empty). Production code MUST NOT call this — the registry is populated
 * once at adapter-module load time and never cleared.
 */
export function _resetRegistryForTests(): void {
  REGISTRY.clear();
}

/**
 * File-extension → LanguageId map. The factory owns this so the canonical
 * list lives in one place; Wave 4 worker re-uses
 * {@link detectLanguageFromPath} when stamping AnalyzePayload entries.
 *
 * Tier 1 (Wave 2 + 3, real grammars): js/jsx/mjs/cjs/ts/tsx/py.
 * Tier 2 (Wave 3 fallback only):       java/cc/cpp/cxx/h/hpp.
 */
const EXT_MAP: Record<string, LanguageId> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  java: 'java',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
};

/**
 * Map a workspace-relative path to its language id by file extension.
 * Returns null when (a) the path has no extension, (b) the extension is
 * not in {@link EXT_MAP}, or (c) the path ends with a trailing dot.
 *
 * Case-insensitive on the extension — `Foo.PY` resolves to 'python' so
 * Windows users with capitalized extensions still flow through the AST
 * pipeline. The path itself is not normalized otherwise (slash direction
 * does not affect extension extraction).
 */
export function detectLanguageFromPath(relativePath: string): LanguageId | null {
  const dot = relativePath.lastIndexOf('.');
  if (dot < 0 || dot === relativePath.length - 1) return null;
  const ext = relativePath.slice(dot + 1).toLowerCase();
  return EXT_MAP[ext] ?? null;
}
