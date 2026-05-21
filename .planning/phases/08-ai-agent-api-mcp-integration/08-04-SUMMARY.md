---
phase: 08-ai-agent-api-mcp-integration
plan: 04
subsystem: api
tags: [phase-8, wave-2, mcp, server, transport, express, streamable-http, dns-rebinding, CVE-2025-66414, N-08-08, N-08-09, T-08-04, T-08-05-dns-rebinding]

# Dependency graph
requires:
  - phase: 08-01
    provides: "MCP runtime deps (@modelcontextprotocol/sdk@1.29.0, express@5.2.1) + versioncon.mcp.* settings keys + FakeReaders fixture"
  - phase: 08-02
    provides: "src/mcp/readers.ts — 6 Reader interfaces (BranchReader/SyncReader/ActivityReader/ChatReader/DependencyReader/PresenceReader)"
  - phase: 08-03
    provides: "src/mcp/registry.ts — READ_ONLY_TOOLS Set + registerReadOnlyTool factory (consumed by 08-06/07/08; not by Wave-2 server scaffold itself)"
provides:
  - "src/mcp/server.ts — Express + StreamableHTTPServerTransport bootstrap binding 127.0.0.1 with DNS-rebinding protection (CVE-2025-66414 mitigation)"
  - "src/mcp/buildServer.ts — DI composer constructing McpServer per session, accepting all 6 Reader interfaces + optional registerTools callback seam"
  - "src/mcp/lifecycle.ts — startMcpLifecycle/stopMcpLifecycle pair with 3 injection seams for 08-05 (ensureConsent, upsertMcpConfig, removeMcpConfig)"
  - "Source-grep gates N-08-08 (127.0.0.1 present + 0.0.0.0 absent) and N-08-09 (enableDnsRebindingProtection + allowedHosts) green for the first time"
  - "22 new tests in src/test/suite/mcpServer.test.ts: server lifecycle, port re-allocation, SDK client E2E handshake, DNS-rebinding rejection via raw http.request, source-grep gates, buildServer DI, lifecycle settings/consent/config-writer paths"
affects: [08-05, 08-06, 08-07, 08-08, 08-09]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Wave-2 server scaffold pattern: bind FIRST (port 0 → kernel-assigned), then read httpServer.address() to compute allowedHosts entries containing the literal `127.0.0.1:<port>` and `localhost:<port>` strings — DNS-rebinding gate needs the port-bearing host strings."
    - "DI composer with registerTools callback seam (buildServer.ts): Wave-2 ships with zero tools registered; Wave-3 plans 08-06/07/08 will replace the callback with direct imports of register*(server, deps) functions. The callback path remains for tests."
    - "Three-injection-seam lifecycle pattern: ensureConsent, upsertMcpConfig, removeMcpConfig are accepted as optional async function params on LifecycleOpts. Wave-2 ships without them (all paths gated behind `if (opts.x)`); 08-05 implements them; 08-09 wires extension.ts to call lifecycle with all three injected."
    - "Lazy require('vscode') inside startMcpLifecycle so the module loads under bare mocha for unit tests without an extension host. Production callers from extension.ts (08-09) get vscode via Node's loader inside the extension host."
    - "Raw http.request (not undici fetch) for DNS-rebinding-gate testing: Node's undici fetch silently overrides the outbound Host header, rendering it useless for the foreign-Host test. http.request honors the Host header verbatim."

key-files:
  created:
    - src/mcp/server.ts
    - src/mcp/buildServer.ts
    - src/mcp/lifecycle.ts
    - src/test/suite/mcpServer.test.ts
    - .planning/phases/08-ai-agent-api-mcp-integration/08-04-SUMMARY.md
  modified: []

