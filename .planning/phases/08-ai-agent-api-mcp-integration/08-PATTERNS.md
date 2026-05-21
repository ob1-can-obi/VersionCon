# Phase 8: AI Agent API (MCP Integration) — Pattern Map

**Mapped:** 2026-05-20
**Surfaces:** Extension-side only (`src/mcp/**` greenfield + `src/extension.ts` modification + `src/test/suite/mcp*.test.ts`)
**Files classified:** 24 new + 2 modified
**Analogs found in repo:** 22 / 24 new files have a direct in-repo analog. The 2 net-new shapes (`src/mcp/server.ts` MCP HTTP/SSE listener, `src/mcp/resources/dependencyGraph.ts` MCP-resource template) have no in-repo analog — RESEARCH.md §A.2 + §1226 canonical SDK code excerpts substitute. Per CONTEXT N-08-06, `src/mcp/` MUST NOT import from `relay/`; relay analogs are referenced for structural shape only.

---

## File Classification

### Production code (`src/mcp/**` — all new)

| New File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/mcp/server.ts` | network listener (HTTP/SSE) | event-driven | `relay/src/server.ts:96-120` (HTTP+upgrade boot shape ONLY — DO NOT import from relay/) + RESEARCH §A.2 canonical SDK excerpt | partial (boot-shape only, no in-repo MCP analog) |
| `src/mcp/buildServer.ts` | DI composer / factory | request-response | `src/host/SessionHostFactory.ts` (factory that wires controller from injected deps) | role-match |
| `src/mcp/registry.ts` | runtime allow-list + factory | request-response | `relay/src/auth.ts:74-164` (allow-list-style gate + verify pattern); secondary `src/commands/aliases.ts` (factory-style registration loop) | role-match (allow-list discipline mirrors auth gate; factory-loop mirrors aliases) |
| `src/mcp/readers.ts` | type-only interface module | (none — types only) | `src/network/Transport.ts:1-260` (type-only interface module exporting multiple `interface` declarations with extensive JSDoc) | exact |
| `src/mcp/lifecycle.ts` | activation/deactivation lifecycle | event-driven | `src/extension.ts:189-221` (`getGitBridgeOutputChannel` + `getDeepLinkOutputChannel` lazy-channel pattern) + `src/extension.ts:371-408` (`ensureVersionconExcluded` activation-side config-edit helper) | role-match |
| `src/mcp/consent.ts` | first-run modal prompt | request-response | `src/extension.ts:301-315` (Phase 7 UriHandler T-07-10 confirmation prompt) — STRONG analog already cited in RESEARCH §1271 | exact |
| `src/mcp/mcpConfig.ts` | JSONC config edit-in-place | file-I/O (read-modify-write) | `src/extension.ts:371-408` `ensureVersionconExcluded` (`.vscode/settings.json` deep-merge; preserves sibling entries) | role-match (deviation: use `jsonc-parser.modify`/`applyEdits` instead of `JSON.parse`/`JSON.stringify` so user comments + sibling entries survive — RESEARCH §D.1) |
| `src/mcp/adapters/BranchReaderImpl.ts` | reader adapter | request-response | `src/commands/aliases.ts` (thin pass-through wrapping existing canonical handler) + reader-shape `getActiveBranch()`/`listBranches()` already on `BranchManager` (lines 71-236) | exact |
| `src/mcp/adapters/SyncReaderImpl.ts` | reader adapter | request-response | `src/commands/aliases.ts` + `SyncTracker.getLatestPushId()`/`getOutOfSyncPaths()` already on `SyncTracker:63-92` | exact |
| `src/mcp/adapters/ActivityReaderImpl.ts` | reader adapter | request-response | `src/commands/aliases.ts` + `PushHistory.getRecords()`/`getLatestRecord()` already on `PushHistory:42-56` | exact |
| `src/mcp/adapters/ChatReaderImpl.ts` | reader adapter | request-response | `src/commands/aliases.ts` + `ChatLog.getRecent(n)` already on `ChatLog:106` | exact |
| `src/mcp/adapters/DependencyReaderImpl.ts` | reader adapter | request-response | `src/commands/aliases.ts` + ad-hoc call into `AstFactory.getAdapter` + `joinImpact` (no method-level analog; RESEARCH §I.1) | partial |
| `src/mcp/adapters/PresenceReaderImpl.ts` | reader adapter | request-response | `src/commands/aliases.ts` + existing `SessionHost.getPresenceSnapshot`/`getMemberTracking` getters | exact |
| `src/mcp/tools/getBranchStatus.ts` | tool registration (per-handler file) | request-response | `src/commands/aliases.ts` (one file, one registration function, exports `register*`, takes injected context); secondary RESEARCH §1188 canonical SDK excerpt | exact |
| `src/mcp/tools/getSyncStatus.ts` | tool registration | request-response | mirror `getBranchStatus.ts` | exact |
| `src/mcp/tools/getRecentActivity.ts` | tool registration | request-response | mirror `getBranchStatus.ts` | exact |
| `src/mcp/tools/getChatLog.ts` | tool registration | request-response | mirror `getBranchStatus.ts` | exact |
| `src/mcp/tools/queryDependencies.ts` | tool registration | request-response | mirror `getBranchStatus.ts` (adds `DependencyReader` dep) | exact |
| `src/mcp/tools/listDependents.ts` | tool registration | request-response | mirror `getBranchStatus.ts` (adds `DependencyReader` dep) | exact |
| `src/mcp/tools/adviseSync.ts` | composite tool (fan-in) | request-response (fans into 3 readers) | `src/commands/aliases.ts` (registration shape) + RESEARCH §I.2 composition pattern | role-match (no composite-tool analog in repo) |
| `src/mcp/resources/dependencyGraph.ts` | MCP resource template | request-response | RESEARCH §1226 canonical SDK excerpt — no in-repo MCP analog | none in-repo |

### Test files (`src/test/suite/mcp*.test.ts` — all new)

| New File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/test/suite/fixtures/fakeReaders.ts` | test fixtures / harness | (test util) | `src/test/suite/sessionClientCloudReconnect.test.ts:32-86` `StubCloudTransport` (in-file fake conforming to an interface) | role-match (extract to a shared fixtures file rather than re-define per-test) |
| `src/test/suite/mcpServer.test.ts` | E2E integration test | event-driven | `src/test/suite/sessionClientCloudReconnect.test.ts` (boot transport + assert state transitions); secondary `src/test/suite/cloudTransportSwapToken.test.ts` (full E2E with stubs) | exact |
| `src/test/suite/mcpToolsRead.test.ts` | per-tool unit tests | request-response | `src/test/suite/bootstrapTokenIssue.test.ts` (per-function unit test; `setup()` + multiple `test()` blocks asserting shape) | exact |
| `src/test/suite/mcpAdviseSync.test.ts` | composite-tool unit/E2E | request-response | `src/test/suite/cloudTransportSwapToken.test.ts` (multi-stub composition + state assertions) | role-match |
| `src/test/suite/mcpDependencyResource.test.ts` | resource read happy path | request-response | `src/test/suite/bootstrapTokenIssue.test.ts` (single-shot read + assert) | exact |
| `src/test/suite/mcpConfigWriter.test.ts` | config file I/O test | file-I/O | `src/test/suite/branchManager.test.ts:7-21` (tmpdir setup/teardown + file-shape assertions) | exact |
| `src/test/suite/mcpReadOnlyGate.test.ts` | source-grep + runtime gate | batch | `src/test/suite/uriHandlerBootstrapToken.test.ts:24-65` (source-grep gates: `fs.readFileSync` + `assert.match` regex pattern) | exact |
| `src/test/suite/mcpConsent.test.ts` | first-run prompt test | request-response | `src/test/suite/uriHandlerBootstrapToken.test.ts:69-85` (stub `vscode.window.showInformationMessage` + assert) | exact |
| `src/test/suite/mcpActivation.test.ts` | activation E2E (SC-1) | event-driven | `src/test/suite/uriHandlerBootstrapToken.test.ts` + `src/test/suite/branchManager.test.ts` (activation-side wiring + file effects) | role-match |

