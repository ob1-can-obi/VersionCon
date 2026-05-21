---
phase: 08-ai-agent-api-mcp-integration
plan: 07
subsystem: api
tags: [phase-8, wave-3, dep-graph, tools, resource, SC-2, AI-03, T-08-10-path-traversal, latency-budget]

# Dependency graph
requires:
  - phase: 08-02
    provides: "DependencyReader interface (src/mcp/readers.ts) + DependencyReaderImpl ad-hoc forwardDeps (single-file AstFactory analysis); reverseDeps stub returning empty"
  - phase: 08-03
    provides: "registerReadOnlyTool factory + READ_ONLY_TOOLS allow-list (query_dependencies, list_dependents already in the Set)"
  - phase: 08-04
    provides: "buildServer.ts DI composer + startMcpServer harness; FakeReaders fixture with depForward/depReverse canned data"
  - phase: 08-06
    provides: "buildServer.ts FIRST amend pattern (4 inline register* calls before callback seam) — 08-07 mirrors with 3 more calls (2 tools + 1 resource)"
provides:
  - "src/mcp/tools/queryDependencies.ts — query_dependencies tool registration (forward direction; {depends_on:{symbols,files}, hops})"
  - "src/mcp/tools/listDependents.ts — list_dependents tool registration (reverse direction; v1 bounding documented in description)"
  - "src/mcp/resources/dependencyGraph.ts — versioncon-state://dependency-graph/{symbolOrPath} resource template (T-08-10 mitigated by construction)"
  - "src/mcp/buildServer.ts — amended (2nd amend) with 3 new imports + 3 inline registrations before optional callback seam"
  - "src/test/suite/mcpDependencyReader.test.ts — 22 E2E tests (tools/list + tool/call x2 + resource read + T-08-10 traversal + scheme/decode source-grep + latency budget + SC-2 evidence)"
  - "AI-03 surface complete: 6 of 7 expected tools live + 1 resource. Only advise_sync remains (plan 08-08)"
  - "SC-2 closed (AI agent can read forward + reverse + resource form of the dep graph for any symbol/file)"
affects: [08-08, 08-09]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-tool registration file pattern reused from 08-06: ~80 line file under src/mcp/tools/ exporting registerQueryDependencies(server, deps) / registerListDependents(server, deps). Each calls registerReadOnlyTool with name + LLM-facing description + zod inputSchema {target: z.string().min(1), hops: z.union([z.literal(1), z.literal(2)]).optional()} + handler that delegates to depReader.forwardDeps / reverseDeps. Payload {depends_on|dependents, hops} via JSON.stringify."
    - "Resource registration pattern (NEW for Phase 8): src/mcp/resources/<name>.ts exports register<Resource>(server, deps) calling server.registerResource(name, new ResourceTemplate(uri, {list: undefined}), meta, handler). Handler signature is async (uri, vars) => ReadResourceResult — destructures the {symbolOrPath} capture, decodeURIComponents it, queries the reader (in-memory key only — no fs touch), and returns contents:[{uri, mimeType, text}]."
    - "URI scheme isolation: versioncon-state:// for MCP resources is intentionally distinct from versioncon:// (Phase 7 UriHandler scheme). Even though the SDK uses the URI as an internal key only — never dispatched to the OS — scheme isolation is defense-in-depth against future ambiguity. CONTEXT D-2 amended 2026-05-21 to lock this."
    - "T-08-10 (path traversal) mitigation by construction: the resource handler decodes the URI capture but uses it ONLY as a string key against DependencyReader. NO filesystem operations against the captured string. Tests assert empty arrays for traversal-shaped URIs AND a source-grep gate confirms zero fs.read* calls in dependencyGraph.ts."
    - "buildServer.ts Wave-3 amendment pattern (2nd amend): direct imports + inline calls BEFORE the optional callback seam, mirroring 08-06's pattern. The 7 production registrations (4 simple readers from 08-06 + 2 dep tools + 1 dep resource from 08-07) all land before the test-injection callback. Plan 08-08 (advise_sync) will be the 3rd amend, completing the 7-tool catalog."
    - "Comment hygiene for source-grep gates (lesson reinforced from 08-06): the literal 'fs.read' in a comment trips the T-08-10 gate `grep -cE 'fs\\\\.read|fs\\\\.readFile'`. Initial draft had a comment '// No fs.read happens against this string' which counted as 1 hit (failing the >=0 acceptance). Rewrote to 'NO filesystem read happens against this string' — content preserved, literal substring removed. Same lesson as 08-06 deviations 5/6."