key-decisions:
  - "SDK v1.29.0 export paths verified at runtime against the installed package: { McpServer, ResourceTemplate } from server/mcp.js; { StreamableHTTPServerTransport } from server/streamableHttp.js (a thin wrapper around WebStandardStreamableHTTPServerTransport); { isInitializeRequest, ...InitializeRequestSchema } from types.js. All match RESEARCH §A.2."
  - "buildServer.ts is a Wave-2 STUB that registers ZERO tools by default. The optional registerTools callback (signature: (server, deps) => void) is the seam Wave-3 plans 08-06/07/08 will REPLACE with direct imports. The callback path stays alive for tests but production buildServer will invoke register* functions inline."
  - "lifecycle.ts has THREE injection seams (ensureConsent/upsertMcpConfig/removeMcpConfig) typed as optional Promise-returning callbacks on LifecycleOpts. Wave-2 ships with all three absent (each guarded by `if (opts.x)` checks). Plan 08-05 implements them; plan 08-09 wires them in extension.ts."
  - "Test file is monolithic (src/test/suite/mcpServer.test.ts) — covers server lifecycle, buildServer DI, AND lifecycle integration in one suite. The lifecycle tests are wrapped in `(vscode ? suite : suite.skip)` so the file loads under bare mocha for the server-only subset (17/22 tests) when an extension host isn't available; under vscode-test the full 22 run."
  - "Lazy require('vscode') in lifecycle.ts — production code uses it; bare mocha tests that supply `_startMcpServer` test seam never touch the require line. This is a test-friendliness Rule-2 fix that has zero impact on production."
  - "MCP SDK behavior: the ListToolsRequestSchema handler is only installed inside registerTool() (mcp.js line 56-67, called from line 650). With zero tools registered (Wave-2 baseline), client.listTools() throws 'Method not found' — that IS the Wave-2 baseline; the test accepts both `[]` and `Method not found` shapes."
  - "DNS-rebinding test uses raw http.request, not fetch. Node 23's undici fetch silently overrides the Host header on outbound requests, so the foreign-Host test had to drop to the lower level. The test sets Host: evil.example.com explicitly and asserts the SDK responds in the 4xx range."

patterns-established:
  - "Pattern: Bind-then-construct-transport. Bind the HTTP server with `port=0` to get a kernel-assigned port, read httpServer.address() to capture it, then pass the resolved `127.0.0.1:<port>` + `localhost:<port>` strings into StreamableHTTPServerTransport's allowedHosts array. This is the only way to make DNS-rebinding protection work with ephemeral ports."
  - "Pattern: Three-seam lifecycle. Optional async function params (ensureConsent/upsertMcpConfig/removeMcpConfig) injected by the caller, each guarded by `if (opts.x)`. Wave-2 ships with all three absent; downstream plans inject them. The seams are typed in LifecycleOpts so test code is forward-compatible."
  - "Pattern: DI composer with optional callback seam. buildServer returns a configured McpServer; an optional `registerTools(server, deps)` callback lets Wave-2 tests inject registration without modifying the file. Wave-3 plans replace the callback path with direct imports — the seam survives the migration."
  - "Pattern: Lazy require('vscode') for test-friendliness. Modules that call vscode APIs only inside function bodies can `import type * as vscode from 'vscode'` at module scope (zero runtime cost) and `const vscode = require('vscode')` lazily inside the function. Allows the module to load under bare mocha for unit tests."
  - "Pattern: Source-grep tests as security gates. Each gate is a Mocha test that fs.readFileSync's the target module + applies a regex. N-08-08 (127.0.0.1 present, 0.0.0.0 absent) and N-08-09 (enableDnsRebindingProtection + allowedHosts) are enforced on every CI run — drift breaks the build."

requirements-completed: [AI-01]

# Metrics
duration: 35min
completed: 2026-05-21
---

# Phase 8 Plan 04: MCP Server Bootstrap + Lifecycle Summary

**Express + StreamableHTTPServerTransport HTTP listener bound to literal 127.0.0.1 with enableDnsRebindingProtection + allowedHosts (CVE-2025-66414 mitigation). DI composer + activate-time orchestrator with three injection seams for 08-05. 22 new tests; N-08-08 + N-08-09 source-grep gates green for the first time in Phase 8.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-05-21T09:50:00Z (after baseline test capture)
- **Completed:** 2026-05-21T10:00:00Z (Task 2 commit)
- **Tasks:** 2
- **Files created:** 4 (server.ts + buildServer.ts + lifecycle.ts + mcpServer.test.ts)
- **Files modified:** 0
- **Tests added:** 22 (1110 → 1155 passing; +22 from this plan + ~23 from parallel 08-05 RED commits on the same branch)
- **Atomic commits:** 2 (1 per task) + 1 metadata commit (this SUMMARY)

## Accomplishments

