# Project Research Summary

**Project:** VersionCon — Collaborative VS Code Extension with Dependency-Aware Version Control
**Domain:** Collaborative VS Code Extension — LAN/Cloud Version Control with AST Dependency Analysis
**Researched:** 2026-05-04
**Confidence:** HIGH

## Executive Summary

VersionCon is a VS Code extension that delivers push-based collaborative version control with semantic conflict detection directly inside the editor. Unlike real-time sync tools (Live Share, Code With Me), it adopts an explicit "push when ready" model that mirrors git's mental model while layering on dependency-aware conflict detection using live AST analysis. This positions it in an underserved gap: JetBrains Code With Me is being discontinued in 2026, VS Code Live Share requires Microsoft servers and has no semantic conflict intelligence, and no existing tool provides function-level conflict attribution ("you call this function and Alice just changed it"). The architecture is built around a host-authoritative serialization sync model — no CRDTs, no OT — which is dramatically simpler to implement and more appropriate for team codebases than document-style real-time sync.

The recommended implementation approach is a layered build starting from the transport foundation (WebSocket + mDNS via `ws` and `bonjour-service`) up through the split-pane UI (React + Vite in a webview), the sync engine (explicit push with diff), branch management, and finally the AST dependency analysis layer (web-tree-sitter in a child process). The dependency analysis layer is the product's primary differentiator but is NOT on the critical path for v1 — a file-level conflict notification ships first, then upgrades to function-level once the base system is validated. This sequencing is essential: the networking and UI layers must be proven before adding the complexity of multi-language AST parsing.

The three highest-risk areas are: (1) the webview drag-and-drop interaction, which has a documented bug in VS Code 1.90+ that breaks cross-panel drag without a workaround through the extension host; (2) LAN discovery via mDNS, which silently fails in office/university VLANs and must always have a manual IP fallback as the primary join path; and (3) AST analysis architecture — using native `node-tree-sitter` instead of WASM `web-tree-sitter` is a critical mistake that breaks extension installation and must be decided on day one. These risks have known mitigations documented in research and must be addressed in the early phases, not deferred.

## Key Findings

### Recommended Stack

The stack centers on TypeScript 5.x throughout, with esbuild bundling the extension host (Node.js/CJS target) and Vite bundling the React webview (browser/ESM target). These two build pipelines are separate by design — webviews are sandboxed iframes and cannot share code with the extension host at runtime. See `.planning/research/STACK.md` for full details.

The networking layer uses `ws@^8.18.x` for WebSocket transport (raw, no Socket.IO overhead — VersionCon's push model doesn't need Socket.IO's room abstractions) and `bonjour-service@^1.x` for mDNS LAN discovery (pure JS — `node-mdns` requires native dependencies that cannot be bundled in a `.vsix`). For AST parsing, `web-tree-sitter@^0.25.x` with pre-compiled WASM grammars is the only viable choice — native `tree-sitter` bindings break on every Electron ABI version bump. Message validation across the WebSocket and postMessage boundaries uses `zod@^4.x`, which infers TypeScript types automatically.

**Core technologies:**
- TypeScript 5.7+: Extension host + webview language — VS Code itself is TypeScript; strict mode eliminates message-passing boundary bugs
- `ws@^8.18.x`: WebSocket transport — raw, battle-tested, no Socket.IO overhead; 50k+ connection ceiling
- `bonjour-service@^1.x`: LAN mDNS discovery — pure JS, no native deps, distributable in `.vsix`
- `web-tree-sitter@^0.25.x`: AST parsing — WASM build avoids Electron ABI version conflicts that break native bindings
- React 18 + Vite 6: Webview UI — strongest community patterns for complex VS Code webview UIs; Fast Refresh in dev
- Zod 4: Protocol validation — TypeScript-first, infers types from schemas, critical at WebSocket + postMessage boundaries
- `@sanity/diff-match-patch@^3.2.x`: Diff computation — maintained fork of Google's library; used for push summaries
- esbuild: Extension host bundler — VS Code's official recommendation; 10-20x faster than webpack

**Critical version constraint:** Do NOT upgrade `web-tree-sitter` to 0.26.x — WASM files built with 0.25.x-era grammars are incompatible. Pin at `^0.25.x` until all language grammars have rebuilt WASM files.

### Expected Features

Based on competitor analysis and domain research, VersionCon's feature set divides clearly into table stakes (what every collaboration tool must have), differentiators (VersionCon's unique value), and deliberate anti-features (explicitly excluded). See `.planning/research/FEATURES.md` for full prioritization matrix.

