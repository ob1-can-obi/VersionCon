---
plan: 05-04
phase: 05-dependency-aware-conflict-detection-ast
title: Worker (forked Node process) + AstAnalyzer (host coordinator) + joinImpact
status: complete
completed: 2026-05-11
mode: autonomous
wave: 4
depends_on:
  - "05-02"
  - "05-03"
subsystem: ast-worker
tags: [phase-5, wave-4, worker, ipc, analyzer, joinImpact, T-05-01, T-05-02, T-05-03, T-05-05]
provides:
  - "AstAnalyzer host-side coordinator (Promise<AnalysisResult> API for Wave 5)"
  - "src/ast/worker.ts forked Node entry point (dist/ast-worker.js)"
  - "joinImpact pure-fn symbol/reference join (file-scoped, T-05-05 mitigation)"
  - "esbuild config: third context bundling the worker + import.meta.url shim"
  - "Test fixture infrastructure (stub-worker + canary-worker + dist copy step)"
key-files:
  created:
    - src/ast/joinImpact.ts
    - src/ast/worker.ts
    - src/ast/AstAnalyzer.ts
    - src/test/suite/astJoinImpact.test.ts
    - src/test/suite/astAnalyzer.test.ts
    - src/test/suite/astWorkerIntegration.test.ts
    - src/test/fixtures/ast-stub-worker.js
    - src/test/fixtures/ast-no-fork-canary.js
  modified:
    - esbuild.config.mjs
decisions:
  - "web-tree-sitter BUNDLED into the worker (not externalized) — pure CJS module bundles cleanly; avoids runtime node_modules lookup; WASM grammars + the runtime engine WASM still live in dist/vendor/tree-sitter/ as separate files copied by copyTreeSitterGrammars."
  - "import.meta.url SHIM via esbuild define+banner — emscripten loader calls createRequire(import.meta.url); esbuild's CJS bundler stubs import.meta.url to undefined. Banner injects `__importMetaUrl = url.pathToFileURL(__filename).href` at module init; define aliases import.meta.url to that. Fix discovered during integration testing (Rule 3 — auto-resolve a blocker)."
  - "Worker exit handler is worker-identity-guarded — captures the specific child reference and only nullifies this.worker / settles pending requests when this.worker === child. Without this, a stale exit event from a previously-killed worker would clobber a freshly re-forked worker. Discovered during circuit auto-recovery + dispose-then-re-fork tests."
  - "joinImpact import-bridge supports DOTTED method names — when the changed symbol is `A.bar` and a consumer imports `A` (the class), the import-bridge matches the root name. Preserves T-05-05 file-scoping while supporting class-method changes."
  - "Stub worker fixture is plain JS (not TS) — tsc does not compile fixture .js files; esbuild's copyTestFixtures step mirrors src/test/fixtures/*.js into dist/test/fixtures/ at build time."
  - "crash-once stub uses a GLOBAL sentinel file (STUB_CRASH_FLAG env) — each forked process starts with callCount=0, so a per-process counter wouldn't model 'crash once across the analyzer's lifetime'. Sentinel-file approach works across re-forks."
  - "Circuit breaker resets the consecutiveFailures counter to 0 after opening — the cooldown timer is the gate, not the counter. After cooldown, the next analyzeChange tries again; if it also fails, the counter starts fresh."
metrics:
  duration: "~75 min (Tasks 1-4 + esbuild bundling fix + integration debugging)"
  completed: 2026-05-11
  tasks: 4
  files: "6 created (3 src + 3 test) + 2 fixtures + 1 modified (esbuild config)"
  tests_added: 51
  tests_total_before: 604
  tests_total_after: 655
---

# Phase 5 Plan 04: AstAnalyzer + AstWorker + joinImpact — Summary

**One-liner:** SC-2 architecturally satisfied — AST work runs in a long-lived forked Node child via `child_process.fork('dist/ast-worker.js')` while the host process retains a thin Promise-based `analyzeChange()` coordinator with T-05-01 (3-strike circuit), T-05-02 (5s timeout), T-05-03 (segment-aware path validation), and T-05-05 (file-scoped symbol join) all unit-tested via stub + integration paths.

