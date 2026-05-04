# Phase 1: Extension Foundation + LAN Networking - Research

**Researched:** 2026-05-04
**Domain:** VS Code Extension Development, WebSocket Networking, mDNS Service Discovery
**Confidence:** HIGH

## Summary

Phase 1 is a greenfield VS Code extension scaffold with WebSocket-based LAN networking. The core challenge is building a polished host/join flow with custom webviews that follows the locked stateless webview architecture, establishing reliable WebSocket transport with heartbeat-driven reconnect, and implementing mDNS discovery as a secondary path behind the mandatory manual IP join.

The technology stack is well-established: `ws` (the de facto Node.js WebSocket library), `bonjour-service` (TypeScript mDNS implementation), and VS Code's native Extension API for webview panels, sidebar views, and status bar items. The deprecated `@vscode/webview-ui-toolkit` is replaced by `@vscode-elements/elements` (Lit-based web components matching VS Code's design language). The extension uses esbuild for bundling and TypeScript throughout.

**Primary recommendation:** Structure the extension as a clear host/client split with a shared message protocol layer. Build the manual IP join flow first (per locked decision), implement heartbeat/reconnect as a transport-level concern invisible to the UI layer, and use VS Code's `globalState` for session history persistence with `SecretStorage` for invite codes.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** 3-step wizard -- Step 1: Session name, Step 2: Network config (port, bandwidth limits), Step 3: Credential setup (invite code generation)
- **D-02:** Auto-detect a free port and primary network interface with manual override option for both
- **D-03:** Dedicated "share with your team" screen at wizard end showing host IP/port prominently with copy-to-clipboard button
- **D-04:** Custom webview UI for the entire wizard (not VS Code native quick-picks/input boxes) -- sets the visual identity for the whole extension
- **D-05:** Invite code + username model -- host generates a reusable invite code, joiner enters code + picks a display name to identify themselves
- **D-06:** Invite codes are reusable for the lifetime of a session; host can regenerate the code if compromised
- **D-07:** Two join entry points -- sidebar "Join Session" button AND command palette command, both lead to the same webview join form
- **D-08:** Extension remembers last 3-5 sessions (IP, session name, display name) for one-click reconnect -- key to achieving NET-04 (coding within seconds)
- **D-09:** Status indicator lives in two places -- VS Code status bar (at-a-glance icon + text) and VersionCon sidebar header (detailed view)
- **D-10:** 3 connection states -- Connected (green), Reconnecting (yellow/spinning), Disconnected (red)
- **D-11:** Silent auto-reconnect on connection drop -- status bar turns yellow, no toast notification unless reconnect fails after ~30 seconds of retries
- **D-12:** Workspace stays fully editable during disconnect -- user keeps coding locally, aligns with scratch pad safety model (SAFE-02). No read-only lockout.
- **D-13:** Moderate admin surface in phase 1 -- member list (display names + online status), kick/disconnect individual members, bandwidth monitor
- **D-14:** Session management controls live in the VersionCon sidebar panel (not a separate webview tab) -- always one click away
- **D-15:** When host closes VS Code while hosting, show confirmation prompt: "You're hosting a session with N members. End session?" -- prevents accidental shutdown
- **D-16:** Basic member list visible to ALL members (not just host) -- shows who's connected with display name + online status. Full presence (file being edited, branch) comes in Phase 4.

