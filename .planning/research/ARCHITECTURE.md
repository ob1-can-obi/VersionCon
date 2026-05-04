# Architecture Research

**Domain:** Collaborative VS Code Extension — LAN/Cloud Version Control with AST Dependency Analysis
**Researched:** 2026-05-04
**Confidence:** HIGH (VS Code APIs, LSP patterns, tree-sitter); MEDIUM (relay server patterns, MCP integration)

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         VS Code Extension Host (Node.js)                    │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  Extension   │  │   State      │  │  Network     │  │  AST Analysis  │  │
│  │  Controller  │  │  Manager     │  │  Manager     │  │  Engine (LSP)  │  │
│  │  (activate)  │  │  (Redux-like)│  │  (ws + mDNS) │  │  (worker proc) │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                 │                 │                   │           │
│         └─────────────────┴────────┬────────┴───────────────────┘           │
│                                    │                                         │
│                            Internal Event Bus                                │
│                         (vscode.EventEmitter)                               │
│                                    │                                         │
│  ┌─────────────────────────────────┴───────────────────────────────────┐    │
│  │                         VS Code API Surface                         │    │
│  │   FileSystemWatcher │ workspace.fs │ commands │ window │ context    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
│  ┌─────────────────────────────────┴───────────────────────────────────┐    │
│  │                       Webview Layer (React)                         │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌───────────────────┐   │    │
│  │  │  Split Pane UI  │  │   Chat Panel    │  │  Review Panel     │   │    │
│  │  │ (Branch + Work) │  │   (Activity)    │  │  (Diff + Approve) │   │    │
│  │  └─────────────────┘  └─────────────────┘  └───────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
         │                          │
         ▼ LAN (WebSocket direct)   ▼ Cloud (WebSocket via relay)
┌─────────────────┐        ┌─────────────────────────────────────────────┐
│   Peer Nodes    │        │          Cloud Relay Server                 │
│  (other devs    │        │  ┌────────────┐  ┌───────────┐              │
│   on LAN)       │        │  │  Session   │  │   Auth    │              │
│                 │        │  │  Router    │  │  (JWT)    │              │
└─────────────────┘        │  └────────────┘  └───────────┘              │
                           │  ┌────────────────────────────┐             │
                           │  │   Branch State Store       │             │
                           │  │   (push history, members)  │             │
                           │  └────────────────────────────┘             │
                           └─────────────────────────────────────────────┘
         │
         ▼ (optional AI integration)
┌─────────────────────────────────────────┐
│  MCP Server (embedded in extension)     │
│  Exposes: branch state, dep graph,      │
│  sync status, chat log, presence        │
│  ← readable by Claude Code, Cursor,     │
│    Copilot, Codex, etc.                 │
└─────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| Extension Controller | Activation entry point; wires all components together; registers commands | `extension.ts` activate/deactivate lifecycle |
| State Manager | Single source of truth for all mutable state (branches, presence, push history, permissions) | Redux-style store with named actions and event emitter notifications |
| Network Manager | Abstracts LAN vs cloud transport; handles peer discovery, WebSocket lifecycle, reconnection | `ws` library for WebSocket; `bonjour` for mDNS LAN discovery |
| AST Analysis Engine | Parses source files for all supported languages; builds and updates dependency graph; answers impact queries on push | Runs as separate Node.js child process (LSP pattern) using `tree-sitter` |
| File System Watcher | Monitors workspace files for changes; triggers diff computation; enforces sync gate before run | `vscode.workspace.createFileSystemWatcher` |
| Diff Engine | Computes line-level and semantic diff between workspace and branch state | `diff` npm package or custom Myers diff; feeds AST engine |
| Split Pane UI (Webview) | Renders the two-pane layout (branch view right, workspace view left); handles drag-and-drop between panes | WebviewPanel with React; HTML5 drag-and-drop within webview DOM |
| Chat Panel (Webview) | In-extension chat with code snippet support; automatic activity log | WebviewPanel or WebviewViewProvider (sidebar) with React |
| Review Panel (Webview) | Inline diff + approve/reject/comment flow | WebviewPanel with React; reads diff data from State Manager |
| MCP Server | Exposes read-only extension state to AI agents via MCP protocol | `McpStdioServerDefinition` or `McpHttpServerDefinition` registered via `vscode.lm.registerMcpServerDefinitionProvider` |
| Cloud Relay Server | Routes WebSocket messages between peers when direct LAN connection is unavailable | Separate Node.js server (not in extension); deployed to cloud |
| Notification System | Routes push events, conflict alerts, and presence changes to relevant users | Event-driven; extension-side filters by dependency graph before surfacing to user |