## What shipped

### Source files (3 new)

**`src/ast/joinImpact.ts`** — pure-fn symbol/reference join. Diffs pre/post `SymbolIndex` by name + line; emits added/removed/modified `ChangedSymbol[]`. For each change, walks every member's `ReferenceIndex` map and applies the **strict import-bridge gate** (T-05-05): a reference counts as a caller only if the ref-file imports the changed symbol's name (or its root class name for dotted methods like `A.bar`) FROM the changed file. Best-effort path normalization handles `./cart-helpers` ⇄ `cart-helpers.ts`, `./cart/index` ⇄ `cart.ts`. Determinism: `affectedSymbols` sorted by `(changedIn, name)`; callers sorted by displayName then line. `perMember` regroup excludes members with zero attributions.

**`src/ast/worker.ts`** — forked-process entry. Boots `Parser.init()` via grammars.ts then side-effect-imports all 5 adapters (cpp, java, javascript, python, typescript). Per `AnalyzePayload` message: gates each file via `skipPolicy.shouldSkip`, gets the adapter for the detected language, awaits `prepare(relativePath)`, runs `extractSymbols(pre)` + `extractSymbols(post)` for changed files, runs `extractReferences(content)` for every member tracked file. Each extract* call wrapped in try/catch — one bad file feeds the `unsupportedLanguages` set but does NOT poison the pass (T-05-01 partial mitigation). Calls `joinImpact` with the per-file pre/post maps + member reference maps + display names; responds via `process.send({ requestId, ok, result|error })`. `uncaughtException` handler is best-effort: notify parent + exit(1); parent re-forks lazily on next call.

**`src/ast/AstAnalyzer.ts`** — host-side coordinator. Public API: `new AstAnalyzer(workspaceRoot, branchDir, opts?)` + `.analyzeChange(args): Promise<AnalysisResult>` + `.dispose()`. Owns ONE long-lived `child_process.fork()`'d worker, lazy-forked on first qualifying call. Each request: `validateAndFilter` (T-05-03), forward to worker with crypto.randomUUID() requestId, race response against per-request `setTimeout` (T-05-02 default 5s, tests override to 50–200ms). On any of (worker `ok:false`, timeout, exit-before-reply) increment `consecutiveFailures`; after 3 in a row open the 30s circuit (T-05-01 — short-circuits without forking; auto-recovers when `circuitOpenUntil <= now()`). Worker exit handler captures `child` reference and guards with `this.worker === child` so a stale exit cannot clobber a re-forked worker.

### Test fixtures (2 new)

**`src/test/fixtures/ast-stub-worker.js`** — 60-line deterministic stub for unit tests. `STUB_MODE` env-var dispatch: `echo` (default — reply with synthetic `AnalysisResult` containing one affectedSymbol), `never-reply` (drives T-05-02 timeout tests), `crash-once` (uses `STUB_CRASH_FLAG` sentinel file — global-across-forks first-call-crashes pattern; drives T-05-01 recovery test), `crash-always`, optional `STUB_DELAY_MS` for concurrency.

**`src/test/fixtures/ast-no-fork-canary.js`** — writes a sentinel file (`CANARY_SENTINEL_PATH` env) on first IPC message. Path-validation tests assert the sentinel does NOT exist after the call — proves the analyzer never forked when every input path was unsafe.

### Test suites (3 new)