### Claude's Discretion
- WebSocket library choice and configuration
- Extension scaffold structure (folder layout, activation events)
- mDNS/Bonjour implementation details and timing
- Heartbeat interval and reconnect backoff strategy
- Bandwidth monitoring approach and display format
- Webview-to-extension host message protocol design
- Session state persistence format

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| NET-01 | Host can create a LAN session with full control (port, bandwidth limits, credentials per user) | WebSocket server setup with `ws`, port auto-detection via `net.createServer`, bandwidth via `maxPayload` + rate limiting |
| NET-02 | Host setup uses a step-by-step wizard (sliding window style) with only essential fields | Custom webview panel with multi-step form, stateless architecture with extension host state management |
| NET-03 | New members can join by entering host address + credentials -- no terminal commands | WebSocket client connect + invite code auth handshake, webview join form |
| NET-04 | One-click join experience -- member is coding within seconds of connecting | Session history in `globalState` (last 3-5 sessions), one-click reconnect entries |
| NET-05 | Connection status indicator always visible | VS Code `StatusBarItem` API + sidebar WebviewViewProvider header |
| NET-07 | LAN discovery via mDNS/Bonjour with manual IP entry as primary fallback | `bonjour-service` for mDNS publish/browse, manual IP form built first per locked decision |
| NET-08 | Host can configure bandwidth limits for the session | `maxPayload` on ws server + application-level rate limiting with configurable thresholds |
| SAFE-01 | Branch is always the source of truth -- read-only from workspace until explicit push | Session model enforces read-only semantics on shared state; foundation established here |
| SAFE-02 | Local workspace is a scratch pad -- break things freely, re-pull from branch to recover | D-12: workspace stays fully editable during disconnect; no lockout behavior |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| WebSocket Server (host) | Extension Host (Node.js) | -- | VS Code extension host runs in Node.js; networking must live here |
| WebSocket Client (joiner) | Extension Host (Node.js) | -- | Client connections managed by extension host, not webview |
| Setup Wizard UI | Webview Panel | -- | Custom UI per D-04; rendered as webview panel in editor area |
| Sidebar Session Management | WebviewViewProvider | -- | D-14: sidebar panel for member list + session controls |
| Status Bar Indicator | Extension Host (VS Code API) | -- | `StatusBarItem` is a native VS Code API, no webview needed |
| mDNS Discovery | Extension Host (Node.js) | -- | Multicast DNS requires raw UDP socket access, only available in Node |
| Session History Persistence | Extension Host (globalState) | -- | VS Code `ExtensionContext.globalState` for cross-session persistence |
| Credential Storage | Extension Host (SecretStorage) | -- | Invite codes stored securely via VS Code SecretStorage API |
| Message Protocol | Shared (Extension Host) | -- | Protocol definitions shared between host/client code |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| ws | 8.20.0 | WebSocket server + client | De facto Node.js WebSocket library; 138 code snippets in Context7, simple API, built-in ping/pong, `maxPayload` for bandwidth control [VERIFIED: npm registry] |
| bonjour-service | 1.3.0 | mDNS/Bonjour service publish + discovery | TypeScript rewrite of original bonjour; pure JS implementation (no native deps), publish/find API [VERIFIED: npm registry + Context7] |
| @vscode-elements/elements | 2.5.1 | Webview UI components (Lit-based) | Replaces deprecated @vscode/webview-ui-toolkit; matches VS Code design language, Lit web components [VERIFIED: npm registry] |
| web-tree-sitter | 0.26.8 | WASM-based AST parsing (day-one inclusion per locked decision) | Locked pre-phase decision: use web-tree-sitter from day one, never node-tree-sitter [VERIFIED: npm registry] |
| typescript | 6.0.3 | Type-safe development | VS Code extension standard; strict mode required [VERIFIED: npm registry] |
| esbuild | 0.28.0 | Extension bundling | Official VS Code recommendation for extension bundling; fast, simple config [VERIFIED: npm registry] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @types/vscode | 1.118.0 | VS Code API type definitions | Always -- provides IntelliSense and compile-time safety for Extension API [VERIFIED: npm registry] |
| @types/ws | 8.18.1 | ws library type definitions | Always -- TypeScript definitions for ws [VERIFIED: npm registry] |
| nanoid | 5.1.11 | Invite code generation | Generate short, URL-safe, cryptographically secure IDs for invite codes [VERIFIED: npm registry] |
| @vscode/test-cli | 0.0.12 | VS Code extension test runner | Running integration tests inside Extension Development Host [VERIFIED: npm registry] |
| @vscode/test-electron | 2.5.2 | Test environment launcher | Launches VS Code instance for integration testing [VERIFIED: npm registry] |
| mocha | 11.7.5 | Test framework | Official VS Code test CLI uses Mocha under the hood [VERIFIED: npm registry] |
| @types/mocha | 10.0.10 | Mocha type definitions | TypeScript support for test files [VERIFIED: npm registry] |
| @vscode/vsce | 3.9.1 | Extension packaging and publishing | Build .vsix for distribution [VERIFIED: npm registry] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| ws | socket.io | socket.io adds room/namespace abstraction but is heavier; ws is lower-level but gives full control needed for custom protocol |
| bonjour-service | @homebridge/ciao | ciao is Apple-focused, bonjour-service is more general and TypeScript-native |
| @vscode-elements/elements | Raw HTML + CSS variables | Elements provides consistent VS Code look without custom CSS work; raw HTML gives more control but more effort |
| nanoid | uuid | nanoid generates shorter IDs (21 chars vs 36); better for invite codes users type manually |
| esbuild | webpack | esbuild is 10-100x faster; webpack has more plugins but unnecessary complexity for extensions |

**Installation:**
```bash
npm install ws bonjour-service @vscode-elements/elements web-tree-sitter nanoid
npm install -D typescript esbuild @types/vscode @types/ws @types/mocha mocha @vscode/test-cli @vscode/test-electron @vscode/vsce
```

## Architecture Patterns

### System Architecture Diagram

```
                    HOST MACHINE                                    JOINER MACHINE
 +------------------------------------------+        +------------------------------------------+
 |  VS Code Extension Host (Node.js)        |        |  VS Code Extension Host (Node.js)        |
 |                                           |        |                                           |
 |  +----------------+   +---------------+  |        |  +----------------+   +---------------+  |
 |  | SessionManager |-->| WebSocket     |<-|--WS----|->| WebSocket     |<--| SessionClient |  |
 |  | (host state)   |   | Server (ws)   |  |  conn  |  | Client (ws)   |   | (join state)  |  |
 |  +--------+-------+   +-------+-------+  |        |  +-------+-------+   +-------+-------+  |
 |           |                    |          |        |          |                    |          |
 |  +--------v-------+   +-------v-------+  |        |  +-------v--------+  +-------v-------+  |
 |  | mDNS Publisher |   | Auth Handler  |  |        |  | mDNS Browser   |  | Auth Handler  |  |
 |  | (bonjour-svc)  |   | (invite code) |  |        |  | (bonjour-svc)  |  | (invite code) |  |
 |  +----------------+   +---------------+  |        |  +----------------+  +---------------+  |
 |           |                    |          |        |          |                    |          |
 |  +--------v--------------------v-------+  |        |  +-------v--------------------v------+  |
 |  |       Message Protocol Layer        |  |        |  |       Message Protocol Layer      |  |
 |  | (typed JSON messages, heartbeat)    |  |        |  | (typed JSON messages, heartbeat)  |  |
 |  +------------------+------------------+  |        |  +-----------------+-----------------+  |
 |                     |                     |        |                    |                    |
 +---------------------|---------------------+        +--------------------|--------------------+
                       |                                                   |
            +----------v-----------+                            +----------v-----------+
            |   VS Code UI Layer   |                            |   VS Code UI Layer   |
            |                      |                            |                      |
            | - Webview Panel      |                            | - Webview Panel      |
            |   (setup wizard)     |                            |   (join form)        |
            | - Sidebar View       |                            | - Sidebar View       |
            |   (session mgmt)     |                            |   (member list)      |
            | - Status Bar Item    |                            | - Status Bar Item    |
            |   (connection state) |                            |   (connection state) |
            +----------------------+                            +----------------------+

    Message Flow:
    1. Webview fires "webview-ready" on mount --> Extension sends full state snapshot
    2. User action in webview --> postMessage to extension host
    3. Extension host processes --> updates state --> pushes new state to webview
    4. Network events (join/leave/heartbeat) --> extension host --> state update --> webview
```