### Files modified (NOT created)

| Modified File | What Changes | Analog | Match Quality |
|---|---|---|---|
| `src/extension.ts` | Add `startMcpServer` + `ensureConsent` + `upsertMcpConfig` calls in `activate()` (line 804+); shutdown in `deactivate()`. Add `getMcpOutputChannel` lazy factory. | itself — `extension.ts:189-221` (lazy channel pattern) + `extension.ts:867-869` `void ensureVersionconExcluded(context).catch(...)` (fire-and-forget activation helper) | exact (in-place) |
| `package.json` | 4 new deps (`@modelcontextprotocol/sdk`, `zod`, `jsonc-parser`, `express`); 1 new devDep (`@types/express`); 3 new `contributes.configuration.properties` keys (`versioncon.mcp.enabled`, `.port`, `.consent`) | itself — existing `contributes.configuration` block | exact (in-place) |

---

## Pattern Assignments

### `src/mcp/server.ts` (network listener, event-driven)

**Analog:** `relay/src/server.ts` (structural shape ONLY — **DO NOT `import` from relay/** per CONTEXT N-08-06). Plus RESEARCH §A.2 canonical SDK excerpt as the actual code source.

**Why this analog:** The relay/server.ts code site is the only HTTP-listener-bootstrap pattern in the codebase. It demonstrates the project's house style for `startServer({ port })` async factory + `RunningServer` handle. The MCP server uses the same OUTER shape but the inner body is the StreamableHTTPServerTransport + McpServer wiring from the SDK example.

**Boot-shape pattern** (`relay/src/server.ts:64-120`):
```typescript
export interface StartServerOptions {
  /** Bind port. `0` requests an ephemeral port (used by tests). Defaults to env PORT or 8080. */
  port?: number;
  // ...
}

export interface RunningServer {
  port: number;
  close: () => Promise<void>;
  registry: SessionRegistry;
}

export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const requestedPort = opts.port ?? parseInt(process.env.PORT ?? '8080', 10);
  // ...
  const registry = new SessionRegistry();

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      // ...
    }
  });
```

**Deviations:**
- Replace `requestedPort = parseInt(process.env.PORT...)` with `listen(0, '127.0.0.1', ...)` — kernel-assigned ephemeral port (CONTEXT D-5, T-08-04, N-08-08 gate).
- Replace `http.createServer` + `WebSocketServer` with `express()` + `StreamableHTTPServerTransport` per RESEARCH §A.2.
- MUST add `enableDnsRebindingProtection: true` + `allowedHosts: ['127.0.0.1:<port>']` literally — N-08-09 gate / CVE-2025-66414.
- Bind literal `'127.0.0.1'` string, NEVER `'localhost'` (Pitfall 2; Node 17+ resolves `localhost` to `::1`).
- NO console.* in this file — use OutputChannel via injected `log` function (N-08-04).
- Return `RunningServer = { port, close, registry? }` but `registry` becomes `McpServer` instance.

---

### `src/mcp/buildServer.ts` (DI composer, request-response)

**Analog:** `src/host/SessionHostFactory.ts` (factory that constructs the controller from injected deps).

**Why this analog:** The factory pattern of "single function, takes injected deps, returns a configured controller" is exactly the buildServer shape — needed for tests (inject fakeReaders) and for production (real adapters).

**Excerpt to mirror** (factory style; see `src/host/SessionHostFactory.ts` for the full shape):
- One file, one default-export function.
- Takes a deps bundle (`{ branchReader, syncReader, ... }`).
- Constructs the central object (`new McpServer(...)`).
- Calls each per-tool/resource `register*` function in turn, passing the configured server + relevant readers.
- Returns the configured `McpServer` instance (NOT bound — bind happens in `server.ts`).

**Deviation:** Unlike SessionHostFactory which returns a fully-bound listening host, `buildServer` returns ONLY the McpServer object; transport-binding happens in `server.ts`. This lets tests construct an in-memory McpServer for protocol-shape assertions without binding a port.

---

### `src/mcp/registry.ts` (runtime allow-list + factory, request-response)

**Analog:** `relay/src/auth.ts:43-72` (allow-list-style discipline via type union + dedicated reason vocabulary) — structural shape only, NOT an import. The `READ_ONLY_TOOLS` Set + `registerReadOnlyTool` factory body is given verbatim in RESEARCH §1036-1067 and that's what the executor copies.

**Why this analog:** Phase 7's auth.ts establishes the project's "small reason vocabulary + Set-based allow-list + log-but-never-leak" discipline. The MCP registry mirrors that exact posture for the read-only tool gate.

**Allow-list discipline excerpt** (`relay/src/auth.ts:49-72`):
```typescript
type AuthFailReason =
  | 'malformed'
  | 'expired'
  | 'wrong-alg'
  | 'unknown-session'
  | 'malformed-aud';