| Suite                                                            | Count | Purpose                                                                                                                          |
| ---------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `astJoinImpact.test.ts` — "Phase 5 Wave 3 — joinImpact (T-05-05)" | 23    | Pure-fn join: empty/degenerate, added/removed/modified detection, caller enumeration, T-05-05 cross-file collision rejection, import-bridge invariant, import-path normalization (./foo ⇄ foo.ts), class-method (A.bar) gating, import/export changes, variable value-only NOT detected (v1), perMember regroup, determinism sort. |
| `astAnalyzer.test.ts` — "Phase 5 Wave 3 — AstAnalyzer (T-05-01/02/03)" | 19    | Stub-driven: 8 path-rejection cases + safe-paths-accepted + 2 mTF cases + timeout (T-05-02, never-reply stub @ 200ms) + crash-once recovery (T-05-01) + 3-strike open-circuit + 30s cooldown auto-recovery (fake clock) + concurrent + dispose + post-dispose re-fork. |
| `astWorkerIntegration.test.ts` — "Phase 5 Wave 3 — AstAnalyzer integration" | 9     | END-TO-END real worker + real WASMs: JS attribution, TS+TSX routing, Python attribution, Java fallback (no semantic attribution), mixed JS+Java in one push, no-impact green path, T-05-04 large-file neighbor, worker reuse across 3 sequential calls, dispose terminates worker. |

### Build-config changes (1 modified)

**`esbuild.config.mjs`** — three additions:

1. Third `esbuild.context()` for `src/ast/worker.ts` → `dist/ast-worker.js` (CJS / platform:node / target:node18 / external:['vscode']).
2. `copyTestFixtures()` mirrors `src/test/fixtures/*.js` into `dist/test/fixtures/` on every build (initial + onEnd hook). Tsc doesn't emit raw .js inputs; this gives the AstAnalyzer test suite a stable fixture path.
3. `import.meta.url` shim (`define` + `banner`) — web-tree-sitter's emscripten loader calls `createRequire(import.meta.url)` to derive `scriptDirectory` and require Node built-ins. When esbuild bundles ESM to CJS, `import.meta.url` is stubbed to undefined; the loader throws `'filename' must be a file URL ... Received undefined` before any WASM load attempt. Fix: define maps `import.meta.url` to `__importMetaUrl`; the banner sets `__importMetaUrl = require('url').pathToFileURL(__filename).href` at module init.

## Commits

| Hash      | Type     | Description                                                                  |
| --------- | -------- | ---------------------------------------------------------------------------- |
| `4076c70` | test     | add failing joinImpact unit tests (TDD RED)                                  |
| `0a676ec` | feat     | implement joinImpact pure-fn symbol/reference join (TDD GREEN)                |
| `df58c7e` | feat     | add forked AST worker entry + esbuild bundle config                          |
| `9dc744c` | chore    | add stub worker fixtures + esbuild copy step                                 |
| `1a1cf5e` | test     | add failing AstAnalyzer unit tests (TDD RED)                                 |
| `8ceecf3` | feat     | implement AstAnalyzer host-side coordinator (TDD GREEN)                      |
| `af91d79` | fix      | alias import.meta.url to file://__filename in worker bundle                  |
| `54d1044` | test     | add end-to-end AstAnalyzer integration suite (9 tests)                       |

## T-05-01/02/03/05 mitigation evidence

| Threat   | Mitigation                                                                    | Pinned by                                                                                                            |
| -------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| T-05-01  | Worker exit handler + 3-strike circuit + 30s cooldown                         | `astAnalyzer.test.ts` "crash-once → empty then re-fork succeeds", "3 timeouts open the circuit", "circuit auto-recovers after 30s cooldown elapses" |
| T-05-02  | `setTimeout(timeoutMs)` Promise.race + worker SIGTERM + circuit increment     | `astAnalyzer.test.ts` "never-reply stub triggers timeout — empty result returned" (200ms timeout test)              |
| T-05-03  | `validateAndFilter` segment-aware (`segments.includes('..')`) + abs-path + backslash + drive-letter rejects | `astAnalyzer.test.ts` 8 path-rejection cases + canary "every path rejected → no fork" + memberTrackedFiles filter test |
| T-05-04  | `shouldSkip` re-check in worker (defense-in-depth)                            | `astWorkerIntegration.test.ts` "600KB neighbor does not block analysis of smaller file"                              |
| T-05-05  | File-scoped import-bridge gate in joinImpact                                  | `astJoinImpact.test.ts` "symbol name collision across files — only correct file attributed" + 9 integration tests using real imports |

## Worker bundle integrity