### Recommended Project Structure

```
src/
├── extension.ts              # Activation, command registration, provider setup
├── host/
│   ├── SessionHost.ts        # WebSocket server lifecycle, member tracking
│   ├── AuthHandler.ts        # Invite code validation, member authentication
│   └── BandwidthMonitor.ts   # Per-connection rate tracking
├── client/
│   ├── SessionClient.ts      # WebSocket client, reconnect logic
│   └── ConnectionState.ts    # State machine (Connected/Reconnecting/Disconnected)
├── network/
│   ├── protocol.ts           # Message type definitions (shared host+client)
│   ├── heartbeat.ts          # Ping/pong + reconnect backoff logic
│   └── discovery.ts          # mDNS publish + browse via bonjour-service
├── ui/
│   ├── WizardPanel.ts        # Webview panel for setup wizard
│   ├── JoinPanel.ts          # Webview panel for join form
│   ├── SidebarProvider.ts    # WebviewViewProvider for sidebar
│   ├── StatusBarManager.ts   # Status bar item management
│   └── webview/              # HTML/CSS/JS assets for webviews
│       ├── wizard/
│       ├── join/
│       └── sidebar/
├── storage/
│   ├── SessionHistory.ts     # globalState persistence (last 3-5 sessions)
│   └── SecretStore.ts        # SecretStorage wrapper for invite codes
├── utils/
│   ├── network.ts            # IP detection, port finding
│   └── id.ts                 # nanoid-based invite code generation
└── test/
    ├── suite/
    │   ├── host.test.ts
    │   ├── client.test.ts
    │   ├── protocol.test.ts
    │   └── discovery.test.ts
    └── runTest.ts
```

### Pattern 1: Stateless Webview with Extension Host State (LOCKED)

**What:** All state lives in the extension host. Webviews are pure renderers that fire `webview-ready` on mount and receive a full state snapshot. User actions send messages to extension host which updates state and pushes new snapshot.

**When to use:** Always -- this is a locked architectural decision.

**Example:**
```typescript
// Source: VS Code official webview API docs + CONTEXT.md locked decision
// Extension Host side
class WizardPanel {
  private state: WizardState = { step: 1, sessionName: '', port: 0, inviteCode: '' };

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case 'webview-ready':
          // Send full state snapshot on mount
          webviewView.webview.postMessage({ type: 'state-update', payload: this.state });
          break;
        case 'wizard-next':
          this.state = { ...this.state, ...msg.payload };
          webviewView.webview.postMessage({ type: 'state-update', payload: this.state });
          break;
      }
    });
  }
}

// Webview side (in HTML script)
const vscode = acquireVsCodeApi();

// Fire webview-ready immediately on mount
vscode.postMessage({ type: 'webview-ready' });

// Listen for state updates
window.addEventListener('message', (event) => {
  const { type, payload } = event.data;
  if (type === 'state-update') {
    renderUI(payload); // Pure render from state
  }
});
```

### Pattern 2: Typed Message Protocol

**What:** All WebSocket communication uses a typed, discriminated-union message format. Every message has a `type` field used for routing.

**When to use:** All network communication between host and client.

**Example:**
```typescript
// Source: Standard discriminated union pattern for type-safe messaging
// src/network/protocol.ts

// Shared message types
type MessageType =
  | 'auth-request'      // Client -> Host: invite code + display name
  | 'auth-response'     // Host -> Client: accepted/rejected + session info
  | 'member-joined'     // Host -> All: new member notification
  | 'member-left'       // Host -> All: member disconnected
  | 'member-kicked'     // Host -> Target: you were kicked
  | 'state-sync'        // Host -> Client: full session state
  | 'heartbeat-ping'    // Bidirectional: keepalive
  | 'heartbeat-pong';   // Bidirectional: keepalive response

interface BaseMessage {
  type: MessageType;
  timestamp: number;
}

interface AuthRequest extends BaseMessage {
  type: 'auth-request';
  inviteCode: string;
  displayName: string;
}

interface AuthResponse extends BaseMessage {
  type: 'auth-response';
  accepted: boolean;
  reason?: string;
  sessionInfo?: { name: string; memberCount: number; hostDisplayName: string };
}

// Discriminated union
type ProtocolMessage = AuthRequest | AuthResponse | MemberJoined | MemberLeft | /* ... */;

// Type-safe send
function sendMessage(ws: WebSocket, msg: ProtocolMessage): void {
  ws.send(JSON.stringify(msg));
}

// Type-safe receive
function parseMessage(data: string): ProtocolMessage | null {
  try {
    const msg = JSON.parse(data);
    if (!msg.type) return null;
    return msg as ProtocolMessage;
  } catch {
    return null;
  }
}
```