- **`src/mcp/server.ts` (171 lines)** — the network-bind module:
  - Binds Express on `BIND_HOST = '127.0.0.1'` constant (literal IPv4 — N-08-08 gate).
  - Port 0 by default (kernel-assigned ephemeral; RESEARCH §C.1); explicit port via `opts.port`.
  - Computes `port` via `httpServer.address()` AFTER bind, BEFORE any transport construction — required so allowedHosts contains the resolved port.
  - Constructs each `StreamableHTTPServerTransport` with `{ sessionIdGenerator: () => randomUUID(), enableDnsRebindingProtection: true, allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`] }` — CVE-2025-66414 mitigation (N-08-09 gate).
  - Per-session transports keyed by `mcp-session-id` header in a `Record<string, StreamableHTTPServerTransport>`; cleaned up on `transport.onclose`.
  - 1 MiB Express body cap via `app.use(express.json({ limit: '1mb' }))` (T-08-03 partial DoS mitigation).
  - Returns `McpServerHandle { port, url, close }` where `url = http://127.0.0.1:<port>/mcp`.
  - All diagnostics via injected `log` callback; NO `console.*` anywhere (N-08-04 preserved).
  - `close()` drains all active transports via `Promise.all`-ish loop, then `httpServer.close(cb)`.

- **`src/mcp/buildServer.ts` (76 lines)** — DI composer:
  - `buildServer(deps): McpServer` factory takes a 6-Reader bundle plus optional `log` + `registerTools` callback.
  - Constructs `new McpServer({ name: 'versioncon', version: process.env.npm_package_version ?? '0.0.0' }, { capabilities: { tools: {}, resources: {} } })`.
  - If `deps.registerTools` is provided, invokes it once. Wave-2 ships with no tools registered by default — Wave-3 plans 08-06/07/08 will replace the callback with direct imports.
  - Imports the 6 Reader interfaces from `./readers.js` (type-only — no runtime dependency on the adapters).

- **`src/mcp/lifecycle.ts` (135 lines)** — activate-time orchestrator:
  - `startMcpLifecycle(opts): Promise<McpServerHandle | null>` reads `versioncon.mcp.enabled` via `vscode.workspace.getConfiguration('versioncon.mcp')`. Returns `null` + logs `[mcp] disabled` if `false`.
  - Three injection seams as optional async function params on `LifecycleOpts`:
    - `ensureConsent?: () => Promise<boolean>` — 08-05 fills in
    - `upsertMcpConfig?: (port: number) => Promise<void>` — 08-05 fills in
    - `removeMcpConfig?: () => Promise<void>` — 08-05 fills in
  - `_startMcpServer?: (opts: StartMcpServerOpts) => Promise<McpServerHandle>` test seam — defaults to the production `startMcpServer` from server.ts.
  - `stopMcpLifecycle(handle, { removeMcpConfig?, log? })` calls `removeMcpConfig` first (best-effort, errors logged), then `handle.close()`, then logs `[mcp] stopped`.
  - Lazy `require('vscode')` inside the function body — allows the module to load under bare mocha for unit tests.

- **`src/test/suite/mcpServer.test.ts` (449 lines, 22 tests)** — comprehensive coverage:
  - **Phase 8 — startMcpServer lifecycle (3 tests):** port > 0, url shape, log content.
  - **Phase 8 — startMcpServer re-allocates on restart (1 test):** two consecutive starts succeed.
  - **Phase 8 — E2E: SDK client handshake + tools/list (2 tests):** client.connect handshake; tools/list returns either `[]` (Wave 3+) or `Method not found` (Wave-2 baseline).
  - **Phase 8 — DNS-rebinding protection (1 test):** raw `http.request` with `Host: evil.example.com` returns 4xx.
  - **Phase 8 — N-08-08 source-grep (2 tests):** 127.0.0.1 present, 0.0.0.0 absent.
  - **Phase 8 — N-08-09 source-grep (2 tests):** enableDnsRebindingProtection + allowedHosts present.
  - **Phase 8 — N-08-04 preserved (3 tests):** no `console.*` in server.ts / buildServer.ts / lifecycle.ts.
  - **Phase 8 — buildServer DI composer (3 tests):** returns McpServer; registerTools callback invoked once; receives server + deps.
  - **Phase 8 — startMcpLifecycle (5 tests):** enabled=false → null; enabled=true → starts; consent=false → null; upsertMcpConfig invoked with port; stopMcpLifecycle calls removeMcpConfig before close.

## Task Commits

Each task was committed atomically:

1. **Task 1: server.ts — MCP Express + StreamableHTTPServerTransport bootstrap** — `aa8e17d` (feat)
2. **Task 2: buildServer DI composer + lifecycle orchestrator + 22 tests** — `a1b27f6` (feat)

**Plan metadata:** (this SUMMARY commit — docs(08-04))

## SDK v1.29.0 Export Paths Used (Verified at Runtime)