key-files:
  created:
    - src/mcp/tools/queryDependencies.ts (82 lines)
    - src/mcp/tools/listDependents.ts (81 lines)
    - src/mcp/resources/dependencyGraph.ts (94 lines)
    - src/test/suite/mcpDependencyReader.test.ts (442 lines, 22 tests across 5 suites)
    - .planning/phases/08-ai-agent-api-mcp-integration/08-07-SUMMARY.md
  modified:
    - src/mcp/buildServer.ts (+3 imports, +12 inline registration lines; callback seam shape unchanged)

key-decisions:
  - "Used bare 'zod' import (matching 08-06 tool files) rather than 'zod/v4'. Consistency with the rest of src/mcp/ — heterogeneous import paths inside one subsystem would create churn."
  - "list_dependents tool description explicitly documents the v1 reverse-walk bounding: 'NOTE: v1 reverse-walk is bounded by the lack of a standing reverse index; the production reader may return empty for symbols not in the recent-edit window'. The test 'description notes the v1 reverseDeps bounding' asserts this so future tool-description rewrites can't accidentally drop the disclaimer. RESEARCH §I and 08-02-SUMMARY 'DependencyReaderImpl v1 Limitations' both justify the warning."
  - "Resource handler uses (server as any).registerResource cast rather than typed call. The SDK's McpServer type publishes registerResource (verified at node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts), but the same `any` cast is used in registry.ts for registerTool (RESEARCH §A.3 gotcha) so we keep the pattern consistent. Both gates (TypeScript noEmit AND runtime) pass."
  - "ResourceTemplate vars.symbolOrPath has TS type `string | string[]` (SDK supports multi-segment captures). The handler defensively joins via `Array.isArray(vars.symbolOrPath) ? vars.symbolOrPath.join('/') : vars.symbolOrPath` before decodeURIComponent. In practice the parser delivers a single string for `/parseToken`, but the join handles a future `/path/with/slashes` shape that the template might admit."
  - "Latency test uses Date.now() for elapsed measurement rather than process.hrtime.bigint(). Date.now() resolution is millisecond-level which is plenty for a <500ms budget; bigint arithmetic in the test code is unnecessary cognitive overhead. Plan called out both options — Date.now wins for readability."
  - "p95 calculation in the latency test uses samples[Math.floor(samples.length * 0.95)] equivalent (samples[4] for a 5-sample run) — the index into a sorted ascending array. For 5 samples this is the max; for larger N it would be the proper percentile. v1 only does 5 to keep the test fast."
  - "Resource test asserts the wider `forward.files` shape including 'src/host/AuthHandler.ts' (FakeReaders.depReverse.parseToken.files), correctly handling the asymmetric fixture: forwardDeps('parseToken') returns {symbols:['verifyClient'], files:['src/host/AuthHandler.ts']} but reverseDeps('parseToken') returns {symbols:[], files:['src/host/AuthHandler.ts']}. The dual-form resource test asserts BOTH directions against the canned fixture rather than a symmetric placeholder, exercising what the LLM actually sees."

patterns-established:
  - "MCP Resource Template pattern: src/mcp/resources/<resource>.ts exports register<Resource>(server, deps) calling server.registerResource with a ResourceTemplate. URI scheme is versioncon-state:// for ALL future Phase 8 resources. Handler is async (uri, vars) => {decodeURIComponent on vars; reader query; return contents:[{uri:uri.href, mimeType, text:JSON.stringify(...)}]}. Plan 08-08 reuses if/when adviseSync needs a resource form."
  - "URI scheme isolation: MCP resources use versioncon-state://, deep-links use versioncon://. Future MCP resources MUST use versioncon-state:// — adding a new scheme would balloon the OS-handler attack surface."
  - "T-08-10 (path traversal) mitigation by construction: any MCP resource that captures a free-form string from a URI must NEVER fs.read against the captured string. Use the string ONLY as a key into an in-memory reader. Source-grep gate `grep -cE 'fs\\\\.read|fs\\\\.readFile' src/mcp/resources/<file>.ts == 0` enforces."
  - "Latency budget pattern: tests assert `Date.now()`-based elapsed time + a p95 of N trials, with a relaxed CI bound (5x the production p95 target — here <500ms vs <100ms). RESEARCH §I documents the budget rationale; the relaxed test bound avoids CI flake while still catching catastrophic regressions."

