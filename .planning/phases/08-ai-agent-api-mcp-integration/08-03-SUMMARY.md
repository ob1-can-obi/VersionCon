---
phase: 08-ai-agent-api-mcp-integration
plan: 03
subsystem: mcp-registry
tags: [phase-8, wave-1, registry, layer-2-runtime-gate, read-only, N-08-02, N-08-10, T-08-01, T-08-05, SC-3]

# Dependency graph
requires: [08-01]
provides:
  - "src/mcp/registry.ts — frozen READ_ONLY_TOOLS Set + registerReadOnlyTool factory (Layer 2 runtime read-only enforcement)"
  - "Two-point enforcement: registration-time throw + call-time {isError:true} return"
  - "Factory stamps annotations.readOnlyHint:true + openWorldHint:false on every tool (Pitfall 6 mitigation)"
  - "Wrapped handler catches user-handler exceptions and converts to {isError:true} (T-08-stack-leak mitigation)"
  - "N-08-02 gate green (READ_ONLY_TOOLS.has count = 3 in src/mcp/registry.ts)"
  - "N-08-10 proposed gate green (no server.registerTool outside registry.ts; asserted now, preserved by 08-06/07/08)"
  - "18 new tests in src/test/suite/mcpReadOnlyGate.test.ts (suite: 'Phase 8 — READ_ONLY_TOOLS / registerReadOnlyTool / N-08 gates')"
  - "Cumulative test count 1093 passing (was 1070 baseline; +18 from this plan, +5 from parallel 08-02)"
affects: [08-04, 08-05, 08-06, 08-07, 08-08, 08-09]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Layer-2 runtime enforcement pattern: frozen Set allow-list + factory that re-checks at registration AND at call time"
    - "Annotation-stamping factory: handlers never set annotations themselves; the factory owns them — Pitfall 6 mitigation by construction"
    - "Exception-conversion wrapping: try/catch around the user handler converts unhandled errors to {isError:true} with String(err.message) only — no stack-trace leak"
    - "Injected-log discipline: factory accepts an optional `log: (line: string) => void` sink (OutputChannel-backed in production) — NEVER console.* (N-08-04)"
    - "Test pattern for frozen-Set call-time-gate exercise: override Set.prototype.has for the duration of the test rather than mutating the instance (which is frozen)"
    - "Source-grep gate test pattern from PATTERNS.md mcpReadOnlyGate.test.ts: fs.readdir + recursive walk + per-line regex offender-collection (matches uriHandlerBootstrapToken.test.ts idiom)"

key-files:
  created:
    - src/mcp/registry.ts (188 lines)
    - src/test/suite/mcpReadOnlyGate.test.ts (430 lines, 18 tests)
    - .planning/phases/08-ai-agent-api-mcp-integration/08-03-SUMMARY.md (this file)
  modified: []

key-decisions:
  - "Used `import * as z from 'zod'` (root export) instead of `import * as z from 'zod/v4'` (RESEARCH §A.2 alternate). Both paths exist in zod@3.25.76 and SDK 1.29.0 works with either; the root export is the standard recommended path in zod@3.25 and avoids tying us to the v4-namespace surface which the SDK may evolve. The generic `T extends z.ZodRawShape` is identical in both."
  - "Set.prototype.has override pattern for the call-time gate test. `READ_ONLY_TOOLS` is Object.freeze'd (preventing `(set as any).has = ...` on the instance), so the test exercises the rare 'prototype tampering' threat the registry.ts JSDoc explicitly documents as the belt-and-suspenders rationale. The override is bracketed in a try/finally to restore Set.prototype.has after the test."
  - "Type-coercion `(server as any).registerTool(...)` inside the factory body. The SDK's registerTool overloads on @modelcontextprotocol/sdk@1.29.0 have a complex generic ZodRawShape signature that does not infer cleanly through our wrapper's `<T extends z.ZodRawShape>` generic plus the spread `{...meta, annotations: ...}` literal. The `as any` is scoped to ONE call site, types are recovered at the closure boundary (handler typed `(args: z.objectInputType<T,...>, _extra: unknown): Promise<CallToolResult>`), and the factory's user-facing surface is still fully typed. Documented in the file with an eslint-disable comment."
  - "Added a 4th call-time-gate test (`wrapped handler converts unhandled exceptions to {isError:true}` plus the `log function invocation` test) beyond the plan's minimum 8-test floor. These exercise T-08-stack-leak (no stack-trace in error message) and confirm the operator-log path is wired — both small additions that catch regressions cheaply."
  - "Added a 'throws on a write-shaped name (push_change)' registration-time test as an explicit T-08-05 elevation-attempt scenario. The plan's <behavior> lists generic 'throws on unknown name' but the SC-3 lock makes the write-shape case worth a dedicated test."
  - "Test file path-resolution via `process.cwd()` not `__dirname`. Matches the canonical project idiom in src/test/suite/uriHandlerBootstrapToken.test.ts:25 (`process.cwd() + 'src/extension.ts'`). The Mocha test harness sets cwd to the repo root."
  - "Test file uses node:fs/promises and node:fs (built-in). Zero new runtime deps."