## Recommended Project Structure

```
src/
├── extension.ts                # VS Code activate/deactivate; wire-up only
├── controller/
│   └── ExtensionController.ts  # Orchestrates all subsystems
├── state/
│   ├── store.ts                # Central state store (Redux-like)
│   ├── actions.ts              # All named state mutation actions
│   ├── selectors.ts            # Derived state queries
│   └── types.ts                # TypeScript types for all state shapes
├── network/
│   ├── NetworkManager.ts       # Abstracts LAN vs cloud; single entry point
│   ├── LanTransport.ts         # WebSocket server/client for LAN mode
│   ├── CloudTransport.ts       # WebSocket client to relay server
│   ├── PeerDiscovery.ts        # mDNS/bonjour LAN host advertisement + join
│   └── protocol.ts             # Message type definitions (typed wire protocol)
├── analysis/
│   ├── AnalysisWorker.ts       # Child process entry point (spawned by LSP pattern)
│   ├── DependencyGraph.ts      # Graph store: nodes (functions/imports), edges (calls/refs)
│   ├── parsers/
│   │   ├── PythonParser.ts     # tree-sitter-python wrapper
│   │   ├── TypeScriptParser.ts # tree-sitter-typescript wrapper
│   │   ├── JavaParser.ts       # tree-sitter-java wrapper
│   │   └── CppParser.ts        # tree-sitter-cpp wrapper
│   └── ImpactAnalyzer.ts       # Given a diff, returns which workspace symbols are affected
├── sync/
│   ├── FileSystemWatcher.ts    # Wraps vscode.FileSystemWatcher; debounced events
│   ├── DiffEngine.ts           # Line-level diff between workspace and branch snapshot
│   ├── BranchManager.ts        # Branch CRUD; push/revert operations
│   └── SyncGate.ts             # Enforces "must be in sync before run/test"
├── webview/
│   ├── WebviewManager.ts       # Creates/manages all WebviewPanel instances
│   ├── panels/
│   │   ├── SplitPanePanel.ts   # Left (workspace) + right (branch) pane controller
│   │   ├── ChatPanel.ts        # Chat + activity log panel
│   │   └── ReviewPanel.ts      # Diff review + approve panel
│   └── bridge/
│       └── MessageBridge.ts    # Type-safe postMessage wrapper (extension ↔ webviews)
├── ai/
│   └── McpServer.ts            # MCP server exposing read-only extension state to AI agents
├── notifications/
│   └── NotificationRouter.ts   # Filters push events through dep graph; surfaces to UI
└── cloud/
    └── server/                 # Separate deployable (not loaded by extension at runtime)
        ├── RelayServer.ts      # WebSocket session router
        ├── AuthService.ts      # JWT issue + verify
        └── BranchStore.ts      # Persistent branch state (push history, members)

webview-ui/                     # Separate build target (React app bundled into extension)
├── src/
│   ├── SplitPane/
│   ├── Chat/
│   └── Review/
└── package.json
```

### Structure Rationale

- **`analysis/` as child process:** AST parsing is CPU-heavy. Running it in a child process (LSP pattern) keeps the extension host event loop unblocked. The LSP `vscode-languageserver-node` IPC transport is used for structured communication. HIGH confidence pattern — VS Code's own language servers all follow this.
- **`network/` with transport abstraction:** `NetworkManager` exposes a single `send(message)` / `onMessage` interface. `LanTransport` and `CloudTransport` implement it. Switching between modes requires no changes upstream. MEDIUM confidence — pragmatic design; Live Share uses a similar auto/direct/relay pattern.
- **`state/` as Redux-like store:** Augment Code rebuilt their extension with Redux + Redux-Saga and reported 2x performance gains and dramatically faster debugging. Named actions = full audit log of state mutations. HIGH confidence recommendation.
- **`webview-ui/` as separate build:** Webviews are isolated sandboxes. They cannot import extension code directly. A separate React build (bundled by Vite or webpack) is deployed into the extension as static assets. Message bridge handles all communication.
- **`cloud/server/` separate from extension:** The relay server is a standalone Node.js process deployed independently. The extension only contains the WebSocket client. This keeps the extension's install size small and lets the relay server scale independently.

