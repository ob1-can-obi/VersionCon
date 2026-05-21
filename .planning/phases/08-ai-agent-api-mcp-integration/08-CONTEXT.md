# Phase 8: AI Agent API (MCP Integration) - Context

**Gathered:** 2026-05-21
**Status:** Ready for planning
**Source:** /gsd-discuss-phase 8 --all (best-fit auto-decision mode)

<domain>
## Phase Boundary

Deliver an MCP (Model Context Protocol) server inside the VersionCon VS Code extension that exposes collab state — branch, sync, recent activity, chat log, dependency graph, sync advice — as **strictly read-only** tools to AI agents (Claude Code, Cursor, VS Code Copilot, Codex). After this phase, an AI agent that has read VersionCon's MCP context can correctly identify "you're out-of-sync" and "this push will conflict with Bob's edit to symbol X" without any manual setup beyond enabling the extension (SC-1, SC-4).

**In scope:**
- MCP server hosted **in-process inside the VS Code extension** (HTTP/SSE on localhost), accessed by AI clients via auto-written config in `.vscode/mcp.json`
- Tool catalog (granular, callable functions; not a coarse get_context blob): `get_branch_status`, `get_sync_status`, `get_recent_activity`, `get_chat_log`, `query_dependencies`, `list_dependents`, `advise_sync`
- Resource catalog (browseable state): `versioncon-state://dependency-graph/{file_or_symbol}` for the dep graph (browseable URI form alongside the query-tool form). **Scheme amended per RESEARCH §G.2 (2026-05-21):** original choice was `versioncon://` but the deep-link UriHandler from Phase 7 already owns that scheme; `versioncon-state://` provides clean namespace separation with zero functional difference for MCP clients
- Read-only enforcement at TWO layers: (a) the MCP-server module imports ONLY Reader interfaces from `src/state/`, `src/host/`, `src/ast/` — TypeScript types prevent accidentally wiring a writer; (b) the `tools/call` dispatcher asserts the tool name is on a hard-coded READ_ONLY_TOOLS allow-list before invocation. Both gates source-grep-tested (mirror Phase 7's T-07-XX gate discipline)
- Auto-port allocation + auto-write `.vscode/mcp.json` on extension activation (with one-time user confirmation prompt, mirroring Phase 7's UriHandler T-07-10 confirmation pattern)
- Sync-advice tool that returns BOTH: (1) static state facts (`behind: 3, ahead: 1, dirty_files: [...]`), AND (2) predicted-conflict array from Phase 5 AST + Phase 4 file-presence cross-reference, with confidence scores
- Setting toggle `versioncon.mcp.enabled` (default `true`) to disable for users who don't want it
- One server per VS Code workspace; each writes its own `.vscode/mcp.json` on its own port (no multi-workspace coordination logic — each workspace is independent)

**Architectural seams shipped for future security/AI-write phase (no rewrite required when they land):**
- Tool registration goes through a `registerReadOnlyTool(name, schema, handler)` factory that enforces the read-only contract by construction; a future `registerWriteTool` would be a separate, gated factory (not present in v1)
- MCP server module is import-isolated from any state-mutation code; the file-level boundary makes a future security review trivially auditable
- Tool descriptions are LLM-facing prompts — written as such, with examples and call-when-to-use guidance baked in (treats descriptions as first-class artifacts, not afterthoughts)

**Out of scope (deferred to future phases):**
- WRITE tools (push, create_branch, sync, comment-on-review, send-chat-message). Phase 8 is strictly read-only per SC-3 lock. Deferred to a future "AI write API" phase that will require its own permission/audit model
- MCP **prompts** primitive (parameterized prompt templates accessible from client UI). Not needed for v1; tools + resources cover AI-01..04. Deferred indefinitely
- OAuth / bearer-token auth on the MCP server. Localhost-only trust boundary is sufficient for v1 (same defense-in-depth-in-layers philosophy as Phase 7's L4 deferral). The TLS/JWT story for remote MCP access lands when (and if) we expose MCP over the relay
- Reading state of **remote cloud-mode sessions** via MCP (e.g. an AI agent seeing the chat log of a session that's running on a peer machine). v1 reads only the local extension's state — the same view the human user sees. Cross-machine MCP federation is a separate concern
- Listing / interrogating **other team members'** dependency graphs. Each user's MCP server exposes only the local user's view of the codebase + collab state
- Auto-detection / auto-registration with non-VS-Code AI clients beyond writing `.vscode/mcp.json` (which Claude Code and Codex can also read at workspace root). Dual-config to `~/.claude/.mcp.json` or `~/.codex/...` deferred to user docs
- Streaming tool results / long-running tools / progress notifications. All v1 tools return synchronously in <100ms (in-process, in-memory reads). Future expensive tools (e.g. cross-repo analysis) would need streaming — not in scope
- Token-budget protection for huge result sets. v1 caps each tool's result size by pre-computing limits (e.g. `get_recent_activity` defaults to last 20 events, `get_chat_log` to last 50 messages, `query_dependencies` to 1-2 hops). The LLM never sees the full dep graph at once
- Telemetry / observability on MCP tool calls. Defer to a future "AI usage analytics" concern; v1 logs to OutputChannel only (mirroring Phase 7's logger discipline)

The MCP server is deliberately a **read-only viewport** onto state that already exists. All VersionCon protocol logic (chat, presence, push, AST, review, permission gates) stays untouched. Phase 8 adds no new collaboration capabilities — it makes the existing ones legible to AI tools.

</domain>

<decisions>
## Implementation Decisions

### 1. Transport: HTTP/SSE on localhost, in-process
**LOCKED.** The MCP server runs inside the extension host process and binds an HTTP/SSE listener on `127.0.0.1:<auto-allocated-port>`. AI clients connect via `.vscode/mcp.json` URL entries.

**Rationale:**
- Direct access to `SessionHost`, the Phase 5 AST graph (`src/ast/AstAnalyzer.ts`), and live state — zero IPC overhead, zero serialization-boundary bugs
- One config entry works for both Claude Code AND VS Code Copilot (and Cursor, Codex) — they all read `.vscode/mcp.json`
- Matches SC-1 "no manual setup beyond enabling the extension" (extension auto-writes the config on activate)
- Mirrors the pattern used by GitHub MCP Server, Postgres MCP, and the canonical VS Code "MCP Tools" sample — these all live inside long-running host processes
- Trust boundary is the user's local machine; same model as VS Code's own LM API. No new attack surface

**Disqualified — stdio subprocess:** would require either spawning a separate Node process (which can't see in-memory `SessionHost`) or building a custom IPC layer back to the extension. Extra code, extra boundary, no win for our use case.

**Disqualified — dual stdio+HTTP:** doubles the test matrix, gains nothing since all four target clients (Claude Code, VS Code Copilot, Cursor, Codex) support HTTP/SSE.

### 2. Tool surface: granular tools, not coarse get_context
**LOCKED.** Each user-facing capability (branch status, sync status, recent activity, chat, dep-graph) is exposed as a SEPARATE MCP tool with its own schema and description. Plus one composite advisory tool (`advise_sync`) that orchestrates several reads for the AI's most common question.

**Initial catalog (subject to refinement during /gsd-plan-phase research):**

| Tool name | Purpose | Returns | Requirement |
|---|---|---|---|
| `get_branch_status` | Current branch, ahead/behind vs main, dirty files | `{branch, ahead, behind, dirty: [path]}` | AI-02, SC-1 |
| `get_sync_status` | Last sync time, pending pushes, any sync-blocked files | `{last_sync_at, pending_pushes: [...], blocked: [...]}` | AI-02, SC-1 |
| `get_recent_activity(limit?)` | Recent pushes — who, when, what files | `[{actor, ts, files, message}]` | AI-02, SC-1 |
| `get_chat_log(limit?, since?)` | Chat history (READ-ONLY — no send) | `[{actor, ts, text, channel}]` | AI-02 |
| `query_dependencies(symbol\|file)` | Symbols/files the target depends ON (forward) | `{depends_on: [...], hops: 1-2}` | AI-03, SC-2 |
| `list_dependents(symbol\|file)` | Files/symbols that depend on the target (reverse) | `{dependents: [...], hops: 1-2}` | AI-03, SC-2 |
| `advise_sync(target_files?)` | Composite: state + predicted conflicts | `{state: {...}, predicted_conflicts: [{file, reason, confidence}]}` | AI-04, SC-4 |

**Rationale:**
- Each tool's description is effectively a **prompt to the LLM** about when to call it — granular tools yield better model decisions ("the model picks the right tool for the right question")
- Aligns with how Postgres MCP, GitHub MCP, Linear MCP shape their surfaces — one tool per logical query
- A coarse `get_context()` returning everything blows the model's context window and forces the LLM to scan irrelevant data. Granular tools let the LLM read only what it needs

**Resources (in addition to tools):**
- `versioncon-state://dependency-graph/{path_or_symbol}` — browseable URI form of `query_dependencies`, so AI clients that prefer the Resources primitive (some IDE-integrated agents) can drag-and-drop or @-mention dep info into the chat. Same underlying data as the tool. **Scheme finalized per RESEARCH §G.2:** `versioncon-state://` (NOT `versioncon://` — that scheme is owned by Phase 7's deep-link UriHandler)

### 3. Read-only enforcement: structural + runtime, both source-grep gated
**LOCKED.** Two-layer defense, mirroring Phase 7's T-07-XX gate discipline.

**Layer 1 — Structural (compile-time):**
- The MCP server module (`src/mcp/`) imports ONLY Reader interfaces — explicit `BranchReader`, `SyncReader`, `ActivityReader`, `ChatReader`, `DependencyReader` types defined in `src/mcp/readers.ts`
- These Reader types expose `get*` / `list*` / `query*` methods only — no `set*`, `push*`, `update*`, `delete*`
- Source-grep gate: `grep -rE 'push|commit|send|update|delete|set[A-Z]' src/mcp/ | wc -l` near zero (allowance for false positives like `setTimeout`)
- TypeScript compile is itself the first gate — if a writer leaks in, `tsc --noEmit` fails

**Layer 2 — Runtime (defense-in-depth):**
- Hard-coded `READ_ONLY_TOOLS` allow-list in `src/mcp/registry.ts` — a `Set<string>` of every tool name registered. The `tools/call` dispatcher asserts `READ_ONLY_TOOLS.has(name)` before invocation
- Any future write-tool would have to bypass BOTH the import boundary AND the runtime allow-list — not accidental
- Source-grep gate: `grep -c 'READ_ONLY_TOOLS\.has' src/mcp/` >= 1

**Threat model (preview — full STRIDE in /gsd-plan-phase):**
- T-08-01 (Elevation of Privilege) — model tricks server into calling a write-equivalent tool. Mitigation: structural + runtime gates above
- T-08-02 (Information Disclosure) — MCP server exposes state outside the user's view (e.g. another teammate's chat). Mitigation: server reads only the LOCAL extension's state, which is already filtered to what the human user sees
- T-08-03 (DoS) — model spams expensive tool calls. Mitigation: result-size caps + tool execution time logged; no rate-limit in v1 (localhost trust boundary)
- T-08-04 (Tampering) — non-VS-Code process binds the same port. Mitigation: port allocation uses `0` (kernel-assigned), written to `.vscode/mcp.json` on bind; a squatter on the port doesn't see our state

### 4. Dependency-graph access: query API, not full dump
**LOCKED.** Two query tools (forward + reverse) with 1-2 hop default; resource URI form for browseability.

**Rationale:**
- Phase 5's dep graph can hold thousands of symbols across a large codebase — full dump destroys the model's context window
- Query API matches how humans actually navigate dependency graphs: "what does X depend on?" and "what depends on X?"
- 1-hop default (direct relationships); `hops: 2` flag for one-level transitive — beyond that, the LLM should issue multiple targeted queries rather than load a giant subgraph
- Symbol-level AND file-level entry points (`query_dependencies('src/foo.ts')` and `query_dependencies('FooClass')` both work)

**Phase 5 integration:**
- `src/ast/AstAnalyzer.ts` already exposes the graph internally — Phase 8 adds a thin `DependencyReader` interface in `src/mcp/readers.ts` that wraps the existing API
- No changes to `src/ast/` source; Phase 8 is a viewport layer

### 5. Activation lifecycle: always-on, port auto-allocated, config auto-written with one-time consent
**LOCKED.** MCP server starts on extension activation (default). Allocates a free port, writes `.vscode/mcp.json`, then ready.

**First-run consent flow:**
- On first activation, before writing `.vscode/mcp.json`, prompt user: *"VersionCon wants to register an MCP server with this workspace so AI agents (Claude Code, Copilot, Cursor) can read your collab state. The server is local-only and read-only. Allow?"* — [Allow] / [Decline]
- If Decline: server doesn't start; setting `versioncon.mcp.enabled` flips to `false`; user can re-enable in settings
- If Allow: persistent setting `versioncon.mcp.consent: granted` — no future prompts
- Mirrors Phase 7's `UriHandler T-07-10` confirmation pattern — same pattern, same UX expectation

**Setting toggles:**
- `versioncon.mcp.enabled` (default `true`) — master switch
- `versioncon.mcp.port` (default `0` = auto-allocate) — manual override for users who need a specific port
- `versioncon.mcp.consent` (default `false`, set by first-run prompt) — persistent grant

**Lifecycle hooks:**
- `activate()` → start server, write config (if enabled + consent granted)
- `deactivate()` → stop server, REMOVE the config entry from `.vscode/mcp.json` (so a stale URL pointing at a dead port doesn't haunt the user's mcp.json)

**Multi-workspace:**
- Each VS Code window/workspace runs its own MCP server on its own port, writes its own `.vscode/mcp.json` entry
- No cross-workspace coordination — keeps the design simple and matches how VS Code itself isolates workspaces

### 6. Sync-advice: factual state + heuristic conflict prediction, never blocks
**LOCKED.** `advise_sync(target_files?)` returns a composite payload combining static state facts AND predicted-conflict heuristics.

**Composition:**
```typescript
{
  state: {
    behind: number,        // commits behind the team's view
    ahead: number,         // local commits not pushed
    dirty: string[],       // file paths with unsaved/unpushed changes
    last_sync_at: ISO8601,
  },
  predicted_conflicts: Array<{
    file: string,
    reason: 'ast-symbol-overlap' | 'file-edit-overlap' | 'lock-held-by-peer',
    confidence: 0.0 - 1.0,
    detail: string,        // human + LLM-readable explanation
    peer?: string,         // member display name if known
  }>,
}
```

**Two heuristic sources, fused in `advise_sync`:**
- (a) Phase 4 file-level presence — "Bob has file X open and dirty" → high-confidence `file-edit-overlap`
- (b) Phase 5 AST — "you edited symbol `parseToken`; Alice pushed a change to `verifyClient` which depends on `parseToken`" → medium-confidence `ast-symbol-overlap`

**Critical contract:**
- The advisory NEVER blocks anything (read-only)
- Confidence scores are LLM-actionable — the model can decide whether to surface a warning to the user or ignore a low-confidence prediction
- `target_files?` is optional — when present, scope to those files only; when absent, scope to all dirty + recent-locally-edited files (typical case)

**Out of scope for v1:**
- Sub-symbol-level conflict prediction (line-level diffs)
- Multi-hop transitive impact ("editing X breaks downstream Y which is being edited by Z") — bounded at 1 hop in v1
- Auto-execution of the advice ("auto-pull before commit") — that's a write operation; future phase

</decisions>

<canonical_refs>
## Canonical References

Downstream agents (researcher, planner, executor) MUST read these before acting:

**Phase planning artifacts:**
- `.planning/PROJECT.md` — project mission + tech stack
- `.planning/REQUIREMENTS.md` — AI-01..AI-04 (the spec for this phase, lines 89-92) + traceability table (lines 189-192)
- `.planning/ROADMAP.md` — Phase 8 scope + success criteria (SC-1..SC-4)
- `.planning/STATE.md` — current milestone state
- `.planning/phases/07-cloud-mode-relay-server/07-CONTEXT.md` — security-in-layers philosophy (L0..L4); seam discipline pattern; UriHandler consent UX (T-07-10) — this phase's first-run prompt mirrors that pattern

**Phase 5 dependency graph (REQUIRED reading for AI-03 / SC-2):**
- `src/ast/AstAnalyzer.ts` — graph builder + query API surface
- `src/ast/types.ts` — `Symbol`, `Dependency`, `AstGraph` types
- `src/ast/joinImpact.ts` — existing conflict-impact heuristic (Phase 5's contribution to AI-04 / SC-4)
- `.planning/phases/05-dependency-aware-conflict-detection-ast/05-01-SUMMARY.md..05-05-SUMMARY.md` — what Phase 5 actually shipped

**Phase 4 presence + chat (REQUIRED reading for AI-02):**
- `src/host/SessionHost.ts` — chat log + presence state surface
- `src/state/` — branch/sync state readers (exact filenames TBD by researcher)

**MCP spec + SDK docs (REQUIRED reading for AI-01, transport, tools, resources):**
- https://modelcontextprotocol.io/ — protocol spec (latest)
- https://modelcontextprotocol.io/docs/concepts/tools — tools primitive contract
- https://modelcontextprotocol.io/docs/concepts/resources — resources primitive contract
- https://github.com/modelcontextprotocol/typescript-sdk — `@modelcontextprotocol/sdk` (the TS SDK we'll build on)
- VS Code MCP integration docs (1.95+): how `lm.registerMcpServerDefinitionProvider` (or equivalent current API name) works for programmatic registration vs `.vscode/mcp.json`
- Claude Code MCP config docs: `.mcp.json` schema for HTTP/SSE servers
- HTTP/SSE transport spec (2024-11 update to MCP)

**Threat-model carry-overs from Phase 7 (PRESERVED — must not regress):**
- All Phase 7 T-07-XX invariants stay green. Phase 8 does NOT modify `relay/src/` or any `auth/` / `network/` cloud code

</canonical_refs>

<code_context>
## Codebase Snapshot Relevant to Phase 8

**Existing modules Phase 8 will READ from (not modify):**
- `src/state/` — branch state, sync status (Phase 3 + 4 work)
- `src/host/SessionHost.ts` — local view of session, chat, presence
- `src/client/SessionClient.ts` — cloud-mode equivalent
- `src/ast/AstAnalyzer.ts` + `src/ast/joinImpact.ts` — dep graph + conflict heuristic (Phase 5)
- `src/services/` — telemetry / logging utilities (mirror Phase 7 OutputChannel pattern)
- `src/auth/TokenService.ts` — DO NOT import (read-only API must not touch token-issuance code, even by accident — structural Layer-1 gate)

**New module Phase 8 will CREATE:**
- `src/mcp/` — MCP server (entry point, transport, tool/resource registry)
- `src/mcp/readers.ts` — type-only file defining `BranchReader`, `SyncReader`, `ActivityReader`, `ChatReader`, `DependencyReader`. These are the ONLY interfaces the MCP server is allowed to depend on
- `src/mcp/server.ts` — HTTP/SSE listener + JSON-RPC frame handler (wraps `@modelcontextprotocol/sdk`)
- `src/mcp/tools/*.ts` — one file per tool (`getBranchStatus.ts`, `getSyncStatus.ts`, `getRecentActivity.ts`, `getChatLog.ts`, `queryDependencies.ts`, `listDependents.ts`, `adviseSync.ts`)
- `src/mcp/resources/*.ts` — one file per resource (`dependencyGraph.ts`)
- `src/mcp/registry.ts` — `READ_ONLY_TOOLS` allow-list + `registerReadOnlyTool` factory
- `src/mcp/lifecycle.ts` — server start/stop, port allocation, `.vscode/mcp.json` write/cleanup
- `src/mcp/consent.ts` — first-run user prompt
- `src/test/suite/mcp*.test.ts` — extensive test coverage (mirror Phase 7's test discipline — ~100+ new tests expected)

**Package additions:**
- `@modelcontextprotocol/sdk` (TS SDK) as a runtime dep — pinned to a specific minor (verify latest stable during research)
- Dev deps for MCP-client test harness — researcher will identify

**Settings additions to `package.json`:**
- `versioncon.mcp.enabled` (boolean, default true)
- `versioncon.mcp.port` (number, default 0 = auto)
- `versioncon.mcp.consent` (boolean, default false — set by first-run flow)

**No changes to:**
- `relay/` (cloud relay is untouched — Phase 8 is local-only)
- `src/network/` (no new transports)
- `src/auth/` (read-only enforcement structurally forbids importing this)
- `src/ast/`, `src/host/`, `src/client/`, `src/state/` (read-only consumers only)

</code_context>

<deferred>
## Deferred Ideas — Future Phases

- **AI write API** (push, branch-create, sync-trigger, send-chat from agent) — needs its own permission/audit model. Out of v1 strictly per SC-3
- **MCP prompts primitive** — useful for "review-this-push" / "explain-this-conflict" prompt templates; not needed for v1, add when value is clear
- **OAuth / bearer-token auth on the MCP server** — only needed if we ever expose MCP over the relay (remote AI access). Localhost-only suffices for v1 — same defense-in-depth-in-layers logic as Phase 7's L4 deferral
- **Cross-machine MCP federation** — AI agent on machine A reads collab state from machine B's session. Would require an MCP-over-relay bridge + auth. Defer; v1 reads local view only
- **Telemetry on MCP usage** — which tools the AI actually calls, which produce useful results, etc. Useful for tuning tool descriptions but not blocking v1
- **Streaming / long-running tools** — needed if we ever expose cross-repo or heavy analysis. v1 tools all return in <100ms; not needed
- **Dual-config writing to `~/.claude/.mcp.json` and `~/.codex/...`** — `.vscode/mcp.json` covers VS Code Copilot directly and is readable by Claude Code/Cursor/Codex at the workspace root. Per-user config in their home dirs is a docs concern, not extension behavior
- **Auto-discovery of which AI clients are installed and adapting config to each** — let users configure their own; we provide the workspace-root config
- **Sub-symbol-level conflict prediction** — line-level diffs for `predicted_conflicts`. v1 stays at symbol/file granularity
- **Multi-hop transitive impact in `advise_sync`** — "editing X breaks Y which someone else is editing" beyond 1 hop. v1 stops at 1 hop
- **Auto-execution of advisory output** — "auto-pull before commit" etc. That's a write; future phase

</deferred>

<open_questions_for_research>
## Open Questions for the Researcher

Items the `/gsd-plan-phase 8` researcher should resolve before the planner finalizes plans:

1. **MCP TS SDK current API surface** — `@modelcontextprotocol/sdk` has shifted between releases. Researcher should confirm the latest stable version, the current HTTP/SSE transport API (`StreamableHTTPServerTransport` vs `SseServerTransport`), and any breaking changes since Nov 2024
2. **VS Code MCP programmatic registration API** — exact current name of the `lm.registerMcpServerDefinitionProvider` (or whatever it's now called). If available, it's a cleaner alternative to writing `.vscode/mcp.json` for VS Code Copilot users specifically — researcher should evaluate trade-offs
3. **Port collision strategy** — what happens if `.vscode/mcp.json` is checked into git (it shouldn't be, but might be)? Should we use a deterministic-but-checked port or always re-allocate? Probably re-allocate + rewrite, but researcher should evaluate
4. **`.vscode/mcp.json` merge semantics** — if the user already has MCP servers configured in that file (e.g. for Postgres MCP), we need to merge — not overwrite. Researcher confirms the file format and merge rules
5. **Stdio fallback for AI clients that don't support HTTP/SSE** — verify all four target clients (Claude Code, Cursor, Copilot, Codex) support HTTP/SSE in current versions; if any don't, decide whether to add stdio as a fallback or document a limitation
6. **Tool description writing patterns** — research how Postgres MCP, GitHub MCP, Linear MCP write their tool descriptions. The descriptions are the actual prompts to the LLM; quality matters
7. **Resource URI scheme conflicts** — `versioncon://` is already used as the deep-link scheme (Phase 7's UriHandler). Confirm using the same scheme for MCP resources is OK or pick a different scheme (`versioncon-mcp://`?)

</open_questions_for_research>

<gates_and_invariants>
## Source-Grep Gates (Carry to /gsd-plan-phase as N-08-XX invariants)

These are non-negotiable. The planner will turn them into per-task `grep_invariants` blocks.

1. **N-08-01 (Read-only structural):** `grep -rE 'import.*from.*src/auth' src/mcp/ | wc -l` == 0. MCP module never imports the auth/token-issuance layer
2. **N-08-02 (Read-only runtime):** `grep -c 'READ_ONLY_TOOLS\.has' src/mcp/` >= 1. The runtime allow-list gate is wired
3. **N-08-03 (No writers in readers.ts):** `grep -E 'set[A-Z]|push|update|delete|commit' src/mcp/readers.ts | wc -l` == 0 (with documented allowance for false-positive lexemes like `setTimeout`)
4. **N-08-04 (No console.* in src/mcp/):** mirror Phase 7's logger discipline. `grep -rE '^\s*console\.' src/mcp/ | wc -l` == 0
5. **N-08-05 (No new transport in src/network/):** Phase 8 must not touch `src/network/`. `git diff --name-only main..HEAD -- src/network/ | wc -l` == 0 after Phase 8 completes
6. **N-08-06 (No relay/ changes):** Same as Phase 7. `git diff --name-only main..HEAD -- relay/ | wc -l` == 0 after Phase 8 completes
7. **N-08-07 (Test coverage floor):** total extension test count after Phase 8 >= baseline + 80 (rough floor — actual count emerges from plans)
8. **N-08-08 (MCP server binds 127.0.0.1 only):** `grep -c "127\.0\.0\.1\|localhost" src/mcp/server.ts` >= 1 AND `grep -c "0\.0\.0\.0" src/mcp/server.ts` == 0. Server never binds publicly

</gates_and_invariants>

<success_criteria_carry_forward>
## Success Criteria (verbatim from ROADMAP.md)

1. **SC-1** — Claude Code (or any MCP-compatible client) can call a VersionCon tool to read the current branch state, sync status, and recent push activity without any manual setup beyond enabling the extension
2. **SC-2** — An AI agent can read the full dependency graph — which symbols each workspace file uses and who else depends on those symbols — to give conflict-aware advice
3. **SC-3** — AI agents cannot push, create branches, or modify shared state on behalf of users — the API is strictly read-only
4. **SC-4** — An AI agent that has read VersionCon context can correctly identify that a user's local workspace is out of sync and advise them to pull before running

**Verification approach (preview — full plan in /gsd-plan-phase):**
- SC-1: integration test that boots the MCP server, connects an MCP client, calls each of the 3 tools, asserts the schema and non-empty result
- SC-2: integration test that calls `query_dependencies` and `list_dependents` against a fixture codebase with known symbol relationships and asserts the returned graph slice matches
- SC-3: structural source-grep gates (N-08-01..N-08-03) + a "negative" test that asserts no write tool exists in the `tools/list` response + a runtime-allow-list integration test
- SC-4: end-to-end test that synthetically puts the workspace in an out-of-sync state, calls `advise_sync`, asserts the LLM-readable advisory mentions the sync gap and at least one predicted conflict (when applicable)

</success_criteria_carry_forward>