patterns-established:
  - "Pattern: two-point runtime enforcement via a frozen Set allow-list + factory wrapper. ANY future allow-list-gated registration code in the codebase can follow the same shape: (1) frozen Set, (2) registration-time throw, (3) wrapped handler with call-time re-check, (4) annotation/metadata stamp at the same site."
  - "Pattern: prototype-level mutation in tests to exercise frozen-instance gates. When Object.freeze prevents instance mutation, override the corresponding prototype method for the duration of the test (`Set.prototype.has`, `Map.prototype.get`, etc.) with a try/finally restore. This is the cleanest way to test 'what if the gate were tampered with' scenarios on frozen data structures."
  - "Pattern: factory-owned annotations stamping. By centralizing `annotations: {readOnlyHint, openWorldHint}` in registerReadOnlyTool, no tool handler can accidentally ship without the read-only badge. Source-grep test asserts this (registry.ts contains 'readOnlyHint: true' literal); future tools' per-tool tests can assert via the same registerTool capture pattern."
  - "Pattern: source-grep test as a structural gate (proposed N-08-10). The grep is run from a Mocha test (fs.readdir + walk + per-line regex), so it lights up red the moment a downstream plan adds a forbidden call site. Matches the Phase 7 T-07-XX gate test family."

requirements-completed: [AI-01]

# Metrics
duration: 6min
completed: 2026-05-21
---

# Phase 8 Plan 03: Registry + READ_ONLY_TOOLS Gate Summary

**Layer-2 runtime read-only enforcement landed. Frozen 7-name allow-list Set + factory that throws at registration time and rejects at call time with `{isError:true}`. Factory stamps `annotations.readOnlyHint:true` on every tool — no handler can accidentally ship without the read-only badge. 18 new tests; N-08-02 + N-08-10 source-grep gates green.**

## Performance

- **Duration:** ~6 min (start 2026-05-21T09:34:19Z; end 2026-05-21T09:40:13Z)
- **Tasks:** 1 (single-task plan)
- **Files created:** 3 (registry.ts, mcpReadOnlyGate.test.ts, this SUMMARY)
- **Files modified:** 0
- **Tests added:** 18 (1070 baseline -> 1093 passing; +18 from this plan + 5 from parallel 08-02)
- **Atomic commits:** 1 test commit (RED) + 1 feat commit (GREEN) + 1 metadata commit (this SUMMARY)

## Accomplishments