| Check                                                | Result                  |
| ---------------------------------------------------- | ----------------------- |
| `dist/ast-worker.js` exists                          | ✓ 91KB                  |
| `grep -c "require['\"]vscode['\"]"` in worker bundle | 0 (vscode not imported) |
| `grep -c "segments.includes('..')"` in AstAnalyzer.ts | 2 (validation + JSDoc reference) |
| `grep -c "child_process"` in AstAnalyzer.ts          | 2 (import + JSDoc)      |
| `npx tsc --noEmit`                                   | clean                   |
| `npm run build`                                      | clean (extension + chat + worker contexts) |

## Integration test runtime

9 integration tests, ~75-100ms each (warmest run after WASM cache primed) = ~800ms total. Acceptable for the value (catches real-WASM ABI breakage, esbuild bundling regressions, vendor path resolution failures, T-05-05 file-scoping under real adapter output — none of which the stub-worker unit tests can catch).

## Tests

- **Pre-wave baseline:** 604 passing (after Waves 1-3)
- **Post-wave total:** **655 passing**, 0 failing
- **Added this wave:** 51 (joinImpact 23 + analyzer 19 + integration 9)

## Deviations from plan

### Rule 3 — auto-fixed blocking issue

**1. import.meta.url stub breaks web-tree-sitter in CJS worker bundle**

- **Found during:** Task 4 integration test (first run after `npm run build`)
- **Issue:** Worker forked successfully but every analyzeChange returned `ok: false` with error `'filename' must be a file URL object, file URL string, or absolute path string. Received undefined`. Traced to web-tree-sitter's emscripten loader calling `createRequire(import.meta.url)` — esbuild's CJS bundle stubs `import.meta` to `{}`, so `import.meta.url` is undefined.
- **Fix:** esbuild `define` + `banner` shim. Define maps `import.meta.url` → `__importMetaUrl`; banner sets `__importMetaUrl = require('url').pathToFileURL(__filename).href` at module init. Worker now boots web-tree-sitter cleanly and loads WASM grammars.
- **Files modified:** `esbuild.config.mjs`
- **Commit:** `af91d79`

### Rule 1 — bug fixed in worker exit race

**2. Worker exit handler clobbered freshly re-forked worker**

- **Found during:** Task 3 AstAnalyzer tests — circuit auto-recover and post-dispose re-fork tests failed (2ms elapsed instead of ~50ms; r2 empty after dispose+re-fork).
- **Issue:** The 'exit' handler called `this.worker = null` and walked `this.pending` to settle requests with `ok: false`. But it captured `this` via the closure, not the specific child reference. When a previously-killed worker's exit event fired AFTER the analyzer had already re-forked a new worker, the stale handler clobbered the new worker handle + settled pending requests belonging to the new worker.
- **Fix:** Capture the specific `child` ChildProcess in the handler closure and guard all state mutations on `this.worker === child`. Stale exit events become no-ops.
- **Files modified:** `src/ast/AstAnalyzer.ts`
- **Commit:** `8ceecf3` (incorporated into the GREEN commit)

### Rule 1 — adjusted joinImpact import-bridge to support dotted methods

**3. Import-bridge required exact name match — failed class-method changes**

- **Found during:** Task 1 joinImpact test "class with new method emits only the added method as a changed symbol"
- **Issue:** The class-method test changes `A.bar` and the consumer imports `A` (not `A.bar`). The strict `imp.name === change.name` gate rejected the bridge because `'A' !== 'A.bar'`.
- **Fix:** Compute `rootName = change.name.slice(0, change.name.indexOf('.'))` and let the bridge match either the full name OR the root name. Preserves T-05-05 file-scoping (import must still resolve `from` the changed file) while supporting class-method changes.
- **Files modified:** `src/ast/joinImpact.ts`
- **Commit:** `0a676ec` (incorporated into the joinImpact GREEN commit)

### Rule 1 — stub fixture rework for cross-fork crash modeling

**4. crash-once stub mode reset per fork, not globally**