### Pattern 3: Connection State Machine

**What:** Connection status modeled as a finite state machine with deterministic transitions.

**When to use:** Tracking connection lifecycle for both UI indicators and reconnect logic.

**Example:**
```typescript
// Source: Standard state machine pattern for connection management
type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

interface ConnectionState {
  status: ConnectionStatus;
  lastConnected: number | null;
  reconnectAttempts: number;
  error: string | null;
}

// Transitions
const transitions: Record<ConnectionStatus, ConnectionStatus[]> = {
  disconnected: ['connecting'],
  connecting: ['connected', 'disconnected'],
  connected: ['reconnecting', 'disconnected'],
  reconnecting: ['connected', 'disconnected'],
};

function transition(current: ConnectionStatus, next: ConnectionStatus): boolean {
  return transitions[current].includes(next);
}
```

### Pattern 4: Exponential Backoff with Jitter for Reconnect

**What:** Reconnect attempts use exponential backoff with random jitter to avoid thundering herd.

**When to use:** D-11 silent auto-reconnect on connection drop.

**Example:**
```typescript
// Source: Standard reconnect pattern verified via WebSocket best practices research
function getReconnectDelay(attempt: number): number {
  const baseDelay = 1000;  // 1 second
  const maxDelay = 30000;  // 30 second cap
  const exponential = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 1000; // 0-1s jitter
  return Math.min(exponential + jitter, maxDelay);
}

// Usage in reconnect loop
class ReconnectManager {
  private attempts = 0;
  private maxAttempts = 10; // ~30s of retries per D-11
  private timer: NodeJS.Timeout | null = null;

  scheduleReconnect(connect: () => Promise<boolean>): void {
    if (this.attempts >= this.maxAttempts) {
      this.onReconnectFailed(); // Show toast notification per D-11
      return;
    }

    const delay = getReconnectDelay(this.attempts);
    this.timer = setTimeout(async () => {
      const success = await connect();
      if (success) {
        this.attempts = 0; // Reset on success
      } else {
        this.attempts++;
        this.scheduleReconnect(connect);
      }
    }, delay);
  }

  reset(): void {
    this.attempts = 0;
    if (this.timer) clearTimeout(this.timer);
  }
}
```

### Anti-Patterns to Avoid

- **State in webview:** Never store application state in the webview JavaScript. The webview can be destroyed/recreated at any time. All state lives in extension host.
- **retainContextWhenHidden:** Do NOT use this. It keeps webview in memory consuming resources. Instead, use the stateless pattern: send full state on `webview-ready`.
- **Synchronous network operations:** Never block the extension host with synchronous I/O. All network ops must be async.
- **Global mutable singletons:** Use dependency injection or a central state manager passed to components, not module-level mutable globals.
- **Untyped messages:** Never use raw strings or untyped objects for WebSocket or webview messages. Always use discriminated unions.
- **node-tree-sitter:** LOCKED DECISION -- never use `node-tree-sitter`. Only `web-tree-sitter` (WASM). Switching later would require rewriting the entire AST layer.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| WebSocket server/client | Custom TCP socket handling | `ws` library | Handles framing, masking, close codes, per-message deflate, ping/pong correctly |
| mDNS service discovery | Manual UDP multicast | `bonjour-service` | mDNS protocol is complex (probing, conflict resolution, record types); library handles edge cases |
| UI components | Custom HTML elements from scratch | `@vscode-elements/elements` | Pre-built components match VS Code theme automatically via CSS variables |
| Invite code generation | Math.random-based IDs | `nanoid` | Cryptographically secure, URL-safe, configurable length, no collisions at scale |
| Port availability check | Manual socket binding attempts | `net.createServer().listen(0)` | Node.js built-in; `listen(0)` picks a free port automatically |
| Secure credential storage | File-based storage / plaintext | VS Code `SecretStorage` API | Platform-native encryption (Keychain/Credential Manager/Keyring) |
| Extension bundling | Custom build scripts | `esbuild` | Official VS Code recommendation; handles tree-shaking, minification, externals |

**Key insight:** VS Code extension development has well-established patterns. The extension API provides storage, secrets, UI primitives, and lifecycle management. Fighting these patterns (e.g., building custom state persistence) creates maintenance burden and breaks expected VS Code behavior.

## Common Pitfalls

### Pitfall 1: Webview State Loss on Tab Switch
**What goes wrong:** User fills out wizard step 2, switches to another tab, comes back -- wizard resets to step 1.
**Why it happens:** VS Code destroys webview DOM when the panel is hidden (unless `retainContextWhenHidden` is set, which has high memory cost).
**How to avoid:** Stateless webview pattern (locked decision). Extension host holds all wizard state. On `webview-ready`, send full state snapshot. Webview re-renders from snapshot.
**Warning signs:** State disappears when switching tabs; `retainContextWhenHidden: true` in options.

