---
phase: 8
slug: ai-agent-api-mcp-integration
status: planner_signed_off
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-21
populated_from_plans: 2026-05-21
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Detail derived from 08-RESEARCH.md "Validation Architecture" section.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | mocha 11.x + @vscode/test-electron + assert/strict (existing repo convention; same harness used by ~70 test files in `src/test/suite/`) |
| **Config file** | `.mocharc.js` (existing) + `src/test/runTest.ts` (existing) |
| **Quick run command** | `npm test -- --grep "<test name>"` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~16-20 seconds (current 1061 tests run in 16s; +80 new tests adds ~1-2s) |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- --grep "<task-specific test name>"`
- **After every plan wave:** Run `npm test` (full extension suite)
- **Before `/gsd-verify-work`:** Full suite must be green (target: 1061 + ≥80 = ≥1141 passing)
- **Max feedback latency:** ~20 seconds

---

## Per-Task Verification Map

*Populated from per-plan `<verify><automated>` blocks (2026-05-21).*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|--------|
| 08-01-T1 | 08-01 | 0 | AI-01 | T-08-06 (supply-chain) | Deps pinned + audit clean | install + audit | `npm install && npm audit --omit=dev` | ⬜ pending |
| 08-01-T2 | 08-01 | 0 | AI-01 | — | FakeReaders fixture compiles + smoke-tests | unit | `npx tsc --noEmit && npm test -- --grep "mcpFixtures"` | ⬜ pending |
| 08-02-T1 | 08-02 | 1 | AI-02, AI-03 | T-08-01, T-08-02 | readers.ts type-only, no writers, no auth import | structural + grep | `npx tsc --noEmit && grep -rE 'import.*from.*src/auth' src/mcp/ \| wc -l` == 0 AND `grep -c 'set[A-Z]' src/mcp/readers.ts` near 0 | ⬜ pending |
| 08-02-T2 | 08-02 | 1 | AI-02, AI-03 | T-08-02 (info disclosure) | 6 adapters delegate to existing classes; defensive copies | unit | `npm test -- --grep "readerAdapters"` | ⬜ pending |
| 08-03-T1 | 08-03 | 1 | AI-01 | T-08-01 (EoP) | READ_ONLY_TOOLS Set + registerReadOnlyTool factory | unit + grep | `npm test -- --grep "mcpRegistry"` AND `grep -c 'READ_ONLY_TOOLS\.has' src/mcp/` >= 1 | ⬜ pending |
| 08-04-T1 | 08-04 | 2 | AI-01 | T-08-04, T-08-05 (DNS-rebind) | 127.0.0.1 + enableDnsRebindingProtection + allowedHosts | unit | `npm test -- --grep "mcpServer"` AND `grep -c "enableDnsRebindingProtection: true" src/mcp/server.ts` >= 1 | ⬜ pending |
| 08-04-T2 | 08-04 | 2 | AI-01 | T-08-04 | lifecycle.ts start/stop + port allocation; sequential idempotent | unit | `npm test -- --grep "mcpLifecycle"` | ⬜ pending |
| 08-05-T1 | 08-05 | 2 | AI-01 | T-08-07, T-08-09 (sibling-destruction) | jsonc-parser modify preserves comments + sibling entries; no token field | unit | `npm test -- --grep "mcpConfig"` | ⬜ pending |
| 08-05-T2 | 08-05 | 2 | AI-01 | T-08-CONSENT-bypass | First-run prompt mirrors Phase 7 T-07-10; Global setting persists | unit | `npm test -- --grep "mcpConsent"` | ⬜ pending |
| 08-06-T1 | 08-06 | 3 | AI-02 | T-08-03 (DoS — result caps) | 4 tools (branch/sync/activity/chat) registered with readOnlyHint + result-size caps | unit + integration | `npm test -- --grep "mcpSimpleReaderTools"` | ⬜ pending |
| 08-07-T1 | 08-07 | 3 | AI-03 | T-08-03, T-08-10 (path-traversal) | queryDeps + listDeps tools + versioncon-state:// resource; <100ms p95 perf | unit + integration + perf | `npm test -- --grep "mcpDependencyReader"` | ⬜ pending |
| 08-08-T1 | 08-08 | 4 | AI-04 | T-08-03 | adviseSync composite returns state + predicted_conflicts with 5-tier confidence | unit + heuristic | `npm test -- --grep "mcpAdviseSync"` | ⬜ pending |
| 08-09-T1 | 08-09 | 5 | AI-01, AI-02, AI-03, AI-04 | All T-08-* | extension.ts activate/deactivate wires startMcpLifecycle; index.ts barrel export | integration | `npm test -- --grep "mcpActivation"` | ⬜ pending |
| 08-09-T2 | 08-09 | 5 | AI-01, AI-03 | — | 4 E2E test files prove SC-1..SC-4; final N-08-01..09 grep sweep | E2E + grep sweep | `npm test` (full suite >= 1141 passing) AND all N-08-XX gates green | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Success-Criterion → Test Mapping

| SC | Requirement | Test Suite | Pass Criteria |
|---|---|---|---|
| **SC-1** | AI-01, AI-02 (config-free setup; AI agent reads branch/sync/activity) | `mcpToolSurfaceE2E.test.ts` | Connect MCP client → assert `tools/list` contains `get_branch_status`, `get_sync_status`, `get_recent_activity` → call each → assert non-empty result with shape from RESEARCH §F |
| **SC-2** | AI-03 (full dep graph read) | `mcpDependencyReaderE2E.test.ts` | Boot MCP server against a fixture workspace with known symbol relationships → call `query_dependencies('parseToken')` and `list_dependents('verifyClient')` → assert returned graph slice matches fixture; per-call latency p95 ≤ 100ms |
| **SC-3** | (strictly read-only) | `mcpReadOnlyEnforcementE2E.test.ts` + source-grep gates N-08-01..N-08-03 | (a) Assert `tools/list` contains NO write tools (negative test); (b) Assert runtime `READ_ONLY_TOOLS.has(name)` gate rejects synthetic write-tool name; (c) Source-grep: `grep -rE 'import.*from.*src/auth' src/mcp/ | wc -l` == 0 |
| **SC-4** | AI-04 (out-of-sync advisory + conflict prediction) | `mcpAdviseSyncE2E.test.ts` | Synthetic out-of-sync workspace state → call `advise_sync` → assert returned payload includes `state.behind > 0` AND at least one `predicted_conflicts` entry with `reason ∈ {ast-symbol-overlap, file-edit-overlap, lock-held-by-peer}` AND `confidence > 0` |

---

## Requirement → Test Mapping

| REQ-ID | Description | Test |
|---|---|---|
| **AI-01** | Expose extension state via MCP protocol | `mcpServerLifecycle.test.ts` — boot server, handshake (initialize), `tools/list`, `resources/list` |
| **AI-02** | AI agents read branch/sync/activity/chat | `mcpToolSurfaceE2E.test.ts` + per-tool unit tests (`getBranchStatus.test.ts`, `getSyncStatus.test.ts`, `getRecentActivity.test.ts`, `getChatLog.test.ts`) |
| **AI-03** | AI agents read dep graph | `mcpDependencyReaderE2E.test.ts` + unit tests (`queryDependencies.test.ts`, `listDependents.test.ts`, `dependencyGraphResource.test.ts`) |
| **AI-04** | AI agents understand sync, advise + flag conflicts | `mcpAdviseSyncE2E.test.ts` + `adviseSync.test.ts` (unit-level heuristic composition) |

---

## Security Gate → Test Mapping

(Source-grep gates from CONTEXT §gates_and_invariants + RESEARCH N-08-09 addition)

| Gate | Verification |
|---|---|
| **N-08-01** Read-only structural (no `src/auth/` import) | `grep -rE 'import.*from.*src/auth' src/mcp/ \| wc -l` == 0 |
| **N-08-02** Runtime read-only allow-list wired | `grep -c 'READ_ONLY_TOOLS\.has' src/mcp/` >= 1 |
| **N-08-03** No writers in readers.ts | `grep -E 'set[A-Z]\|push\|update\|delete\|commit' src/mcp/readers.ts \| wc -l` == 0 (modulo documented allowlist for `setTimeout`/`setInterval`) |
| **N-08-04** Logger discipline (no console.* in `src/mcp/`) | `grep -rE '^\s*console\.' src/mcp/ \| wc -l` == 0 |
| **N-08-05** No new transport in `src/network/` | `git diff --name-only main..HEAD -- src/network/` empty |
| **N-08-06** No `relay/` changes | `git diff --name-only main..HEAD -- relay/` empty |
| **N-08-07** Test count floor | Total extension tests >= 1141 (1061 baseline + 80 new) |
| **N-08-08** Localhost-only binding | `grep -c "127\.0\.0\.1\|localhost" src/mcp/server.ts` >= 1 AND `grep -c "0\.0\.0\.0" src/mcp/server.ts` == 0 |
| **N-08-09 (NEW from RESEARCH)** DNS-rebinding protection enabled (CVE-2025-66414) | `grep -c "enableDnsRebindingProtection: true" src/mcp/server.ts` >= 1 AND `grep -c "allowedHosts" src/mcp/server.ts` >= 1 |

---

## Wave 0 Requirements

- [ ] Add `@modelcontextprotocol/sdk@^1.29.0` to `package.json` dependencies
- [ ] Add `jsonc-parser@^3.3.1` to `package.json` dependencies (for safe `.vscode/mcp.json` merge)
- [ ] Add MCP TS-SDK to dev-dependencies if a separate test-utilities path is needed (researcher to confirm)
- [ ] Add `versioncon.mcp.enabled`, `versioncon.mcp.port`, `versioncon.mcp.consent` settings to `package.json` `contributes.configuration`
- [ ] `src/test/suite/mcpFixtures.ts` — shared fixtures: a tiny client wrapper that bootstraps an MCP HTTP client against an ephemeral-port server, helpers for synthetic SessionHost state

*Existing infrastructure (mocha + @vscode/test-electron + assert/strict) covers all phase requirements — no framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| UAT-8-1: First-run consent prompt UX | AI-01 / SC-1 | OS-modal dialog; can't be asserted from mocha headless test reliably | Fresh install on a clean workspace → open VS Code → accept the VersionCon MCP consent prompt → verify `.vscode/mcp.json` written; reject the prompt → verify NOT written |
| UAT-8-2: Claude Code reads `.vscode/mcp.json` and lists VersionCon tools | AI-01 / SC-1 | Cross-tool integration; Claude Code is external | In a workspace with the extension active → run `claude` CLI → `/mcp` → verify `versioncon` server appears with the 7 expected tools |
| UAT-8-3: VS Code Copilot Chat agent-mode picks up the server | AI-01 / SC-1 | Copilot Chat UI verification | Open Copilot Chat in agent mode → `@versioncon` mention → verify tool catalog visible; invoke `get_branch_status` and verify response |
| UAT-8-4: Cursor reads the same mcp.json | AI-01 | Cross-tool integration; Cursor is external | In Cursor with the workspace open → MCP panel → verify `versioncon` listed → invoke a tool |
| UAT-8-5: Live conflict-prediction scenario | AI-04 / SC-4 | Requires two-machine setup or paired Phase 4 presence emission | Two machines, both with VersionCon active and joined to the same session. Machine A edits `parseToken` in `src/auth/TokenService.ts`; Machine B edits `verifyClient` in `relay/src/auth.ts` (depends on parseToken). On Machine B, the AI agent calls `advise_sync` → verify `predicted_conflicts` contains the symbol-overlap entry |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (sdk pkg install, jsonc-parser, settings)
- [x] No watch-mode flags (all commands are one-shot `npm test -- --grep "..."` or `npm test`)
- [x] Feedback latency < 20s (per-task grep: <1s, per-suite mocha: ~16s)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-05-21 (orchestrator-signed after plan-checker BLOCKER 4 resolution)

## E2E Test File Naming — Aligned with Plans (WARNING 6 resolution)

VALIDATION.md SC→test mapping originally referenced canonical names; the actual test files produced by 08-09 use slightly different names. Authoritative table:

| SC | Plan that produces | Actual test file name |
|---|---|---|
| SC-1 | 08-09 Task 2 | `src/test/suite/mcpActivation.test.ts` (covers activation + tool surface) |
| SC-2 | 08-07 Task 1 + 08-09 Task 2 | `src/test/suite/mcpDependencyReader.test.ts` |
| SC-3 | 08-03 Task 1 + 08-09 Task 2 | `src/test/suite/mcpRegistry.test.ts` (Layer-2 gate) + `src/test/suite/mcpReadOnlyEnforcement.test.ts` (E2E) |
| SC-4 | 08-08 Task 1 + 08-09 Task 2 | `src/test/suite/mcpAdviseSync.test.ts` |