```bash
$ node -e "..."
mcp.js: [ 'McpServer', 'ResourceTemplate' ]
streamableHttp: [ 'StreamableHTTPServerTransport' ]
types Initialize: [
  'InitializeRequestParamsSchema', 'InitializeRequestSchema',
  'isInitializeRequest', 'InitializeResultSchema',
  'InitializedNotificationSchema', 'isInitializedNotification'
]
client: [ 'Client', 'getSupportedElicitationModes' ]
client/streamableHttp: [ 'StreamableHTTPError', 'StreamableHTTPClientTransport' ]
```

All match RESEARCH §A.2. The plan's `<interfaces>` block is reusable verbatim against the installed SDK.

**Note on the SDK's deprecation banner:** `StreamableHTTPServerTransport` is a thin Node-HTTP wrapper around `WebStandardStreamableHTTPServerTransport`. The `enableDnsRebindingProtection` / `allowedHosts` options carry a `@deprecated Use external middleware for host validation instead` JSDoc tag. We use them anyway because:
1. They're the SDK-native CVE-2025-66414 mitigation and are still functionally present in v1.29.0.
2. RESEARCH §A.2 documents the exact options.
3. External middleware would be more complex (require constructing the allowedHosts list at the same point we currently do, just in a different place). The deprecation is a "prefer middleware in greenfield" hint, not a removal warning.
4. The behavior is verified by the integration test (foreign Host returns 403/4xx).

## Source-Grep Gate Results (After This Plan)

```bash
# N-08-08 positive (IPv4 literal present in server.ts)
$ grep -c "127\.0\.0\.1" src/mcp/server.ts
6   # PASS (>= 1)

# N-08-08 negative (no 0.0.0.0 in server.ts)
$ grep -c "0\.0\.0\.0" src/mcp/server.ts
0   # PASS (== 0)

# N-08-09 positive (DNS-rebinding mitigation)
$ grep -c "enableDnsRebindingProtection: true" src/mcp/server.ts
2   # PASS (>= 1)
$ grep -c "allowedHosts" src/mcp/server.ts
4   # PASS (>= 1)

# N-08-04 preserved across all 3 new files
$ grep -E '^\s*console\.' src/mcp/server.ts src/mcp/buildServer.ts src/mcp/lifecycle.ts | wc -l
0   # PASS (== 0)

# N-08-01 preserved across my 3 files
$ grep -E 'import.*from.*src/auth' src/mcp/server.ts src/mcp/buildServer.ts src/mcp/lifecycle.ts | wc -l
0   # PASS (== 0)

# Express body cap (T-08-03 partial)
$ grep -c "'1mb'" src/mcp/server.ts
1   # PASS (>= 1)

# Per-session transport map keyed by mcp-session-id
$ grep -c "mcp-session-id" src/mcp/server.ts
3   # PASS (>= 1)
$ grep -c "sessionIdGenerator" src/mcp/server.ts
1   # PASS (>= 1)

# buildServer imports all 6 Reader interfaces
$ grep -cE "BranchReader|SyncReader|ActivityReader|ChatReader|DependencyReader|PresenceReader" src/mcp/buildServer.ts
12  # PASS (>= 6 — one for the import, one for the BuildServerDeps field, x6)

# lifecycle reads versioncon.mcp settings
$ grep -c "versioncon.mcp" src/mcp/lifecycle.ts
5   # PASS (>= 1)

# All three injection seams present
$ grep -c "ensureConsent" src/mcp/lifecycle.ts
6   # PASS
$ grep -c "upsertMcpConfig" src/mcp/lifecycle.ts
7   # PASS
$ grep -c "removeMcpConfig" src/mcp/lifecycle.ts
8   # PASS
```

## Port Re-allocation Behavior Observed

The "two consecutive starts" test bound port-0 twice. On Darwin 24 / Node 23, the kernel ALWAYS picked a different port in our test runs (we saw e.g. 58133 → 58134 in adjacent starts). The test does NOT assert distinctness — RESEARCH §C.2 specifies that what matters is that re-binding succeeds, not that the port is fresh. The kernel may reuse the just-freed port on other OSes (Linux TIME_WAIT handling). Both ports were positive integers in [1, 65535).

## DNS-Rebinding Rejection Status Code Observed

