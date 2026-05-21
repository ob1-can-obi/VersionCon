---
phase: 8
slug: ai-agent-api-mcp-integration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-21
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

*Filled out by planner during plan generation; this is the skeleton.*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| (planner to fill from RESEARCH §A-I + STRIDE table) |  |  |  |  |  |  |  |  | ⬜ pending |

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

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (sdk pkg install, jsonc-parser, settings)
- [ ] No watch-mode flags
- [ ] Feedback latency < 20s
- [ ] `nyquist_compliant: true` set in frontmatter once planner finishes

**Approval:** pending (planner sign-off)