## Architectural Patterns

### Pattern 1: Extension ↔ Webview Message Bridge (typed postMessage)

**What:** All communication between the extension host and webview panels passes through a single typed message bridge. Messages are discriminated unions — each has a `type` field plus typed payload.

**When to use:** Always — webviews are sandboxed iframes, direct function calls are impossible.

**Trade-offs:** Async by nature; debugging requires logging both sides. However, this boundary enforces clean separation and prevents webview crashes from taking down the extension.

**Example:**
```typescript
// protocol.ts (shared types)
export type ExtensionToWebview =
  | { type: 'BRANCH_STATE_UPDATE'; branches: Branch[] }
  | { type: 'PUSH_COMPLETE'; pushId: string; affectedUsers: string[] }
  | { type: 'PRESENCE_UPDATE'; users: PresenceEntry[] };

export type WebviewToExtension =
  | { type: 'DRAG_FILE_TO_WORKSPACE'; filePath: string; branchId: string }
  | { type: 'INITIATE_PUSH'; message: string; stagedFiles: string[] }
  | { type: 'REQUEST_REVIEW'; targetBranch: string };

// In extension: MessageBridge.ts
panel.webview.postMessage({ type: 'BRANCH_STATE_UPDATE', branches });
panel.webview.onDidReceiveMessage((msg: WebviewToExtension) => { ... });

// In webview React app
const vscode = acquireVsCodeApi();
vscode.postMessage({ type: 'INITIATE_PUSH', message, stagedFiles });
window.addEventListener('message', (event) => {
  const msg: ExtensionToWebview = event.data;
  // dispatch to React state
});
```

### Pattern 2: LSP-Style Child Process for AST Analysis

**What:** AST analysis (tree-sitter parsing, dependency graph construction, impact queries) runs in a dedicated child process. Extension communicates with it via JSON-RPC over IPC, exactly as the VS Code Language Server Protocol works.

**When to use:** Any CPU-bound operation that could block the extension event loop. AST parsing of large files (>100KB) or many files on push events qualifies.

**Trade-offs:** Adds process startup latency (~50-200ms on first use). Eliminates UI freezes. Process can be killed and restarted cleanly on crash. Isolation means AST engine bugs cannot corrupt extension state.

**Example:**
```typescript
// AnalysisWorker.ts (child process entry)
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
const connection = createConnection(ProposedFeatures.all);

connection.onRequest('analyzeImpact', async ({ changedFiles, workspaceFiles }) => {
  const graph = await buildDependencyGraph(workspaceFiles);
  return computeImpact(changedFiles, graph);
});
connection.listen();

// In extension: ImpactAnalyzer.ts
const client = new LanguageClient('versioncon-analysis', serverOptions, clientOptions);
const impact = await client.sendRequest('analyzeImpact', { changedFiles, workspaceFiles });
```

### Pattern 3: Serialization-Based Sync (not CRDT/OT)

**What:** Branch state is a server-authoritative log of pushes. When a user wants to push, the server checks if the client has the latest branch head. If not, the client must pull first (serialization model). There is no real-time character sync — pushes are explicit atomic operations.

**When to use:** VersionCon's "manual push" model. This is the right choice for this product: no CRDT complexity, clear conflict surface, predictable UX. Matches git's conceptual model while adding dependency-aware conflict detection.

**Trade-offs:** Users occasionally blocked to pull before pushing. Simpler to implement and debug than CRDT/OT. Appropriate for teams (not high-frequency concurrent typing scenarios). Branch is always consistent — no conflict merging of partially-applied states.