### Pitfall 2: mDNS Fails Silently in Corporate/University Networks
**What goes wrong:** mDNS discovery works in dev/home network but completely fails in production environments (corporate VLANs, university networks).
**Why it happens:** mDNS uses multicast UDP 5353 to 224.0.0.251 which is link-local and never routed between VLANs. Corporate firewalls block multicast traffic.
**How to avoid:** Build manual IP join path FIRST (locked decision). mDNS is a convenience layer on top, never the only path. UI must always show manual IP entry prominently.
**Warning signs:** Testing only on home network; mDNS as the primary join flow.

### Pitfall 3: WebSocket Connection Appears Alive But Is Dead
**What goes wrong:** Network cable unplugged or laptop sleeps -- TCP connection stays "open" for minutes (TCP keepalive default is 2 hours on most OS).
**Why it happens:** TCP doesn't detect dead connections without application-level keepalive. The OS-level TCP keepalive timer is too slow for real-time UX.
**How to avoid:** Implement WebSocket ping/pong heartbeat at 15-30 second intervals. If no pong received within interval + latency allowance, terminate and trigger reconnect.
**Warning signs:** Status shows "Connected" when network is actually down; members appear online when they've left.

### Pitfall 4: Bundling `vscode` Module
**What goes wrong:** esbuild tries to bundle the `vscode` module, build fails or produces broken extension.
**Why it happens:** `vscode` module doesn't exist on disk -- VS Code provides it at runtime via a shim. Bundlers can't resolve it.
**How to avoid:** Mark `vscode` as external in esbuild config: `external: ['vscode']`.
**Warning signs:** Build errors about missing `vscode` module; runtime errors about `require('vscode')`.

### Pitfall 5: CSP Blocks Webview Scripts
**What goes wrong:** Webview loads but scripts don't execute, no error visible to user.
**Why it happens:** Content Security Policy blocks inline scripts and scripts from unexpected sources.
**How to avoid:** Use nonce-based CSP. Generate a cryptographic nonce per render, include it in CSP header and on script tags. Never use inline event handlers.
**Warning signs:** Webview HTML renders but is non-interactive; console shows CSP violations (only visible in Developer Tools).

### Pitfall 6: Extension Activation Too Early or Too Late
**What goes wrong:** Extension activates on every VS Code startup (slowing boot) or doesn't activate when user clicks sidebar icon.
**Why it happens:** Wrong activation events in `package.json`. Using `*` activates on every startup. Missing view activation event means sidebar click doesn't activate.
**How to avoid:** Use `onView:versioncon.sidebar` for sidebar activation, `onCommand:versioncon.*` for commands. Avoid `*` activation. Use `onStartupFinished` only if absolutely needed.
**Warning signs:** Extension takes > 100ms to activate; or user clicks sidebar and nothing happens.

### Pitfall 7: Invite Code Timing Attack
**What goes wrong:** Attacker can brute-force invite codes by measuring response time differences between valid and invalid codes.
**Why it happens:** String comparison short-circuits on first mismatch, making invalid codes respond faster than partially-valid ones.
**How to avoid:** Use constant-time comparison for invite code validation (`crypto.timingSafeEqual`). Rate-limit auth attempts (max 5 per IP per minute).
**Warning signs:** Using `===` for invite code comparison; no rate limiting on auth endpoint.

## Code Examples

### VS Code Extension Activation and Registration

```typescript
// Source: VS Code Extension API official docs (code.visualstudio.com/api)
// src/extension.ts

import * as vscode from 'vscode';
import { SidebarProvider } from './ui/SidebarProvider';
import { WizardPanel } from './ui/WizardPanel';
import { JoinPanel } from './ui/JoinPanel';
import { StatusBarManager } from './ui/StatusBarManager';

export function activate(context: vscode.ExtensionContext) {
  // Sidebar WebviewViewProvider
  const sidebarProvider = new SidebarProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('versioncon.sidebar', sidebarProvider)
  );

  // Status bar
  const statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('versioncon.hostSession', () => {
      WizardPanel.createOrShow(context);
    }),
    vscode.commands.registerCommand('versioncon.joinSession', () => {
      JoinPanel.createOrShow(context);
    })
  );

  // Deactivation cleanup handled by dispose pattern
}

export function deactivate() {
  // Cleanup handled by disposables registered in context.subscriptions
}
```

### package.json Configuration

```json
// Source: VS Code Extension API docs (activation events, contributes)
{
  "name": "versioncon",
  "displayName": "VersionCon",
  "description": "Collaborative version control with dependency-aware conflict detection",
  "version": "0.1.0",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "activationEvents": [],
  "main": "./dist/extension.js",
  "contributes": {
    "viewsContainers": {
      "activitybar": [{
        "id": "versioncon",
        "title": "VersionCon",
        "icon": "resources/icon.svg"
      }]
    },
    "views": {
      "versioncon": [{
        "type": "webview",
        "id": "versioncon.sidebar",
        "name": "Session"
      }]
    },
    "commands": [
      { "command": "versioncon.hostSession", "title": "VersionCon: Host Session" },
      { "command": "versioncon.joinSession", "title": "VersionCon: Join Session" }
    ]
  },
  "scripts": {
    "vscode:prepublish": "npm run build",
    "build": "esbuild src/extension.ts --bundle --outfile=dist/extension.js --external:vscode --format=cjs --platform=node",
    "watch": "npm run build -- --watch --sourcemap",
    "test": "vscode-test",
    "lint": "tsc --noEmit"
  }
}
```

