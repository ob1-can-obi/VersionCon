---
phase: 05-dependency-aware-conflict-detection-ast
plan: 01
subsystem: ast-scaffold
tags: [phase-5, wave-1, types, skip-policy, ast-factory, foundation]
requires: []
provides:
  - LanguageId type union (Waves 2-5 key everything off this)
  - SymbolIndex / ReferenceIndex / AffectedSymbol / AnalysisResult shapes
  - AstAdapter interface contract (Wave 2 + Wave 3 implement)
  - AnalyzePayload / AnalysisResponse IPC frames (Wave 4 worker)
  - shouldSkip(relativePath, sizeBytes?) gate (Wave 4 + 5 pre-IPC filter)
  - DEFAULT_MAX_FILE_BYTES (500_000) + SKIP_PATH_PATTERNS constants
  - getAdapter / registerAdapter / detectLanguageFromPath (factory seam)
  - ChatRecord.meta.affectedSymbols + .unsupportedLanguages (SC-5 + SC-3 fields)
affects:
  - src/types/chat.ts (ChatRecord.meta gains 2 optional fields)
tech-stack:
  added: []   # No new dependencies; web-tree-sitter already in package.json
  patterns:
    - "Pure type module (src/ast/types.ts): zero runtime imports; type-only import from chat.ts via 'import type'"
    - "Module-private registry mutated via registerAdapter (Wave 2/3 wire) — public signature stable across waves"
    - "Path normalization defense: backslash→forward-slash + lowercase before substring match (Plan 04-06 fileOverlap precedent)"
    - "TDD RED → GREEN per task: failing test commit before implementation commit"
    - "Source-grep contract tests (Plan 04-03 filesExclude pattern) pin export names against refactor drift"
key-files:
  created:
    - src/ast/types.ts
    - src/ast/skipPolicy.ts
    - src/ast/AstFactory.ts
    - src/test/suite/astSkipPolicy.test.ts
    - src/test/suite/astTypesContract.test.ts
  modified:
    - src/types/chat.ts
decisions:
  - "Synchronous AstAdapter methods (extractSymbols, extractReferences) — async + Promise.race would defeat T-05-01 (timer leak on crash) and SC-2 (host thread). Wave 4 enforces 5s timeout at the child-process level, not the adapter level."
  - "Substring (not regex) match for skip-path patterns — nested skip dirs (packages/foo/node_modules/x.js) MUST be rejected; a regex anchored to ^ would let them through."
  - "DEFAULT_MAX_FILE_BYTES = 500_000 (>= comparison) — SPEC writes '>500KB'; >= 500_000 gives unambiguous boundary semantics so the 500KB == 500_000 line is the line."
  - "Java + C++ register as LanguageId in detectLanguageFromPath BUT getAdapter returns null in v1 — caller routes to fallback per SC-3. v1.1 wires real WASM grammars without changing the contract."
  - ".h extension tagged 'cpp' (not 'c') — SC-3 v1 scope enumerates cpp only; C is deferred until v2. Mixed-language repos with C headers route through cpp fallback (file-level analysis still works)."
  - "_resetRegistryForTests test-only hook — production code MUST NOT call this; registry populated once at module load. Same pattern as ChatLog defensive-copy / PresenceMap snapshot tests."
  - "Type-only import from src/types/chat.ts → src/ast/types.ts (import type { AffectedSymbol }) — keeps the runtime dependency graph acyclic; chat.ts remains a pure type module with no runtime imports."
metrics:
  duration: "~5 min"
  completed: 2026-05-11
  tasks: 3
  files: 5 created + 1 modified
  tests_added: 57
  tests_total_before: 439
  tests_total_after: 496
---

# Phase 5 Plan 01: Types + skipPolicy + AstFactory + ChatRecord meta extension — Summary

**One-liner:** Phase 5 foundation laid down — pure-type AST module, 500KB skip-policy gate (T-05-04 mitigation), language-aware factory with empty Wave 1 registry, and optional ChatRecord.meta fields ready for Wave 5 stamping — 57 new tests pin the contract.

## What shipped

Wave 1 is foundation-only. No tree-sitter grammars yet (Waves 2 + 3), no worker yet (Wave 4), no host wiring yet (Wave 5). The contract is locked so the four downstream plans can develop against stable types without re-deriving them.

### Files created

1. **`src/ast/types.ts`** (8 exports, ~165 LOC) — `LanguageId`, `SymbolIndex`, `ReferenceIndex`, `AffectedSymbol`, `AstAdapter` interface, `AnalysisResult`, `AnalyzePayload` IPC frame, `AnalysisResponse` discriminated union. Pure types — no runtime imports. Every interface JSDoc'd with which Wave consumes it + which SC/threat it traces to.

2. **`src/ast/skipPolicy.ts`** (3 exports, ~85 LOC) — `shouldSkip(relativePath, sizeBytes?)`, `DEFAULT_MAX_FILE_BYTES = 500_000`, `SKIP_PATH_PATTERNS = ['node_modules/', 'dist/', 'build/', 'target/', 'out/', '.min.']`. T-05-04 mitigation at the contract layer.

3. **`src/ast/AstFactory.ts`** (4 exports, ~95 LOC) — `getAdapter` (returns null for all 5 LanguageIds in Wave 1), `registerAdapter` (Wave 2/3 entry point), `_resetRegistryForTests` (test-only), `detectLanguageFromPath` (13 extension entries: js/jsx/mjs/cjs → javascript, ts/tsx → typescript, py → python, java → java, cc/cpp/cxx/h/hpp → cpp).

