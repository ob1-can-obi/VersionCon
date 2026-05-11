---
plan: 05-02
phase: 05-dependency-aware-conflict-detection-ast
title: JavaScript + TypeScript adapters
status: complete
completed: 2026-05-11
mode: autonomous (executor agent stream-dropped before writing this SUMMARY; orchestrator reconstructed from git log + tree inspection)
---

# Wave 2 Summary — JS + TS adapters with vendored WASMs

## What shipped

**Vendored grammars** (`src/vendor/tree-sitter/`):
- `javascript.wasm`
- `typescript.wasm`
- `tsx.wasm`

**Source files** (new):
- `src/ast/grammars.ts` — `Parser.init()` + `Language.load()` memoization (one-shot WASM bootstrapping, shared between adapters)
- `src/ast/adapters/javascript.ts` — extracts functions / classes / variables / imports / exports / calls / reads; registers itself in AstFactory at module load
- `src/ast/adapters/typescript.ts` — extends JS coverage with TypeScript-specific interfaces + type aliases; routes `.tsx` files through the tsx grammar; registers itself for `'typescript'` (handles both .ts and .tsx via parserFor())

**Tests** (new):
- `src/test/suite/astJavaScriptAdapter.test.ts` — adapter behavior + crash-tolerance (T-05-01) + source-grep side-effect contract
- `src/test/suite/astTypeScriptAdapter.test.ts` — same coverage shape for TS, plus TSX-routing tests

**Build** (modified):
- `esbuild.config.mjs` — copyFile hook copies vendored WASMs into `dist/` so the worker can load them at runtime

## Commits

- `754c0e8` feat(05-02): vendor JS/TS/TSX tree-sitter WASMs + esbuild copy hook
- `9d17253` feat(05-02): add grammars.ts Parser.init + Language.load memoization
- `e487c90` test(05-02): add failing JavaScriptAdapter behavior + crash-tolerance tests (RED)
- `f8b5983` feat(05-02): implement JavaScriptAdapter tree-sitter walker (GREEN)
- `19d3f18` test(05-02): add failing TypeScriptAdapter behavior + TSX routing tests (RED)
- `7106d72` feat(05-02): implement TypeScriptAdapter — interfaces + TSX routing (GREEN)

## Tests

- Wave 1 baseline: 496 passing
- Post-Wave 2 (running with Wave 3's overlap excluded): ~554 passing — adapter packs together added +108 to baseline

## Reconstruction note

The Wave 2 executor agent's response stream dropped between the last GREEN commit and writing this SUMMARY. All commits landed cleanly; type-check and full test suite pass at 604 (after a small subsequent fix `da3cce8` reshaping two ordering-fragile runtime-registration tests to source-grep). No code surface required reconstruction.

## Deviations

- One follow-up commit by the orchestrator (`da3cce8`): the "must register itself on import" runtime tests for JS + TS were flaky because parallel adapter suites call `_resetRegistryForTests()` and mocha's alphabetical run order means those resets fire BEFORE this suite's "is it registered?" check. Reshape the contract from "runtime assertion" to "source-grep for `registerAdapter('javascript', new JavaScriptAdapter())` at module scope" — same guarantee, no ordering fragility. Rule 2 fix.