const SESSION_ID_SHAPE = /^vc-[a-z0-9-]{1,64}$/;

function logFail(sessionId: string | undefined, reason: AuthFailReason): void {
  // Logger discipline (CONTEXT D-11, T-07-03/04): only {event, sessionId, reason}.
  logger.warn({ event: 'auth-fail', sessionId, reason });
}
```

**Registry contract to copy** (verbatim from RESEARCH §1036-1067):
```typescript
// src/mcp/registry.ts
export const READ_ONLY_TOOLS = new Set<string>([
  'get_branch_status', 'get_sync_status', 'get_recent_activity',
  'get_chat_log', 'query_dependencies', 'list_dependents', 'advise_sync',
]);

export function registerReadOnlyTool<T extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  meta: { title: string; description: string; inputSchema: T },
  handler: (args: z.objectInputType<T, z.ZodTypeAny>) => Promise<CallToolResult>,
): void {
  if (!READ_ONLY_TOOLS.has(name)) {
    throw new Error(`registerReadOnlyTool: '${name}' not in READ_ONLY_TOOLS`);
  }
  server.registerTool(name,
    { ...meta, annotations: { readOnlyHint: true, openWorldHint: false } },
    async (args) => {
      if (!READ_ONLY_TOOLS.has(name)) {
        return { content: [{ type: 'text', text: `Tool '${name}' rejected.` }], isError: true };
      }
      return handler(args);
    },
  );
}
```

**Deviations:** Add a `logger`-equivalent injected param (OutputChannel-backed) so the factory can log `{event:'tool-call', name, ms}` per RESEARCH §A.6. NO console.* (N-08-04).

---

### `src/mcp/readers.ts` (type-only interface module)

**Analog:** `src/network/Transport.ts:1-260` — the canonical "type-only file exporting multiple `interface` declarations with extensive JSDoc" pattern.

**Why this analog:** `Transport.ts` is the exact precedent: dual interfaces (`HostTransport`, `ClientTransport`) used across the codebase as the structural seam, with NO runtime imports. The MCP readers follow the same posture but with 6 interfaces (BranchReader, SyncReader, ActivityReader, ChatReader, DependencyReader, PresenceReader).

**Imports pattern** (`src/network/Transport.ts:32-33`):
```typescript
import type { IncomingMessage } from 'http';
import type { ProtocolMessage } from './protocol.js';
```
**Note:** ALL imports are `import type` — no runtime code lands in this module.

**Interface declaration pattern** (`src/network/Transport.ts:54-79`):
```typescript
/**
 * Host-side transport: accepts inbound peer connections, sends/receives
 * protocol messages per connection, and drives heartbeat ping/pong + close
 * lifecycle. Asymmetric with ClientTransport because the host listens for
 * many peers while a client opens a single socket.
 */
export interface HostTransport {
  /**
   * Begin accepting connections. Resolves with the actual port bound (LAN:
   * `findFreePort()` is internal to LanHostTransport when port === 0; future
   * Cloud: returns 0 because no local port is bound).
   */
  listen(port: number, maxPayloadBytes: number): Promise<number>;
  // ...
}
```

**Interface body to write** (per RESEARCH §1070-1103):
```typescript
export interface BranchReader {
  getActiveBranch(): Promise<string>;
  listBranches(): readonly BranchInfo[];
}