- **`src/mcp/registry.ts` (188 lines)** ships the Layer 2 runtime read-only gate:
  - `READ_ONLY_TOOLS: ReadonlySet<string>` — `Object.freeze(new Set([...]))` containing exactly the 7 expected tool names verbatim per CONTEXT D-3 and the plan's must_haves.
  - `RegisterReadOnlyToolMeta<T extends z.ZodRawShape>` interface for tool metadata (title, description, raw zod shape).
  - `registerReadOnlyTool<T extends z.ZodRawShape>(server, name, meta, handler, log?)` factory with TWO enforcement points:
    1. **Registration-time:** throws synchronously if `name` is not in `READ_ONLY_TOOLS` (catches misnaming at module load).
    2. **Call-time:** wrapped handler re-checks `READ_ONLY_TOOLS.has(name)` inside the closure and returns `{isError:true}` on rejection — belt-and-suspenders defense against the T-08-frozen-set-bypass scenario.
  - **Annotation stamping:** the factory spreads `annotations: { readOnlyHint: true, openWorldHint: false }` into every `server.registerTool` call. Handlers NEVER set their own annotations (Pitfall 6 mitigation).
  - **Exception conversion:** the wrapped handler wraps the user handler in try/catch and converts any uncaught error to `{isError:true, content:[{text: 'Tool $name failed: <message>'}]}`. Stack traces never leak into the model prompt (T-08-stack-leak).
  - **Logger discipline:** the factory accepts an optional `log: (line: string) => void` parameter (default no-op). All diagnostic lines go through `log` only — NEVER `console.*` (N-08-04 preserved).

- **`src/test/suite/mcpReadOnlyGate.test.ts` (430 lines, 18 tests across 7 suites)** ships the behavioral + structural test coverage:
  - **Suite 1 — READ_ONLY_TOOLS allow-list content (4 tests):** size=7; positive presence of all 7 expected names; SC-3 negative (no `push_`/`create_`/`update_`/`delete_`/`set_`/`send_`/`commit_`/`merge_`/`revert_`-prefixed names); `Object.isFrozen` true.
  - **Suite 2 — registerReadOnlyTool registration-time gate (5 tests):** throws on unknown name (with message regex `/not in READ_ONLY_TOOLS/`); does NOT throw on valid name; throws on pluralized typo (`get_branch_statuses`); throws on write-shaped name (`push_change`) — T-08-05 elevation attempt; annotations.readOnlyHint:true + openWorldHint:false stamp present.
  - **Suite 3 — registerReadOnlyTool call-time gate, defense-in-depth (3 tests):** wrapped handler returns `{isError:true}` when `Set.prototype.has` is patched to return false for the tool name (plan-checker WARNING 1 coverage); user handler is NOT invoked; rejection message matches `/not on the read-only allow-list/`. Unhandled exception in user handler → `{isError:true}` with String(message) only (NO stack-trace frame matching `/at <funcName> \(/`). Log function invoked on call-time gate rejection.
  - **Suite 4 — N-08-02 source-grep:** `READ_ONLY_TOOLS.has` count in `src/mcp/` >= 1 (actual: 3 in registry.ts).
  - **Suite 5 — N-08-10 proposed source-grep:** `server.registerTool` occurrences in `src/mcp/` outside `registry.ts` == 0.
  - **Suite 6 — N-08-04 preserved:** no `^\s*console\.` in `src/mcp/registry.ts`.
  - **Suite 7 — registry.ts contract source-greps (3 tests):** `Object.freeze(new Set(...))` literal present; all 7 expected names present as string literals; no write-shape literal regex matches.

- **TypeScript clean:** `npx tsc --noEmit -p .` exits 0.
- **All N-08 gates relevant to this plan are green** (see <verification> section below).
- **Cumulative test count:** 1093 passing (was 1070 baseline; this plan +18, parallel plan 08-02 +5 = +23 delta).

## The 7 Names Committed to READ_ONLY_TOOLS (Verbatim)

```typescript
export const READ_ONLY_TOOLS: ReadonlySet<string> = Object.freeze(new Set<string>([
  'get_branch_status',
  'get_sync_status',
  'get_recent_activity',
  'get_chat_log',
  'query_dependencies',
  'list_dependents',
  'advise_sync',
]));
```

Exactly matches the catalog locked in CONTEXT.md decisions item 2.

## Factory Signature (Verbatim)

```typescript
export function registerReadOnlyTool<T extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  meta: RegisterReadOnlyToolMeta<T>,
  handler: (args: z.objectInputType<T, z.ZodTypeAny>) => Promise<CallToolResult>,
  log?: (line: string) => void,
): void
```