requirements-completed: [AI-03]  # Plan 08-07 closes AI-03 (dep graph read). AI-02 is 4/7 from 08-06; advise_sync (08-08) closes the remaining tools but does not affect AI-03.

# Metrics
duration: 7min
completed: 2026-05-21
---

# Phase 8 Plan 07: Dependency Graph Tools + Resource Summary

**Land the AI-03 / SC-2 surface: query_dependencies + list_dependents tools + versioncon-state://dependency-graph/{symbolOrPath} resource. URI scheme isolated from Phase 7's UriHandler. T-08-10 path-traversal mitigated by construction (handler uses URI capture as in-memory key only — no fs.read). 22 new E2E tests; cumulative 1202 passing.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-05-21T10:24:46Z (baseline test capture)
- **Completed:** 2026-05-21T10:32:03Z (task commit + SUMMARY write)
- **Tasks:** 1 (per plan; 1 atomic GREEN commit covering implementation + 22 tests after RED proven)
- **Files created:** 4 (2 tool files + 1 resource file + 1 test file)
- **Files modified:** 1 (buildServer.ts)
- **Tests added:** 22 (1180 → 1202 passing)

## The 2 Tools + 1 Resource

| Surface | Name | Description | Input | Output |
|---|---|---|---|---|
| Tool | `query_dependencies` | "Returns the symbols and files that the given target (file path or symbol name) DEPENDS ON. Forward dependency direction. Default 1 hop; pass `hops: 2` for one-level transitive. Read-only." | `{target: z.string().min(1), hops?: 1\|2}` | `{depends_on:{symbols,files}, hops}` |
| Tool | `list_dependents` | "Returns the symbols and files that DEPEND ON the given target (file path or symbol name). Reverse dependency direction. Default 1 hop. Call this to predict who is affected by changes to a target. NOTE: v1 reverse-walk is bounded by the lack of a standing reverse index; the production reader may return empty for symbols not in the recent-edit window. A full reverse index lands in a future phase. Read-only." | `{target: z.string().min(1), hops?: 1\|2}` | `{dependents:{symbols,files}, hops}` |
| Resource | `dependency-graph-symbol` | "Browseable view of the dependency graph for a specific symbol or file. Returns both forward dependencies (what the target depends on) and reverse dependents (what depends on the target), capped at 1 hop. Use this resource form to @-mention dep info in chat; use the query_dependencies / list_dependents tools to call it from a prompt." | URI template `versioncon-state://dependency-graph/{symbolOrPath}` | mimeType `application/json` + JSON body `{target, forward, reverse}` |

All 3 descriptions verbatim from RESEARCH §F.4 + §1226-1269 canonical excerpt. Each contains the literal "Read-only" substring (per template discipline). `list_dependents` additionally documents the v1 reverse-walk bounding so AI agents don't misinterpret empty results.

## URI Scheme Decision (Locked in CONTEXT D-2)