**Example:**
```
Client A wants to push:
  1. Client sends: { type: 'PUSH_REQUEST', branchHeadSeen: 'abc123', diff: [...] }
  2. Server checks: is 'abc123' still the branch head?
     YES → apply push, broadcast PUSH_COMPLETE to all peers
     NO  → reject with { type: 'PUSH_REJECTED_STALE', currentHead: 'def456' }
  3. Client on rejection: pull latest, re-run impact analysis, re-attempt
```

### Pattern 4: Transport Abstraction for LAN/Cloud Duality

**What:** `NetworkManager` defines a single interface regardless of transport. `LanTransport` acts as a WebSocket server (host) or client (joiner) on the local network. `CloudTransport` connects to the relay server. The connection mode is determined once at session join and is invisible to all upstream code.

**When to use:** From day one — VersionCon must support both LAN and cloud. Building the abstraction first avoids a painful refactor later.

**Trade-offs:** Slight indirection. Upside: LAN and cloud session handling is isolated; relay server can be upgraded without touching extension code.

**Example:**
```typescript
interface Transport {
  send(message: WireMessage): void;
  onMessage(handler: (msg: WireMessage) => void): void;
  connect(config: ConnectionConfig): Promise<void>;
  disconnect(): void;
}
class LanTransport implements Transport { /* ws server or client */ }
class CloudTransport implements Transport { /* ws client to relay */ }

class NetworkManager {
  private transport: Transport;
  async initialize(mode: 'lan' | 'cloud', config: ConnectionConfig) {
    this.transport = mode === 'lan' ? new LanTransport() : new CloudTransport();
    await this.transport.connect(config);
  }
}
```

## Data Flow

### Push Flow (Core Operation)

```
User drags file to branch view + clicks "Push"
    │
    ▼
SplitPanePanel (Webview) → postMessage({ type: 'INITIATE_PUSH', message, files })
    │
    ▼
MessageBridge → BranchManager.stagePush(files, message)
    │
    ▼
DiffEngine.computeDiff(workspaceFiles, branchSnapshot)
    │                                     │
    ▼                                     ▼
ImpactAnalyzer.query(diff)          Format for smart push summary UI
    │
    ▼
[ImpactResult: who is affected, what symbols changed]
    │
    ▼
Show smart push summary in SplitPanePanel
    │
    ▼ (user confirms)
NetworkManager.send({ type: 'PUSH_REQUEST', branchHeadSeen, diff, message })
    │
    ▼
Server validates HEAD → applies push → broadcasts PUSH_COMPLETE
    │
    ▼
All peers receive PUSH_COMPLETE
    │
    ├─► StateManager.applyRemotePush(push)  [update branch snapshot]
    │
    ├─► ImpactAnalyzer.query(push.diff, peer.workspaceFiles)
    │       │
    │       └─► if affected → NotificationRouter.notify(user, impact details)
    │
    └─► ChatPanel.logPushActivity(push)
```

### Presence Flow

```
User opens file in VS Code editor
    │
    ▼
vscode.window.onDidChangeActiveTextEditor
    │
    ▼
StateManager.updatePresence(userId, { file, branch })
    │
    ▼
NetworkManager.send({ type: 'PRESENCE_UPDATE', userId, file, branch })
    │
    ▼ (broadcast to all peers)
All peers: StateManager.applyPresenceUpdate(entry)
    │
    ▼
SplitPanePanel refreshed with current presence data
```

### AST Analysis Flow (on push received)

```
Incoming push diff arrives via NetworkManager
    │
    ▼
DiffEngine parses changed symbols (functions added/removed/modified)
    │
    ▼
ImpactAnalyzer.sendRequest('analyzeImpact', { changedSymbols, myWorkspaceFiles })
    │         [IPC to child process]
    ▼
AnalysisWorker:
  1. Load current dependency graph (or rebuild incrementally via tree-sitter)
  2. BFS from changed symbols → find all callers/importers in workspace
  3. Return: { affected: [{ file, line, symbol, reason }] }
    │
    ▼ (back in extension host)
NotificationRouter.filter(impactResult, userPreferences)
    │
    ├─► GREEN: no impact → status bar "In sync, no conflicts"
    └─► AMBER: affected → inline notification with details
```

