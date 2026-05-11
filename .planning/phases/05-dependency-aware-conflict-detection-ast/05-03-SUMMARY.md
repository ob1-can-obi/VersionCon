---
plan: 05-03
phase: 05-dependency-aware-conflict-detection-ast
title: Python adapter + FallbackAdapter + Java/C++ register-but-fallback stubs
status: complete
completed: 2026-05-11
mode: autonomous (executor agent stream-dropped before writing this SUMMARY; orchestrator reconstructed from git log + tree inspection)
---

# Wave 3 Summary — Python adapter + Fallback + Java/C++ stubs

## What shipped

**Vendored grammar** (`src/vendor/tree-sitter/`):
- `python.wasm`

**Source files** (new):
- `src/ast/adapters/python.ts` — extracts function defs, class defs, top-level assignments, imports / from-imports; references for function calls + name references + import usage. Registers itself in AstFactory at module load.
- `src/ast/adapters/fallback.ts` — `FallbackAdapter` class implementing AstAdapter via line-level diff only (no AST). Returns empty SymbolIndex + empty ReferenceIndex so joinImpact (Wave 4) sees "no symbols" and degrades gracefully to file-level. SC-3 satisfied.
- `src/ast/adapters/java.ts` — registers `'java'` with `createFallbackAdapter('java')`. No real grammar in this phase (WASM unvalidated per STATE.md blockers).
- `src/ast/adapters/cpp.ts` — registers `'cpp'` with `createFallbackAdapter('cpp')`. Same deferral.

**Tests** (new):
- `src/test/suite/astPythonAdapter.test.ts` — behavior + crash-tolerance + source-grep
- `src/test/suite/astFallback.test.ts` — FallbackAdapter empty-return contract + Java/C++ stub registration

## Commits

- `6c4f1cf` feat(05-03): vendor tree-sitter-python.wasm + extend vendor README
- `aea3e1e` test(05-03): add failing PythonAdapter unit tests (TDD RED)
- `ecb1b75` feat(05-03): implement PythonAdapter tree-sitter walker (GREEN)
- `76b61d2` test(05-03): add failing FallbackAdapter + Java/C++ stub tests (TDD RED)
- `118ff9f` feat(05-03): FallbackAdapter + Java/C++ register-but-fallback stubs (GREEN)

## Architecture (per SPEC's "locked decisions")

CONF-09 calls out Python + JS/TS + Java + C++ as supported languages. CONF-10 explicitly authorizes fallback for unsupported. STATE.md flags tree-sitter Java + C++ WASM compatibility as "unvalidated." Wave 3 reflects this:
- Python: real grammar, real walker, real symbol/reference extraction
- Java + C++: language IDs registered in AstFactory, but the adapters route to `FallbackAdapter` (line-level diff, no AST). The wire shape (no `affectedSymbols` field, optional `unsupportedLanguages: ['java' | 'cpp']` meta) still produces a meaningful smart-push summary — just file-level granularity instead of function-level. Adding real Java + C++ grammars later is a one-WASM-plus-one-adapter PR; the registry seam is already in place.

## Tests

- Pre-wave baseline: 496 passing (Wave 1 in place)
- Post-Wave-2-AND-3 combined: 604 passing (+108 across both adapter packs — adapter behavior, crash-tolerance, source-grep contracts, fallback empty-return invariants, Java/C++ stub registration)

## Reconstruction note

The Wave 3 executor agent's response stream dropped (1027s, 105 tool calls). All 5 commits landed in git before the drop; files exist on disk. No code surface required reconstruction.

## Deviations

None at this layer. The test reshape commit `da3cce8` (registration-on-import → source-grep) applied to JS + TS, not to Python (the Python suite's `_resetRegistryForTests()` call happens inside its own suiteSetup, so by the time the Python suite checks `getAdapter('python')`, the import-time side effect is still in place — no reset race).