Tested with raw `http.request` setting `Host: evil.example.com`. The SDK v1.29.0 returns **`200 OK`** when fetch is used (Node 23's undici silently overrides the Host header — the body became a regular MCP response, NOT a rejection). Switching to raw `http.request` (which honors Host verbatim) produced a **403 Forbidden** response with the body `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Invalid Host header"},"id":null}` — the SDK's `validateRequestHeaders` private method (per webStandardStreamableHttp.d.ts:196). Test asserts `status >= 400 && status < 500`.

This is a CRITICAL test-environment finding: **undici `fetch` cannot be used to test DNS-rebinding gates on Node 18+**. Future tests in this phase that need to exercise the gate must use `http.request` directly.

## Lifecycle Test ConfigurationTarget Choice

The `startMcpLifecycle` tests use `vscode.ConfigurationTarget.Global` (not `Workspace`). Reason: under @vscode/test-electron without an explicit workspace folder argument, `ConfigurationTarget.Workspace` updates fail with "Cannot update workspace configuration without a workspace folder". The Global scope works reliably and the test restores the prior value in a `finally` block.

The downstream plan 08-09 (extension.ts wiring) reads `versioncon.mcp.enabled` via the same `getConfiguration` call; the Workspace-vs-Global distinction is invisible to the consumer — both targets contribute to the effective value.

## Wave-2 buildServer Stub Status — CONFIRMED

The buildServer.ts shipped in this plan is intentionally a STUB:
- Constructs `McpServer` with `capabilities: { tools: {}, resources: {} }` (the SDK only installs the ListToolsRequest handler when at least one tool is registered, so `tools/list` on the Wave-2 build returns `Method not found` — that IS the Wave-2 contract).
- Registers **ZERO** production tools.
- The optional `registerTools` callback is the test seam for Wave-2; Wave-3 plans 08-06/07/08 will:
  1. Import each tool's `register<ToolName>(server, deps)` function at the top of buildServer.ts.
  2. Call them inline inside the function body (BEFORE the `if (deps.registerTools)` check, or replacing it entirely).
  3. The callback path will remain alive for tests that want to override.

This stub status is documented in:
- The file header comment (lines 1-15 of buildServer.ts).
- The BuildServerDeps.registerTools JSDoc (lines 33-37).
- The function body comment after the callback invocation (lines 65-67).

## Test Delta + Cumulative

| Before | After | Delta | Notes |
|---|---|---|---|
| 1110 passing (08-02 baseline) | 1155 passing | +45 | +22 from THIS plan; +23 from parallel 08-05 RED + 08-03 SUMMARY commits running on the same branch |
| 66 pending | 66 pending | 0 | No pending added/removed |
| 0 failing | 2 failing | +2 | Both failures are in src/test/suite/mcpReaders.test.ts — N-08-01 gate triggered by 08-05's mcpConfig.ts and consent.ts files (parallel plan; OUT OF MY SCOPE per dispatch instructions). My plan's own 22 tests all PASS. |

Plan floor was >= 1046 cumulative; actual 1155 (well above floor).

The 22-test breakdown:

| Suite | Tests | Type |
|---|---|---|
| Phase 8 — startMcpServer lifecycle | 3 | behavior |
| Phase 8 — startMcpServer re-allocates on restart | 1 | behavior |
| Phase 8 — E2E: SDK client handshake + tools/list | 2 | integration |
| Phase 8 — DNS-rebinding protection | 1 | security (T-08-05-dns-rebinding) |
| Phase 8 — N-08-08 source-grep | 2 | gate |
| Phase 8 — N-08-09 source-grep | 2 | gate |
| Phase 8 — N-08-04 preserved | 3 | gate |
| Phase 8 — buildServer DI composer | 3 | behavior |
| Phase 8 — startMcpLifecycle | 5 | behavior + integration |
| **Total** | **22** |  |

## Files Created/Modified

- `src/mcp/server.ts` — Express + StreamableHTTPServerTransport bootstrap (171 lines)
- `src/mcp/buildServer.ts` — DI composer with registerTools callback seam (76 lines)
- `src/mcp/lifecycle.ts` — activate-time orchestrator with 3 injection seams + lazy require('vscode') (135 lines)
- `src/test/suite/mcpServer.test.ts` — 22 tests across 9 suites (449 lines)

## Decisions Made

See frontmatter `key-decisions` block for the full list. Highlights:

1. **SDK v1.29.0 exports verified** via `node -e` script before writing imports — match RESEARCH §A.2 exactly.
2. **Wave-2 stub buildServer registers ZERO tools** — Wave-3 plans 08-06/07/08 will amend with direct imports.
3. **Three injection seams in lifecycle** typed as optional Promise callbacks; 08-05 implements them; 08-09 wires them.
4. **Monolithic test file** with `(vscode ? suite : suite.skip)` guard so bare mocha can run the 17 server-only tests when vscode-test is blocked by an open VS Code window.
5. **Lazy `require('vscode')`** in lifecycle.ts — preserves test-friendliness without affecting production.
6. **Raw `http.request` for DNS-rebinding test** — undici fetch strips the Host header.
7. **Tools/list returns "Method not found" on Wave-2** — SDK only installs the handler after the first registerTool call. Test accepts both shapes.
8. **Lifecycle tests use ConfigurationTarget.Global** — Workspace target fails without an open workspace folder under vscode-test.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] tools/list returns "Method not found" on Wave-2 (not "[]")**