export interface SyncReader {
  getOutOfSyncPaths(): readonly string[];
  getLatestPushId(): string | null;
}
// ... etc.
```

**Critical contract (N-08-03 gate):** NO method name on a Reader interface may match `set*` / `push*` / `update*` / `delete*` / `commit*` (with documented allowance for `setTimeout`/`setInterval` lexemes in JSDoc text only). Source-grep gate enforces this on every CI run.

**Deviation:** Unlike `Transport.ts` (which has both an `interface` definition and is implemented in `LanTransport.ts`/`CloudTransport.ts` in the same `src/network/` tree), `readers.ts` interfaces are implemented one directory deeper (`src/mcp/adapters/*Impl.ts`) to keep this file PURELY type-only (no runtime sibling).

---

### `src/mcp/lifecycle.ts` (activation/deactivation, event-driven)

**Analog:** `src/extension.ts:189-221` (lazy OutputChannel factory pattern) + `src/extension.ts:371-408` (`ensureVersionconExcluded` activation-side helper that touches `.vscode/`).

**Why this analog:** `getDeepLinkOutputChannel` (Phase 7) is the canonical "lazy singleton registered into `context.subscriptions` on first use" pattern that the MCP output channel should mirror exactly. `ensureVersionconExcluded` is the canonical fire-and-forget-activation-side workspace-edit helper — same shape as MCP's "ensure config + start server" startup work.

**Lazy OutputChannel factory pattern** (`src/extension.ts:207-221`):
```typescript
// Phase 7 (Plan 07-06): dedicated Output channel for the vscode:// deep-link
// UriHandler. Lazily created on first deep-link arrival via
// getDeepLinkOutputChannel() and disposed with the extension via
// context.subscriptions. Mirrors the getGitBridgeOutputChannel lifecycle
// pattern above (single canonical channel name; idempotent push to subs).
let deepLinkOutputChannel: vscode.OutputChannel | null = null;
let deepLinkChannelPushedToSubs = false;

function getDeepLinkOutputChannel(
  context: vscode.ExtensionContext,
): vscode.OutputChannel {
  if (!deepLinkOutputChannel) {
    deepLinkOutputChannel = vscode.window.createOutputChannel('VersionCon: Deep Links');
  }
  if (!deepLinkChannelPushedToSubs) {
    context.subscriptions.push(deepLinkOutputChannel);
    deepLinkChannelPushedToSubs = true;
  }
  return deepLinkOutputChannel;
}
```

**Fire-and-forget activation helper pattern** (`src/extension.ts:862-869`):
```typescript
// --- Phase 4.3 (SC-1, T-04.3-01 mitigation): hide .versioncon/ from File
// Explorer by merging { ".versioncon": true } into .vscode/settings.json.
// Fire-and-forget so activation never blocks on disk I/O. The helper itself
// swallows malformed-JSON / read errors; the outer catch is defense-in-depth
// for write/mkdir failures so a permission error never breaks activation.
void ensureVersionconExcluded(context).catch(err => {
  console.error('[versioncon] files.exclude injection failed', err);
});
```

**Lifecycle helper body** (compose from above patterns + RESEARCH §A.7):
- Export `startMcpServer(context, log)` that: reads `versioncon.mcp.enabled` → returns early if false; calls `ensureConsent` → returns early if declined; constructs `buildServer(...realReaders)`; calls `startServer({ port: 0, server, log })`; calls `upsertMcpConfig(workspaceFolder, port)`; stores port in workspaceState; logs `{event:'mcp-started', port}`.
- Export `stopMcpServer()` that: calls `runningServer.close()`; calls `removeMcpConfig(workspaceFolder)`; logs `{event:'mcp-stopped'}`.
- `void startMcpServer(context, log).catch(err => log.appendLine(...))` from `activate()` — fire-and-forget activation never blocks.

**Deviation from extension.ts:867:** Replace `console.error` (which would violate N-08-04) with `log.appendLine` calls into the MCP OutputChannel. The `console.error` at line 868 is in `extension.ts` (not `src/mcp/`) and is exempt from N-08-04.

---

### `src/mcp/consent.ts` (first-run modal prompt, request-response)

**Analog (STRONG — already cited in RESEARCH §1271):** `src/extension.ts:301-315` — the Phase 7 T-07-10 UriHandler confirmation prompt. Same UX (modal `showInformationMessage`), same persistent grant via setting, same Allow/Decline dichotomy.

**Why this analog:** CONTEXT explicitly calls this out as the pattern to mirror: *"Mirrors Phase 7's UriHandler T-07-10 confirmation pattern — same pattern, same UX expectation."* The prompt copy differs (different feature) but the structural shape is identical.

**Phase 7 T-07-10 confirmation excerpt** (`src/extension.ts:301-315`):
```typescript
// T-07-10 mitigation — REQUIRED confirmation prompt before any panel open
// or network call. UI-SPEC literal copy ("Join VersionCon session? You've
// been invited to join a cloud session at <relay>.").
const choice = await vscode.window.showInformationMessage(
  `Join VersionCon session? You've been invited to join a cloud session at ${relay}.`,
  'Join',
  'Cancel',
);

if (choice !== 'Join') {
  // Silent cancellation per UI-SPEC §Reconnect Progress Copy ("no toast on
  // cancel"). Only an OutputChannel breadcrumb is left for diagnostics.
  channel.appendLine(`[${ts}] Deep-link declined by user (choice=${choice ?? 'dismissed'})`);
  return;
}
```

**Adaptation for `src/mcp/consent.ts`** (verbatim from RESEARCH §1271-1297, copy exactly):
```typescript
import * as vscode from 'vscode';

const CONSENT_PROMPT =
  'VersionCon wants to register an MCP server with this workspace so AI agents (Claude Code, ' +
  'Copilot, Cursor) can read your collab state. The server is local-only and read-only. Allow?';

export async function ensureConsent(): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('versioncon.mcp');
  if (cfg.get<boolean>('consent') === true) return true;
  const choice = await vscode.window.showInformationMessage(
    CONSENT_PROMPT,
    { modal: false },
    'Allow', 'Decline',
  );
  if (choice === 'Allow') {
    await cfg.update('consent', true, vscode.ConfigurationTarget.Global);
    return true;
  } else {
    await cfg.update('enabled', false, vscode.ConfigurationTarget.Global);
    return false;
  }
}
```

**Deviations from extension.ts:301:**
- Phase 7 uses `'Join' / 'Cancel'`; consent uses `'Allow' / 'Decline'` (matches CONTEXT D-5 first-run prompt copy).
- Phase 7 logs a decline breadcrumb; consent doesn't need a log line because the setting flip itself is the persistent breadcrumb.
- Phase 7's prompt is per-deep-link; consent's prompt is once-per-machine (persistent grant via `versioncon.mcp.consent`).
- Use `ConfigurationTarget.Global` per RESEARCH §Open Questions item 1 (matches Phase 7's UriHandler consent scope).

---

### `src/mcp/mcpConfig.ts` (JSONC config edit-in-place, file-I/O)

**Analog:** `src/extension.ts:371-408` `ensureVersionconExcluded` — the canonical "read-modify-write a JSON config under `.vscode/` while preserving sibling entries" helper.

**Why this analog:** This is the ONLY file in the repo today that performs a deep-merge edit on a JSON file under `.vscode/`. The defensive posture (swallow malformed-JSON, mkdir parent, conditional write) is exactly what MCP config edits need.

**Excerpt to mirror** (`src/extension.ts:371-408`):
```typescript
export async function ensureVersionconExcluded(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (context.workspaceState.get<boolean>('versioncon.filesExcludeInjected')) {
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    // No folder open — defer until one is opened. Do NOT set the flag yet.
    return;
  }
  const settingsPath = path.join(folder.uri.fsPath, '.vscode', 'settings.json');
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fsPromises.readFile(settingsPath, 'utf-8');
    existing = JSON.parse(raw) as Record<string, unknown>;
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      // Defensive: a top-level JSON array or null is not a valid settings
      // shape; treat as empty rather than letting the assignment below blow up.
      existing = {};
    }
  } catch {
    /* file missing or malformed — treat as empty, do NOT propagate */
  }
  const filesExclude =
    (existing['files.exclude'] as Record<string, unknown> | undefined) ?? {};
  // If the user already has an opinion (true OR false), respect it and just
  // set the workspaceState flag so we never revisit on subsequent activations.
  if (Object.prototype.hasOwnProperty.call(filesExclude, '.versioncon')) {
    await context.workspaceState.update('versioncon.filesExcludeInjected', true);
    return;
  }
  filesExclude['.versioncon'] = true;
  existing['files.exclude'] = filesExclude;
  await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsPromises.writeFile(settingsPath, JSON.stringify(existing, null, 2), 'utf-8');
  await context.workspaceState.update('versioncon.filesExcludeInjected', true);
}
```

**Critical deviations for `mcpConfig.ts`:**
1. **DO NOT use `JSON.parse` / `JSON.stringify`** — they destroy comments and rewrite formatting. Use `jsonc-parser.modify(rawText, ['servers', 'versioncon'], value, opts)` + `jsonc-parser.applyEdits(rawText, edits)` per RESEARCH §D.1 + Pitfall 4. RESEARCH §1158 explicitly cites this anti-pattern.
2. **DO NOT gate on `workspaceState.get('mcpConfigInjected')`** — on every activation, OVERWRITE the entry with the fresh port (self-healing per RESEARCH Pitfall 3). The MCP entry is per-session state, not a one-time install.
3. **Preserve sibling entries** — if user has Postgres MCP / GitHub MCP entries, do NOT touch them (T-08-09 mitigation; `mcpConfigWriter.test.ts` pins this).
4. **Export TWO functions:** `upsertMcpConfig(folder, port)` and `removeMcpConfig(folder)` (the latter called from `deactivate()` per RESEARCH §D.3 to prevent stale entries — Pitfall 3).

---

### `src/mcp/adapters/*ReaderImpl.ts` (reader adapters — 6 files, all same shape)

**Analog:** `src/commands/aliases.ts` — thin pass-through wrapper that exposes a specific external surface (commands) by delegating to existing internal surface (canonical command handlers).

**Why this analog:** Aliases are the canonical "one file = one registration function = pure delegation" pattern. The reader adapters do the same: each `*ReaderImpl.ts` exports a constructor taking an underlying source object (BranchManager, SyncTracker, etc.) and exposes ONLY the reader-interface methods, delegating each call to the underlying getter.

**Excerpt to mirror** (`src/commands/aliases.ts:29-53`):
```typescript
export function registerGitStyleAliases(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('versioncon.cmd.push', () =>
      vscode.commands.executeCommand('versioncon.push'),
    ),
    vscode.commands.registerCommand('versioncon.cmd.pull', () =>
      vscode.commands.executeCommand('versioncon.pull'),
    ),
    // ... pure delegation, one line per alias
  );
}
```

**Underlying reader-shape getters already exist** (no new methods needed on filesystem classes):
- `src/filesystem/BranchManager.ts:71,184,236` — `listBranches() / getRequireReview() / getBranch()`
- `src/filesystem/SyncTracker.ts:63,92` — `getLatestPushId() / getOutOfSyncPaths()`
- `src/filesystem/PushHistory.ts:42,47,56` — `getRecords() / getRecord() / getLatestRecord()`
- `src/filesystem/ChatLog.ts:98,106` — `getRecords() / getRecent(n)`

**Adapter body pattern (apply to each `*ReaderImpl.ts`):**
```typescript
import type { BranchReader } from '../readers.js';
import type { BranchManager } from '../../filesystem/BranchManager.js';

export class BranchReaderImpl implements BranchReader {
  constructor(private readonly mgr: BranchManager) {}

  async getActiveBranch(): Promise<string> {
    return this.mgr.getActiveBranch();
  }
  listBranches(): readonly BranchInfo[] {
    return this.mgr.listBranches();
  }
}
```

**Deviations / per-adapter notes:**
- `DependencyReaderImpl.ts`: NO direct getter on `AstAnalyzer` — must call `AstFactory.getAdapter(lang)` + run `joinImpact` ad-hoc per query (RESEARCH §I.1). Single-file analysis only, no batch (Pitfall 7).
- `PresenceReaderImpl.ts`: wraps `SessionHost.getPresenceSnapshot()` and `SessionHost.getMemberTracking()`. Adapter MUST defensive-copy (don't return live mutable map references).
- All adapters: NO writer methods on the constructor's stored reference (TS interface gate enforces this — Layer 1 N-08-03).

---

### `src/mcp/tools/getBranchStatus.ts` (per-tool registration, request-response)

**Analog:** `src/commands/aliases.ts` — one file, one registration function, takes injected context, exports `register*`. Secondary: RESEARCH §1188 canonical SDK excerpt (gives the BODY but not the project's per-file shape).

**Why this analog:** The "one file per registration, exports `register<Thing>(...)`, no top-level state" shape is the project's established style for command/handler registration. The `tools/*.ts` files follow the same shape but register MCP tools instead of VS Code commands.

**Code body to mirror** (verbatim from RESEARCH §1186-1224):
```typescript
// src/mcp/tools/getBranchStatus.ts
import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerReadOnlyTool } from '../registry.js';
import type { BranchReader, SyncReader } from '../readers.js';

export function registerGetBranchStatus(
  server: McpServer,
  deps: { branchReader: BranchReader; syncReader: SyncReader },
): void {
  registerReadOnlyTool(server, 'get_branch_status', {
    title: 'Branch Status',
    description:
      "Returns the current VersionCon branch name, commits ahead/behind the team's view, " +
      'and the list of dirty (uncommitted) files. Call this when the user asks about their ' +
      'branch state or before suggesting any sync action. Read-only.',
    inputSchema: {},
  }, async (): Promise<CallToolResult> => {
    const branch = await deps.branchReader.getActiveBranch();
    const dirty = deps.syncReader.getOutOfSyncPaths();
    const payload = {
      branch,
      ahead: 0,    // populated from PushHistory delta; planner spec'd
      behind: dirty.length,
      dirty,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    };
  });
}
```

**Pattern for the other 5 simple readers (`getSyncStatus`, `getRecentActivity`, `getChatLog`, `queryDependencies`, `listDependents`):** Mirror the above 1:1. Substitute:
- Tool name (must be one of `READ_ONLY_TOOLS` set).
- Per-tool `deps` parameter (only the readers that tool needs).
- Per-tool description from RESEARCH §F.4.
- Per-tool inputSchema (mostly `{}` for the get-* tools; `{ symbolOrPath: z.string() }` for `query_dependencies`/`list_dependents`).
- Per-tool handler body (single reader call → JSON payload).

**Critical contract:** EVERY tool MUST register via `registerReadOnlyTool` — never call `server.registerTool` directly (T-08-05 mitigation; RESEARCH suggests proposed gate N-08-10 `grep -c "server.registerTool" src/mcp/` should be 0 outside registry.ts).

---

### `src/mcp/tools/adviseSync.ts` (composite tool, request-response with fan-in)

**Analog:** Same `getBranchStatus.ts` registration shape, but body fans in to 3 readers + AST.

**Why this analog:** No composite-tool exists in the repo today. Use the simple-reader shape for the wrapper (registerReadOnlyTool + inputSchema + handler), but the handler body fuses Sync + Presence + Dependency readers per RESEARCH §I.2-I.3.

**Body composition (sketch per RESEARCH §I.2):**
```typescript
async (args) => {
  const [syncState, presence, depImpact] = await Promise.all([
    /* read sync state from syncReader */,
    /* read presence from presenceReader */,
    /* compute predicted conflicts via depReader + joinImpact */,
  ]);
  const predicted_conflicts = fuseSources(presence, depImpact);
  return { content: [{ type: 'text', text: JSON.stringify({ state: syncState, predicted_conflicts }) }] };
}
```

**Deviation from simple readers:** This is the ONLY tool that takes optional `target_files?: z.array(z.string())` input. The composition logic itself is net-new code per RESEARCH §I.

---

### `src/mcp/resources/dependencyGraph.ts` (MCP resource template)

**Analog:** None in repo — use RESEARCH §1226 canonical SDK excerpt verbatim.

**Why no in-repo analog:** MCP resources are a new primitive. No existing code in `src/` registers a URI-template-based resource. The SDK example is the source of truth.

**Code body to mirror** (verbatim from RESEARCH §1226-1269):
```typescript
// src/mcp/resources/dependencyGraph.ts
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { DependencyReader } from '../readers.js';