Where:
- `T extends z.ZodRawShape` — generic that propagates zod input types through to the handler. Future tool files (08-06/07/08) get full type safety on their `args` parameter.
- `RegisterReadOnlyToolMeta<T>` = `{ title: string; description: string; inputSchema: T }`. `inputSchema` is a raw zod shape object (NOT `z.object(...)` — per RESEARCH §A.3 gotcha).
- `log` defaults to no-op when absent. In production it is bound to the `VersionCon: MCP` OutputChannel via `getMcpOutputChannel` (plan 08-05).

## Two Layers of Runtime Checking

| Layer | Where | Behavior |
|---|---|---|
| **Registration-time** | Lines 121-125 of registry.ts (top of factory body) | `if (!READ_ONLY_TOOLS.has(name)) throw new Error(\`registerReadOnlyTool: '\${name}' not in READ_ONLY_TOOLS allow-list\`)` — synchronous throw at module load, NOT at first call |
| **Call-time** | Lines 137-149 of registry.ts (inside wrapped handler) | `if (!READ_ONLY_TOOLS.has(name)) { if(log) log(...); return { content:[...], isError: true }; }` — belt-and-suspenders defense against prototype tampering |

Both gates source the SAME `READ_ONLY_TOOLS.has(name)` predicate. The call-time check is genuinely a re-check (not a duplicate) because the closure runs at a different point in the JS engine's lifecycle than the factory body.

## Annotations Stamp Confirmation

```typescript
// inside registerReadOnlyTool body, line ~133:
(server as any).registerTool(
  name,
  {
    ...meta,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  /* wrapped handler */,
);
```

The `annotations` object is spread INTO the meta argument by the factory. No tool handler file can override or omit this — the factory is the ONLY legal path. Verified by:
- Source-grep test: `grep -c 'readOnlyHint: true' src/mcp/registry.ts = 2` (declared in JSDoc + the literal stamp).
- Behavioral test: factory captured via monkeypatched `server.registerTool` asserts `meta.annotations.readOnlyHint === true` AND `meta.annotations.openWorldHint === false`.

## Test Count Delta + Cumulative

| Before | After | Delta | Notes |
|---|---|---|---|
| 1070 passing | 1093 passing | +23 | This plan +18; parallel 08-02 plan +5 |
| 66 pending | 66 pending | 0 | No pending added/removed |
| 0 failing | 0 failing | 0 | No regression |

Plan floor was >= 1034 cumulative; actual 1093 (well above floor; baseline was already at 1070 from 08-01 + 08-08 docs commit).

## Source-Grep Gate Results (Verbatim)

```bash
# N-08-01 (Read-only structural): no src/auth imports in src/mcp/
grep -rE 'import.*from.*src/auth' src/mcp/ | wc -l
# Expected: 0   Actual: 0   PASS

# N-08-02 (Read-only runtime): READ_ONLY_TOOLS.has wired
grep -c "READ_ONLY_TOOLS\.has" src/mcp/registry.ts
# Expected: >= 2   Actual: 3   PASS

# N-08-04 (No console.* in src/mcp/): logger discipline
grep -rE '^\s*console\.' src/mcp/ | wc -l
# Expected: 0   Actual: 0   PASS

# N-08-10 proposed (server.registerTool only in registry.ts)
grep -rn "server.registerTool" src/mcp/ | grep -v "src/mcp/registry.ts" | wc -l
# Expected: 0   Actual: 0   PASS

# Set frozen
grep -c "Object.freeze" src/mcp/registry.ts
# Expected: >= 1   Actual: 1   PASS

# annotations.readOnlyHint stamped
grep -c "readOnlyHint: true" src/mcp/registry.ts
# Expected: >= 1   Actual: 2   PASS

# Seven names present (positive)
grep -c "get_branch_status\|get_sync_status\|get_recent_activity\|get_chat_log\|query_dependencies\|list_dependents\|advise_sync" src/mcp/registry.ts
# Expected: 7   Actual: 7   PASS

# SC-3 negative (no write-shaped names in Set literal)
grep -c "'push_\|'create_\|'update_\|'delete_\|'send_" src/mcp/registry.ts
# Expected: 0   Actual: 0   PASS
```