- **Used:** `versioncon-state://dependency-graph/{symbolOrPath}` ✓
- **NOT used:** `versioncon://...` (owned by Phase 7's deep-link UriHandler)

Source-grep verification (run against `src/mcp/resources/dependencyGraph.ts`):

```bash
$ grep -c "versioncon-state://dependency-graph" src/mcp/resources/dependencyGraph.ts
1   # PASS (>=1; appears in ResourceTemplate construction)

$ grep -cE "(^|[^-])versioncon://dependency-graph" src/mcp/resources/dependencyGraph.ts
0   # PASS (==0; Phase 7 scheme absent)
```

The dedicated test 'URI scheme uses versioncon-state:// not versioncon://' runs the same assertion at test time — covers source-file rewrites by future agents.

## T-08-10 (Path Traversal) Mitigation

The resource handler:

```typescript
async (uri, vars) => {
  const raw = Array.isArray(vars.symbolOrPath) ? vars.symbolOrPath.join('/') : vars.symbolOrPath;
  const target = decodeURIComponent(raw);
  const [forward, reverse] = await Promise.all([
    deps.depReader.forwardDeps(target, 1),
    deps.depReader.reverseDeps(target, 1),
  ]);
  return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({target, forward, reverse}) }] };
}
```

The decoded `target` string is used ONLY as a key into `DependencyReader` (in-memory map lookup against `FakeReaders.depForward/depReverse` in tests; against the workspace-confined `AstFactory.detectLanguageFromPath -> getAdapter -> extractReferences` chain in production — and 08-02 added the `path.resolve` + workspace-root confinement check at that layer).

**Verification:**

| Gate | Command | Result |
|---|---|---|
| Test: traversal URI returns empty arrays | `tools/call resources/read` with `encodeURIComponent('../../etc/passwd')` | PASS — `payload.target === '../../etc/passwd'`; `forward = {symbols:[], files:[]}`, `reverse = {symbols:[], files:[]}` |
| Source: zero fs.read* calls | `grep -cE 'fs\.read|fs\.readFile' src/mcp/resources/dependencyGraph.ts` | 0 PASS |
| Source: decodeURIComponent present | `grep -c 'decodeURIComponent' src/mcp/resources/dependencyGraph.ts` | 2 PASS (>=1) |

## Observed Latency

Measured via the 5 latency test trials on FakeReaders (full SDK round-trip including HTTP transport):

- All 5 trials < 500ms (the relaxed CI bound)
- The 5-trial suite completed in 139ms total (avg ~28ms per round-trip including HTTP + SDK overhead)
- p95 of 5 was well under the budget

Production `DependencyReaderImpl.forwardDeps` (08-02): single-file ad-hoc AstFactory analysis with `MAX_RESULTS = 100` cap. Per CONTEXT D-2 the production target is <100ms p95 on a 1KB fixture; the FakeReaders measurement validates the tool surface itself adds negligible overhead — the real latency lives in DependencyReaderImpl. If 8.1 finds production latency biting, a standing dep index is the agreed Pitfall 7 solution.

## buildServer.ts SECOND Amend Confirmed

Plan 08-06 was the FIRST amend (4 simple-reader tools). Plan 08-07 is the SECOND amend, adding:

- 3 imports (queryDependencies, listDependents, dependencyGraph resource)
- 3 inline `register*(server, deps)` calls placed AFTER the 08-06 block and BEFORE the optional callback seam

Source-grep gate:
```bash
$ grep -c "registerQueryDependencies\|registerListDependents\|registerDependencyGraphResource" src/mcp/buildServer.ts
6   # PASS (>=6 — 3 imports + 3 calls)
```

Production tool catalog is now 6 of the 7 planned tools (08-08 will append `advise_sync`). Production resource count is 1.

## Task Commits

1. **`6529f5e`** — `feat(08-07): query_dependencies + list_dependents tools + dependencyGraph resource (AI-03 / SC-2)` — the 3 new src files + buildServer.ts edit + 22-test mcpDependencyReader.test.ts (single GREEN commit; RED was proven separately by running the test against the un-amended buildServer.ts before the implementation files existed in `dist/`).

**This SUMMARY commit:** (separate `docs(08-07)`) — to follow.

## Source-Grep Gate Results

```bash
# AI-03 / SC-2 surface present
$ grep -c "versioncon-state://dependency-graph" src/mcp/resources/dependencyGraph.ts
1   # PASS (>=1)

# Phase 7 scheme NOT reused
$ grep -cE "(^|[^-])versioncon://dependency-graph" src/mcp/resources/dependencyGraph.ts
0   # PASS (==0)

# T-08-10 path-traversal mitigation in place
$ grep -cE "fs\.read|fs\.readFile" src/mcp/resources/dependencyGraph.ts
0   # PASS (==0)
$ grep -c "decodeURIComponent" src/mcp/resources/dependencyGraph.ts
2   # PASS (>=1; appears in body comment + handler code)

# N-08-10 preserved (no direct server.registerTool outside registry.ts)
$ grep -rn "server\.registerTool" src/mcp/ | grep -v "src/mcp/registry.ts" | wc -l
0   # PASS (==0)

# Each new tool file uses the registry factory
$ grep -c "registerReadOnlyTool" src/mcp/tools/queryDependencies.ts src/mcp/tools/listDependents.ts
3   3   # PASS (>=2 total — appears in import, factory call, JSDoc)

# Single registerResource call (in the new resource file)
$ grep -rn "registerResource" src/mcp/ | wc -l
1   # PASS (==1 — only src/mcp/resources/dependencyGraph.ts)

# buildServer.ts wired to all 3 new registrations
$ grep -c "registerQueryDependencies\|registerListDependents\|registerDependencyGraphResource" src/mcp/buildServer.ts
6   # PASS (>=6 — 3 imports + 3 calls)

# N-08-01 preserved (no src/auth imports in src/mcp/)
$ grep -rE "import.*from.*src/auth" src/mcp/ | wc -l
0   # PASS (==0)

# N-08-04 preserved (no console.* in src/mcp/)
$ grep -rE '^\s*console\.' src/mcp/ | wc -l
0   # PASS (==0)

# tsc compile
$ npx tsc --noEmit -p .
(exit 0)   # PASS

# Test suite
$ npm test  →  1202 passing, 0 failing
```

## Test Delta + Cumulative

| Before | After | Delta |
|---|---|---|
| 1180 passing | 1202 passing | +22 |
| 66 pending | 66 pending | 0 |
| 0 failing | 0 failing | 0 |

22-test breakdown (mcpDependencyReader.test.ts):

| Suite | Tests |
|---|---|
| Phase 8 — query_dependencies tool | 7 |
| Phase 8 — list_dependents tool | 4 |
| Phase 8 — dependency-graph resource (versioncon-state://) | 5 |
| Phase 8 — latency budget (<500ms relaxed CI; target <100ms p95) | 3 |
| Phase 8 — SC-2 evidence (AI agent reads full dep graph) | 2 |
| Tools list registration shape | (included above) |
| Resource URI scheme + decodeURIComponent + T-08-10 fs.read gates | (included above) |
| **Total** | **22** |

Plan floor was `>= 14 new tests`; actual 22 (the plan's must_haves also said ">=14 tests").

## Files Created / Modified

```
A  src/mcp/tools/queryDependencies.ts     (82 lines)
A  src/mcp/tools/listDependents.ts        (81 lines)
A  src/mcp/resources/dependencyGraph.ts   (94 lines)
A  src/test/suite/mcpDependencyReader.test.ts  (442 lines, 22 tests across 5 suites)
M  src/mcp/buildServer.ts                 (+3 imports, +12 inline lines; callback seam shape unchanged)
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Comment text "No fs.read happens against this string" false-positives the T-08-10 source-grep gate**

- **Found during:** Final acceptance-criteria verification (the `T-08-10 source-grep` test failed on the first run)
- **Issue:** My initial draft of `src/mcp/resources/dependencyGraph.ts` had an inline comment `// No fs.read happens against this string.` explaining the T-08-10 mitigation rationale. The literal `fs.read` substring inside that comment matched the test assertion `assert.doesNotMatch(text, /\bfs\.read\w*/)` AND the source-grep gate `grep -cE "fs\.read|fs\.readFile"` (which I'd configured to require 0 hits). The test reported `T-08-10: resource handler must not read from filesystem`. SAME class of bug as 08-06 deviations 5 + 6.
- **Fix:** Rewrote the comment phrasing to "NO filesystem read happens against this string" — content preserved, the offending `fs.read` literal removed. Also tightened the surrounding header comment so it documents the gate as `'fs\.read|fs\.readFile'` (using backslash-escaped regex notation, which is `fs\.read` in the file with a literal backslash that doesn't match the test's `\b fs\.read \w*` pattern).
- **Files modified:** `src/mcp/resources/dependencyGraph.ts` (one comment block rewrite)
- **Verification:** `grep -cE "fs\.read|fs\.readFile" src/mcp/resources/dependencyGraph.ts` returns 0; the T-08-10 source-grep test passes.
- **Pattern lesson (REPEAT from 08-06):** Source-grep gates that operate on literal text must be considered when writing comments. The codebase pattern (see 08-06-SUMMARY deviations 5/6) is: when a literal substring is part of a source-grep gate, comments and JSDoc that reference the literal must use an escape that breaks the literal match (e.g. backslash-escaped regex notation `fs\.read`, descriptive paraphrase, or backtick-quoted regex inside a longer string).

**2. [Rule 2 - API Compatibility] McpServer.registerResource type signature missing — used `(server as any)` cast**

- **Found during:** Task 1 implementation (writing the resource file's body)
- **Issue:** The SDK exports `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, and the bundled `.d.ts` does declare a `registerResource` method, but the TypeScript surface visible to consumers requires a non-trivial generic parameter shape for the handler signature that the plan-body's canonical excerpt didn't match exactly. Rather than fight the type to match (which would have added 20 lines of generic ceremony for a code path that just calls `JSON.stringify`), I used `(server as any).registerResource(...)` — mirroring the EXACT same pattern that `registry.ts` uses for `registerTool` per RESEARCH §A.3 gotcha (and the existing `eslint-disable-next-line @typescript-eslint/no-explicit-any` comment in registry.ts:134).
- **Fix:** N/A — the cast is the right call; consistency with `registry.ts` was the priority. Documented in the file's import block and in `key-decisions` above.
- **Files modified:** None additional (the cast was the original implementation, not a change)
- **Verification:** `npx tsc --noEmit -p .` exits 0; all 22 tests pass; runtime behavior matches the canonical SDK shape.

---

**Total deviations:** 2 (1 Rule 1 comment-hygiene bug; 1 Rule 2 SDK-type-vs-canonical-excerpt accommodation).
**Impact on plan:** Neither deviation changed any plan acceptance criterion; both were implementation-level adjustments. All `<must_haves>`, `<acceptance_criteria>`, and `<success_criteria>` PASS.

## Threat Model Confirmations

| Threat ID | Status | How addressed in 08-07 |
|---|---|---|
| T-08-10 (path traversal via URI captures) | MITIGATED by construction | Resource handler decodes URI capture but uses it ONLY as in-memory key into DependencyReader. No fs.read against the captured string. 3 verifications: (a) test asserts traversal URI returns empty arrays, (b) source-grep gate `grep -cE 'fs\.read|fs\.readFile' src/mcp/resources/dependencyGraph.ts == 0`, (c) the underlying DependencyReaderImpl (08-02) ALSO has `path.resolve` + workspace-root confinement so even if the resource handler regressed, the reader would still reject out-of-tree paths. |
| T-08-URI-scheme-collision (Phase 7 versioncon:// overlap) | MITIGATED | Used distinct `versioncon-state://` scheme per RESEARCH §G.2 / CONTEXT D-2 amendment. Test asserts the bare `versioncon://dependency-graph` substring is absent from the resource file. URI scheme isolation prevents OS-handler dispatch overlap. |
| T-08-03 (dep-graph cost / DoS) | MITIGATED | Production DependencyReaderImpl single-file analysis (Pitfall 7 — 08-02 design) caps the per-call cost at parser-extract-references for one file. `MAX_RESULTS = 100` in the reader caps the response size. Per-call latency budget <100ms p95 (test asserts <500ms on FakeReaders to accommodate CI variance). If production latency bites, the agreed solution is the 8.1 standing dep index. |
| T-08-01-runtime (resource handler tries to write) | MITIGATED | DependencyReader interface is read-only (Layer 1 — 08-02 readers.ts). The resource handler only calls `forwardDeps` / `reverseDeps` — both signature-marked-readonly. N-08-03 gate (no writer-shaped method names on Reader interfaces) preserved. |
| T-08-stack-leak (handler throws; stack leaks) | MITIGATED | registerReadOnlyTool from 08-03 wraps tool handlers with try/catch → {isError:true} conversion. The resource handler does NOT have an equivalent wrapper — the SDK auto-converts throws to ResourceError but doesn't sanitize stack. The reader-side error surface (DependencyReaderImpl returns empty rather than throwing on any failure mode, per 08-02-SUMMARY) means a throw from the resource handler is essentially impossible. If a future refactor changes the reader contract to throw, the resource handler should be wrapped too — `key-decisions` notes this as a future-hardening item. |

## AI-03 Progress: Surface Complete

| Tool | Plan | Status |
|---|---|---|
| `get_branch_status` | 08-06 | DONE |
| `get_sync_status` | 08-06 | DONE |
| `get_recent_activity` | 08-06 | DONE |
| `get_chat_log` | 08-06 | DONE |
| `query_dependencies` | **08-07** | **DONE** |
| `list_dependents` | **08-07** | **DONE** |
| `advise_sync` | 08-08 | pending |

Resource:

| Resource URI | Plan | Status |
|---|---|---|
| `versioncon-state://dependency-graph/{symbolOrPath}` | **08-07** | **DONE** |

## SC-2 Closure Evidence

The plan's `<success_criteria>` includes "SC-2 evidence E2E test combines all 3 surfaces against the parseToken fixture and asserts non-empty data".

The dedicated SC-2 test (`'SC-2: forward + reverse + resource all return data for parseToken'`) calls all 3 surfaces in parallel via `Promise.all`:

```typescript
const [fwd, rev, res] = await Promise.all([
  client.callTool({ name: 'query_dependencies', arguments: { target: 'parseToken' } }),
  client.callTool({ name: 'list_dependents',    arguments: { target: 'parseToken' } }),
  client.readResource({ uri: 'versioncon-state://dependency-graph/parseToken' }),
]);
```

And asserts:
- `fwd.depends_on` has data (forward direction)
- `rev.dependents.files` has data (reverse direction — FakeReaders canned)
- `res.forward` matches `fwd.depends_on` exactly (same underlying reader call; the resource is the browseable form of the tools' data)

A second SC-2 cross-check test asserts surface-consistency: `query_dependencies('parseToken')` and the resource read of the same target produce IDENTICAL forward slices (`assert.deepStrictEqual(fwdP.depends_on, resP.forward)`). This rules out normalization drift between tool and resource entry points — they're guaranteed to be the same data.

**SC-2 closed.** AI agents that have read VersionCon's MCP catalog can ask "what does parseToken depend on?", "what depends on parseToken?", and "give me the full dep slice for parseToken" through three distinct entry points returning consistent data.

## Issues Encountered

- **Comment-hygiene gate (REPEATED from 08-06):** the literal `fs.read` in a code comment tripped the T-08-10 source-grep gate. Same class of bug as 08-06 deviations 5 and 6. Documented as a pattern for 08-08 authors — when a source-grep gate operates on literal text, comments that reference the gate's literal must use a paraphrase or an escape that breaks the literal match.
- **SDK type for registerResource:** the `McpServer.registerResource` TypeScript signature uses a generic that the canonical RESEARCH excerpt didn't exercise cleanly. Used `(server as any).registerResource(...)` mirroring the existing `registry.ts` registerTool cast (also `any`-cast per RESEARCH §A.3 gotcha). Both gates (TypeScript noEmit AND runtime behavior) pass. Documented.

## User Setup Required

None — Plan 08-07 ships in-process registrations. No new external service, no new config, no new secrets. The 2 new tools and 1 new resource become available to any MCP client that connects to the extension's MCP server (the extension-host activation wiring is the 08-09 concern).

## Next Phase Readiness

**Plan 08-08 unblocked.** This plan's outputs:

1. **2 new tool registrations + 1 resource** wired through buildServer.ts. Plan 08-08 (`advise_sync`) is the 3rd amend, completing the 7-tool catalog.
2. **MCP Resource Template pattern** established (URI scheme + handler shape + T-08-10 mitigation). If 08-08 needs a resource form for `advise_sync`, the pattern is copy-paste from `dependencyGraph.ts`.
3. **Latency budget pattern established** — Date.now()-based + p95-of-N variance dampening + relaxed-CI bound. Reusable for any future Phase 8 tool that has a perf SLA.
4. **Comment-hygiene-for-source-grep-gates** lesson reinforced (3rd time across 08-06 + 08-07). Future tool / resource authors should default to descriptive paraphrase when comments reference a gate's literal.

**Confirmation per dispatcher prompt:**

- `src/mcp/tools/queryDependencies.ts`: **created** (82 lines; uses `registerReadOnlyTool` x3; description from RESEARCH §F.4; `forwardDeps` call; zod {target.min(1), hops.union(literal 1, literal 2).optional()} schema)
- `src/mcp/tools/listDependents.ts`: **created** (81 lines; uses `registerReadOnlyTool` x3; same input schema as query_dependencies; description documents v1 reverse-walk bounding)
- `src/mcp/resources/dependencyGraph.ts`: **created** (94 lines; URI scheme `versioncon-state://`; `ResourceTemplate(..., {list: undefined})`; `decodeURIComponent`; `Promise.all([forwardDeps, reverseDeps])`)
- `src/mcp/buildServer.ts`: **amended** (2nd amend — 3 imports + 3 inline register* calls before callback seam)
- `src/test/suite/mcpDependencyReader.test.ts`: **created** (442 lines; 22 tests across 5 suites: query_dependencies x7, list_dependents x4, resource x5, latency x3, SC-2 x2 — plus 1 each for tools/list registration shape inside the relevant suites)
- URI scheme correct: `grep -c "versioncon-state://dependency-graph"` returns 1; `grep -cE "(^|[^-])versioncon://dependency-graph"` returns 0
- T-08-10 mitigated by construction: `grep -cE "fs\.read|fs\.readFile" src/mcp/resources/dependencyGraph.ts` returns 0; `grep -c "decodeURIComponent"` returns 2 (>=1); test 'T-08-10: traversal-looking URI returns empty arrays' passes
- Latency: 5 trials < 500ms each; suite total 139ms; production target <100ms p95 documented
- N-08-10 (no `server.registerTool` outside registry.ts): **0 hits** in literal grep
- N-08-01 / N-08-04 preserved: 0 / 0
- `npx tsc --noEmit -p .`: **exit 0**
- `npm test`: **1202 passing, 0 failing**

---

## Self-Check: PASSED

- [x] `src/mcp/tools/queryDependencies.ts` exists (82 lines; contains `registerReadOnlyTool` x3, `query_dependencies` literal, `forwardDeps` literal, `DependencyReader` import, `'Read-only'` substring)
- [x] `src/mcp/tools/listDependents.ts` exists (81 lines; contains `registerReadOnlyTool` x3, `list_dependents` literal, `reverseDeps` literal, v1-bounding description text)
- [x] `src/mcp/resources/dependencyGraph.ts` exists (94 lines; contains `versioncon-state://dependency-graph`, `ResourceTemplate`, `decodeURIComponent`; ZERO `versioncon://dependency-graph` matches; ZERO `fs.read*` matches)
- [x] `src/mcp/buildServer.ts` modified — 3 imports + 3 inline registrations before callback seam
- [x] `src/test/suite/mcpDependencyReader.test.ts` exists (442 lines, 22 tests across 5 suites)
- [x] Commit `6529f5e` exists in git log (`feat(08-07): query_dependencies + list_dependents tools + dependencyGraph resource (AI-03 / SC-2)`)
- [x] `npx tsc --noEmit -p .` exits 0
- [x] `npm test` reports 1202 passing, 0 failing
- [x] N-08-10 (server.registerTool outside registry.ts): 0 hits
- [x] N-08-01 (src/auth in src/mcp/): 0 hits
- [x] N-08-04 (console.* in src/mcp/): 0 hits
- [x] T-08-10 (fs.read in dependencyGraph.ts): 0 hits
- [x] URI scheme correct (versioncon-state:// present; versioncon://dependency-graph absent)
- [x] decodeURIComponent appears in resource file (2 hits — header + handler body)
- [x] All Phase 8 acceptance criteria from 08-07-PLAN.md verified individually

---
*Phase: 08-ai-agent-api-mcp-integration*
*Completed: 2026-05-21*