export function registerDependencyGraphResource(
  server: McpServer,
  deps: { depReader: DependencyReader },
): void {
  server.registerResource(
    'dependency-graph-symbol',
    new ResourceTemplate('versioncon-state://dependency-graph/{symbolOrPath}', {
      list: undefined,                                 // browseable but not enumerated
    }),
    {
      title: 'Dependency Graph (Symbol/File)',
      description:
        'Browseable view of the dependency graph for a specific symbol or file. ' +
        'Returns both forward dependencies and reverse dependents, capped at 1 hop. ' +
        'Use this resource form to @-mention dep info in chat; use the ' +
        'query_dependencies / list_dependents tools to call it from a prompt.',
      mimeType: 'application/json',
    },
    async (uri, { symbolOrPath }): Promise<ReadResourceResult> => {
      const target = decodeURIComponent(symbolOrPath as string);
      const [forward, reverse] = await Promise.all([
        deps.depReader.forwardDeps(target, 1),
        deps.depReader.reverseDeps(target, 1),
      ]);
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ target, forward, reverse }),
        }],
      };
    },
  );
}
```

**Critical contract:** URI scheme is `versioncon-state://` (NOT `versioncon://` — that scheme is owned by Phase 7's UriHandler per CONTEXT open-question #7; RESEARCH §G.2 resolves to `versioncon-state://`). The `symbolOrPath` capture is decoded but used ONLY as an in-memory map key — no `fs.read` on the decoded string (T-08-10 path-traversal defense).