**Must have (table stakes — v1 launch):**
- LAN networking + host/join flow — without this there is no product; join must be instant, no terminal required
- Split-pane UI (workspace left, branch right) — the core visual metaphor that differentiates the interaction model
- Drag-and-drop file management (branch to workspace, workspace to branch) — the direct manipulation model for non-git users
- Explicit push with message + pre-push diff — teams must see what they're pushing before it lands
- Push history + full-push revert — "I can undo this" is a prerequisite for team adoption
- Real-time presence (who's online, what file they're on) — teams feel blind without it; required for any collaborative tool
- In-app text chat with push events auto-logged — co-located context; keeps "one screen" vision
- Branch management with admin/member permissions — required for any team beyond 2 people
- Connection status indicator — always-visible sync state is table stakes
- Setup wizard + zero-terminal join flow — required for the "coding within seconds" UX promise
- Soft conflict notification (file-level at minimum) — even file-level beats silent overwrites

**Should have (differentiators — v1.x):**
- Full dependency-aware conflict detection (AST-based, per-language) — the primary differentiator; upgrades file-level to function-level
- Smart push summary with dependency impact + affected teammates — "blast radius" awareness before pushing
- Inline code review (approve / request changes / comment) — add once push flow is stable
- Cloud mode — same protocol over internet via relay; add after LAN is proven

**Defer (v2+):**
- AI Agent API (expose state to Claude Code, Cursor, Codex) — requires all other features to be stable first
- Additional language AST support beyond Python/JS/TS/Java/C++ — add based on user demand
- Workspace snapshot/export — nice to have, not blocking core flow
- CI/CD hooks — appeals to advanced teams, not core use case

**Hard anti-features (never build):**
- Real-time character-by-character sync (CRDT/OT) — conflicts with the explicit push mental model; massive complexity for wrong UX
- Video/voice chat — separate technical problem; point to Discord/Zoom
- Full GitHub/GitLab integration — creates a two-system consistency problem; VersionCon is a workflow replacement, not a wrapper

### Architecture Approach

The architecture is a layered extension-host-centric design: all mutable state lives in a Redux-like State Manager in the Node.js extension host; webviews are stateless rendering layers that receive state snapshots via typed `postMessage` and send user actions back. The sync model is serialization-based (server-authoritative branch head, explicit push gate) — no CRDTs. The AST analysis engine runs as a dedicated child process (LSP-style IPC) to avoid blocking the extension host event loop. Transport is abstracted behind a `NetworkManager` interface with `LanTransport` and `CloudTransport` implementations, making LAN vs cloud switching invisible to all upstream code. See `.planning/research/ARCHITECTURE.md` for full data flow diagrams and build layer ordering.

**Major components:**
1. State Manager — Redux-like single source of truth for all mutable state; event-emitter pub/sub to all subsystems; webviews are pure view layers driven by state snapshots
2. Network Manager — transport abstraction over `LanTransport` (ws server/client) and `CloudTransport` (relay client); serialization sync model with branch-head validation on push
3. AST Analysis Engine — child process (LSP-style IPC) running `web-tree-sitter` parsers for Python/JS/TS/Java/C++; dependency graph with BFS impact queries; never runs on extension host event loop
4. Split-Pane Webview — React UI for workspace+branch two-pane layout; stateless rendering layer; drag-and-drop routed through extension host to avoid VS Code 1.90+ cross-webview bug
5. Message Bridge — typed discriminated-union `postMessage` protocol between extension host and all webview panels; Zod validation on both sides
6. Cloud Relay Server — standalone Node.js deployment (not inside the extension); routes WebSocket messages between peers; JWT auth; extension only contains the outbound client

**Architectural build order (from ARCHITECTURE.md):**
Layer 0 → Foundation types and wire protocol; Layer 1 → Extension host core + LAN transport; Layer 2 → Full networking (mDNS, cloud transport); Layer 3 → UI shell (split pane); Layer 4 → Sync engine; Layer 5 → AST analysis (parallelizable with Layer 4); Layer 6 → Notifications + chat; Layer 7 → Review system; Layer 8 → MCP/AI integration; Layer 9 → Cloud relay deployment.