- **Found during:** Task 3 — crash recovery test fail
- **Issue:** Each forked stub process starts with `callCount = 0`. `crash-once && callCount === 1` triggers on the FIRST message of every fork — never recovers.
- **Fix:** Added `STUB_CRASH_FLAG` env — a file path that the stub checks before crashing. First fork: file doesn't exist → write it + crash. Second fork: file exists → fall through to echo. Models "crashes once across the analyzer's lifetime" correctly.
- **Files modified:** `src/test/fixtures/ast-stub-worker.js` + `src/test/suite/astAnalyzer.test.ts` (test passes `STUB_CRASH_FLAG`)
- **Commit:** `9dc744c` + `1a1cf5e`

### Integration test fixture content adjustments

**5. v1 "modified" detection requires line-number shift — fixtures rewritten**

- **Found during:** Task 4 integration tests (after import.meta.url fix)
- **Issue:** First-pass fixtures changed function BODIES but kept `function foo()` at line 1 in both pre and post. v1 joinImpact compares (name, line) — same line = unchanged. Tests failed because no symbols were "modified".
- **Fix:** Rewrote each fixture's `post` content to add a helper / header line ABOVE the changed function so its line genuinely shifts (line 1 → line 4, etc.). This is the documented v1 limitation (no content hash); a future plan can add `SymbolIndex.hash` and surface value-only diffs.
- **Files modified:** `src/test/suite/astWorkerIntegration.test.ts` (no source-code change — purely test fixtures)
- **Commit:** `54d1044`

## Authentication gates

None encountered.

## Known limitations / v1 scope reminders

1. **Value-only changes not detected** — variable reassignment without a line shift, function body edits that don't move the declaration. SymbolIndex needs a `hash?: string` field (Phase 5.x).
2. **Java / C++ fallback** — registered in AstFactory but route through FallbackAdapter, which has empty ReferenceIndex. No symbol-level attribution for these languages in v1. Wave 3 documented this; Wave 4 preserves it by surfacing `unsupportedLanguages: ['java']` in AnalysisResult.
3. **Path-base validation deferred** — `workspaceRoot` + `branchDir` constructor args are stored but the v1 `validateAndFilter` is rel-path-only (matches Plan 04-15 CR-03-NEW exactly). Wave 5 or a follow-up may extend the validator to require the joined absolute path stay under workspaceRoot OR branchDir.
4. **Worker reuse across mode changes** — `AstAnalyzer` is constructed with `env` once and that env is baked into the long-lived worker. Tests that change `STUB_MODE` per-test construct a fresh analyzer each test.

## Self-Check: PASSED

- src/ast/joinImpact.ts: FOUND
- src/ast/worker.ts: FOUND
- src/ast/AstAnalyzer.ts: FOUND
- src/test/suite/astJoinImpact.test.ts: FOUND
- src/test/suite/astAnalyzer.test.ts: FOUND
- src/test/suite/astWorkerIntegration.test.ts: FOUND
- src/test/fixtures/ast-stub-worker.js: FOUND
- src/test/fixtures/ast-no-fork-canary.js: FOUND
- esbuild.config.mjs: modified
- dist/ast-worker.js: present + 0 vscode imports
- Commit `4076c70`: FOUND (test 05-04 joinImpact RED)
- Commit `0a676ec`: FOUND (feat 05-04 joinImpact GREEN)
- Commit `df58c7e`: FOUND (feat 05-04 worker + esbuild)
- Commit `9dc744c`: FOUND (chore 05-04 fixtures)
- Commit `1a1cf5e`: FOUND (test 05-04 AstAnalyzer RED)
- Commit `8ceecf3`: FOUND (feat 05-04 AstAnalyzer GREEN)
- Commit `af91d79`: FOUND (fix 05-04 import.meta.url)
- Commit `54d1044`: FOUND (test 05-04 integration)

## TDD Gate Compliance

| Plan-level gate | Status                                                          |
| --------------- | --------------------------------------------------------------- |
| RED commits (test before impl) | `4076c70` (joinImpact) → `0a676ec` (joinImpact), `1a1cf5e` (analyzer) → `8ceecf3` (analyzer) — both gates ordered correctly |
| GREEN commits   | both followed RED                                               |
| REFACTOR        | not separately needed; the import.meta.url fix is a Rule 3 build-config patch, not a code refactor |