---

### `src/test/suite/fixtures/fakeReaders.ts` (test fixtures harness)

**Analog:** `src/test/suite/sessionClientCloudReconnect.test.ts:32-86` — `StubCloudTransport` class. Same pattern but extracted to a shared file (rather than re-defined per-test).

**Why this analog:** This is the closest "fake implementing an interface" pattern. Re-using its shape (constructor takes deterministic data, methods return what tests need) and exposing one `FakeReaders` class implementing all 6 Reader interfaces from `src/mcp/readers.ts`.

**Excerpt to mirror** (`src/test/suite/sessionClientCloudReconnect.test.ts:32-65`):
```typescript
class StubCloudTransport implements ClientTransport {
  public readonly sentFrames: ProtocolMessage[] = [];
  public swapCalls: Array<{ token: string; resolve: (ok: boolean) => void }> = [];
  // ... public test-inspection state

  async connect(): Promise<boolean> { /* ... */ }
  onOpen(h: () => void): void { this.openHandlers.push(h); }
  // ... interface methods that return canned values or push into test-inspection arrays

  /** Test helper — inject a frame. */
  _injectMessage(payload: ProtocolMessage): void { /* ... */ }
}
```

**Pattern for `fixtures/fakeReaders.ts`:**
- Export one `FakeReaders` class (or one `Fake<X>Reader` per interface — both styles are valid).
- Each method returns deterministic canned data (fixtures match RESEARCH §H.3 examples).
- Expose test-inspection helpers (`_setDirtyFiles(paths)`, `_setBranchAhead(n)`, etc.) so tests synthesize specific states without re-instantiating the whole fake.
- Include realistic fixture data: e.g. `parseToken` symbol with known dependents (per `mcpDependencyReaderE2E.test.ts` SC-2 requirement).

**Deviation:** Unlike `StubCloudTransport` (live in the test file), `fakeReaders.ts` lives in `src/test/suite/fixtures/` so multiple `mcp*.test.ts` files import it. Path layout matches RESEARCH §1493.

---

### `src/test/suite/mcpServer.test.ts` (E2E integration test)

**Analog:** `src/test/suite/sessionClientCloudReconnect.test.ts` (boot transport + assert end-state); secondary `src/test/suite/cloudTransportSwapToken.test.ts` (multi-stub composition).

**Why this analog:** The Phase 7 E2E tests demonstrate the "boot real-ish controller + stub the transport boundary + assert end-state" pattern. The MCP server E2E follows the same shape: boot a real `McpServer` with `FakeReaders`, bind it to an ephemeral port, then connect a real `StreamableHTTPClientTransport`-backed MCP client and assert `tools/list`/`tools/call` responses.

**Setup/teardown shape to mirror** (`src/test/suite/branchManager.test.ts:12-21` — applies to all mcp*.test.ts files):
```typescript
let tmpDir: string;
let manager: BranchManager;

setup(async () => {
  tmpDir = path.join(os.tmpdir(), `versioncon-branch-mgr-${Date.now()}`);
  // ... fresh deterministic state per test
});

teardown(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  // ... full cleanup
});
```