### State Management Flow

```
[State Store]  (single source of truth)
    │
    ├── branches: Branch[]
    ├── pushHistory: Push[]
    ├── presence: Map<userId, PresenceEntry>
    ├── permissions: Map<userId, Permission>
    ├── syncStatus: 'in-sync' | 'stale' | 'pushing'
    └── chat: Message[]

Actions (named, logged):
  PUSH_RECEIVED | PUSH_SENT | PEER_JOINED | PEER_LEFT
  PRESENCE_UPDATED | BRANCH_CREATED | PERMISSIONS_CHANGED
  FILE_DRAGGED_TO_WORKSPACE | REVIEW_SUBMITTED

StateManager dispatches action → mutates state → fires vscode.EventEmitter
    │
    ├─► Webviews: receive postMessage with new state slice
    ├─► NotificationRouter: evaluates if notification needed
    └─► NetworkManager: some state changes trigger outgoing messages
```

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 2-10 users (hackathon/small team) | Single relay server instance, in-memory branch state, no persistence required. LAN mode avoids relay entirely for low latency. |
| 10-50 users (dev team) | Relay server needs persistent branch store (SQLite or PostgreSQL). Add reconnection logic and offline queue for messages sent while disconnected. |
| 50-200 users (organization) | Relay server horizontally scaled behind a load balancer (sticky sessions via Redis pub/sub for message routing). AST analysis worker pool. |
| 200+ users | Per-team relay servers, CDN-edge presence updates, consider CRDT for presence-only data (branch state stays serialization model). |

### Scaling Priorities

1. **First bottleneck:** Relay server broadcast fan-out on large pushes. Each PUSH_COMPLETE is broadcast to all connected peers. At 50+ users, this becomes O(n) work per push on the server. Fix: partition sessions by repo/branch rather than global broadcast.
2. **Second bottleneck:** AST analysis worker CPU time on large repos. At 10k+ files, the dependency graph rebuild on each push gets expensive. Fix: incremental graph updates (tree-sitter supports incremental parsing; process only changed files, update edges atomically).

## Anti-Patterns

### Anti-Pattern 1: Shared State in Webview

**What people do:** Store branch state, push history, or presence data inside the React component state of the webview. Pass it back to the extension only when needed.

**Why it's wrong:** Webviews can be hidden, disposed, or crash. If the webview is the source of truth for state, that state can be lost. The extension host is long-lived; the webview is ephemeral. VS Code warns explicitly: webview content is destroyed when hidden unless `retainContextWhenHidden` is set (which has high memory cost).

**Do this instead:** All state lives in the extension host State Manager. Webviews are pure view layers — they receive state snapshots via `postMessage` and send user actions back. They hold no persistent state.

### Anti-Pattern 2: Direct AST Parsing in Extension Host Event Loop

**What people do:** Call tree-sitter synchronously inside `onDidChangeTextDocument` or `onDidReceiveMessage` handlers to do dependency analysis.

**Why it's wrong:** Tree-sitter parsing large files (>100KB) or running BFS on a large dependency graph can take 10-500ms. Running this on the Node.js event loop blocks every VS Code UI interaction — keystrokes lag, commands stall, the editor feels frozen.

**Do this instead:** Spawn a child process (LSP-style worker). Send parse/analyze requests over IPC. Extension host stays responsive; analysis results arrive asynchronously.

### Anti-Pattern 3: Single WebSocket Server in Extension for Cloud

**What people do:** Embed a WebSocket server directly in the extension to serve as the "cloud relay" — opening a port and expecting remote users to connect to it.

**Why it's wrong:** Firewalls, NAT, and corporate networks block inbound connections on arbitrary ports. Works on LAN, breaks on cloud. This is exactly why Live Share introduced a relay service — direct P2P often fails across the internet.

**Do this instead:** For LAN mode, the host can run an embedded WebSocket server (ports are open on local networks). For cloud mode, all clients (including the host) connect outbound to a relay server. The relay routes messages. No inbound ports required on any client.

### Anti-Pattern 4: Character-Level Real-Time Sync (CRDT)