### WebSocket Server with Heartbeat (Host)

```typescript
// Source: ws library Context7 docs + official README
// src/host/SessionHost.ts

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server } from 'net';

interface Member {
  ws: WebSocket;
  displayName: string;
  isAlive: boolean;
  joinedAt: number;
}

export class SessionHost {
  private wss: WebSocketServer | null = null;
  private members: Map<string, Member> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  async start(port: number): Promise<number> {
    // If port is 0, find a free port
    const actualPort = port === 0 ? await this.findFreePort() : port;

    this.wss = new WebSocketServer({
      port: actualPort,
      maxPayload: 10 * 1024 * 1024, // 10MB default, configurable
      perMessageDeflate: false, // LAN doesn't need compression
    });

    this.wss.on('connection', (ws) => this.handleConnection(ws));
    this.startHeartbeat();

    return actualPort;
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.members.forEach((member, id) => {
        if (!member.isAlive) {
          member.ws.terminate();
          this.members.delete(id);
          this.broadcastMemberLeft(id);
          return;
        }
        member.isAlive = false;
        member.ws.ping();
      });
    }, 15000); // 15-second heartbeat interval
  }

  private async findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.listen(0, () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });
  }

  stop(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.wss?.close();
    this.members.clear();
  }
}
```

### Auto-Detect Local IP Address

```typescript
// Source: Node.js os.networkInterfaces() API
// src/utils/network.ts

import * as os from 'os';

export function getLocalIPv4(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (iface.internal || iface.family !== 'IPv4') continue;
      return iface.address;
    }
  }
  return '127.0.0.1'; // Fallback
}

export function getAllIPv4Addresses(): Array<{ name: string; address: string }> {
  const result: Array<{ name: string; address: string }> = [];
  const interfaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const iface of addrs ?? []) {
      if (iface.internal || iface.family !== 'IPv4') continue;
      result.push({ name, address: iface.address });
    }
  }
  return result;
}
```

### mDNS Service Publication and Discovery

```typescript
// Source: bonjour-service Context7 docs
// src/network/discovery.ts

import { Bonjour, Service, Browser } from 'bonjour-service';

const SERVICE_TYPE = 'versioncon';

export class DiscoveryManager {
  private bonjour: Bonjour;
  private publishedService: Service | null = null;
  private browser: Browser | null = null;

  constructor() {
    this.bonjour = new Bonjour();
  }

  publishSession(name: string, port: number): void {
    this.publishedService = this.bonjour.publish({
      name,
      type: SERVICE_TYPE,
      port,
      txt: { version: '1' }
    });
  }

  browseSessions(onFound: (session: { name: string; host: string; port: number }) => void): void {
    this.browser = this.bonjour.find({ type: SERVICE_TYPE }, (service) => {
      onFound({
        name: service.name,
        host: service.host,
        port: service.port
      });
    });
  }

  stop(): void {
    this.publishedService?.stop?.();
    this.browser?.stop();
    this.bonjour.destroy();
  }
}
```

### Session History Persistence

```typescript
// Source: VS Code globalState API (code.visualstudio.com/api)
// src/storage/SessionHistory.ts

import * as vscode from 'vscode';

interface SessionEntry {
  hostIp: string;
  port: number;
  sessionName: string;
  displayName: string;
  lastConnected: number;
}

const MAX_HISTORY = 5;
const STORAGE_KEY = 'versioncon.sessionHistory';

export class SessionHistory {
  constructor(private context: vscode.ExtensionContext) {}

  getHistory(): SessionEntry[] {
    return this.context.globalState.get<SessionEntry[]>(STORAGE_KEY, []);
  }

  async addEntry(entry: Omit<SessionEntry, 'lastConnected'>): Promise<void> {
    const history = this.getHistory();
    const newEntry: SessionEntry = { ...entry, lastConnected: Date.now() };

    // Remove duplicate (same IP + port)
    const filtered = history.filter(
      (h) => !(h.hostIp === entry.hostIp && h.port === entry.port)
    );

    // Prepend new, cap at MAX_HISTORY
    const updated = [newEntry, ...filtered].slice(0, MAX_HISTORY);
    await this.context.globalState.update(STORAGE_KEY, updated);
  }
}
```

### Status Bar Item Management