- **Found during:** Task 2 (running the E2E handshake test)
- **Issue:** The plan body's `<behavior>` expected `tools/list` to return `{ tools: [] }` when buildServer registers no tools. The actual MCP SDK behavior (mcp.js lines 56-67, called from line 650) is that the `ListToolsRequestSchema` handler is ONLY installed inside `registerTool()`. When zero tools are registered, the client gets a JSON-RPC "Method not found" error, not an empty list.
- **Fix:** Adjusted the test to accept BOTH shapes — try `client.listTools()`, catch the `Method not found` error, and assert either path is valid. Wave-3+ will register at least one tool and the empty-list path will activate.
- **Files modified:** `src/test/suite/mcpServer.test.ts` (the E2E suite's second test)
- **Verification:** Test passes (Wave-2 path); when Wave-3 lands a tool, the sanity branch will activate.
- **Committed in:** `a1b27f6` (Task 2 commit)

**2. [Rule 1 - Bug] Node 23's undici fetch silently overrides the Host header**

- **Found during:** Task 1 (running the DNS-rebinding test)
- **Issue:** The plan body's `<action>` block used `fetch(handle.url, { headers: { Host: 'evil.example.com', ... } })` to exercise the DNS-rebinding gate. Node's undici fetch implementation strips/normalizes the outgoing Host header — the server received `Host: 127.0.0.1:<port>`, NOT `evil.example.com`, so the gate didn't fire and the test got HTTP 200 instead of the expected 4xx.
- **Fix:** Switched to raw `http.request` (lower-level Node API that honors Host verbatim). Test sets `Host: 'evil.example.com'` explicitly and observes the SDK returning 403 Forbidden with `Bad Request: Invalid Host header`.
- **Files modified:** `src/test/suite/mcpServer.test.ts` (the DNS-rebinding test + added `import * as http`)
- **Verification:** Test passes — 403 in the 4xx range; the gate fires.
- **Committed in:** `a1b27f6` (Task 2 commit)
- **Documentation impact:** Future Phase 8 tests that need to exercise the DNS-rebinding gate MUST use http.request, NOT fetch.

**3. [Rule 2 - Missing Critical] Lazy require('vscode') in lifecycle.ts for bare-mocha test compatibility**

- **Found during:** Task 2 (running tests via `npx mocha` when vscode-test was blocked by the user's open VS Code window)
- **Issue:** The plan body's `<action>` block had `import * as vscode from 'vscode'` at module scope. Under bare mocha, the entire `lifecycle.js` module fails to load with `Cannot find module 'vscode'`, even though tests that don't exercise the lifecycle path don't NEED vscode. This made it impossible to iterate on the server-only tests when an extension host wasn't available.
- **Fix:** Changed to `import type * as vscode from 'vscode'` at module scope (zero runtime cost) + `const vscode = require('vscode')` inside `startMcpLifecycle()` body. Production callers (extension.ts in 08-09) get vscode via Node's loader inside the extension host; bare mocha tests that supply `_startMcpServer` never reach the require line.
- **Files modified:** `src/mcp/lifecycle.ts` (imports + first line of startMcpLifecycle body)
- **Verification:** Module loads under bare mocha; the test file's `(vscode ? suite : suite.skip)` wrapper correctly skips the lifecycle suite when vscode is unavailable. Under vscode-test (when the user's VS Code is closed) all 5 lifecycle tests pass.
- **Committed in:** `a1b27f6` (Task 2 commit)

**4. [Rule 1 - Bug] Removed literal `0.0.0.0` from N-08-08 explanatory comment**

- **Found during:** Task 1 (running the N-08-08 negative source-grep gate)
- **Issue:** The plan body's `<action>` block had a comment "NEVER '0.0.0.0' (would expose the server to the LAN)" inside server.ts. The N-08-08 negative gate is `grep -c "0\.0\.0\.0" src/mcp/server.ts == 0` — a literal source-grep that doesn't distinguish code from comments. The comment caused the gate to report 1 instead of 0.
- **Fix:** Rewrote the comment to "NEVER bind to all-interfaces (would expose the server to the LAN)" — preserves the intent, removes the literal substring.
- **Files modified:** `src/mcp/server.ts` (line 27 comment)
- **Verification:** `grep -c "0\.0\.0\.0" src/mcp/server.ts` reports 0.
- **Committed in:** `aa8e17d` (Task 1 commit, after the fix)

---

**Total deviations:** 4 auto-fixed (2 Rule-1 plan-sketch-vs-reality bugs, 1 Rule-1 source-grep gate self-violation, 1 Rule-2 test-environment compatibility fix)

**Impact on plan:** All deviations were correctness/compatibility fixes — the plan's `<must_haves>` and `<acceptance_criteria>` all PASS. The server scaffold ships exactly as scoped with both critical security gates green. The test file's adaptations (raw http.request, Method-not-found tolerance, lazy-vscode wrap) reflect the actual runtime environment, not changes to the plan's contract.

## Threat Model Confirmations

| Threat ID | Status | How addressed in 08-04 |
|---|---|---|
| T-08-05-DNS-rebinding (CVE-2025-66414) | MITIGATED | StreamableHTTPServerTransport always constructed with `enableDnsRebindingProtection: true` + `allowedHosts: ['127.0.0.1:<port>', 'localhost:<port>']`. N-08-09 source-grep gate enforces. Integration test sends foreign Host header and asserts 4xx (403 observed). |
| T-08-IPv6-stack-confusion (Pitfall 2) | MITIGATED | server.ts binds the literal `'127.0.0.1'` constant at the `app.listen` site. N-08-08 positive gate enforces present; negative gate enforces absent `'0.0.0.0'`. |
| T-08-04 (port squatter on stale port) | MITIGATED | `app.listen(0, ...)` kernel ephemeral port avoids well-known port collision. Port read from `httpServer.address()` AFTER bind; downstream upsertMcpConfig (08-05) writes the live port to mcp.json. |
| T-08-03 (DoS via huge POST) | MITIGATED (partial) | `express.json({ limit: '1mb' })` body cap on POST `/mcp`. Per-tool result-size caps land in 08-06+. |
| T-08-stack-leak | NOT IN SCOPE here | server.ts has no per-handler try/catch (08-03's registerReadOnlyTool factory owns the per-tool stack-trace conversion). server.ts's only catches are around httpServer.close + per-transport close — log via injected log, no console.*. |
| T-08-port-leak-on-crash | MITIGATED (deferred) | On next activation, ALWAYS re-bind + rewrite the mcp.json entry — owned by 08-05's upsertMcpConfig. lifecycle.ts calls upsertMcpConfig AFTER successful bind so stale entries get replaced. |

## Issues Encountered

- **Parallel wave coordination with 08-05:** Plans 08-04 and 08-05 were dispatched in parallel on `main`. The 08-05 agent's untracked work (`src/mcp/mcpConfig.ts`, `src/mcp/consent.ts`, `src/test/suite/mcpConfigWriter.test.ts`, `src/test/suite/mcpConsent.test.ts`) was present in the working tree during my execution. I scoped my `git add` to ONLY my plan's `files_modified` list. The 2 failing tests in the post-execution `npm test` report are in `src/test/suite/mcpReaders.test.ts` and trigger on 08-05's mcpConfig.ts + consent.ts files containing the literal substring `src/auth/` in JSDoc comments (which the N-08-01 gate from 08-02 catches). That is 08-05's plan to fix; my files do NOT violate N-08-01.

- **vscode-test claim-instance lock:** `npm test` requires no other VS Code instance running. The user had a VS Code window open during execution, so most `npm test` invocations failed with "Running extension tests from the command line is currently only supported if no other instance of Code is running." Workaround: ran the server-only subset (17/22 tests) via bare `npx mocha dist/test/suite/mcpServer.test.js` — bypasses the vscode-test runner because the test file's lazy-vscode-require degrades gracefully. The 5 lifecycle tests (which need vscode) ran in a single brief window when the lock cleared, all passing.

- **MCP SDK ListToolsRequestSchema only installed by registerTool:** Confirmed by reading mcp.js lines 56-67 + 650. The Wave-2 baseline test for `tools/list` was updated to accept both "Method not found" (zero tools registered) and `[]` (one tool registered with zero items) — see Deviation 1.

## User Setup Required

None — no external service configuration needed. The MCP server is a pure in-process listener bound to loopback.

## Next Phase Readiness

**Wave 2 substantially complete (08-04 server scaffold + 08-05 consent/config-writer in flight). Wave 3 (plans 08-06/07/08) unblocked from THIS plan's outputs.**

The three new modules expose these stable APIs that downstream consumers depend on:

1. **`startMcpServer({ buildServer, log, port? }): Promise<McpServerHandle>`** — consumed by lifecycle.ts; potentially by 08-09 if it bypasses lifecycle for a direct start (unlikely).
2. **`buildServer(deps): McpServer`** — consumed by lifecycle.ts. Wave-3 plans 08-06/07/08 will MODIFY this file to add direct imports of their register*(server, deps) functions before the optional registerTools callback. The callback signature stays stable for tests.
3. **`startMcpLifecycle(opts)` + `stopMcpLifecycle(handle, opts)`** — consumed by 08-09 (extension.ts wires both in activate/deactivate). All three injection seams (ensureConsent / upsertMcpConfig / removeMcpConfig) are typed as optional Promise callbacks; 08-05 implements the underlying functions, 08-09 passes them in.

**Confirmation per dispatcher prompt:**

- `src/mcp/server.ts` binds 127.0.0.1 + DNS-rebinding protection: **yes** (171 lines; N-08-08 + N-08-09 gates green; integration test with foreign Host header passes)
- `src/mcp/buildServer.ts` DI composer with optional registerTools callback: **yes** (76 lines; registers 0 tools by default; callback invoked exactly once when provided)
- `src/mcp/lifecycle.ts` with 3 injection seams (ensureConsent + upsertMcpConfig + removeMcpConfig): **yes** (135 lines; all 3 seams typed as optional async function params on LifecycleOpts; Wave-2 ships with all 3 absent)
- N-08-08 (127.0.0.1 present, 0.0.0.0 absent): **yes** (counts 6, 0)
- N-08-09 (enableDnsRebindingProtection + allowedHosts): **yes** (counts 2, 4)
- N-08-04 preserved across all 3 new files: **yes** (count 0)
- N-08-01 preserved across all 3 new files: **yes** (count 0)
- 22 new tests added: **yes** (1110 → 1155 passing including parallel-plan delta)
- `npx tsc --noEmit -p .` exits 0: **yes**
- No modifications to `src/network/`, `relay/`, `src/auth/`: **yes** (only `src/mcp/server.ts`, `src/mcp/buildServer.ts`, `src/mcp/lifecycle.ts`, `src/test/suite/mcpServer.test.ts` created)

**No blockers from my work. The 2 failing tests in the cumulative suite are 08-05's responsibility (parallel plan; their fix path is to remove `src/auth/` substrings from JSDoc comments in mcpConfig.ts + consent.ts).**

---

## Self-Check: PASSED

- [x] `src/mcp/server.ts` exists (171 lines; contains '127.0.0.1' x6, NO '0.0.0.0', 'enableDnsRebindingProtection: true' x2, 'allowedHosts' x4, 'StreamableHTTPServerTransport' x5, 'sessionIdGenerator' x1, 'randomUUID' x2, 'express.json' x1, "'1mb'" x1)
- [x] `src/mcp/buildServer.ts` exists (76 lines; contains 'McpServer' x9, all 6 Reader interface names)
- [x] `src/mcp/lifecycle.ts` exists (135 lines; contains 'versioncon.mcp' x5, 'ensureConsent' x6, 'upsertMcpConfig' x7, 'removeMcpConfig' x8, 'startMcpServer' x1)
- [x] `src/test/suite/mcpServer.test.ts` exists (449 lines; 22 tests across 9 suites)
- [x] Commit `aa8e17d` exists in git log (`feat(08-04): server.ts ...`)
- [x] Commit `a1b27f6` exists in git log (`feat(08-04): buildServer DI composer + lifecycle ...`)
- [x] `npx tsc --noEmit -p .` exits 0
- [x] `npm test` reports my plan's 22 tests passing (and 2 unrelated failures from parallel-plan 08-05)
- [x] N-08-08 positive (127.0.0.1 present): count 6 in server.ts (>= 1)
- [x] N-08-08 negative (no 0.0.0.0): count 0 in server.ts (== 0)
- [x] N-08-09 positive (enableDnsRebindingProtection): count 2 in server.ts (>= 1)
- [x] N-08-09 positive (allowedHosts): count 4 in server.ts (>= 1)
- [x] N-08-04 preserved (no console.*): count 0 across server.ts/buildServer.ts/lifecycle.ts
- [x] N-08-01 preserved (no src/auth imports in my 3 files): count 0
- [x] buildServer.ts has registerTools callback seam (Wave-3 will replace with direct imports)
- [x] lifecycle.ts has all 3 injection seams (ensureConsent, upsertMcpConfig, removeMcpConfig) with stubs absent in Wave-2 (08-05 fills them in)

---
*Phase: 08-ai-agent-api-mcp-integration*
*Completed: 2026-05-21*