**What people do:** Attempt to build Google Docs-style character-by-character sync using CRDTs to avoid merge conflicts entirely.

**Why it's wrong:** VersionCon's core value is the "manual push" model — teams push when they're ready, not on every keystroke. CRDT implementation is substantial complexity (Yjs, Automerge require significant integration work). The "smart push" model intentionally gives teams control and predictability. Real-time character sync also conflicts with the "workspace is your scratch pad" mental model.

**Do this instead:** Keep the serialization model — explicit pushes, server-authoritative branch head, dependency-aware conflict notification. The complexity savings are significant and the UX matches user expectations (hackathon/dev teams, not document editors).

### Anti-Pattern 5: One Giant Webview Panel

**What people do:** Put the split pane, chat, and review UI all inside a single webview to simplify architecture.

**Why it's wrong:** A single panel is forced into a fixed position. VS Code's layout system allows users to drag panels, pop them into separate windows, or use them from the sidebar. With one monolithic panel, users cannot rearrange. Each feature (split pane, chat, review) has a distinct surface in VS Code's UX: split pane belongs in the editor group, chat/activity in the sidebar, review in an editor tab.

**Do this instead:** Three separate WebviewPanel / WebviewViewProvider instances. They all share the same State Manager and MessageBridge. State stays consistent across all views.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Cloud Relay Server | WebSocket client from extension (`CloudTransport`); all traffic encrypted; JWT auth on connect handshake | Relay does not persist code content — only routes messages and stores branch metadata. Deploy separately from extension. |
| mDNS/Bonjour (LAN discovery) | `bonjour` npm package (pure JS, no native deps) in extension host to advertise and discover hosts on local subnet | `bonjour` preferred over `node-mdns` because no native module compilation required — simplifies extension distribution. |
| tree-sitter language grammars | `tree-sitter`, `tree-sitter-python`, `tree-sitter-typescript`, `tree-sitter-java`, `tree-sitter-cpp` npm packages; run in worker process | Grammars are pre-compiled WASM or native bindings. Use WASM variant for portability in extension packaging. |
| MCP AI integration | `vscode.lm.registerMcpServerDefinitionProvider` API; extension hosts local MCP stdio server exposing read-only tools | Tools exposed: `get_branch_state`, `get_dependency_graph`, `get_recent_activity`, `get_sync_status`, `get_chat_log`. Read-only — AI agents cannot push on behalf of users. |
| VS Code FileSystemWatcher | `vscode.workspace.createFileSystemWatcher('**/*')` for workspace change detection | Use debounce (300-500ms) to avoid triggering on every keystroke. Watcher is disposed when session ends. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Extension Host ↔ Webview Panels | Typed `postMessage` / `onDidReceiveMessage` (async, JSON-serializable only) | All messages flow through `MessageBridge.ts`. No direct function calls possible. Define discriminated union types for both directions. |
| Extension Host ↔ Analysis Worker | JSON-RPC over IPC (LSP client/server pattern using `vscode-languageserver-node`) | Worker is spawned on first analysis request; kept alive for session. Restart on crash via error handler. |
| Extension Host ↔ Network Layer | Direct function call (both in same Node.js process) | `NetworkManager` is a singleton instantiated by `ExtensionController`. State Manager subscribes to network events via callback registration. |
| Extension Host ↔ Cloud Relay | WebSocket (outbound only from extension side) | Wire protocol is JSON messages with typed `type` field. Authentication via JWT on handshake. |
| Extension Host ↔ LAN Peers | WebSocket (direct TCP on local network) | Host runs `ws.Server` on port 3737 (configurable). Joiners connect as WebSocket clients. Same wire protocol as cloud. |
| State Manager ↔ All Subsystems | `vscode.EventEmitter` (pub/sub within extension host) | Subsystems subscribe to relevant state change events. Decoupled — no direct references between subsystems. |

## Suggested Build Order

The architecture has clear dependency layers. Build them in this order to avoid blocked work:

```
Layer 0: Foundation (no dependencies)
  ├── state/types.ts             — TypeScript types for all domain objects
  ├── state/store.ts             — State store skeleton (empty actions OK)
  └── network/protocol.ts        — Wire message type definitions

Layer 1: Extension Host Core
  ├── extension.ts               — Activate with stub wiring
  ├── network/NetworkManager.ts  — Transport abstraction + LAN WebSocket
  └── sync/BranchManager.ts      — Branch state CRUD

Layer 2: Networking
  ├── network/LanTransport.ts    — WebSocket server (host) + client (joiner)
  ├── network/PeerDiscovery.ts   — mDNS advertisement + browse
  └── network/CloudTransport.ts  — Relay server client (requires relay deployed)

Layer 3: UI Shell
  ├── webview/MessageBridge.ts   — Type-safe message passing
  ├── webview/panels/SplitPanePanel.ts — Two-pane layout (stub data first)
  └── webview-ui/SplitPane/      — React UI for split pane

Layer 4: Sync Engine
  ├── sync/FileSystemWatcher.ts  — File change detection
  ├── sync/DiffEngine.ts         — Line-level diff
  └── sync/SyncGate.ts           — Pre-run sync enforcement

Layer 5: AST Analysis (can start parallel to Layer 4)
  ├── analysis/AnalysisWorker.ts — Child process setup
  ├── analysis/parsers/           — tree-sitter language wrappers
  ├── analysis/DependencyGraph.ts — Graph store
  └── analysis/ImpactAnalyzer.ts  — Push impact queries

Layer 6: Notifications + Chat
  ├── notifications/NotificationRouter.ts
  └── webview/panels/ChatPanel.ts

Layer 7: Review System
  └── webview/panels/ReviewPanel.ts

Layer 8: AI Integration
  └── ai/McpServer.ts             — MCP server (read-only state exposure)

Layer 9: Cloud Relay (deployed separately)
  └── cloud/server/               — Relay server, auth, persistent branch store
```

**Key dependency constraints:**
- State Manager must exist before any other component (all subsystems read/write it)
- Network layer can be built without AST engine — early testing with file-level conflict detection only
- Webview UI can be developed against stub `postMessage` data before the backend is fully built
- Cloud relay and LAN transport share the same wire protocol — implement protocol types first, both transports second
- MCP server is last — it is a read surface over already-built functionality

## Sources

- [VS Code Webview API — official docs](https://code.visualstudio.com/api/extension-guides/webview) — HIGH confidence
- [VS Code Tree View API — official docs](https://code.visualstudio.com/api/extension-guides/tree-view) — HIGH confidence
- [VS Code MCP Developer Guide — official docs](https://code.visualstudio.com/api/extension-guides/ai/mcp) — HIGH confidence
- [vscode-languageserver-node — Context7](https://context7.com/microsoft/vscode-languageserver-node/llms.txt) — HIGH confidence
- [Augment Code — Rebuilding State Management (Redux in VS Code extension)](https://www.augmentcode.com/blog/rebuilding-state-management) — MEDIUM confidence (verified pattern, single source)
- [Live Share Connectivity Model — Microsoft Learn](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/connectivity) — HIGH confidence (official)
- [CodePrism — Graph-Based Code Analysis Engine Architecture](https://rustic-ai.github.io/codeprism/blog/graph-based-code-analysis-engine/) — MEDIUM confidence (implementation reference, not official spec)
- [Matthew Weidner — Server Architectures for Collaborative Apps](https://mattweidner.com/2024/06/04/server-architectures.html) — HIGH confidence (authoritative analysis of sync models)
- [tree-sitter — GitHub](https://github.com/tree-sitter/tree-sitter) — HIGH confidence
- [node-tree-sitter — npm/GitHub](https://github.com/tree-sitter/node-tree-sitter) — HIGH confidence
- [bonjour — npm](https://www.npmjs.com/package/bonjour) — MEDIUM confidence (pure JS mDNS, widely used)
- [ws WebSocket library — GitHub](https://github.com/websockets/ws) — HIGH confidence
- [TypeFox VS Code Messenger (extension ↔ webview patterns)](https://www.typefox.io/blog/vs-code-messenger/) — MEDIUM confidence

---
*Architecture research for: VersionCon — Collaborative VS Code Extension*
*Researched: 2026-05-04*