### Critical Pitfalls

Research identified 10 critical pitfalls. The top 5 most impactful with their prevention strategies are listed here. See `.planning/research/PITFALLS.md` for the full list with phase mappings.

1. **tree-sitter native module ABI mismatch on install** — Use `web-tree-sitter` (WASM) from day one. Never use `node-tree-sitter`. This must be decided in the extension scaffolding phase — switching later requires rewriting the entire AST layer. Recovery cost: HIGH.

2. **mDNS LAN discovery silently fails in VLANs and corporate/university networks** — Always build the manual IP+port join path BEFORE mDNS discovery. mDNS is a convenience enhancement; manual IP is the required primary path. The join wizard must display the host's IP prominently. Recovery cost: MEDIUM but requires UX redesign.

3. **Webview state loss on VS Code tab switch** — Implement "webview is stateless" architecture from the start: all state lives in extension host; on every webview mount, fire `webview-ready` and host responds with full state snapshot. Never store business data in React state. Setting `retainContextWhenHidden: true` is a last resort (high memory cost). Recovery cost: HIGH — requires full host↔webview protocol rewrite.

4. **Cross-webview drag-and-drop blocked by VS Code 1.90+ security regression (issue #256444)** — Route drag events through the extension host, not directly between webview DOM panels. Implement drag-start in Webview A → extension host → message to Webview B. Provide a right-click context menu as fallback for all drag operations. Test on VS Code 1.90+ on all three OS targets before building dependent features.

5. **Zombie WebSocket connections (sleep/wake/VLAN change leaves connections appearing alive)** — Implement application-level heartbeat: ping every 15 seconds, pong timeout 5 seconds, trigger reconnect on failure. Connection status indicator must reflect heartbeat state, not WebSocket `readyState`. Never infer connection health from the absence of errors.

**Additional high-impact pitfalls to be aware of:**
- AST false positives from dynamic language features (Python duck typing, JS dynamic imports) erode user trust — scope conflict detection at module-import level first, add confidence ratings
- AST parsing performance degrades on generated files (minified JS, node_modules) — implement 500KB file size guard and always respect `.gitignore`/`node_modules` exclusion
- Permission system complexity creep derails MVP — ship exactly two roles (admin, member) in v1; no fine-grained RBAC until user demand is validated

## Implications for Roadmap

Based on the feature dependency graph from FEATURES.md and the architectural build order from ARCHITECTURE.md, research suggests the following phase structure. The LAN networking layer is the critical blocker — no other feature works without it. The split-pane UI can be scaffolded with stub data in parallel. AST analysis is explicitly a later phase since all table-stakes features work without it.

### Phase 1: Extension Foundation + LAN Networking

**Rationale:** The networking layer is the single critical dependency for the entire product. Nothing — not presence, not push, not chat — works without it. This phase also establishes the architectural decisions that cannot be changed later: WASM tree-sitter (not native), stateless webviews, transport abstraction. Getting these wrong is HIGH recovery cost; getting them right is cheap.

**Delivers:** Working host/join flow over LAN; connection status indicator; manual IP join (before mDNS); WebSocket heartbeat and reconnection; extension scaffolding with correct architecture (State Manager, Message Bridge, transport abstraction); `web-tree-sitter` WASM setup verified

**Addresses from FEATURES.md:** LAN networking layer, connection status indicator, setup wizard/join flow (partial)

**Avoids from PITFALLS.md:** tree-sitter native module mismatch (day-one decision), mDNS-only discovery failure (manual IP first), zombie WebSocket connections (heartbeat built-in)

**Research flag:** Standard patterns for VS Code extension scaffolding. LAN WebSocket server is well-documented. mDNS setup with `bonjour-service` needs validation against real network environments.

### Phase 2: Split-Pane UI + File System Layer

**Rationale:** The split-pane UI is the product's visual identity and must be built and tested early — the cross-webview drag-and-drop bug (VS Code 1.90+) needs resolution time, and the "filesystem is truth" invariant must be established before any sync features are built on top. These two concerns are tightly coupled: the UI shows files from the filesystem, and any divergence between them creates data integrity bugs.

**Delivers:** Two-pane webview layout (workspace left, branch right); drag-and-drop between panes (routed via extension host, with right-click context menu fallback); stateless webview state protocol (webview-ready → full state snapshot); file system watcher with `awaitWriteFinish` (handles Vim/Emacs rename saves); filesystem-as-truth invariant with consistency tests; onboarding wizard UI

**Addresses from FEATURES.md:** Split-pane UI, drag-and-drop file management, setup wizard (UI completion), branch visibility

**Avoids from PITFALLS.md:** Cross-webview drag-and-drop VS Code 1.90+ bug (route through extension host), webview state loss on tab switch (stateless webview protocol), filesystem-UI divergence (filesystem-first architecture), file watcher OS differences (chokidar + `awaitWriteFinish` + three-OS testing)

**Research flag:** Drag-and-drop between webviews is a known bug requiring a non-obvious workaround — this phase needs careful prototyping and testing across VS Code minor versions and all three OS targets before declaring done. Do not assume it works until tested on VS Code 1.90+ on Windows.

### Phase 3: Push, Sync + Branch Management

**Rationale:** With networking and UI established, the core push flow is the first user-visible collaborative feature. Push history and revert are required for user trust ("I can undo this"). Branch management with exactly two roles (admin and member) enables multi-person sessions. This phase delivers the minimum viable product that validates the "explicit push" mental model.

**Delivers:** Explicit push with message + pre-push diff (line-level, before AST); push history / activity log; full-push and file-level revert; branch creation and switching; admin/member permission model (exactly two roles, no fine-grained RBAC); sync-before-run warning (not hard block); activity log auto-posted to chat

**Addresses from FEATURES.md:** Explicit push + message + diff, push history + revert, branch management + admin permissions, sync-before-run enforcement

**Avoids from PITFALLS.md:** Permission system complexity creep (two roles only, documented decision; no fine-grained RBAC UI), conflict notification fatigue (soft warnings, not modals)

**Stack elements used:** `@sanity/diff-match-patch` for diff computation; Zod schemas for push message validation; State Manager push/revert actions; `uuid` for push IDs

**Research flag:** Standard patterns. Push/revert logic is well-understood. Permission system boundary (admin/member) is explicitly constrained by research — enforce this during planning.

### Phase 4: Presence + Chat + Notifications

**Rationale:** Presence and chat depend on the networking layer (Phase 1) and push system (Phase 3). They are table-stakes features that teams expect but don't block the core push workflow. Grouping them together makes sense because the chat system and activity log are tightly coupled — push events auto-log to chat — and the notification system is part of the same concern.

**Delivers:** Real-time presence indicators (who's online, what file they're on); in-app text chat with code snippet support; push/revert/branch events auto-logged in chat thread; soft non-blocking conflict notifications (file-level, shown at save/push trigger, not mid-typing); notification router that filters by relevance (only notify members whose workspace has affected files)

**Addresses from FEATURES.md:** Real-time presence, in-app text chat, code snippet support in chat, soft non-blocking conflict notifications, activity log auto-posted in chat, branch visibility

**Avoids from PITFALLS.md:** Conflict notification fatigue (buffer notifications; show at natural break points, not mid-typing; targeted routing), "fishbowl effect" (presence shows file, not content)

**Research flag:** Standard patterns for presence and chat. Notification routing logic (filter by dependency impact) is straightforward at file-level; it becomes more complex when upgraded to AST-level in Phase 5.

### Phase 5: Dependency-Aware Conflict Detection (AST)

**Rationale:** This is the product's primary differentiator but is architecturally isolated from all preceding phases. File-level conflict notification ships in Phase 4; this phase upgrades it to function-level semantic detection. It is explicitly a separate phase because AST parsing has distinct technical risks (false positive rate, performance on large files, WASM version pinning) that require focused validation. Do not integrate into the push flow until precision is validated on real-world codebases.

**Delivers:** LSP-style child process for AST analysis (decoupled from extension host event loop); `web-tree-sitter` parsers for Python, JavaScript/TypeScript, Java, C++; dependency graph with BFS impact queries; upgrade of conflict notification from file-level to function-level ("Alice changed `calculate_total` — you call this in line 34"); smart push summary upgrade from "files changed" to "dependency impact + affected teammates"; 500KB file size guard + `node_modules`/`dist` exclusion; confidence ratings on conflict notifications (high confidence: direct import found; possible: same function name in project)

**Addresses from FEATURES.md:** Dependency-aware conflict detection, "you call this function" conflict attribution, smart push summary (full impact analysis), AI Agent API prerequisites (dependency graph built here)

**Avoids from PITFALLS.md:** AST false positives from dynamic languages (module-import scoping, confidence ratings), AST performance on large files (file size guard, incremental parsing, content-hash cache), single-threaded AST parsing on extension host (child process from day one)

**Research flag:** This phase needs deep research and careful validation. AST false positive rate on dynamic languages (Python duck typing, JS dynamic imports, circular deps) must be measured on real-world codebases before integrating with the push flow. Validate precision on 3+ real codebases and document false positive rate before declaring this phase done. Tree-sitter version pinning (0.25.x) must be enforced — verify Java and C++ grammar WASM compatibility explicitly.

### Phase 6: Inline Code Review

**Rationale:** Inline code review (approve / request changes / comment) is a natural extension of the push flow once the diff and dependency analysis layers are stable. It adds team governance without requiring a separate GitHub PR workflow. It depends on Phase 3 (push system) and benefits from Phase 5 (AST-enriched diff context). It is a v1.x feature — add after the core push workflow is validated in real use.

**Delivers:** Review panel with inline diff view; approve / request changes / comment flow; threaded comments on specific lines; review status integrated with push summary; review comments auto-logged in chat

**Addresses from FEATURES.md:** Inline code review, review comments in chat

**Research flag:** Standard patterns for code review UI. The diff display component is already built in Phase 3; this phase adds the approval workflow layer on top. No unusual technical risk.

### Phase 7: Cloud Mode + Relay Server

**Rationale:** Cloud mode uses the same WebSocket protocol as LAN mode but connects through a hosted relay server instead of direct LAN WebSocket. The transport abstraction built in Phase 1 (`CloudTransport` implementing the same `Transport` interface as `LanTransport`) means this phase is primarily infrastructure: deploying and authenticating the relay server, not protocol changes. Add after LAN protocol is proven to avoid debugging two transport layers simultaneously.

**Delivers:** Cloud relay server deployment (standalone Node.js, not inside extension); JWT authentication on relay connection handshake; `CloudTransport` connecting to relay over WSS; same wire protocol as LAN mode; no inbound port required on any client (all outbound connections to relay)

**Addresses from FEATURES.md:** Cloud mode

**Avoids from PITFALLS.md:** Anti-pattern of embedding relay in extension (firewalls block inbound ports; relay must be a separate deployed service)

**Research flag:** Relay server deployment and JWT auth are well-documented patterns. The main unknown is operational: hosting, scaling, and cost of the relay service. This phase will benefit from research during planning on relay hosting options and JWT library choices.

### Phase 8: AI Agent API (MCP Integration)

**Rationale:** The AI Agent API is explicitly the last phase — it is a read-only surface layer over functionality that must all be working first: dependency graph (Phase 5), push history (Phase 3), presence (Phase 4), branch management (Phase 3). VS Code's `vscode.lm.registerMcpServerDefinitionProvider` API makes this a well-defined integration point. It is a v2+ feature with high future value but no blocking user demand on day one.

**Delivers:** Embedded MCP server in extension exposing read-only tools: `get_branch_state`, `get_dependency_graph`, `get_recent_activity`, `get_sync_status`, `get_chat_log`; AI agents (Claude Code, Cursor, Codex) can query collaboration context; read-only — AI agents cannot push on behalf of users

**Addresses from FEATURES.md:** AI Agent API / protocol

**Research flag:** VS Code MCP API is new (2025) and the documentation is official but the ecosystem is still maturing. This phase should be researched during planning — specifically the `McpStdioServerDefinition` vs `McpHttpServerDefinition` choice and current MCP client support in Claude Code and Cursor.

### Phase Ordering Rationale

- **Networking before UI:** The transport layer is the critical foundation; nothing works without it and architectural decisions (transport abstraction, WASM vs native tree-sitter, stateless webviews) made here are expensive to change later.
- **UI before push:** The split-pane UI's drag-and-drop bug (VS Code 1.90+) needs resolution time; it is a known risk that should be prototyped early, not discovered late when push depends on it.
- **Push before presence/chat:** The explicit push model is the product's core interaction; validating it works before adding surrounding features reduces scope during the riskiest phase.
- **File-level conflicts before AST conflicts:** AST analysis is the differentiator but is NOT on the critical path for v1. Shipping file-level detection first validates the conflict notification UX before adding AST complexity.
- **LAN before cloud:** Same protocol, different transport. Debug one transport at a time. Cloud relay adds operational complexity that should not be in scope while the core protocol is being proven.
- **AI API last:** It is a read layer over a fully functional system. Building it first would mean building it against stubs.

### Research Flags

**Phases needing deeper research during planning:**
- **Phase 2 (Split-Pane UI):** The cross-webview drag-and-drop regression (VS Code 1.90+, issue #256444) needs a prototype proof-of-concept before committing to implementation approach. The extension-host routing workaround is documented but untested in this specific context.
- **Phase 5 (AST Analysis):** False positive rate on dynamic languages (Python, JavaScript) needs validation on real-world codebases. Grammar WASM version compatibility for Java (`tree-sitter-java@^0.23.5`) and C++ (`tree-sitter-cpp@^0.23.4`) against `web-tree-sitter@^0.25.x` must be verified explicitly — these grammar packages lag behind the parser version.
- **Phase 7 (Cloud Mode):** Relay server hosting, JWT library selection, and relay scaling approach need research during planning. Operational costs of "always-on" relay service for a VS Code extension are unclear.
- **Phase 8 (AI Agent API):** VS Code MCP API is new; `McpStdioServerDefinition` vs `McpHttpServerDefinition` tradeoffs and current AI client support should be researched during planning.

**Phases with standard well-documented patterns (research-phase can be skipped):**
- **Phase 1 (Foundation + LAN Networking):** VS Code extension scaffolding, `ws` WebSocket server, and `bonjour-service` mDNS are all well-documented with high-confidence sources.
- **Phase 3 (Push + Branch Management):** Diff computation, push history, and revert are well-understood patterns. Two-role permission model is explicitly constrained by research — no design decisions needed.
- **Phase 4 (Presence + Chat):** WebSocket presence broadcast and chat are standard patterns. The notification routing logic is straightforward at file-level.
- **Phase 6 (Inline Code Review):** Standard PR-style review UI patterns; diff display is already built in Phase 3.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Core technologies (VS Code APIs, `ws`, `web-tree-sitter`, React, Zod) verified against official docs and Context7. Critical version constraints documented (web-tree-sitter 0.25.x pin, @types/vscode 1.109.0). One LOW-confidence item: C++ tree-sitter WASM compatibility with the pinned web-tree-sitter version — requires explicit test. |
| Features | HIGH | Table stakes verified against competitor feature analysis (Live Share, GitLens, Codespaces). Differentiators verified against academic literature (DeltaImpactFinder, SAM). Anti-features are well-reasoned. JetBrains Code With Me discontinuation confirmed as market signal. |
| Architecture | HIGH | Extension host patterns (state manager, message bridge, child process for CPU work) verified via VS Code official docs and Augment Code rebuild case study. Serialization sync model verified as correct via Matthew Weidner's authoritative server architecture analysis. MEDIUM confidence on relay server patterns and MCP integration (newer APIs). |
| Pitfalls | HIGH | Critical pitfalls (tree-sitter ABI, mDNS VLAN failure, webview state loss, drag-and-drop VS Code 1.90+ bug) all verified with direct GitHub issue citations and official documentation. AST false positive research supported by academic literature. |

**Overall confidence: HIGH**

### Gaps to Address

- **tree-sitter-java and tree-sitter-cpp WASM compatibility:** Both grammar packages are on `^0.23.x` but `web-tree-sitter` is pinned at `^0.25.x`. Research notes this as a compatibility risk. Before Phase 5, verify WASM build compatibility by running both grammars against `web-tree-sitter@0.25.x` in a test harness. If incompatible, Java and C++ support may need to be deferred or require building custom WASM files.

- **Cross-webview drag-and-drop workaround validation:** VS Code issue #256444 is documented as unfixed in 1.90+. The extension-host routing workaround (drag events in Webview A → extension host → message to Webview B) is the recommended approach but has not been prototyped for this specific layout. This should be a throwaway spike in Phase 2 before full UI implementation.

- **mDNS reliability on target deployment environments:** Research identifies VLAN and corporate network failures as certain — manual IP join is the required fallback. However, the specific environments VersionCon targets (classrooms, hackathon venues, corporate LANs) vary widely. The setup wizard should test connectivity immediately after join and surface clear errors rather than silently spinning.

- **Cloud relay operational model:** Phase 7 requires a hosted relay server. The architecture is clear (standalone Node.js `ws` server, outbound connections from all clients including host). What is not researched: hosting platform choice, cost model (per-session vs always-on), and whether VersionCon needs to operate the relay or can allow users to self-host. This needs a decision before Phase 7 planning.

- **AST false positive rate baseline:** Research flags this as a risk but cannot quantify it without testing against real codebases. The recommended mitigation (module-import scoping + confidence ratings) is sound, but actual false positive rates in Python and JavaScript codebases need to be measured before the AST conflict detection is integrated into the push flow. Target: <10% false positive rate on a sample of 3 real-world projects.

## Sources

### Primary (HIGH confidence)
- VS Code Extension API — Webview Guide: https://code.visualstudio.com/api/extension-guides/webview
- VS Code MCP Developer Guide: https://code.visualstudio.com/api/extension-guides/ai/mcp
- VS Code Bundling Extensions (esbuild): https://code.visualstudio.com/api/working-with-extensions/bundling-extension
- VS Code UX Guidelines + Walkthroughs API: https://code.visualstudio.com/api/ux-guidelines/overview
- VS Code Live Share Connectivity Model: https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/connectivity
- Context7 `/websockets/ws` — WebSocket server/client patterns
- Context7 `/tree-sitter/tree-sitter` — incremental parsing, web-tree-sitter initialization
- Context7 `/colinhacks/zod` — schema validation API
- Context7 `vscode-languageserver-node` — LSP child process pattern
- tree-sitter WASM ABI incompatibility (issue #5171): https://github.com/tree-sitter/tree-sitter/issues/5171
- VS Code Webview UI Toolkit deprecation: https://github.com/microsoft/vscode-webview-ui-toolkit
- VS Code cross-webview drag-drop regression (issue #256444): https://github.com/microsoft/vscode/issues/256444
- node-tree-sitter VS Code incompatibility (issues #169, #188, #189): https://github.com/tree-sitter/node-tree-sitter/issues/169
- Matthew Weidner — Server Architectures for Collaborative Apps: https://mattweidner.com/2024/06/04/server-architectures.html

### Secondary (MEDIUM confidence)
- Augment Code — Rebuilding State Management (Redux in VS Code extension): https://www.augmentcode.com/blog/rebuilding-state-management
- npm `bonjour-service` TypeScript rewrite: https://www.npmjs.com/package/bonjour-service
- @vscode/tree-sitter-wasm package: https://www.npmjs.com/package/@vscode/tree-sitter-wasm
- `@sanity/diff-match-patch` maintained fork: https://www.npmjs.com/package/@sanity/diff-match-patch
- TypeFox VS Code Messenger (extension-webview patterns): https://www.typefox.io/blog/vs-code-messenger/
- CodePrism graph-based code analysis engine: https://rustic-ai.github.io/codeprism/blog/graph-based-code-analysis-engine/
- mDNS in the Enterprise (Microsoft): https://techcommunity.microsoft.com/blog/networkingblog/mdns-in-the-enterprise/3275777
- WebSocket heartbeat guide: https://oneuptime.com/blog/post/2026-01-27-websocket-heartbeat/view
- RBAC complexity creep in SaaS: https://www.ratomir.com/blog/why-most-saas-products-struggle-with-permission-management

### Tertiary (LOW confidence / needs validation)
- VS Code 2026 Extension Guide (third-party): https://abdulkadersafi.com/blog/building-vs-code-extensions-in-2026-the-complete-modern-guide — general patterns aligned with official docs but not official source
- DeltaImpactFinder — semantic conflict detection via dependency analysis: https://arxiv.org/abs/1509.04207 — academic research from 2015; confirms problem space but implementation differs from VersionCon's approach
- YASA multi-language AST taint analysis pitfalls: https://arxiv.org/pdf/2601.17390 — relevant to false positive risk but different domain (security analysis vs collaboration)
- JetBrains Code With Me discontinuation — verified in search results citing JetBrains blog; cited as market signal

---
*Research completed: 2026-05-04*
*Ready for roadmap: yes*