```typescript
// Source: VS Code API docs (StatusBarItem)
// src/ui/StatusBarManager.ts

import * as vscode from 'vscode';

type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

export class StatusBarManager implements vscode.Disposable {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.setStatus('disconnected');
    this.item.show();
  }

  setStatus(status: ConnectionStatus): void {
    switch (status) {
      case 'connected':
        this.item.text = '$(circle-filled) VersionCon';
        this.item.color = new vscode.ThemeColor('testing.iconPassed');
        this.item.tooltip = 'Connected to session';
        break;
      case 'reconnecting':
        this.item.text = '$(sync~spin) VersionCon';
        this.item.color = new vscode.ThemeColor('editorWarning.foreground');
        this.item.tooltip = 'Reconnecting...';
        break;
      case 'disconnected':
        this.item.text = '$(circle-outline) VersionCon';
        this.item.color = undefined;
        this.item.tooltip = 'Not connected';
        break;
    }
    this.item.command = 'versioncon.showSidebar';
  }

  dispose(): void {
    this.item.dispose();
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| @vscode/webview-ui-toolkit | @vscode-elements/elements (Lit) | Jan 2025 (deprecated) | Must use community Lit components or raw CSS variables for VS Code theme compliance [VERIFIED: npm registry deprecation flag] |
| Keytar for secrets | SecretStorage API (Electron safeStorage) | VS Code 1.75+ | Transparent to extension devs but underlying security improved [CITED: code.visualstudio.com/api] |
| webpack for bundling | esbuild for bundling | 2023+ official recommendation | 10-100x faster builds; VS Code docs now recommend esbuild first [CITED: code.visualstudio.com/api/working-with-extensions/bundling-extension] |
| node-tree-sitter (native) | web-tree-sitter (WASM) | 2023+ for VS Code extensions | WASM works in all environments including web extensions; no native compilation needed [VERIFIED: Context7 tree-sitter docs] |
| `activationEvents: ["*"]` | Implicit activation via contributes | VS Code 1.74+ | Views/commands auto-activate; no need for explicit activation events [CITED: code.visualstudio.com/api/references/activation-events] |
| mocha-only testing | @vscode/test-cli + mocha | 2024 | Official CLI provides better test configuration and discovery [VERIFIED: npm registry] |

**Deprecated/outdated:**
- `@vscode/webview-ui-toolkit`: Archived Jan 2025; use `@vscode-elements/elements` or raw VS Code CSS variables
- `vscode` npm module (old): Replaced by `@types/vscode` + runtime shim years ago
- `vscode-test` (old package): Replaced by `@vscode/test-electron` + `@vscode/test-cli`
- Keytar: Removed from VS Code in favor of built-in SecretStorage

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | 15-second heartbeat interval is appropriate for LAN sessions | Code Examples (heartbeat) | Too frequent = unnecessary traffic; too infrequent = slow dead connection detection. Low risk -- configurable. |
| A2 | `@vscode-elements/elements` provides sufficient components for wizard UI | Standard Stack | If insufficient, may need custom Lit components or raw HTML. Medium risk -- wizard is custom anyway. |
| A3 | `net.createServer().listen(0)` reliably finds free ports on all platforms | Code Examples (port finding) | Node.js built-in; very low risk of failure. |
| A4 | VS Code `engines` version `^1.85.0` is appropriate minimum | Code Examples (package.json) | Too high excludes users on older VS Code; too low means missing API features. Low risk -- 1.85 is well-established. |
| A5 | nanoid generates invite codes that are human-typeable | Standard Stack | Default alphabet may produce confusing chars (l/1, O/0). May need custom alphabet. Low risk -- configurable. |

## Open Questions (RESOLVED)

1. **Bandwidth monitoring granularity** -- RESOLVED
   - What we know: D-13 requires a bandwidth monitor in the admin surface. `ws` provides `bufferedAmount` per socket.
   - What was unclear: Should we track bytes/second per member, total session throughput, or both? How frequently should we sample?
   - **Resolution:** Track bytes sent/received per member with 5-second sampling; display as "X KB/s" in sidebar. Implemented in `BandwidthMonitor` class (Plan 02) with `recordSent`/`recordReceived` per member and `getAllStats()` returning per-member KB/s rates.

2. **Invite code format and length** -- RESOLVED
   - What we know: D-05/D-06 specify invite code + username model. Codes are reusable per session.
   - What was unclear: How long should invite codes be? Human-typeable vs. copy-paste-only? Custom alphabet to avoid ambiguous characters?
   - **Resolution:** 6-character uppercase alphanumeric using custom alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (32 chars -- excludes 0, O, I, 1 for readability). Generated via `crypto.randomBytes` in `src/utils/id.ts` (Plan 03). Short enough to read aloud, strong enough for LAN use.

3. **Host shutdown confirmation UX** -- RESOLVED
   - What we know: D-15 requires confirmation prompt when host closes VS Code while hosting.
   - What was unclear: VS Code's `onWillDispose` lifecycle -- can we reliably intercept window close? Is `vscode.window.showWarningMessage` shown before process exit?
   - **Resolution:** Use `vscode.window.showWarningMessage` with `{ modal: true }` inside the `deactivate()` function. VS Code calls `deactivate` on window close with ~5s timeout. The modal confirmation is best-effort -- if VS Code closes before the dialog is dismissed, cleanup still proceeds. Implemented in Plan 06, Task 1.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Extension runtime | Yes | v25.7.0 | -- |
| npm | Package management | Yes | 11.10.1 | -- |
| npx | Scaffolding tools | Yes | (bundled) | -- |
| VS Code | Extension host | Not in PATH | -- | Install `code` CLI or test via Extension Development Host |
| yo (Yeoman) | Extension scaffold | Yes (npx) | 7.0.1 | Manual scaffold (preferred -- more control) |
| generator-code | Extension scaffold | Yes (npx) | 1.11.18 | Manual scaffold |

**Missing dependencies with no fallback:**
- None -- all required tools available.

**Missing dependencies with fallback:**
- VS Code CLI (`code` command) not in PATH. Use Extension Development Host (F5 in VS Code) for testing. This is standard for extension development.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Mocha 11.7.5 + @vscode/test-cli 0.0.12 |
| Config file | `.vscode-test.mjs` (Wave 0 creation) |
| Quick run command | `npm test -- --grep "protocol"` |
| Full suite command | `npm test` |

### Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| NET-01 | Host creates session on specified port with settings | integration | `npm test -- --grep "SessionHost"` | Wave 0 |
| NET-02 | Wizard completes 3 steps and produces valid config | unit | `npm test -- --grep "WizardState"` | Wave 0 |
| NET-03 | Client connects with invite code + display name | integration | `npm test -- --grep "auth handshake"` | Wave 0 |
| NET-04 | Session history stores and retrieves last 5 entries | unit | `npm test -- --grep "SessionHistory"` | Wave 0 |
| NET-05 | Status transitions: disconnected->connecting->connected->reconnecting | unit | `npm test -- --grep "ConnectionState"` | Wave 0 |
| NET-07 | mDNS publishes and discovers service on localhost | integration | `npm test -- --grep "Discovery"` | Wave 0 |
| NET-08 | Bandwidth limit rejects messages exceeding maxPayload | integration | `npm test -- --grep "bandwidth"` | Wave 0 |
| SAFE-01 | Session model rejects unauthorized state mutations | unit | `npm test -- --grep "authorization"` | Wave 0 |
| SAFE-02 | Client remains operational during disconnect (no lockout) | unit | `npm test -- --grep "disconnect editing"` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test -- --grep "<relevant-module>"`
- **Per wave merge:** `npm test` (full suite)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `.vscode-test.mjs` -- test runner configuration
- [ ] `src/test/suite/host.test.ts` -- covers NET-01, NET-08, SAFE-01
- [ ] `src/test/suite/client.test.ts` -- covers NET-03, SAFE-02
- [ ] `src/test/suite/protocol.test.ts` -- covers NET-05
- [ ] `src/test/suite/storage.test.ts` -- covers NET-04
- [ ] `src/test/suite/discovery.test.ts` -- covers NET-07
- [ ] Framework install: `npm install -D mocha @types/mocha @vscode/test-cli @vscode/test-electron`

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | Invite code + display name model; constant-time comparison via `crypto.timingSafeEqual` |
| V3 Session Management | Yes | Session lifetime tied to host process; invite codes regenerable on compromise |
| V4 Access Control | Yes | Host-only admin actions (kick, regenerate code); member role separation |
| V5 Input Validation | Yes | Validate all WebSocket message payloads against typed protocol schema; reject malformed messages |
| V6 Cryptography | No | LAN-only in phase 1; no TLS required for local network (Cloud/TLS is Phase 7) |