4. **`src/test/suite/astSkipPolicy.test.ts`** (~120 LOC, 20 tests) — full behavior coverage for shouldSkip + DEFAULT_MAX_FILE_BYTES/SKIP_PATH_PATTERNS pinning.

5. **`src/test/suite/astTypesContract.test.ts`** (~265 LOC, 37 tests) — 23 behavior tests for getAdapter/registerAdapter/detectLanguageFromPath + 14 source-grep tests pinning the 8 named exports in types.ts, the AstAdapter method signatures, and the ChatRecord.meta extension (both fields + the type-only import).

### Files modified

- **`src/types/chat.ts`** — additive only. ChatRecord.meta gains two optional fields (`affectedSymbols?: AffectedSymbol[]` and `unsupportedLanguages?: string[]`) plus a type-only import. Older meta-blind clients (Plan 04-12 push records) continue to render unchanged — SC-5 fallback contract holds.

## Commits

| Hash | Type | Subject |
|------|------|---------|
| `0d261ff` | feat | add src/ast/types.ts and extend ChatRecord.meta for Phase 5 |
| `e5159dc` | test | add failing skipPolicy unit tests (T-05-04 mitigation, RED) |
| `9d86492` | feat | implement skipPolicy with 500KB cap + 6 path patterns (GREEN) |
| `51b4cf9` | test | add failing AstFactory + contract source-grep tests (RED) |
| `dab0059` | feat | implement AstFactory registry + extension detection (GREEN) |

5 commits total. RED → GREEN cycle enforced for both TDD tasks (Task 2 + Task 3); Task 1 was non-TDD per plan (pure type module + frontend additive edit, no behavior to test beyond compile-time).

## Tests

- 20 new tests in `astSkipPolicy.test.ts` (Phase 5 Wave 1 — skipPolicy (T-05-04 mitigation) suite)
- 23 new behavior tests in `astTypesContract.test.ts` (Phase 5 Wave 1 — AstFactory behavior suite)
- 14 new source-grep tests in `astTypesContract.test.ts` (Phase 5 Wave 1 — types + factory + chat contract (source-grep) suite)

**Total: 57 new tests. Suite count 439 → 496 (no regressions, no skips changed).**

Verification command:
```
npx tsc && npm test
# → 496 passing (5s), 66 pending
```

Targeted run:
```
npx tsc && npm test -- --grep "Phase 5 Wave 1"
# → 57 passing (31ms)
```

## Deviations from Plan

**None — plan executed exactly as written.**

One process note (not a deviation): the plan's verify command for Task 2/3 was `npm run build && npx tsc && npm test`. In this repo `npm run build` only runs esbuild (bundles extension.ts), which does NOT compile test files into `dist/test/`. Running `npx tsc` (no flag, full emit) before `npm test` is required — same quirk Plan 04-05 documented in STATE.md decisions. Both tsc and npm test were run in the documented order; outcome matches plan.

## Threat surface

All 5 threats from 05-SPEC.md are accounted for in the threat_model table of the plan; T-05-04 is the only one with executable Wave 1 mitigation (the other four defer mitigation to Waves 2-4 as documented). No new threat surface was introduced beyond what the SPEC already cataloged.

## Wave 1 contract is locked

Downstream waves can now develop in parallel against:

- **Wave 2 (Plan 05-02 — JS/TS adapters):** imports `AstAdapter`, `SymbolIndex`, `ReferenceIndex`, `LanguageId` from `src/ast/types.ts`. Calls `registerAdapter('javascript', ...)` and `registerAdapter('typescript', ...)` at module-init time.
- **Wave 3 (Plan 05-03 — Python + fallback + Java/C++ stubs):** same imports + `registerAdapter('python', ...)`. Fallback adapter consumed by Wave 4 when `getAdapter(...)` returns null.
- **Wave 4 (Plan 05-04 — worker + AstAnalyzer):** imports `AnalyzePayload`, `AnalysisResponse`, `AnalysisResult` for IPC; calls `shouldSkip(rel, size)` to gate `changedFiles` entries before adding them to the payload.
- **Wave 5 (Plan 05-05 — SessionHost wiring):** stamps `AffectedSymbol[]` into the system-event `ChatRecord.meta.affectedSymbols` after AstAnalyzer returns; sets `meta.unsupportedLanguages` for SC-3 fallback signaling.

No file or signature in this plan needs to change for Waves 2-5 to do their work — the seam is stable.

## Self-Check: PASSED

- `src/ast/types.ts` FOUND (verified `[ -f ... ]`)
- `src/ast/skipPolicy.ts` FOUND
- `src/ast/AstFactory.ts` FOUND
- `src/test/suite/astSkipPolicy.test.ts` FOUND
- `src/test/suite/astTypesContract.test.ts` FOUND
- `src/types/chat.ts` modified (2 new optional fields + type-only import)
- Commits `0d261ff`, `e5159dc`, `9d86492`, `51b4cf9`, `dab0059` all present in `git log --oneline`
- `npx tsc --noEmit` exits 0
- `npm test` reports 496 passing
- `grep -c` thresholds met: types.ts exports=8 (>=8), skipPolicy=6 (>=4), AstFactory=11 (>=6), chat.ts=3 (>=2)