**For `mcpServer.test.ts`:**
- `setup`: `const { server, port, close } = await startMcpServer({ port: 0, ...fakeReaders })`. Store `close` for teardown.
- `teardown`: `await close()`. Always.
- Test cases: handshake (initialize), `tools/list` returns exactly the 7 expected tool names (SC-3 negative test), each tool call returns non-empty result, every tool has `annotations.readOnlyHint === true` (Pitfall 6).

---

### `src/test/suite/mcpToolsRead.test.ts` (per-tool unit test)

**Analog:** `src/test/suite/bootstrapTokenIssue.test.ts` — per-function unit test with `setup()` + multiple `test()` blocks asserting input/output shape.

**Why this analog:** This is the project's canonical "test one function in isolation, multiple small assertions" pattern. The MCP per-tool tests follow the same shape: register one tool, invoke it via the SDK client with controlled FakeReaders, assert the returned JSON payload.

**Excerpt to mirror** (`src/test/suite/bootstrapTokenIssue.test.ts:32-66`):
```typescript
suite('Phase 7 — token service bootstrap (MD-03 Option A)', () => {
  let secret: Uint8Array;
  let svc: TokenService;

  setup(() => {
    secret = TokenService.newSecret();
    svc = new TokenService(secret);
  });

  test('issueBootstrap returns a JWT-shaped string (three dot-separated segments)', async () => {
    const jwt = await svc.issueBootstrap('vc-abc123def', 'host-member-id-1');
    assert.strictEqual(typeof jwt, 'string');
    assert.ok(jwt.startsWith('eyJ'), 'JWT must start with base64url-encoded header (eyJ)');
    assert.strictEqual(jwt.split('.').length, 3, 'JWT must be three dot-separated segments');
  });

  test('bootstrap JWT carries role:"member" (literal, never "host" — T-07-15)', async () => {
    const jwt = await svc.issueBootstrap('vc-abc123def', 'host-member-id-1');
    const claims = decodeJwt(jwt);
    assert.strictEqual(claims.role, 'member', /* ... */);
  });
});
```

---

### `src/test/suite/mcpReadOnlyGate.test.ts` (source-grep + runtime gate)

**Analog:** `src/test/suite/uriHandlerBootstrapToken.test.ts:24-65` — the canonical source-grep test pattern (read source file, run regex, assert match count).

**Why this analog:** This is the canonical N-XX gate test pattern in the project. Same shape applies to N-08-01..N-08-09.

**Excerpt to mirror** (`src/test/suite/uriHandlerBootstrapToken.test.ts:31-58`):
```typescript
test('extension.ts contains the literal params.get(\'bt\') (bt parser wired)', () => {
  const src = fsSync.readFileSync(extensionTsPath, 'utf-8');
  assert.match(src, /params\.get\(['"]bt['"]\)/,
    'UriHandler must call params.get(\'bt\') to extract the bootstrap JWT from the deep-link');
});

test('extension.ts has NO unredacted appendLine site referencing bt= (T-07-20 source-grep)', () => {
  const src = fsSync.readFileSync(extensionTsPath, 'utf-8');
  const lines = src.split('\n');
  const offenders: string[] = [];
  for (const line of lines) {
    if (/appendLine/.test(line) && /bt=/.test(line) && !/bt=<redacted>/.test(line)) {
      offenders.push(line.trim());
    }
  }
  assert.strictEqual(offenders.length, 0,
    `OutputChannel must NEVER log bt= without redaction. Offenders: ${JSON.stringify(offenders)}`);
});
```

**For `mcpReadOnlyGate.test.ts` — one test per gate (N-08-01..N-08-09):**
- N-08-01: read all files under `src/mcp/`, assert NONE contain `from '.*src/auth'` (read-only structural).
- N-08-02: read all files under `src/mcp/`, assert `READ_ONLY_TOOLS\.has` appears ≥ 1 time.
- N-08-03: read `src/mcp/readers.ts`, assert NO occurrences of `set[A-Z]|push|update|delete|commit` (modulo `setTimeout`/`setInterval` allowance).
- N-08-04: read all files under `src/mcp/`, assert NONE contain `^\s*console\.` (logger discipline).
- N-08-08: read `src/mcp/server.ts`, assert `127\.0\.0\.1|localhost` ≥ 1 AND `0\.0\.0\.0` == 0.
- N-08-09: read `src/mcp/server.ts`, assert `enableDnsRebindingProtection: true` ≥ 1 AND `allowedHosts` ≥ 1.

Plus runtime tests:
- `registerReadOnlyTool` throws when called with a name NOT in `READ_ONLY_TOOLS`.
- `tools/list` over a real MCP client returns EXACTLY the 7 names in `READ_ONLY_TOOLS` (negative test for SC-3).
- Every returned tool has `annotations.readOnlyHint === true` (Pitfall 6).

---

### `src/test/suite/mcpConfigWriter.test.ts` (file-I/O test)

**Analog:** `src/test/suite/branchManager.test.ts:1-21` — tmpdir setup + file-shape assertions.

**Why this analog:** Canonical pattern for "create a tmpdir, write a fixture file, run the function-under-test, assert the file contents". Matches Wave 0 fixture requirements.

**Excerpt to mirror** (`src/test/suite/branchManager.test.ts:7-21`):
```typescript
suite('BranchManager', () => {
  let tmpDir: string;
  let versionconDir: string;
  let manager: BranchManager;

  setup(async () => {
    tmpDir = path.join(os.tmpdir(), `versioncon-branch-mgr-${Date.now()}`);
    versionconDir = path.join(tmpDir, '.versioncon');
    await fs.mkdir(versionconDir, { recursive: true });
    manager = new BranchManager(versionconDir);
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  // ...
});
```