### Known Threat Patterns for VS Code Extension + WebSocket

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Invite code brute-force | Spoofing | Rate limit auth attempts (5/min per IP); use `crypto.timingSafeEqual` for comparison |
| Malformed WebSocket message crash | Denial of Service | Validate all incoming messages against schema; wrap handlers in try/catch |
| Webview script injection (XSS) | Tampering | Strict CSP with nonce; never interpolate user data into HTML without escaping |
| Member impersonation | Spoofing | Server-assigned member IDs after auth; display names are cosmetic, not identity |
| Resource exhaustion via large messages | Denial of Service | `maxPayload` limit on ws server; per-connection bandwidth monitoring |
| Host confirmation bypass on close | Information Disclosure | Modal confirmation dialog on deactivate; graceful session shutdown |

## Sources

### Primary (HIGH confidence)
- [/websockets/ws] - Context7: WebSocket server setup, heartbeat/ping-pong, server options, perMessageDeflate
- [/onlxltd/bonjour-service] - Context7: Service publish/browse API, TypeScript types
- [/tree-sitter/tree-sitter] - Context7: web-tree-sitter WASM initialization, Language.load, Parser API
- [code.visualstudio.com/api/extension-guides/webview](https://code.visualstudio.com/api/extension-guides/webview) - Official webview docs: CSP, message passing, state, security
- [code.visualstudio.com/api/references/activation-events](https://code.visualstudio.com/api/references/activation-events) - Activation events reference
- [code.visualstudio.com/api/working-with-extensions/bundling-extension](https://code.visualstudio.com/api/working-with-extensions/bundling-extension) - esbuild bundling guide
- npm registry - All version numbers verified via `npm view`

### Secondary (MEDIUM confidence)
- [github.com/microsoft/vscode-extension-samples](https://github.com/microsoft/vscode-extension-samples/blob/main/webview-view-sample/src/extension.ts) - WebviewViewProvider reference implementation
- [github.com/microsoft/vscode-webview-ui-toolkit/issues/561](https://github.com/microsoft/vscode-webview-ui-toolkit/issues/561) - Toolkit deprecation announcement
- [vscode-elements.github.io](https://vscode-elements.github.io) - Replacement UI component library homepage
- [dev.to/hexshift/robust-websocket-reconnection-strategies](https://dev.to/hexshift/robust-websocket-reconnection-strategies-in-javascript-with-exponential-backoff-40n1) - Reconnect patterns verified against ws docs

### Tertiary (LOW confidence)
- None -- all claims verified against primary or secondary sources

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all versions verified via npm registry, libraries well-established and actively maintained
- Architecture: HIGH -- follows locked decisions from CONTEXT.md + official VS Code patterns
- Pitfalls: HIGH -- mDNS VLAN issues well-documented; webview state loss is VS Code's documented behavior; heartbeat patterns from ws official docs

**Research date:** 2026-05-04
**Valid until:** 2026-06-04 (stable domain; VS Code Extension API changes slowly)