## Task Commits

Each phase of TDD + the metadata commit are separate:

1. **RED phase — Task 1 failing tests:** `5484da1` (test) — `test(08-03): RED — failing tests for READ_ONLY_TOOLS + registerReadOnlyTool`
2. **GREEN phase — Task 1 implementation:** `c83d524` (feat) — `feat(08-03): GREEN — registry.ts + READ_ONLY_TOOLS + registerReadOnlyTool factory`
3. **Plan metadata** — this commit (`docs(08-03): SUMMARY`)

## Decisions Made

See frontmatter `key-decisions` block for the full list. Highlights:

1. **zod import path:** used `'zod'` (root) instead of `'zod/v4'` — both work, root is the standard recommended path in zod@3.25 and avoids SDK-evolution risk.
2. **Call-time gate test pattern:** override `Set.prototype.has` for the test scope (Object.freeze prevents instance mutation). Restored in try/finally.
3. **Type coercion at one call site:** `(server as any).registerTool(...)` inside the factory body. The SDK's overloads don't infer cleanly through our `<T extends z.ZodRawShape>` generic + meta spread; the user-facing surface stays fully typed. ESLint comment marks the scope.
4. **Added 4th call-time-gate test:** unhandled exception conversion (T-08-stack-leak coverage).
5. **Added explicit write-shape (`push_change`) registration test:** explicit T-08-05 elevation-attempt scenario.

## Deviations from Plan

None. The plan was executed exactly as written. The four "additions" above (added tests for stack-leak, log-invocation, write-shape, and the `node:fs/promises` import in tests) are within the plan's "at least 8 tests" minimum (actual: 18) and serve as defense-in-depth coverage.

The `(server as any).registerTool` type-coercion was anticipated by the plan body's `<action>` block being a verbatim copy from RESEARCH §A.5; the RESEARCH excerpt is a pseudo-typed sketch that the actual SDK 1.29.0 type signatures don't accept without a coercion. The coercion is scoped to one call site, all user-facing types are preserved, and the behavior is unchanged.

## Issues Encountered

- **Parallel execution race with 08-02:** the dispatcher noted 08-02 was running concurrently and modifying `src/mcp/readers.ts`. During my first `npx tsc --noEmit` invocation, readers.ts was mid-write and had a syntax error in a JSDoc block (`get*/list*/query*/` contained a `*/` that closed the JSDoc comment). I did NOT touch readers.ts (per dispatcher critical-rules); a few seconds later 08-02 had re-saved the file with corrected prose comments and tsc was clean. No remediation needed on my side. Documented as a non-blocker.
- **Object.freeze blocks instance mutation in tests:** the initial test attempt monkeypatched `(READ_ONLY_TOOLS as any).has = ...` and ran into `TypeError: Cannot add property has, object is not extensible`. The fix was to override `Set.prototype.has` instead (with try/finally restoration) — actually a STRONGER test because it exercises the exact "prototype tampering" attack scenario the registry.ts JSDoc cites as the rationale for the call-time gate. Tracked as a key-decision, not a deviation.
- **`npm test` lock contention with parallel 08-02:** vscode-test cannot run while another VS Code test instance is active. I bypassed by running `npx mocha dist/test/suite/mcpReadOnlyGate.test.js` directly during iteration (since my test file has no `vscode` import surface — pure Node + MCP SDK + node:fs), then ran the full `npm test` once 08-02's test harness released. Final cumulative count: 1093 passing.

## User Setup Required

None — no external service configuration. The registry is a pure in-process module; tests run hermetically.

## Next Phase Readiness

**Wave 1 complete (08-02 + 08-03 both shipped in parallel). Wave 2 unblocked.**

The registry exposes the two primary symbols that downstream plans consume:

1. **`READ_ONLY_TOOLS` ReadonlySet** — imported by `src/mcp/buildServer.ts` (08-04) for any `tools/list` shape assertion, and by `src/mcp/server.ts` (08-04) if a defense-in-depth check is added there.
2. **`registerReadOnlyTool<T>` factory** — imported by every `src/mcp/tools/*.ts` file in plans 08-06/07/08. Each tool handler calls this factory exactly once with its tool name, metadata, and handler closure.

Confirmation per dispatcher prompt:
- `src/mcp/registry.ts` exists: **yes** (188 lines, 7-name frozen Set, factory exported)
- `src/test/suite/mcpReadOnlyGate.test.ts` exists: **yes** (430 lines, 18 tests, all passing)
- N-08-02 source-grep gate green: **yes** (`READ_ONLY_TOOLS.has` count = 3 in src/mcp/registry.ts; >= 1 required)
- N-08-10 proposed source-grep gate green: **yes** (`server.registerTool` outside registry.ts = 0)
- N-08-04 preserved: **yes** (no console.* in src/mcp/)
- Call-time gate exercised by a synthetic "unregistered tool" test: **yes** (plan-checker WARNING 1 coverage — `Set.prototype.has` monkeypatch test asserts wrapped handler returns `{isError:true}` and does NOT delegate to the user handler)
- `npx tsc --noEmit` exits 0: **yes**
- Cumulative tests >= 1034: **yes** (1093 passing)

**No blockers. Wave 2 (plan 08-04: buildServer + lifecycle wiring) can start immediately.**

## TDD Gate Compliance

This plan's task had `tdd="true"`. Gate sequence verified in git log:
- ✓ **RED gate** — `test(08-03): RED — failing tests for READ_ONLY_TOOLS + registerReadOnlyTool` (commit `5484da1`)
- ✓ **GREEN gate** — `feat(08-03): GREEN — registry.ts + READ_ONLY_TOOLS + registerReadOnlyTool factory` (commit `c83d524`)
- (REFACTOR phase not needed — implementation was final on first GREEN run)

The RED commit landed the test file with a deliberate compile failure (`Cannot find module '../../mcp/registry.js'`). The GREEN commit landed registry.ts AND a small test-pattern revision (`Set.prototype.has` override) to make the call-time gate test exercise the documented attack scenario; both files committed together as the GREEN step.

---

## Self-Check: PASSED

- [x] `src/mcp/registry.ts` exists (188 lines, contains `READ_ONLY_TOOLS`, `registerReadOnlyTool`, `Object.freeze`, `readOnlyHint: true`, all 7 expected names)
- [x] `src/test/suite/mcpReadOnlyGate.test.ts` exists (430 lines, 18 tests across 7 suites, all passing)
- [x] Commit `5484da1` exists in git log (`test(08-03): RED ...`)
- [x] Commit `c83d524` exists in git log (`feat(08-03): GREEN ...`)
- [x] `npx tsc --noEmit -p .` exits 0
- [x] `npm test` reports 1093 passing, 0 failing
- [x] `grep -c "READ_ONLY_TOOLS\\.has" src/mcp/registry.ts` = 3 (>= 2 required)
- [x] `grep -c "readOnlyHint: true" src/mcp/registry.ts` = 2 (>= 1 required)
- [x] `grep -c "Object.freeze" src/mcp/registry.ts` = 1 (>= 1 required)
- [x] `grep -rE '^\\s*console\\.' src/mcp/` = 0 lines (N-08-04 preserved)
- [x] `grep -rn "server.registerTool" src/mcp/ | grep -v registry.ts | wc -l` = 0 (N-08-10 proposed)
- [x] `grep -rE 'import.*from.*src/auth' src/mcp/` = 0 lines (N-08-01 preserved)
- [x] No modifications to `src/network/`, `relay/`, or `src/auth/` (N-08-05/06 preserved)
- [x] Plan-checker WARNING 1 satisfied: call-time gate test rejects synthetic unregistered-tool call with `{isError:true}`

---
*Phase: 08-ai-agent-api-mcp-integration*
*Completed: 2026-05-21*