**For `mcpConfigWriter.test.ts`:**
- Test 1: empty `.vscode/mcp.json` → `upsertMcpConfig(folder, 12345)` → file written with `{servers:{versioncon:{type:'http',url:'http://127.0.0.1:12345/mcp'}}}` (shape per RESEARCH §B.3).
- Test 2 (T-08-09 — CRITICAL): `.vscode/mcp.json` with existing Postgres MCP + GitHub MCP entries → `upsertMcpConfig` → all 3 entries present, Postgres + GitHub UNCHANGED byte-for-byte; comments preserved (jsonc-parser contract).
- Test 3: existing `versioncon` entry with stale port → `upsertMcpConfig(folder, 99999)` → updated to new port (Pitfall 3 self-healing).
- Test 4: directory `.vscode/` doesn't exist → `upsertMcpConfig` creates it.
- Test 5: `removeMcpConfig` removes ONLY the `versioncon` entry, leaves sibling entries intact.

---

## Shared Patterns

### Logger discipline (OutputChannel, NO console.*)

**Source:** `src/extension.ts:189-221` lazy-channel-singleton pattern.

**Apply to:** Every file in `src/mcp/` that needs to log (server.ts, lifecycle.ts, registry.ts, every tool handler if logging tool-call timings per RESEARCH §A.6).

**Pattern:**
```typescript
let mcpOutputChannel: vscode.OutputChannel | null = null;
let mcpChannelPushedToSubs = false;

export function getMcpOutputChannel(
  context: vscode.ExtensionContext,
): vscode.OutputChannel {
  if (!mcpOutputChannel) {
    mcpOutputChannel = vscode.window.createOutputChannel('VersionCon: MCP');
  }
  if (!mcpChannelPushedToSubs) {
    context.subscriptions.push(mcpOutputChannel);
    mcpChannelPushedToSubs = true;
  }
  return mcpOutputChannel;
}
```

This channel lives in `src/extension.ts` (the activate-side factory; matches `getGitBridgeOutputChannel` + `getDeepLinkOutputChannel` siblings). The channel is THEN passed to `startMcpServer(context, channel)` and threaded through `buildServer` so individual tool handlers can do `log.appendLine({event:'tool-call', name, ms})` — N-08-04 enforced by source-grep test.

### Async fire-and-forget in `activate()`

**Source:** `src/extension.ts:867-869` `void ensureVersionconExcluded(context).catch(...)`.

**Apply to:** `startMcpServer` invocation from `activate()`. Activation MUST NOT block on network bind / config write.

**Pattern:**
```typescript
void startMcpServer(context, getMcpOutputChannel(context)).catch(err => {
  getMcpOutputChannel(context).appendLine(`[mcp] startup failed: ${String(err)}`);
});
```

### Modal consent prompt with persistent grant

**Source:** `src/extension.ts:301-315` (Phase 7 T-07-10) — Allow/Decline + setting flip.

**Apply to:** `src/mcp/consent.ts` ensureConsent().

Already detailed above; the shared discipline is: prompt copy is a LITERAL constant (testable via source-grep), Allow/Decline are LITERAL strings (NOT i18n keys), `ConfigurationTarget.Global` for the persistent grant.

### Source-grep gate testing

**Source:** `src/test/suite/uriHandlerBootstrapToken.test.ts:31-58` — `fs.readFileSync` + `assert.match` regex.

**Apply to:** Every N-08-XX gate in `src/test/suite/mcpReadOnlyGate.test.ts`.

Pattern is identical to Phase 7's T-07-XX gates — the project has 30+ source-grep gate tests already. Use the same regex-and-assert idiom.

### Fixtures live in `src/test/suite/fixtures/`

**Source:** RESEARCH §1493 prescribes the file structure.

**Apply to:** `fakeReaders.ts` — extract shared test doubles to `fixtures/` so multiple `mcp*.test.ts` files can import them, rather than re-defining stubs in every test file (as `cloudTransportSwapToken.test.ts` does today).

---

## No Analog Found

| File | Role | Data Flow | Reason | Substitute |
|---|---|---|---|---|
| `src/mcp/server.ts` (HTTP/SSE + StreamableHTTPServerTransport bootstrap) | network listener | event-driven | Net-new dependency (`@modelcontextprotocol/sdk`). `relay/src/server.ts` shares the boot-shape but is in `relay/` (forbidden import per N-08-06). | RESEARCH §A.2 canonical SDK excerpt (verbatim copy; modify ONLY to add `enableDnsRebindingProtection` + bind `'127.0.0.1'` + inject OutputChannel logger). |
| `src/mcp/resources/dependencyGraph.ts` (MCP resource template) | resource registration | request-response | MCP resources are a new primitive. No existing URI-template registration in the repo. | RESEARCH §1226-1269 canonical SDK excerpt (verbatim). |

---

## Metadata

**Analog search scope:**
- `src/` (all subdirs)
- `relay/src/` (structural reference ONLY — N-08-06 forbids import)
- `src/test/suite/*.test.ts` (test patterns)
- `.planning/phases/07-cloud-mode-relay-server/07-PATTERNS.md` (format reference)

**Files scanned:** ~30 source files + 8 test files (representative sample).

**Pattern extraction date:** 2026-05-20

**Key patterns identified:**
- ALL controller-style registration files in the project follow "one file, one `register*()` function, takes injected deps, exports the function" — matches `src/commands/aliases.ts`.
- ALL OutputChannels in the project use the lazy-singleton-pushed-to-subscriptions pattern — matches `src/extension.ts:189-221`.
- ALL source-grep gate tests use `fs.readFileSync` + `assert.match` regex — matches `src/test/suite/uriHandlerBootstrapToken.test.ts:31-58`.
- ALL setup-files-on-tmpdir unit tests use `path.join(os.tmpdir(), name-${Date.now()})` + `await fs.rm(...)` teardown — matches `src/test/suite/branchManager.test.ts:7-21`.
- ALL consent prompts use `vscode.window.showInformationMessage` (modal) + `ConfigurationTarget.Global` persistence — matches `src/extension.ts:301-315`.
- ALL type-only interface modules use exclusively `import type` declarations — matches `src/network/Transport.ts:32-33`.
- All `.vscode/`-file mutations in the project today use `JSON.parse`/`JSON.stringify`; Phase 8 MUST deviate to `jsonc-parser.modify`+`applyEdits` for `.vscode/mcp.json` to preserve user comments (RESEARCH §D.1 + Pitfall 4).

## PATTERN MAPPING COMPLETE
