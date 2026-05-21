# Phase 8: AI Agent API (MCP Integration) — Research

**Researched:** 2026-05-21
**Domain:** Model Context Protocol (MCP) server hosting inside a VS Code extension; read-only state exposure to AI coding agents
**Confidence:** HIGH on SDK API surface and VS Code integration (verified against `@modelcontextprotocol/sdk@1.29.0` published 2026-03-30 and VS Code 1.102+ docs); MEDIUM on tool-description "best practice" patterns (verified against GitHub MCP source but no universal spec); HIGH on read-only enforcement design (mirrors Phase 7's locked seam discipline)

## Overview

Phase 8 ships an in-process MCP server inside the VersionCon VS Code extension. The server binds an ephemeral localhost HTTP port via `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk@^1.29.0`, registers seven granular read-only tools and one resource via the SDK's `McpServer.registerTool()`/`registerResource()` APIs with Zod schemas, and auto-writes `.vscode/mcp.json` so VS Code Copilot, Claude Code, Cursor, and Codex can all discover the server with no manual setup beyond extension activation. Read-only enforcement is structural (TypeScript Reader interfaces in `src/mcp/readers.ts` — no `set*`/`push*`/`update*` methods exist on the import surface) AND runtime (a `READ_ONLY_TOOLS` allow-list in `src/mcp/registry.ts` gates every `tools/call` dispatch). Both layers are source-grep-tested under N-08-01..N-08-04. The phase carries forward Phase 7's `OutputChannel` logger discipline, source-grep gate style, and atomic-commit cadence verbatim.

**Primary recommendation:** Pin `@modelcontextprotocol/sdk@^1.29.0`, use `StreamableHTTPServerTransport` with `enableDnsRebindingProtection: true` and `allowedHosts: ['127.0.0.1:<port>']`, bind via `app.listen(0, '127.0.0.1', cb)` and discover the port from `server.address().port`, write `.vscode/mcp.json` via `jsonc-parser.modify()` (preserves user comments and other server entries), reuse Phase 7's first-run consent UX pattern verbatim, and structure the codebase exactly per CONTEXT.md's `src/mcp/` layout — one tool per file.

## A. MCP TypeScript SDK — current API surface

### A.1 Version pin

**Recommendation:** `"@modelcontextprotocol/sdk": "^1.29.0"` in `package.json` dependencies; `"zod": "^3.25.0"` as a co-dependency (the SDK requires zod and imports from `zod/v4` but stays backwards-compatible with `^3.25`).

Verified ground truth (via `npm view @modelcontextprotocol/sdk`):

| Field | Value | Source |
|---|---|---|
| Latest stable | `1.29.0` | npm registry, published 2026-03-30T16:50:42.718Z [VERIFIED: npm view] |
| Required peer | `zod ^3.25 \|\| ^4.0` | npm view exports [VERIFIED] |
| Optional peer | `@cfworker/json-schema ^4.1.1` (for Workers — irrelevant for us) | npm view [VERIFIED] |
| v2 status | Pre-alpha on `main` branch; v1.x is "production-recommended for at least 6 months after v2 ships" | [CITED: https://github.com/modelcontextprotocol/typescript-sdk README] |

**Why pin minor (`^1.29.0`) not patch:** v1.24.0 (Dec 2025) introduced the DNS-rebinding-protection breaking-equivalent change (CVE-2025-66414 mitigation, `enableDnsRebindingProtection` flag); using `^1.29.0` gets us that mitigation by construction. Patch updates remain in scope.

**Why NOT pin `@modelcontextprotocol/server` / `@modelcontextprotocol/client` (the split v2 packages):** The v2 packages exist on npm but are explicitly pre-alpha [CITED: README v1.x branch]. v1 is the production path for at least the next 6 months. Migrating to v2 is a future-phase concern.

### A.2 HTTP/SSE server-transport — canonical bootstrap

**Class name:** `StreamableHTTPServerTransport` (NOT `SseServerTransport` — `SseServerTransport` is the deprecated HTTP+SSE legacy transport and exists only for backwards-compat). `StreamableHTTPServerTransport` covers both pure HTTP and SSE-over-HTTP via the same class. [VERIFIED: https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/src/examples/server/simpleStreamableHttp.ts]

**Imports (verified from v1.x example):**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type {
  CallToolResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import * as z from 'zod/v4';
```

Note: import paths end in `.js` because the SDK's `package.json` exports map is ESM-style with explicit extensions. This works fine in CommonJS via the `require` entry of the exports map [VERIFIED: npm view exports].

**Canonical bootstrap (adapted from `simpleStreamableHttp.ts`):**

```typescript
// src/mcp/server.ts — sketch
import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type * as http from 'node:http';

export interface McpServerHandle {
  port: number;
  url: string;          // "http://127.0.0.1:<port>/mcp"
  close: () => Promise<void>;
}

export async function startMcpServer(opts: {
  buildServer: () => McpServer;
  log: (line: string) => void;
}): Promise<McpServerHandle> {
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const postHandler = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // SECURITY: CVE-2025-66414 mitigation — REQUIRED for localhost HTTP servers
        enableDnsRebindingProtection: true,
        allowedHosts: [`127.0.0.1:${handle.port}`, `localhost:${handle.port}`],
        // Optional: allowedOrigins can be set if we want to gate by Origin header too
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete transports[sid];
      };
      const server = opts.buildServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID' },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  };

  app.post('/mcp', postHandler);
  app.get('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (!sid || !transports[sid]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transports[sid].handleRequest(req, res);
  });
  app.delete('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (!sid || !transports[sid]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transports[sid].handleRequest(req, res);
  });

  const httpServer: http.Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('MCP HTTP server failed to bind');
  }
  const handle: McpServerHandle = {
    port: addr.port,
    url: `http://127.0.0.1:${addr.port}/mcp`,
    close: async () => {
      for (const sid of Object.keys(transports)) {
        try { await transports[sid].close(); } catch { /* noop */ }
        delete transports[sid];
      }
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
  opts.log(`MCP server listening on ${handle.url}`);
  return handle;
}
```

**Decision points wrapped into the snippet:**
- `enableDnsRebindingProtection: true` is **required** for localhost (CVE-2025-66414). Without it, a malicious website could DNS-rebind to our 127.0.0.1 listener. [CITED: https://github.com/advisories/GHSA-w48q-cv73-mx4w]
- `allowedHosts` lists both `127.0.0.1:<port>` and `localhost:<port>` since VS Code's MCP client may use either. Adding the port explicitly to the host string is the SDK's required format.
- `sessionIdGenerator: () => randomUUID()` enables stateful sessions (recommended over stateless mode for our use case — lets us reuse one MCP `Server` instance across an LLM's multi-turn conversation).
- `app.listen(0, '127.0.0.1', cb)` binds IPv4 ONLY. Skipping `'127.0.0.1'` would bind to `::` in Node 17+ (dual-stack IPv6/IPv4) — we explicitly want IPv4 only to satisfy N-08-08 (`grep -c "0.0.0.0" src/mcp/server.ts == 0`).

### A.3 Tool registration API — verified signature

From the canonical `simpleStreamableHttp.ts` v1.x example [VERIFIED]:

```typescript
server.registerTool(
  'greet',                                          // tool name (kebab- or snake-case)
  {
    title: 'Greeting Tool',                         // display name (UI label)
    description: 'A simple greeting tool',          // LLM-facing prompt — the most important field
    inputSchema: {                                  // raw shape object, NOT z.object(...)
      name: z.string().describe('Name to greet'),
    },
    annotations: {                                  // OPTIONAL but high-value for us
      readOnlyHint: true,                           // semantic: clients can surface "[read-only]"
      openWorldHint: false,                         // we don't reach external systems
    },
  },
  async ({ name }, extra): Promise<CallToolResult> => {
    return {
      content: [{ type: 'text', text: `Hello, ${name}!` }],
    };
  },
);
```

**Critical gotcha — `inputSchema` is a raw shape, not `z.object(...)`:** The SDK accepts `{ name: z.string() }` directly. Passing `z.object({ name: z.string() })` is wrong for `registerTool`. The SDK wraps it internally and calls `zod-to-json-schema` to expose the schema over the wire.

**Annotations matter for us:** Every Phase 8 tool MUST set `annotations.readOnlyHint: true`. Clients (Claude Code, Linear MCP, etc.) surface "[read-only]" in their UI based on this hint — SC-3 verification surface.

### A.4 Resource registration API — verified signature

Two forms exist. For our seven tools we'll use the **fixed-URI** form for resource list-discoverability, plus a **template** form for the dep-graph (parameterized by file/symbol).

**Fixed-URI form (verified):**

```typescript
server.registerResource(
  'dependency-graph-root',                          // resource name
  'versioncon-state://dependency-graph',            // fixed URI
  {
    title: 'Dependency Graph (Root)',
    description: 'Browseable entry point...',
    mimeType: 'application/json',
  },
  async (): Promise<ReadResourceResult> => ({
    contents: [{
      uri: 'versioncon-state://dependency-graph',
      mimeType: 'application/json',
      text: JSON.stringify({ /* ... */ }),
    }],
  }),
);
```

**Template form (for parameterized resources):**

```typescript
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

server.registerResource(
  'dependency-graph-symbol',
  new ResourceTemplate('versioncon-state://dependency-graph/{symbolOrPath}', {
    // Optional list() for completion: lets the LLM browse known symbols
    list: undefined,                                 // we'll skip list() in v1 — caps response size
  }),
  {
    title: 'Dependency Graph (Symbol/File)',
    description: 'Symbols/files the target depends ON, plus reverse dependents (1-2 hops).',
    mimeType: 'application/json',
  },
  async (uri, { symbolOrPath }): Promise<ReadResourceResult> => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify(/* ... */),
    }],
  }),
);
```

### A.5 Error model

Two patterns supported, both verified from the SDK source and examples:

1. **Return `{ isError: true, content: [...] }`** — explicit, lets us craft a message:
   ```typescript
   return {
     content: [{ type: 'text', text: `Symbol not found: ${name}` }],
     isError: true,
   };
   ```
2. **Throw** — the SDK catches and converts to `{ isError: true, content: [...err.message] }` automatically.

**Recommendation for Phase 8:** Use the explicit `isError: true` return for the runtime allow-list rejection (so we can log "READ_ONLY_TOOLS gate rejected: <name>" with the exact tool name) and for input-validation failures. Throw only for unexpected runtime errors (e.g. AstAnalyzer disposed mid-call) so unhandled exceptions don't leak stack traces into the model's prompt.

```typescript
// src/mcp/registry.ts — runtime gate sketch
export const READ_ONLY_TOOLS = new Set<string>([
  'get_branch_status',
  'get_sync_status',
  'get_recent_activity',
  'get_chat_log',
  'query_dependencies',
  'list_dependents',
  'advise_sync',
]);

export function registerReadOnlyTool<T extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  meta: { title: string; description: string; inputSchema: T },
  handler: (args: z.objectInputType<T, z.ZodTypeAny>) => Promise<CallToolResult>,
): void {
  if (!READ_ONLY_TOOLS.has(name)) {
    throw new Error(`registerReadOnlyTool: '${name}' not in READ_ONLY_TOOLS allow-list`);
  }
  server.registerTool(
    name,
    { ...meta, annotations: { readOnlyHint: true, openWorldHint: false } },
    async (args, extra) => {
      // Defense-in-depth: re-check the gate at call time. Belt + suspenders.
      if (!READ_ONLY_TOOLS.has(name)) {
        return {
          content: [{ type: 'text', text: `Tool '${name}' is not on the read-only allow-list.` }],
          isError: true,
        };
      }
      return handler(args);
    },
  );
}
```

### A.6 Logging — use OutputChannel, NOT `server.sendLoggingMessage`

The SDK exposes `server.sendLoggingMessage({ level, data }, sessionId)` for sending JSON-RPC `notifications/message` frames to the connected client. But these are LLM-facing log lines that pollute the model's context. For our needs we want **operator-facing** logs that go to VS Code's Output panel.

**Recommendation:** Follow Phase 7's logger discipline exactly. Create `VersionCon: MCP` OutputChannel via the same lazy `getXxxOutputChannel(context)` pattern used by `getGitBridgeOutputChannel` and `getDeepLinkOutputChannel` in `src/extension.ts`. Pass an `appendLine`-style logger function down into `src/mcp/server.ts` and every tool handler.

**N-08-04 source-grep gate enforces this:** `grep -rE '^\s*console\.' src/mcp/ | wc -l` must be 0. The OutputChannel is the only legal log surface. (Note: `src/ast/AstAnalyzer.ts` does use `console.error` — that's pre-existing and outside `src/mcp/`, so it doesn't violate the gate.)

### A.7 Lifecycle hooks

SDK lifecycle surface (verified from v1.x source):

| Hook | Where | Purpose |
|---|---|---|
| `server.connect(transport)` | once at start | Binds the McpServer to the transport |
| `transport.onclose` | per-transport | Fires when a client disconnects — clean up the transports map entry |
| `transport.handleRequest(req, res, body?)` | per HTTP request | The actual JSON-RPC dispatch (Express POST/GET/DELETE handlers call this) |
| `transport.close()` | shutdown | Drain pending requests, close the SSE stream |
| `httpServer.close()` | shutdown | Stop accepting new connections |
| `server.close()` | shutdown | Disconnects all transports bound to this McpServer (rarely used directly — close the HTTP layer instead) |

**Shutdown order:** drain transports → close httpServer → dispose OutputChannel via `context.subscriptions.push(...)`. The example in A.2 wraps all of that in `handle.close()`.

### A.8 Streaming responses — NOT needed in v1

All seven Phase 8 tools return in-memory data with <100ms latency. We do NOT need streaming responses, `experimental.tasks`, or `sendLoggingMessage`-as-progress.

For future expensive tools (e.g. cross-repo analysis): the pattern is `extra.sendNotification({ method: 'notifications/progress', params: {...} })` inside a handler. The SDK supports this without ceremony but the v1 tool catalog doesn't require it.

**[VERIFIED: code snippets from `simpleStreamableHttp.ts` v1.x]**

## B. VS Code MCP integration — programmatic registration

### B.1 API name and stability

**Confirmed name:** `vscode.lm.registerMcpServerDefinitionProvider(providerId, provider)`. Stabilized at **VS Code 1.102+** (mid-2025). [CITED: search results citing Cursor forum + microsoft/vscode issue #243522]

**Project compatibility gap:** `package.json` currently pins `"vscode": "^1.85.0"`. To use the programmatic API we must bump to `"vscode": "^1.102.0"`. This is a phase decision — see B.2.

### B.2 Programmatic registration vs `.vscode/mcp.json` — recommendation

**Recommendation: BOTH, with `.vscode/mcp.json` as primary.**

| Method | Reaches | Pros | Cons |
|---|---|---|---|
| `.vscode/mcp.json` | VS Code Copilot + Claude Code + Cursor + Codex (with adapter) | One artifact, one mental model, version-controllable | Stale entries if extension fails to clean up; user-visible config noise |
| `lm.registerMcpServerDefinitionProvider` | VS Code Copilot ONLY | Auto-cleanup on extension deactivate; no file on disk; no merge-with-user-config concern | VS Code 1.102+ engine bump required; doesn't reach Claude Code / Cursor / Codex |

**Why ship both:** the file-based config is unavoidable because Claude Code et al. don't read VS Code's programmatic registry. The programmatic API is nice-to-have for VS Code Copilot because (a) it sidesteps the `.vscode/mcp.json` merge complexity, (b) it auto-cleans up on extension deactivate, (c) Microsoft is steering this way long-term.

**Phase 8 minimum:** ship `.vscode/mcp.json` writer (covers all 4 target clients). Programmatic registration via `lm.registerMcpServerDefinitionProvider` is a STRETCH item — recommend the planner defer it to a follow-up plan (08-08 or similar) so the v1 phase doesn't carry the VS Code engine bump risk.

**Programmatic registration sketch (for the stretch plan):**

```typescript
// package.json contribution
{
  "contributes": {
    "mcpServerDefinitionProviders": [
      { "id": "versioncon.mcpServer", "label": "VersionCon Collab State" }
    ]
  },
  "engines": { "vscode": "^1.102.0" }   // bumped from ^1.85.0
}

// extension.ts wiring (only enable if vscode.lm.registerMcpServerDefinitionProvider exists — feature-detect)
if (typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function') {
  const provider = vscode.lm.registerMcpServerDefinitionProvider(
    'versioncon.mcpServer',
    {
      provideMcpServerDefinitions: async () => {
        if (!mcpHandle) return [];
        return [new vscode.McpHttpServerDefinition(
          'VersionCon Collab State',
          vscode.Uri.parse(mcpHandle.url),
          {},                                      // no headers — localhost trust boundary
          context.extension.packageJSON.version,
        )];
      },
      resolveMcpServerDefinition: async (s) => s,
    },
  );
  context.subscriptions.push(provider);
}
```

**[CITED: https://code.visualstudio.com/api/extension-guides/ai/mcp + Ken Muse blog with verbatim McpStdioServerDefinition constructor pattern]**

### B.3 `.vscode/mcp.json` schema — verified

```jsonc
{
  "servers": {
    "versioncon": {
      "type": "http",
      "url": "http://127.0.0.1:53412/mcp"
    }
    // user may have other entries here — we MUST preserve them
  }
}
```

[VERIFIED: https://code.visualstudio.com/docs/copilot/reference/mcp-configuration — top-level key is "servers" (object), each entry has "type" (http|sse|stdio) + transport-specific fields.]

- Root key is `servers` (object), NOT `mcpServers` (which is the Cursor/Claude Desktop convention).
- `type: "http"` covers Streamable HTTP. `type: "sse"` exists for legacy SSE servers (we don't need it).
- `headers` field is supported for HTTP entries (we don't need it — localhost).
- The file supports JSONC (comments + trailing commas). IntelliSense is provided by VS Code.

**Cache behavior (NOT documented):** VS Code re-reads `.vscode/mcp.json` on workspace open and on file change (watcher-driven). Restarting Copilot chat picks up changes immediately. No documented stale cache.

### B.4 Other clients — do they read `.vscode/mcp.json`?

| Client | Workspace config path | Reads `.vscode/mcp.json`? | Notes |
|---|---|---|---|
| VS Code Copilot | `.vscode/mcp.json` | Yes (canonical) | [VERIFIED] |
| Claude Code | `.mcp.json` (workspace root) | NO — separate file at repo root | Schema is the same `{ servers: {...} }` shape; can be committed [CITED: https://code.claude.com/docs/en/mcp] |
| Cursor | `.cursor/mcp.json` | NO — separate dir | Different root key in some versions (`mcpServers`); workspace-scoped [CITED: docs.cursor.com] |
| Codex | `.codex/config.toml` (TOML, not JSON) | NO | Different format entirely [CITED: developers.openai.com/codex/mcp] |

**Phase 8 implication:** the CONTEXT.md decision "auto-write `.vscode/mcp.json`" covers VS Code Copilot natively. To reach Claude Code we also need to write `.mcp.json` at workspace root (same JSON shape — trivial). Cursor and Codex are docs-only in v1 (per CONTEXT.md `<deferred>` "dual-config to `~/.claude/...` deferred to user docs").

**Recommendation: write BOTH `.vscode/mcp.json` AND `.mcp.json` (workspace root) on activation.** Same content, both files. Cursor and Codex users get a README snippet they can copy.

**Why not deeper auto-config:** writing `~/.cursor/mcp.json` or `~/.codex/config.toml` from a VS Code extension would (a) require cross-tool environment detection, (b) risk corrupting other tools' configs, (c) violate the "workspace artifacts only" boundary. Defer per CONTEXT.md.

## C. Port allocation + binding

### C.1 Free-port discovery — canonical pattern

```typescript
const httpServer = await new Promise<http.Server>((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const addr = httpServer.address();
if (!addr || typeof addr === 'string') {
  throw new Error('failed to discover MCP port');
}
const port = addr.port;
```

**Verified patterns:**
- `listen(0, ...)` ⇒ kernel-assigned ephemeral port. [VERIFIED: Node.js net docs]
- `server.address()` returns `null` BEFORE the 'listening' event fires. Always read it inside the listen callback. [VERIFIED: nodejs/node issue #40537]
- IPv4 vs IPv6 fallback: Node 17+ defaults to IPv6 (`::`) for `localhost` hostname. **Bind explicitly to `'127.0.0.1'`** (string literal) to force IPv4. This satisfies N-08-08 and avoids confusing MCP clients that resolve `localhost` differently.

### C.2 Port persistence across activations

**Recommendation: always re-allocate.** Do NOT cache the port in `globalState` for re-use.

Rationale:
- The previous port may already be bound (another VS Code window restarted, or another process squatted on it). Reuse logic adds complexity for no gain.
- Re-allocation is fast (<1ms).
- The cost of re-allocation is one `.vscode/mcp.json` rewrite per activation — already on the activation path, near-free.
- A stale port in `.vscode/mcp.json` from a previous window would cause MCP clients to fail-fast on stale config — UX worse than a fresh write.

### C.3 Multi-window collision — confirmed safe

Two VS Code windows on the same machine, same workspace OR different workspaces:
- Each runs its own extension host.
- Each binds its own port via `listen(0, ...)` — kernel ensures uniqueness.
- `.vscode/mcp.json` is workspace-scoped: two windows on different workspaces don't collide.
- Two windows on the SAME workspace: this is rare but real. Last-write-wins on `.vscode/mcp.json`. The first window's port becomes stale in the config file. MCP clients in the first window's chat sessions then fail.

**Mitigation for same-workspace collision:** detect on activation whether another extension instance is the "active mcp config owner" by writing a `.versioncon/mcp-owner.json` with `{ pid, port, writtenAt }` and checking on activation. If another live PID owns the config, log a warning to the OutputChannel and skip the config write. This is a defensive measure — not blocking, but worth a small plan task.

**Alternative (simpler):** accept last-write-wins. Document the limitation in README. Single-workspace-per-window is the dominant use case.

**Recommendation:** ship last-write-wins (simpler), document the limitation, revisit if users hit it. Trade complexity for honesty.

### C.4 `.vscode/mcp.json` committed to git — what happens

Even with re-allocation, if a user has committed `.vscode/mcp.json` with a port (which they shouldn't, but might), pulling that file on a different machine puts a stale port at `http://127.0.0.1:53412/mcp` in the config. Our writer overwrites it on activation, so it's self-healing.

**Recommendation:**
- On activation, ALWAYS overwrite the `versioncon` entry's port with the freshly-allocated value.
- Add a one-line README snippet recommending `.vscode/mcp.json` be in `.gitignore` (the entries are machine-local). Doesn't block; just guidance.

## D. `.vscode/mcp.json` merge semantics

### D.1 Read-modify-write — use `jsonc-parser`

Use `jsonc-parser` (`v3.3.1`, by Microsoft, [VERIFIED: `npm view jsonc-parser`]) for parse-edit-write that **preserves user comments and existing entries**:

```typescript
import { parse, modify, applyEdits } from 'jsonc-parser';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function upsertMcpConfig(
  workspaceFolder: string,
  configPath: string,                // '.vscode/mcp.json' OR '.mcp.json'
  serverName: string,                // 'versioncon'
  url: string,                       // 'http://127.0.0.1:53412/mcp'
): Promise<void> {
  const fullPath = path.join(workspaceFolder, configPath);
  let raw = '';
  try {
    raw = await fs.readFile(fullPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    raw = '{}';
  }
  const parsed = parse(raw) ?? {};
  const _ = parsed; // raw is the source of truth — only used to detect file shape

  // jsonc-parser.modify takes the raw text + a JSON path + a value,
  // returns edit operations that applyEdits then applies onto the raw text.
  // Comments and unrelated keys are PRESERVED.
  const edits = modify(raw, ['servers', serverName], { type: 'http', url }, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });
  const next = applyEdits(raw, edits);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, next, 'utf8');
}
```

[VERIFIED: jsonc-parser `modify` + `applyEdits` API documented in `npm view jsonc-parser` README link.]

### D.2 First-time write — directory creation

`fs.mkdir(path.dirname(fullPath), { recursive: true })` creates `.vscode/` if it doesn't exist. No-op if it does. Standard pattern.

### D.3 Cleanup on extension deactivate

**Recommendation: REMOVE the `versioncon` entry on deactivate.**

```typescript
export async function removeMcpConfig(
  workspaceFolder: string,
  configPath: string,
  serverName: string,
): Promise<void> {
  const fullPath = path.join(workspaceFolder, configPath);
  let raw: string;
  try {
    raw = await fs.readFile(fullPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  const edits = modify(raw, ['servers', serverName], undefined, {});
  // modify(..., undefined, ...) emits a DELETE edit
  const next = applyEdits(raw, edits);
  await fs.writeFile(fullPath, next, 'utf8');
}
```

**Why remove (not leave stale):** a stale entry pointing at a dead port produces "MCP server unreachable" errors in Copilot/Claude Code. Cleaner to remove it and re-add on next activation. The cost is one extra write on shutdown — negligible.

**Caveat:** VS Code deactivate is not guaranteed to run on hard crash. The next-activation overwrite handles that case (the stale entry gets its port replaced).

### D.4 User-edited entry detection

**Recommendation: blind overwrite.** Detecting user edits via a signature/hash adds complexity for marginal gain. The `versioncon` entry is auto-managed by the extension; users who hand-edit it should expect it to be reset. The first-run consent prompt makes this expectation explicit.

If we want to be polite: include a comment in the written entry. `jsonc-parser.modify` preserves comments, so a user-added `// custom edit` next to the entry would survive. But adding comments programmatically is awkward in JSON — skip.

## E. Stdio fallback — NOT needed

Verified — all four clients support HTTP/Streamable HTTP in current versions:

| Client | HTTP/Streamable | Source |
|---|---|---|
| VS Code Copilot 1.95+ | YES | [VERIFIED: code.visualstudio.com/docs/copilot/customization/mcp-servers] |
| Claude Code (2026-Q2) | YES (SSE deprecated in favor of HTTP) | [CITED: systemprompt.io/guides/claude-code-mcp-servers-extensions] |
| Cursor (latest) | YES (Streamable HTTP recommended for new deployments) | [CITED: docs.cursor.com/context/model-context-protocol] |
| Codex CLI | YES (HTTP and stdio both supported) | [CITED: developers.openai.com/codex/mcp] |

**Decision: ship HTTP only.** Stdio fallback adds another transport, a second test matrix, and a process-spawn boundary that defeats the "in-process direct access to SessionHost" advantage. Skip.

If a future client requires stdio (unlikely), it's a straightforward addition — same `McpServer` instance, swap `StreamableHTTPServerTransport` for `StdioServerTransport`. Architectural seam stays clean.

## F. Tool-description writing patterns

Tool descriptions are the actual prompt to the LLM. The MCP spec is silent on best practices, but the de-facto pattern from the GitHub MCP, Postgres MCP, and others has settled on:

### F.1 Surveyed patterns (verified)

**GitHub MCP Server (`pkg/github/issues.go`):** [VERIFIED via raw GitHub source]

| Tool | Description (verbatim) |
|---|---|
| `issue_read` | "Get information about a specific issue in a GitHub repository." |
| `list_issue_types` | "List supported issue types for repository owner (organization)." |
| `add_issue_comment` | "Add a comment to a specific issue in a GitHub repository. Use this tool to add comments to pull requests as well (in this case pass pull request number as issue_number), but only if user is not asking specifically to add review comments." |
| `search_issues` | "Search for issues in GitHub repositories using issues search syntax already scoped to is:issue" |

Pattern: 1 sentence describing what the tool does, optionally with a parenthetical caveat or usage hint. Read tools are tighter than write tools. Annotations consistently set `ReadOnlyHint: true`.

**Postgres MCP (read-only family):** [CITED: crystaldba/postgres-mcp README]

- `list_schemas`: "Lists all database schemas available in the PostgreSQL instance."
- `get_object_details`: "Provides information about a specific database object, for example, a table's columns, constraints, and indexes."

Pattern: 1 sentence, verb-first, includes an example or scope hint.

**MCP spec working group SEP-1382 guidance:** [CITED: github.com/modelcontextprotocol/modelcontextprotocol/issues/1382]

> "Tool descriptions provide high-level functionality explanations while schema descriptions provide parameter-specific details... Avoid parameter-specific details" in tool descriptions; "specify parameter types and constraints" in parameter descriptions.

Reference exemplar from SEP-1382: `read_multiple_files`: *"Read the contents of multiple files simultaneously. More efficient than reading files individually when analyzing or comparing multiple files."* — note the "more efficient" hint encodes a "call this when..." nudge into the description.

### F.2 Template for Phase 8 tool descriptions

```
{Action verb} {object}. {Optional: when-to-call hint OR scope caveat}.
```

- Length: 1–3 sentences. ~15-50 words for the description; longer if the tool's purpose isn't self-evident from the name.
- Tone: declarative present tense ("Returns the current branch state") — matches GitHub MCP, Postgres MCP.
- Include `annotations.readOnlyHint: true` on every Phase 8 tool. Annotations are NOT a substitute for the description but they ARE surfaced separately by clients (Claude Code shows "[read-only]" badge based on the annotation).
- Avoid parameter details. Put those in `inputSchema.<param>.describe(...)`.
- Include scope caveats: "scoped to this user's local view", "limited to last N records".

### F.3 Worked example — `advise_sync`

```typescript
server.registerTool(
  'advise_sync',
  {
    title: 'Sync Advice',
    description:
      'Returns the user\'s current sync state (behind/ahead/dirty) plus a list of predicted conflicts ' +
      'with confidence scores, sourced from the active VersionCon session\'s presence tracking and AST ' +
      'dependency graph. Call this before suggesting a push, before running code, or when asked "am I in ' +
      'sync?". Read-only — never blocks or mutates state. Scoped to the local user\'s view.',
    inputSchema: {
      target_files: z.array(z.string())
        .optional()
        .describe(
          'Optional workspace-relative file paths to scope the conflict prediction. ' +
          'When absent, scopes to all dirty + recently-edited files (typical case).',
        ),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ target_files }) => { /* ... */ },
);
```

### F.4 Recommended descriptions for all seven tools

| Tool | Description (recommended, draft for planner) |
|---|---|
| `get_branch_status` | "Returns the current VersionCon branch name, commits ahead/behind the team's view, and the list of dirty (uncommitted) files. Call this when the user asks about their branch state or before suggesting any sync action. Read-only, scoped to the local user's view." |
| `get_sync_status` | "Returns the last sync timestamp, pending pushes, and any files currently blocked from sync. Call this to detect out-of-sync state before recommending push/pull. Read-only." |
| `get_recent_activity` | "Returns recent team push activity (who pushed, when, which files, optional message). Call this to surface what teammates have changed lately. Defaults to last 20 events; pass `limit` to scope. Read-only." |
| `get_chat_log` | "Returns recent in-extension chat messages including user chat and system events (pushes, branch changes, reviews). Call this for team context or to find a referenced past message. Defaults to last 50 messages; pass `limit` or `since` (ISO timestamp). Read-only — does not send chat messages." |
| `query_dependencies` | "Returns the symbols and files that the given target (file path or symbol name) DEPENDS ON. Forward dependency direction. Default 1 hop; pass `hops: 2` for one-level transitive. Read-only." |
| `list_dependents` | "Returns the symbols and files that DEPEND ON the given target (file path or symbol name). Reverse dependency direction. Default 1 hop. Call this to predict who is affected by changes to a target. Read-only." |
| `advise_sync` | See F.3 above. |

### F.5 Resource description pattern

Resource descriptions follow the same template but include MIME type and a hint about when to use the resource form vs the tool form:

```typescript
server.registerResource(
  'dependency-graph-symbol',
  new ResourceTemplate('versioncon-state://dependency-graph/{symbolOrPath}', { list: undefined }),
  {
    title: 'Dependency Graph (Symbol/File)',
    description:
      'Browseable view of the dependency graph for a specific symbol or file. Returns both forward ' +
      'dependencies (what the target depends on) and reverse dependents (what depends on the target), ' +
      'capped at 1 hop. Use this resource form to drag-and-drop or @-mention dep info into chat; use ' +
      'the query_dependencies / list_dependents tools to call it from a prompt.',
    mimeType: 'application/json',
  },
  /* read handler */
);
```

## G. URI scheme conflict — `versioncon-state://` recommended

### G.1 Analysis

CONTEXT.md flagged the risk. Verified findings:

- `versioncon://` is registered as a UriHandler scheme via `package.json contributes.uriHandlers` in Phase 7. The handler triggers on inbound deep-link URIs like `vscode://versioncon.versioncon/join?...`.
- MCP resource URIs are passed AS JSON STRINGS over the protocol — they are NEVER dispatched to VS Code's UriHandler chain. The resource URI is an MCP identifier, not an OS-level URL.
- A user dragging an MCP resource URI from the AI client INTO VS Code chat is just a string copy; nothing handles it as a deep link.

**However:** the spec is unclear and AI clients are evolving. Some clients (e.g. Claude Code) may shell-out a resource URI to the OS-level URL handler if a user clicks it in a UI. If our resource URI is `versioncon://dependency-graph/foo`, the OS would dispatch it via the macOS Launch Services / Windows shell / Linux desktop file registry — and VS Code's UriHandler would receive it as if it were a deep link.

**Phase 7's UriHandler** validates `uri.path === '/join'` and rejects anything else (verified in `src/extension.ts` line 259). So even if `versioncon://dependency-graph/foo` reached the handler, it would log "Unsupported deep-link path: /dependency-graph/foo" and return. **No security exposure, but noisy logs.**

### G.2 Recommendation

**Use `versioncon-state://` as the MCP resource scheme.** Distinct namespace, zero collision risk, explicit intent (this is read-only state, not a write/action URI). Cost of the rename is zero — no code points to the old scheme yet.

**Example resources:**
- `versioncon-state://dependency-graph` (root, browseable)
- `versioncon-state://dependency-graph/src%2Fhost%2FSessionHost.ts` (file)
- `versioncon-state://dependency-graph/SessionHost.handleAuthRequest` (symbol)

**Encoding rule:** percent-encode any `/` in symbol/path arguments. The MCP `ResourceTemplate` parser will decode the `{symbolOrPath}` capture group, so the handler receives the original `src/host/SessionHost.ts` string.

## H. Test patterns for MCP servers

### H.1 Canonical pattern: boot server + connect client + assert

Use the SDK's own client (`@modelcontextprotocol/sdk/client/index.js`) as a test client. This is the same pattern the SDK itself uses for examples. No mock framework needed.

```typescript
// src/test/suite/mcpServer.test.ts — sketch
import * as assert from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ListToolsResultSchema,
  CallToolResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { startMcpServer } from '../../mcp/server.js';
import { buildServer } from '../../mcp/buildServer.js';
import { fakeReaders } from './fixtures/fakeReaders.js';

suite('Phase 8 — MCP server integration', () => {
  let handle: { url: string; close: () => Promise<void> };
  let client: Client;

  setup(async () => {
    handle = await startMcpServer({
      buildServer: () => buildServer(fakeReaders()),
      log: () => {},
    });
    client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
    const t = new StreamableHTTPClientTransport(new URL(handle.url));
    await client.connect(t);
  });

  teardown(async () => {
    await client.close();
    await handle.close();
  });

  test('tools/list returns exactly the 7 read-only tools', async () => {
    const result = await client.request(
      { method: 'tools/list', params: {} },
      ListToolsResultSchema,
    );
    const names = result.tools.map(t => t.name).sort();
    assert.deepStrictEqual(names, [
      'advise_sync',
      'get_branch_status',
      'get_chat_log',
      'get_recent_activity',
      'get_sync_status',
      'list_dependents',
      'query_dependencies',
    ]);
    // SC-3 negative: assert no write-shaped tools leaked
    for (const t of result.tools) {
      assert.strictEqual(t.annotations?.readOnlyHint, true, `${t.name} missing readOnlyHint`);
    }
  });

  test('tools/call get_branch_status returns the fixture branch', async () => {
    const r = await client.request(
      { method: 'tools/call', params: { name: 'get_branch_status', arguments: {} } },
      CallToolResultSchema,
    );
    assert.strictEqual(r.isError, undefined);
    const payload = JSON.parse(r.content[0].text!);
    assert.strictEqual(payload.branch, 'main');
  });

  test('resources/read versioncon-state://dependency-graph/foo returns shape', async () => {
    const r = await client.request(
      { method: 'resources/read', params: { uri: 'versioncon-state://dependency-graph/src%2Ffoo.ts' } },
      ReadResourceResultSchema,
    );
    assert.strictEqual(r.contents[0].mimeType, 'application/json');
  });
});
```

### H.2 VS Code test harness compatibility

The repo uses `@vscode/test-electron` + `mocha` (verified — `src/test/suite/*.test.ts` files use this pattern). The MCP server lifecycle plays cleanly:

- `setup()` calls `startMcpServer()` — binds ephemeral port via `listen(0, '127.0.0.1', ...)`, ready in <50ms.
- `teardown()` calls `handle.close()` — drains transports, closes HTTP server.
- Port leakage: zero — kernel assigns a fresh port each test. The Mocha process holds the listener until teardown, so concurrent tests in the SAME suite would collide IF they used the same fixed port. With `listen(0)` each gets a unique port.
- VS Code test harness runs each suite in a single Extension Development Host process; tests are serial unless explicitly `Promise.all`'d. No concurrency risk.

### H.3 Test fixtures

Create `src/test/suite/fixtures/fakeReaders.ts` with mock `BranchReader`/`SyncReader`/etc. — deterministic data, no real `SessionHost`. Real-`SessionHost` integration is covered by one cross-cutting test that boots a fake LAN session and asserts the MCP server reads the same state. Keep the bulk of MCP tests pure-fixture for fast iteration.

## I. Sync-advice composite implementation strategy

### I.1 Existing API surface to consume

**File presence (Phase 4):**
- `SessionHost.getPresenceSnapshot(): PresenceInfo[]` (line 2002) — list of `{ memberId, displayName, activeFilePath, ... }`. [VERIFIED: source]
- `SessionHost.getMemberTracking(): Map<memberId, string[]>` (line 2153) — paths each member has open.
- `SessionHost.getMemberNames(): Map<memberId, string>` (line 2158).

**Branch + sync (Phase 3):**
- `BranchManager.getActiveBranch(): Promise<string>` (line 55).
- `BranchManager.listBranches(): BranchInfo[]` (line 71).
- `SyncTracker.getOutOfSyncPaths(): string[]` (line 92).
- `SyncTracker.getLatestPushId(): string \| null` (line 63).
- `PushHistory.getLatestRecord(): PushRecord \| undefined` (line 56).
- `PushHistory.getRecords(): PushRecord[]` (line 42).

**Chat (Phase 4):**
- `ChatLog.getRecent(n: number): ChatRecord[]` (line 106).

**Dependency graph (Phase 5):**
- `AstAnalyzer.analyzeChange(args)` — entry point. NOT a query API; it's invoked from `SessionHost.broadcastPush` to compute affected symbols ON each push.
- `joinImpact(changedSymbolsPerFile, memberReferences, memberDisplayNames, unsupportedLanguages): AnalysisResult` — the pure fn doing the actual symbol-cross-reference join.

**Phase 8 architectural implication:** Phase 5 does NOT expose a standing dependency-graph query API. The graph is computed PER push and stamped onto chat records — there is no `getSymbolDependents(symbolName)` method.

To support `query_dependencies` and `list_dependents` we need a thin **indexer** layer that:
1. Builds a cached symbol/reference index from the workspace files (run on activation + on file change).
2. Exposes `forwardDeps(target): {symbols, files}` and `reverseDeps(target): {symbols, files}` queries.
3. Reuses the same `AstAdapter`s + `joinImpact` logic from Phase 5.

**Recommendation:** create `src/mcp/indexer/DependencyIndex.ts` that wraps Phase 5's adapters and exposes the query API. This is the largest new component in Phase 8 — call it out as a dedicated plan (08-05 or similar).

**Alternative (cheaper for v1):** the `query_dependencies` and `list_dependents` tools can run an ad-hoc analysis on the requested file via `AstFactory.getAdapter(lang).extractReferences()` for each call. Slower (~50-200ms per call) but no index maintenance. **Recommendation: ship the ad-hoc version for v1**, defer the indexer to Phase 8.1 if performance bites. The 100ms latency budget per CONTEXT.md is met (just barely).

### I.2 Composition pattern — single composite tool

**Confirmed: CONTEXT.md's decision is correct.** `advise_sync` SHOULD be one composite tool, not three separate tools.

Rationale:
- Composite reduces LLM round-trips. The most common AI question is "should I sync?" — answering it requires branch + sync + presence + AST in one call. Three round-trips would 3x the tool-call latency and 3x the model's tool-selection overhead.
- The granular sub-tools (`get_branch_status`, `get_sync_status`, `query_dependencies`) already exist for the LLM to drill into specifics. `advise_sync` is the "default" answer for sync questions.
- Composite tool description (F.3) explicitly tells the LLM when to call this vs the sub-tools.

### I.3 Confidence-score calibration

Starting heuristic (planner can refine):

| Source signal | Confidence | Reason |
|---|---|---|
| Peer has file X locked/open AND user is editing file X | 0.9 | Direct collision; likely to conflict |
| Peer pushed change to symbol S; user references S in any file | 0.7 | AST-evidenced impact (Phase 5 `joinImpact` import-bridge) |
| Peer pushed change to file F; user has file F open dirty | 0.6 | File-level overlap, no symbol-level evidence |
| User edited symbol S; symbol S is imported BY a peer's open file | 0.5 | Reverse direction; peer may not have committed reads of S yet |
| User edited file F; F has 2-hop transitive dependents in peer-tracked files | 0.3 | Indirect; 2-hop is noisy in v1 |
| User branch is behind by ≥1 push AND none of the above signals fire | 0.2 | Generic out-of-sync hint |

Confidence is calibrated for **LLM use, not human display.** The model decides whether to surface a warning to the user. 0.9 → strong suggestion to sync first; 0.3 → mention as caveat; 0.2 → ignore unless user explicitly asks.

**Out-of-scope for v1 per CONTEXT.md:** sub-symbol-level confidence (line-level diffs), multi-hop transitive (>1 hop), confidence boosts from edit recency.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AI-01 | Expose extension state via MCP so AI tools (Claude Code, Codex, Cursor, etc.) can understand the system | Sections A, B, C, D — SDK + transport + config write strategy across all 4 target clients |
| AI-02 | AI agents can read: current branch state, sync status, recent activity, chat logs | Section I.1 maps each capability to existing read accessors (`SessionHost.getPresenceSnapshot`, `BranchManager.getActiveBranch`, `PushHistory.getRecords`, `ChatLog.getRecent`); each becomes one tool |
| AI-03 | AI agents can read: dependency graph (what symbols are used where, who depends on what) | Section I.1 + Section G — `query_dependencies`/`list_dependents` tools + `versioncon-state://dependency-graph/{...}` resource, both backed by Phase 5 `AstFactory` adapters and `joinImpact` |
| AI-04 | AI agents understand sync matters — advise on when to sync, flag potential conflicts | Section I.2-I.3 — composite `advise_sync` tool combining state facts + AST-driven conflict predictions + presence-driven file-edit overlap, with calibrated confidence scores |

## Project Constraints (from CLAUDE.md)

| Directive | How Phase 8 honors it |
|---|---|
| "Before using Edit, Write, or other file-changing tools, start work through a GSD command" | Planner enters via `/gsd-plan-phase 8` (already engaged); executor enters via `/gsd-execute-phase 8` — same as Phase 7 |
| "Do not make direct repo edits outside a GSD workflow" | All Phase 8 plan tasks are issued through GSD-controlled execution. No researcher-written code (this doc is the only file the researcher emits) |
| "Technology stack not yet documented... follow existing patterns found in the codebase" | Section A.6 mandates Phase 7's OutputChannel logger pattern; Section H mirrors Phase 7's `@vscode/test-electron` + mocha + source-grep gate test discipline verbatim |
| "Project skills not yet established... follow existing patterns" | All N-08-XX invariants are direct adaptations of Phase 7's T-07-XX gates (read-only-import gate, no-console gate, transport-isolation gate) |

## User Constraints (from CONTEXT.md)

### Locked Decisions (from 08-CONTEXT.md `<decisions>`)

1. **Transport: HTTP/SSE on localhost, in-process** — server runs inside the extension host process, binds an HTTP listener on `127.0.0.1:<auto-port>`. Verified achievable via `StreamableHTTPServerTransport` (Section A.2). Stdio fallback NOT shipped (Section E).
2. **Tool surface: granular tools, not coarse get_context** — seven tools (`get_branch_status`, `get_sync_status`, `get_recent_activity`, `get_chat_log`, `query_dependencies`, `list_dependents`, `advise_sync`) plus the `versioncon-state://dependency-graph/{...}` resource. Tool descriptions follow GitHub-MCP / Postgres-MCP / SEP-1382 pattern (Section F).
3. **Read-only enforcement: structural + runtime, both source-grep gated** — `src/mcp/readers.ts` types (Layer 1) + `READ_ONLY_TOOLS` allow-list (Layer 2). Gate definitions in CONTEXT.md `<gates_and_invariants>` are kept verbatim as N-08-01..N-08-08.
4. **Dependency-graph access: query API, not full dump** — `query_dependencies` + `list_dependents` with 1-hop default. Section I.1 specifies ad-hoc analysis via Phase 5 adapters for v1 (no standing index); defer indexer to 8.1 if perf bites.
5. **Activation lifecycle: always-on, port auto-allocated, config auto-written with one-time consent** — Section C.2 confirms re-allocate per activation. Consent UX mirrors Phase 7 UriHandler T-07-10 pattern (verified in `src/extension.ts` line 304 — `showInformationMessage` BEFORE side effects).
6. **Sync-advice: factual state + heuristic conflict prediction, never blocks** — Section I.2-I.3 specifies composite tool + confidence calibration. Returns `{state, predicted_conflicts[]}` as locked in CONTEXT.md.

### Claude's Discretion (from CONTEXT.md `<open_questions_for_research>` — now resolved)

| Open question | Resolution (this research) |
|---|---|
| MCP TS SDK current API surface | Section A — pin `@modelcontextprotocol/sdk@^1.29.0`; `StreamableHTTPServerTransport`; `registerTool` + `registerResource` shapes verified |
| VS Code MCP programmatic registration API | Section B — `vscode.lm.registerMcpServerDefinitionProvider` (stable in 1.102+). Recommend `.vscode/mcp.json` as primary; programmatic as deferred stretch plan |
| Port collision strategy | Section C — always re-allocate via `listen(0)`; always rewrite `.vscode/mcp.json`; document last-write-wins on same-workspace double-window |
| `.vscode/mcp.json` merge semantics | Section D — use `jsonc-parser@3.3.1` `modify()` + `applyEdits()` for safe read-modify-write that preserves user comments and other server entries |
| Stdio fallback for AI clients that don't support HTTP/SSE | Section E — NOT needed. All four target clients support HTTP/Streamable HTTP in current versions |
| Tool description writing patterns | Section F — surveyed GitHub MCP, Postgres MCP, SEP-1382. Template + draft descriptions for all 7 tools provided |
| Resource URI scheme conflicts | Section G — use `versioncon-state://` (not `versioncon://`). Distinct namespace, zero collision with Phase 7 UriHandler. Verified safe |

### Deferred Ideas (OUT OF SCOPE — from CONTEXT.md `<deferred>`)

- AI write API (push, branch-create, sync-trigger, chat-send from agent)
- MCP prompts primitive
- OAuth / bearer-token auth on the MCP server (defense-in-depth-in-layers — same as Phase 7's L4 deferral)
- Cross-machine MCP federation
- Reading remote cloud-mode session state via MCP
- Telemetry / observability on MCP tool calls
- Streaming / long-running tools
- Auto-discovery / auto-config of non-VS-Code AI clients beyond writing `.vscode/mcp.json` + `.mcp.json`
- Sub-symbol-level conflict prediction
- Multi-hop transitive impact (>1 hop) in `advise_sync`
- Auto-execution of advisory output (any write op)

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| HTTP/SSE listener + JSON-RPC framing | Extension Host (Node) | — | MCP `StreamableHTTPServerTransport` runs inside the extension host process for direct in-memory access to `SessionHost`, `BranchManager`, `AstFactory` |
| Tool/resource registration + dispatch | Extension Host (Node) | — | MCP `McpServer` instance lives in the same process; READ_ONLY_TOOLS gate runs here |
| Read access to branch/sync/chat/presence state | Extension Host (Node) | — | All state lives in `SessionHost`/`BranchManager`/`ChatLog`/`PushHistory`/`SyncTracker` in the host process; no remote calls |
| Dependency-graph queries (`query_dependencies` / `list_dependents`) | Extension Host (Node, main thread) | Child process (AstWorker for re-parse) | Tool handlers reuse Phase 5's `AstFactory` adapters; the existing AstWorker child process handles WASM parsing per Phase 5 T-05-01 |
| `.vscode/mcp.json` + `.mcp.json` write/cleanup | Extension Host (Node) | OS filesystem | `jsonc-parser.modify` + `applyEdits` on the workspace folder; user grants consent once via VS Code modal |
| First-run consent prompt | VS Code UI (`window.showInformationMessage`) | Workspace config persistence | Mirrors Phase 7 UriHandler T-07-10 pattern verbatim |
| MCP client connection (Claude Code, Copilot, Cursor, Codex) | External AI client process | — | NOT our tier — they connect TO our listener over HTTP. Our job ends at the WSS handshake / Streamable HTTP POST response |
| Programmatic MCP server registration (stretch) | VS Code Extension API (`vscode.lm`) | — | Only available to VS Code Copilot; requires `engines.vscode ^1.102.0` bump. Deferred to follow-up plan |

## Standard Stack

### Core (NEW for Phase 8)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@modelcontextprotocol/sdk` | `^1.29.0` | MCP server + client (we use server only) | Official TS SDK; v1.x is production-recommended per maintainers [VERIFIED: npm + GitHub] |
| `zod` | `^3.25.0` | Tool input-schema validation | Required peer dep of SDK; SDK imports `zod/v4` but stays backwards-compatible [VERIFIED] |
| `jsonc-parser` | `^3.3.1` | Read-modify-write of `.vscode/mcp.json` and `.mcp.json` preserving user comments | Microsoft official, used by VS Code internally for `settings.json` editing [VERIFIED: npm + microsoft/node-jsonc-parser] |
| `express` | `^4.19.0` or `^5.0.0` | HTTP server wrapper around `StreamableHTTPServerTransport` | The SDK ships an `@modelcontextprotocol/sdk/server/express` helper that expects Express; matches the canonical `simpleStreamableHttp.ts` pattern [VERIFIED] |

### Supporting (already in package.json — reused)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vscode` (engines) | `^1.85.0` (current) | Extension API for OutputChannel, settings, modal | Reused for consent UX, OutputChannel logger, `getConfiguration('versioncon.mcp')` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `StreamableHTTPServerTransport` | `StdioServerTransport` | Stdio would require spawning a child process — loses direct in-memory `SessionHost` access. Disqualified per CONTEXT.md |
| `jsonc-parser` | Naive `JSON.parse`/`JSON.stringify` | Lossy: destroys user comments and re-formats whitespace. Unfriendly. Reject |
| `jsonc-parser` | `comment-json` | Both valid; `jsonc-parser` is Microsoft-maintained and preferred by VS Code's own settings code. Pick Microsoft's |
| `express` | `fastify` or `node:http` | The SDK's canonical example uses Express; switching frameworks adds friction for marginal gain. Stick with Express |
| `@modelcontextprotocol/sdk@^1.29.0` | `@modelcontextprotocol/server` (v2 split package) | v2 is pre-alpha; production-recommended is v1. Defer migration |

**Installation:**

```bash
npm install @modelcontextprotocol/sdk@^1.29.0 zod@^3.25.0 jsonc-parser@^3.3.1 express@^5.0.0
npm install --save-dev @types/express
```

**Version verification (per researcher discipline):**

| Package | Pinned version | Publish date | Source |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | `1.29.0` | 2026-03-30 | `npm view @modelcontextprotocol/sdk version time` [VERIFIED] |
| `zod` | `3.25.x` (peer; SDK imports `zod/v4` namespace within) | Multiple versions current | Peer dep declared by SDK [VERIFIED] |
| `jsonc-parser` | `3.3.1` | (per npm) | `npm view jsonc-parser version` [VERIFIED] |
| `express` | `5.x` (or `4.x` — both work with the SDK's example) | Stable | npm registry — `5.x` matches the SDK's own example dep |

## Architecture Patterns

### System Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│  AI Client process (Claude Code / Copilot / Cursor / Codex)              │
│  reads .vscode/mcp.json OR .mcp.json → opens HTTP connection             │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │  HTTP POST/GET/DELETE /mcp
                               │  Origin/Host header check (DNS rebinding gate)
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  VS Code Extension Host process (single OS-level process per workspace)  │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ src/mcp/server.ts (Express + StreamableHTTPServerTransport)         │ │
│  │   • binds 127.0.0.1:<ephemeral-port> via app.listen(0)              │ │
│  │   • enableDnsRebindingProtection + allowedHosts                     │ │
│  │   • per-session transport map keyed by mcp-session-id header        │ │
│  └────────────────────────┬────────────────────────────────────────────┘ │
│                           │ JSON-RPC dispatch                            │
│                           ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ src/mcp/registry.ts                                                 │ │
│  │   • READ_ONLY_TOOLS allow-list (Layer 2 runtime gate)               │ │
│  │   • registerReadOnlyTool() factory enforces annotations.readOnlyHint│ │
│  └────────────────────────┬────────────────────────────────────────────┘ │
│                           │                                              │
│                           ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ src/mcp/tools/*.ts (7 files, one per tool)                          │ │
│  │   getBranchStatus  getSyncStatus  getRecentActivity  getChatLog     │ │
│  │   queryDependencies  listDependents  adviseSync                     │ │
│  │                                                                     │ │
│  │ src/mcp/resources/dependencyGraph.ts                                │ │
│  │   versioncon-state://dependency-graph/{symbolOrPath}                │ │
│  └────────────────────────┬────────────────────────────────────────────┘ │
│                           │ reads ONLY via Reader interfaces             │
│                           ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ src/mcp/readers.ts (type-only — Layer 1 structural gate)            │ │
│  │   BranchReader  SyncReader  ActivityReader  ChatReader              │ │
│  │   DependencyReader  PresenceReader                                  │ │
│  └────────────────────────┬────────────────────────────────────────────┘ │
│                           │ implemented by adapters that wrap...         │
│                           ▼                                              │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ EXISTING (Phase 3/4/5) state surfaces — read-only consumers only │    │
│  │   SessionHost.getPresenceSnapshot / getMemberTracking            │    │
│  │   BranchManager.getActiveBranch / listBranches                   │    │
│  │   PushHistory.getRecords / getLatestRecord                       │    │
│  │   SyncTracker.getOutOfSyncPaths / getLatestPushId                │    │
│  │   ChatLog.getRecent                                              │    │
│  │   AstFactory.getAdapter + joinImpact (ad-hoc for v1)             │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ src/mcp/lifecycle.ts                                                │ │
│  │   • activate() — consent check → start server → write configs       │ │
│  │   • deactivate() — close transports → close httpServer → remove cfg │ │
│  │ src/mcp/mcpConfig.ts                                                │ │
│  │   • upsertMcpConfig(.vscode/mcp.json) via jsonc-parser              │ │
│  │   • upsertMcpConfig(.mcp.json) via jsonc-parser                     │ │
│  │   • removeMcpConfig(...) on deactivate                              │ │
│  │ src/mcp/consent.ts                                                  │ │
│  │   • first-run vscode.window.showInformationMessage prompt           │ │
│  │   • persists versioncon.mcp.consent setting                         │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

See "File Structure Recommendation" section below for the exact tree.

### Pattern 1: Read-only factory

```typescript
// src/mcp/registry.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';

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

### Pattern 2: Reader interface (Layer 1 structural gate)

```typescript
// src/mcp/readers.ts — type-only file, NO runtime imports
import type { BranchInfo, PushRecord, ChatRecord, PresenceInfo } from '../types/...';

export interface BranchReader {
  getActiveBranch(): Promise<string>;
  listBranches(): readonly BranchInfo[];
}

export interface SyncReader {
  getOutOfSyncPaths(): readonly string[];
  getLatestPushId(): string | null;
}

export interface ActivityReader {
  getRecentPushes(limit: number): readonly PushRecord[];
}

export interface ChatReader {
  getRecent(limit: number): readonly ChatRecord[];
}

export interface DependencyReader {
  forwardDeps(target: string, hops: 1 | 2): Promise<{ symbols: string[]; files: string[] }>;
  reverseDeps(target: string, hops: 1 | 2): Promise<{ symbols: string[]; files: string[] }>;
}

export interface PresenceReader {
  getPresenceSnapshot(): readonly PresenceInfo[];
  getMemberTracking(): ReadonlyMap<string, readonly string[]>;
}
```

**Critical contract:** NO method on a Reader interface mutates state. NO method name matches `set*` / `push*` / `update*` / `delete*`. N-08-03 source-grep gate enforces this.

### Anti-Patterns to Avoid

- **DON'T import `SessionHost` directly from `src/mcp/tools/*.ts`** — that exposes the full mutable surface. Always go through a Reader-typed parameter.
- **DON'T use `console.log/error` in `src/mcp/`** — violates N-08-04. Use the injected `log` function that wraps an OutputChannel.
- **DON'T cache the MCP port in extension globalState** — always re-allocate per Section C.2. Stale ports break MCP clients.
- **DON'T write `.vscode/mcp.json` with `JSON.stringify`** — destroys user comments and other server entries. Use `jsonc-parser.modify` + `applyEdits`.
- **DON'T import from `src/auth/` in `src/mcp/`** — N-08-01 gate. The MCP server has no business knowing about JWTs or auth tokens.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MCP protocol framing | Custom JSON-RPC dispatcher | `@modelcontextprotocol/sdk` `McpServer` + `StreamableHTTPServerTransport` | SDK handles initialize handshake, capability negotiation, session IDs, SSE streaming, version negotiation. Rolling our own is weeks of work for protocol bugs |
| JSON-with-comments parsing | Custom JSONC parser or strict `JSON.parse` | `jsonc-parser` | VS Code uses it internally; preserves comments and formatting on edit |
| Schema validation for tool inputs | Hand-written type guards | `zod` (already a peer dep of SDK) | SDK auto-converts zod schemas to JSON Schema for tool advertisement |
| Free-port allocation | Port-scanning loop | `server.listen(0, '127.0.0.1', ...)` | Kernel-assigned ephemeral port is race-free and atomic |
| First-run consent UX | Custom webview prompt | `vscode.window.showInformationMessage(...)` modal | Phase 7 UriHandler T-07-10 already established this pattern; reuse |
| Workspace config writer | Custom file mutex / atomic rename | `jsonc-parser.modify` + `fs.writeFile` | The .vscode/ dir already exists in well-behaved workspaces; concurrent writes are rare and the workspace owns the file |
| Dep-graph query engine | Custom symbol indexer | Reuse Phase 5 `AstFactory.getAdapter` + `joinImpact` (ad-hoc) | Phase 5 already ships the parsing and join logic; v1 calls them per-query, defer indexing to 8.1 if perf bites |
| In-process MCP client (for tests) | Custom test transport | `@modelcontextprotocol/sdk/client` + `StreamableHTTPClientTransport` | The SDK ships a complete client; using it doubles as a contract test against the protocol |

**Key insight:** the MCP protocol surface is large (initialize, capabilities, tools/list, tools/call, resources/list, resources/read, notifications/*, server-side logging, progress, sessions). The SDK encapsulates all of it. Phase 8's job is to be a thin tools+resources adapter on top — not a protocol implementation.

## Runtime State Inventory

Phase 8 is greenfield code in `src/mcp/**` — there is no pre-existing runtime state to migrate (no stored data with the new format, no external services to reconfigure, no OS registrations to update). **The phase creates NEW config files (`.vscode/mcp.json` + `.mcp.json`) but does not migrate or rename any existing data.** Section omitted by design — this is a greenfield phase, not a rename/refactor.

## Common Pitfalls

### Pitfall 1: Forgetting `enableDnsRebindingProtection`

**What goes wrong:** A malicious website can DNS-rebind to our 127.0.0.1 listener and call our MCP tools on behalf of the user's browser.
**Why it happens:** SDK default is OFF (backwards-compat). Easy to forget on localhost servers.
**How to avoid:** Always pass `{ enableDnsRebindingProtection: true, allowedHosts: [...] }` to `StreamableHTTPServerTransport`. Make it a per-task verification step.
**Warning signs:** No source-grep gate hit on `enableDnsRebindingProtection` in `src/mcp/server.ts`. Add as N-08-09 (recommended).
**Source:** [CITED: https://github.com/advisories/GHSA-w48q-cv73-mx4w]

### Pitfall 2: Binding to `localhost` instead of `127.0.0.1`

**What goes wrong:** Node 17+ resolves `localhost` to IPv6 (`::1`) by default. MCP clients that resolve `localhost` to IPv4 fail to connect ("connection refused" on the wrong stack).
**Why it happens:** SDK examples sometimes show `localhost` strings; Node behavior changed in 17.
**How to avoid:** Always bind to the literal IPv4 string `'127.0.0.1'`. Test on Node 18+ (modern VS Code uses Node 20+).
**Warning signs:** Sporadic test failures on machines with IPv6 disabled. Connection refused from MCP clients.

### Pitfall 3: Stale `.vscode/mcp.json` after deactivate-without-cleanup

**What goes wrong:** Extension deactivates, port dies, MCP entry stays. User opens chat next day, sees "MCP server unreachable."
**Why it happens:** Forgetting to call `removeMcpConfig` in `deactivate()`. Or hard crashes bypassing `deactivate()`.
**How to avoid:** Wire `removeMcpConfig` into `deactivate()`. On activation, ALWAYS overwrite the entry with the fresh port (self-healing).
**Warning signs:** Users report "MCP server unreachable" in clean states.

### Pitfall 4: Hand-overwriting `.vscode/mcp.json` instead of merging

**What goes wrong:** User has Postgres MCP, GitHub MCP, etc. configured. Our extension wipes them all on activation.
**Why it happens:** Naive `JSON.stringify({ servers: { versioncon: {...} } })`.
**How to avoid:** Use `jsonc-parser.modify(rawText, ['servers', 'versioncon'], value, opts)` and `applyEdits`. Section D.1.
**Warning signs:** Issue reports along the lines of "extension deleted my Postgres MCP entry."

### Pitfall 5: Tool descriptions written for humans, not LLMs

**What goes wrong:** Descriptions like "Returns the branch" — too terse. LLM doesn't know when to call.
**Why it happens:** Engineer writes for code-review reader, not for the LLM's tool-selection inference.
**How to avoid:** Follow Section F template. Include "Call this when..." cues. Include scope caveats. Cite GitHub MCP / Postgres MCP examples for tone.
**Warning signs:** AI agents skip the tool when it would have been the right answer, or call it for the wrong question.

### Pitfall 6: Forgetting `readOnlyHint: true` annotations

**What goes wrong:** Claude Code / Linear MCP UI shows our tools without the "[read-only]" badge. Users get nervous; SC-3 verification weaker.
**Why it happens:** `annotations` is optional in the SDK. Easy to skip.
**How to avoid:** `registerReadOnlyTool` factory (Pattern 1) sets the annotation by construction. The factory is the only entry point; bypassing it fails the `READ_ONLY_TOOLS.has()` check.
**Warning signs:** Tool-discovery test (Section H.1) asserts `result.tools[i].annotations.readOnlyHint === true` for every tool — fail loud at test time.

### Pitfall 7: Re-fetching the dependency graph on every `query_dependencies` call

**What goes wrong:** Each call re-parses every workspace file via tree-sitter. 200ms+ per call. CONTEXT.md's "<100ms in-memory" budget broken.
**Why it happens:** Phase 5 doesn't expose a query API — only an analyze-on-push API.
**How to avoid:** v1: cap to single-file analysis per call (parse only the requested file's imports + references). Defer the full standing index to Phase 8.1. Measure in tests.
**Warning signs:** `query_dependencies` test takes >500ms on small fixtures.

## Code Examples

### Tool handler — `get_branch_status` (canonical)

```typescript
// src/mcp/tools/getBranchStatus.ts
// Source: SDK v1.x simpleStreamableHttp.ts pattern + Section I.1 readers
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

### Resource handler — dep-graph template

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

### Consent prompt (mirrors Phase 7 UriHandler T-07-10)

```typescript
// src/mcp/consent.ts
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

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| HTTP+SSE legacy transport (`SseServerTransport`) | `StreamableHTTPServerTransport` | MCP 2024-11 spec update | We use the new transport; legacy SSE only for backwards-compat scenarios we don't need |
| `lm.registerMcpServerDefinitionProvider` proposed API | Stable in VS Code 1.102+ | Mid-2025 stabilization | Programmatic registration is now safe — but requires bumping engines.vscode |
| MCP tools as the only primitive | Tools + Resources + Prompts | MCP 2024-11 spec | We use Tools (LLM calls) + Resources (browseable); skip Prompts per CONTEXT |
| DNS rebinding "best practice" docs | Mandatory `enableDnsRebindingProtection` flag (default-off but called out in SDK 1.24+ docs) | SDK 1.24.0 (Dec 2025) — CVE-2025-66414 mitigation | We MUST set this flag explicitly for localhost servers |
| `@modelcontextprotocol/sdk` (single package, v1.x) | Split `@modelcontextprotocol/server` + `/client` (v2, pre-alpha) | v2 on `main`, ETA Q1 2026 stable | We pin v1.x; defer v2 migration |

**Deprecated/outdated:**
- HTTP+SSE legacy transport (`SseServerTransport`): use `StreamableHTTPServerTransport` for new servers
- `@modelcontextprotocol/sdk` v2 pre-alpha: not for production
- Manual JSON parse-and-rewrite of mcp.json: use `jsonc-parser`

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|---|---|---|
| A1 | Claude Code reads workspace-root `.mcp.json` with the same `{servers: {...}}` shape as VS Code's `.vscode/mcp.json` | B.4, D | If Claude Code requires a different shape (e.g. `mcpServers` root key), our writer covers only VS Code Copilot. Mitigation: README documents the override; user copy-pastes |
| A2 | The SDK's `StreamableHTTPServerTransport` works with Express `5.x` exactly as it does with `4.x` (the SDK's example uses 5.x in 1.29 era; older deps may still be 4.x in some repos) | A.2 | If Express 5 breaks, fall back to 4.19. Both are fine; no real risk |
| A3 | The `mcpServerDefinitionProviders` contribution point in `package.json` is stable as of VS Code 1.102+ | B.2 | If still proposed-API only, fall back to `.vscode/mcp.json` only (already our primary). Programmatic registration is a stretch, not the critical path |
| A4 | Phase 5's `AstFactory.getAdapter` and `joinImpact` work for ad-hoc per-query analysis (single-file, no batch) — they're designed for push-time but the logic is symbol-level so any single file should parse | I.1 | If per-call latency is >500ms on large files, we ship a standing index in 8.1 |
| A5 | The user's workspace folder is always available via `vscode.workspace.workspaceFolders[0].uri.fsPath` when the extension activates and the MCP server should start (i.e. the extension never starts the MCP server in workspace-less mode) | D | If the user opens a single file without a folder, the MCP write would fail. Mitigation: skip MCP startup when no workspace folder; log to OutputChannel; user re-opens via folder |

**Empty assumptions table check:** non-empty (5 items). Planner must confirm A1 (Claude Code config shape) and A4 (Phase 5 per-call latency) before finalizing plans — both are low-effort validations.

## Open Questions

All seven core research questions from CONTEXT.md are resolved (see "Claude's Discretion" mapping table above). Remaining open items the planner should address — none are blocking:

1. **Should `versioncon.mcp.consent` be Global or Workspace scope?** Tradeoff: Global = user grants once for all workspaces, simpler UX; Workspace = per-project trust grant, finer-grained. Phase 7's consent for UriHandler is currently global (single-prompt-per-machine). Recommend Global for consistency. **Planner decision.**
2. **`get_chat_log(since?)` — `since` as ISO timestamp string or epoch ms number?** ISO is friendlier to LLMs; epoch ms is friendlier to test code. Recommend ISO. **Planner decision; trivial.**
3. **`query_dependencies` on a symbol that exists in multiple files (e.g. method name collision)** — return all candidates or fail? Recommend return all with a `disambiguation: [{ file, kind }]` field. **Planner decision; affects schema.**
4. **VS Code engine bump from `^1.85.0` to support programmatic registration** — IF the planner chooses to ship `lm.registerMcpServerDefinitionProvider` in v1, the bump to `^1.102.0` is required. The cost is low (most modern VS Code installs are well past 1.102 by mid-2026), but it's an explicit decision. **Planner decision.**

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js (extension host) | Everything | ✓ | Bundled with VS Code 1.85+ (Node 18+); 1.102+ ships Node 20+ | — |
| `@modelcontextprotocol/sdk` | All MCP code | ✗ (not installed yet) | `^1.29.0` to add | — |
| `zod` | Tool input schemas | ✗ (not installed yet) | `^3.25` to add (peer of SDK) | — |
| `jsonc-parser` | `.vscode/mcp.json` writer | ✗ (not installed yet) | `^3.3.1` to add | Fallback to lossy JSON.stringify — degraded UX, accept |
| `express` | HTTP server wrapper | ✗ (not installed yet) | `^4.19` or `^5.0` to add | Fallback to `node:http` raw — possible but more code |
| VS Code MCP support (Copilot) | SC-1 verification | ✓ | 1.95+ (we pin 1.85 — Copilot users will be on 1.95+ in practice) | — |
| Phase 5 AstFactory + joinImpact | `query_dependencies`, `list_dependents`, `advise_sync` | ✓ | Shipped (Phase 5 Wave 4 — commits 754c0e8..7d4d75b) | — |
| Phase 4 PresenceMap + ChatLog | `get_chat_log`, presence-driven `advise_sync` | ✓ | Shipped (Phase 4 — commit a420eb5) | — |
| Phase 3 BranchManager + SyncTracker + PushHistory | `get_branch_status`, `get_sync_status`, `get_recent_activity` | ✓ | Shipped (Phase 3) | — |
| Phase 7 OutputChannel logger pattern | N-08-04 enforcement | ✓ | Shipped (Phase 7 commits b0fa... — `getDeepLinkOutputChannel`, `getGitBridgeOutputChannel`) | — |

**Missing dependencies with no fallback:** none — all four npm packages install cleanly via npm; all upstream phases are complete.

**Missing dependencies with fallback:** all four npm packages need `npm install` as a first-task step.

## Validation Architecture

> Workflow `nyquist_validation: true` in `.planning/config.json`. Section required.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Mocha (via `@vscode/test-electron` + `@vscode/test-cli`) — existing repo convention; ~70 test files already use it |
| Config file | `.vscode-test.mjs` (workspace root, existing) |
| Quick run command | `npm test -- --grep "Phase 8"` (Mocha grep against suite names) |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AI-01 | Boot server → connect SDK client → `tools/list` returns ≥7 tools | integration | `npm test -- --grep "Phase 8 — MCP server integration"` | ❌ Wave 0 |
| AI-01 | `.vscode/mcp.json` write contains `servers.versioncon.url` pointing at bound port | integration | `npm test -- --grep "mcpConfig merges existing entries"` | ❌ Wave 0 |
| AI-01 | `.vscode/mcp.json` write PRESERVES existing entries (postgres, github) under `servers.*` | integration | same suite | ❌ Wave 0 |
| AI-01 | `enableDnsRebindingProtection: true` set + allowedHosts populated on every transport (source-grep) | structural | `npm test -- --grep "N-08-09 DNS rebinding protection"` (new gate) | ❌ Wave 0 |
| AI-02 | `tools/call get_branch_status` returns `{branch, ahead, behind, dirty}` matching fixture state | integration | same MCP suite, per-tool tests | ❌ Wave 0 |
| AI-02 | `tools/call get_chat_log limit=5` returns last 5 ChatRecord items in reverse-chrono order | integration | same | ❌ Wave 0 |
| AI-02 | `tools/call get_recent_activity` returns last N PushRecords from PushHistory fixture | integration | same | ❌ Wave 0 |
| AI-02 | `tools/call get_sync_status` returns `{last_sync_at, pending_pushes, blocked}` from SyncTracker fixture | integration | same | ❌ Wave 0 |
| AI-03 | `tools/call query_dependencies` on a fixture file returns its imports (1 hop) | integration | same | ❌ Wave 0 |
| AI-03 | `tools/call list_dependents` on a fixture symbol returns files that import it | integration | same | ❌ Wave 0 |
| AI-03 | `resources/read versioncon-state://dependency-graph/<symbol>` returns `{target, forward, reverse}` | integration | same | ❌ Wave 0 |
| AI-04 | `tools/call advise_sync` with out-of-sync fixture returns `predicted_conflicts.length > 0` AND at least one with confidence > 0.5 | integration | same | ❌ Wave 0 |
| AI-04 | `tools/call advise_sync` with in-sync fixture returns `predicted_conflicts.length === 0` | integration | same | ❌ Wave 0 |
| AI-04 | `advise_sync` returned `state.behind > 0` when SyncTracker has out-of-sync paths | integration | same | ❌ Wave 0 |
| SC-1 | "no manual setup beyond enabling the extension" — verified by activation test that asserts `.vscode/mcp.json` exists with `versioncon` entry after activate() | integration | `npm test -- --grep "extension activate writes mcp.json"` | ❌ Wave 0 |
| SC-2 | "AI agent can read the full dependency graph" — combined: `query_dependencies` + `list_dependents` + resource read all backed by real Phase 5 AstFactory call on a small fixture repo | integration | dedicated SC-2 suite | ❌ Wave 0 |
| SC-3 | "AI agents cannot push, create branches, or modify shared state" — `tools/list` response has NO write-shaped tool names (positive list assertion); structural N-08-01/02/03 source-grep gates pass | structural + integration | N-08-01..03 source-grep tests + tools/list whitelist assertion | ❌ Wave 0 |
| SC-3 | `READ_ONLY_TOOLS.has(name)` runtime gate rejects an injected fake-write attempt (synthetic test) | integration | dedicated "runtime allow-list rejects unknown" test | ❌ Wave 0 |
| SC-4 | End-to-end: synthetic out-of-sync workspace → `advise_sync` → assert LLM-readable advisory mentions sync gap + ≥1 predicted conflict | integration | dedicated SC-4 e2e suite | ❌ Wave 0 |
| N-08-01 | `grep -rE 'import.*from.*src/auth' src/mcp/ | wc -l` == 0 | source-grep | `npm test -- --grep "N-08-01"` | ❌ Wave 0 |
| N-08-02 | `grep -c 'READ_ONLY_TOOLS\.has' src/mcp/` >= 1 | source-grep | `npm test -- --grep "N-08-02"` | ❌ Wave 0 |
| N-08-03 | `grep -E 'set[A-Z]|push|update|delete|commit' src/mcp/readers.ts | wc -l` == 0 (with documented setTimeout allowance) | source-grep | `npm test -- --grep "N-08-03"` | ❌ Wave 0 |
| N-08-04 | `grep -rE '^\s*console\.' src/mcp/ | wc -l` == 0 | source-grep | `npm test -- --grep "N-08-04"` | ❌ Wave 0 |
| N-08-05 | `git diff --name-only main..HEAD -- src/network/ | wc -l` == 0 (after Phase 8) | git-grep | manual phase-close check | — |
| N-08-06 | `git diff --name-only main..HEAD -- relay/ | wc -l` == 0 | git-grep | manual phase-close check | — |
| N-08-07 | total extension test count after Phase 8 >= baseline + 80 | meta | counted at phase close | — |
| N-08-08 | `grep -c "127\.0\.0\.1\|localhost" src/mcp/server.ts >= 1 AND grep -c "0\.0\.0\.0" src/mcp/server.ts == 0` | source-grep | `npm test -- --grep "N-08-08"` | ❌ Wave 0 |
| N-08-09 (proposed) | `grep -c "enableDnsRebindingProtection" src/mcp/server.ts >= 1` | source-grep | `npm test -- --grep "N-08-09 DNS rebinding"` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `npm test -- --grep "Phase 8 — <subsystem>"` runs the affected MCP suite (~30s for one subsystem).
- **Per wave merge:** `npm test -- --grep "Phase 8"` runs the entire Phase 8 suite (~2-3 min estimated for 80+ new tests).
- **Phase gate:** `npm test` (full extension suite — 996+ tests baseline) must be green before `/gsd-verify-work 8`.

### Wave 0 Gaps

All test files below are NEW and must land in Wave 0 (test infrastructure before any implementation):

- [ ] `src/test/suite/mcpServer.test.ts` — integration: boot server, connect SDK client, assert tools/list, resources/list
- [ ] `src/test/suite/mcpToolsRead.test.ts` — per-tool happy-path tests for the 5 simple readers (branch/sync/activity/chat/deps)
- [ ] `src/test/suite/mcpAdviseSync.test.ts` — composite advise_sync tool with multiple fixture scenarios (in-sync, behind, dirty, AST-overlap)
- [ ] `src/test/suite/mcpDependencyResource.test.ts` — versioncon-state:// resource read
- [ ] `src/test/suite/mcpConfigWriter.test.ts` — `.vscode/mcp.json` + `.mcp.json` write/upsert/remove with jsonc-parser preserving comments
- [ ] `src/test/suite/mcpReadOnlyGate.test.ts` — N-08-01..04 + N-08-08..09 source-grep tests + READ_ONLY_TOOLS runtime gate rejection test
- [ ] `src/test/suite/mcpConsent.test.ts` — first-run consent prompt + setting persistence
- [ ] `src/test/suite/mcpActivation.test.ts` — SC-1 e2e: activate extension → assert .vscode/mcp.json written → assert server bound
- [ ] `src/test/suite/fixtures/fakeReaders.ts` — deterministic test fixtures for BranchReader, SyncReader, ActivityReader, ChatReader, DependencyReader, PresenceReader
- [ ] Framework install: `npm install --save-dev` is already wired (existing test suite is mocha) — no new framework dep

**Estimated test count:** ~80-100 new tests across the 8 new files. Meets N-08-07 floor.

## Security Domain

Workflow `security_enforcement: true`, `security_asvs_level: 1`. Section required.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | partial | No password auth (localhost trust boundary). Future-phase OAuth/bearer-token deferred per CONTEXT |
| V3 Session Management | yes | `StreamableHTTPServerTransport` sessions keyed by `mcp-session-id` header; UUID-generated per session; close-on-disconnect frees the session |
| V4 Access Control | yes | Two-layer read-only enforcement: Layer 1 structural (Reader interfaces — no writer methods exist on the import surface); Layer 2 runtime (READ_ONLY_TOOLS allow-list gate). Source-grep tested |
| V5 Input Validation | yes | Tool inputs validated by Zod schemas (SDK auto-rejects malformed args before handler invoked). Resource URI template captures are decoded via decodeURIComponent before lookup; path-traversal-safe (no fs reads in v1 resources) |
| V6 Cryptography | partial | No new crypto. Inherits transport security from localhost trust boundary. Future remote-MCP-over-relay phase would add WSS + JWT |
| V7 Error Handling | yes | Errors returned as `{ isError: true, content: [...] }` — never leak stack traces, never include internal paths in messages |
| V8 Data Protection | yes | MCP server reads ONLY the local user's view of state — same data the human user sees. No exfiltration of other teammates' chat / branches beyond what is already broadcast over the LAN/cloud session protocol |
| V13 API & Web Service | yes | DNS rebinding protection (`enableDnsRebindingProtection: true` + `allowedHosts`) gates all incoming HTTP requests by Host header. Origin header check available if needed |
| V14 Config | yes | Settings (`versioncon.mcp.enabled`, `.consent`, `.port`) honored. Bind address is hard-coded `127.0.0.1` — never `0.0.0.0`. N-08-08 enforces |

### Known Threat Patterns for {Node.js + VS Code extension + MCP HTTP server on localhost}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| DNS rebinding attack from malicious website → calls our tools on user's behalf | Spoofing / Tampering | `enableDnsRebindingProtection: true` + explicit `allowedHosts` list (CVE-2025-66414 mitigation, SDK 1.24+) |
| Model tricks server into calling a write-equivalent tool | Elevation of Privilege | Layer 1 structural Reader interfaces (no writer methods); Layer 2 runtime READ_ONLY_TOOLS allow-list; N-08-01..03 source-grep gates |
| MCP server exposes state outside the user's view (e.g. another teammate's chat) | Information Disclosure | Server reads only LOCAL state, which is already filtered to the human user's view. No cross-session data exposure |
| Model spams expensive tool calls (DoS) | DoS | Result-size caps in each tool (get_recent_activity defaults 20, get_chat_log defaults 50, query_dependencies caps at 1-2 hops). Tool execution time logged to OutputChannel. No rate-limit in v1 (localhost trust boundary) |
| Non-VS-Code process binds the same port | Tampering | `listen(0)` kernel-assigned port avoids well-known port collisions. Port stored in `.vscode/mcp.json` AFTER bind succeeds. A squatter on the port would not have a registered `versioncon` entry pointing at them |
| Dependency-poisoning the MCP SDK via a typo-squatting npm package | Tampering | Pin exact major (`^1.29.0`) of the official `@modelcontextprotocol/sdk`. Add `npm audit` step to CI per existing repo discipline |
| MCP client impersonation (a non-allowed AI agent connects) | Spoofing | Out of v1 scope — localhost trust boundary. ANY local process can connect to the localhost listener. Future remote-MCP phase adds OAuth |
| Resource URI traversal → fetches arbitrary file via `versioncon-state://dependency-graph/../../etc/passwd` | Tampering | Resource handler decodes URI capture but ONLY uses it as a key into the in-memory dep graph; no `fs.read` against the captured string. Path traversal is a no-op against an in-memory map |
| `.vscode/mcp.json` write overwrites unrelated user config | Tampering | `jsonc-parser.modify(['servers', 'versioncon'], ...)` targets a specific key path — other keys untouched. Verified by mcpConfigWriter.test.ts |

## File Structure Recommendation

```
src/mcp/
├── server.ts                     # Express + StreamableHTTPServerTransport bootstrap; bind + lifecycle helpers
├── buildServer.ts                # Composes McpServer instance from Readers (DI seam — tests inject fakeReaders)
├── registry.ts                   # READ_ONLY_TOOLS Set<string> + registerReadOnlyTool factory (Layer 2 gate)
├── readers.ts                    # TYPE-ONLY: BranchReader, SyncReader, ActivityReader, ChatReader, DependencyReader, PresenceReader (Layer 1 gate)
├── lifecycle.ts                  # activate() + deactivate() helpers — start server, write configs, cleanup
├── consent.ts                    # First-run vscode.window.showInformationMessage modal + setting persistence
├── mcpConfig.ts                  # upsertMcpConfig / removeMcpConfig — jsonc-parser-based read-modify-write
├── adapters/                     # Implement Reader interfaces by wrapping existing services — keeps src/host/SessionHost.ts untouched
│   ├── BranchReaderImpl.ts       # wraps BranchManager.getActiveBranch + listBranches
│   ├── SyncReaderImpl.ts         # wraps SyncTracker.getOutOfSyncPaths + getLatestPushId
│   ├── ActivityReaderImpl.ts     # wraps PushHistory.getRecords + getLatestRecord
│   ├── ChatReaderImpl.ts         # wraps ChatLog.getRecent
│   ├── DependencyReaderImpl.ts   # wraps AstFactory.getAdapter + joinImpact (ad-hoc per-call analysis)
│   └── PresenceReaderImpl.ts     # wraps SessionHost.getPresenceSnapshot + getMemberTracking + getMemberNames
├── tools/
│   ├── getBranchStatus.ts        # One file per tool; each calls registerReadOnlyTool with description from Section F.4
│   ├── getSyncStatus.ts
│   ├── getRecentActivity.ts
│   ├── getChatLog.ts
│   ├── queryDependencies.ts
│   ├── listDependents.ts
│   └── adviseSync.ts             # Composite: fuses Sync + Presence + Dependency readers per Section I.2-I.3
└── resources/
    └── dependencyGraph.ts        # versioncon-state://dependency-graph/{symbolOrPath} template + list root

src/test/suite/                   # NEW Phase 8 tests (Wave 0):
├── mcpServer.test.ts             # boot + connect SDK client + tools/list assertions
├── mcpToolsRead.test.ts          # per-tool happy paths (5 simple readers)
├── mcpAdviseSync.test.ts         # composite advise_sync scenarios
├── mcpDependencyResource.test.ts # resource read happy path
├── mcpConfigWriter.test.ts       # jsonc-parser-preserving merge tests
├── mcpReadOnlyGate.test.ts       # N-08-01..04, N-08-08..09 source-grep + runtime rejection
├── mcpConsent.test.ts            # first-run prompt + setting persistence
├── mcpActivation.test.ts         # SC-1 e2e: activate → mcp.json written → server bound
└── fixtures/
    └── fakeReaders.ts            # Deterministic fixture set for all Reader interfaces
```

**Files modified (NOT created):**

| File | Modification |
|---|---|
| `src/extension.ts` | Wire `startMcpServer` + `ensureConsent` + `upsertMcpConfig` into `activate()`; wire shutdown into `deactivate()`. Add `getMcpOutputChannel` lazy factory matching `getGitBridgeOutputChannel` pattern (line 189) and `getDeepLinkOutputChannel` pattern (line 210) |
| `package.json` | Add 4 deps (`@modelcontextprotocol/sdk`, `zod`, `jsonc-parser`, `express`) + `@types/express` dev dep; add 3 config keys under `contributes.configuration.properties` (`versioncon.mcp.enabled`, `.port`, `.consent`); leave `engines.vscode` at `^1.85.0` (stretch: bump to `^1.102.0` only if shipping programmatic registration) |

**Files NOT touched (per CONTEXT.md `<code_context>` and N-08-05 / N-08-06):**

- `relay/` — Phase 8 is local-only
- `src/network/` — no new transports
- `src/auth/` — N-08-01 structural ban
- `src/ast/` — Phase 5 surface untouched (Phase 8 ad-hoc-calls existing exports)
- `src/host/SessionHost.ts` — accessed via PresenceReader adapter only, not modified
- `src/host/AuthHandler.ts`, `SessionHostFactory.ts` — not touched
- `src/client/SessionClient.ts` — not touched (Phase 8 reads HOST-side state only)
- `src/filesystem/*` — not touched (BranchManager/SyncTracker/ChatLog/PushHistory/PresenceMap accessed via adapters)
- `src/services/` — GitBridge, WorkspaceDiffer untouched
- `src/state/` — ReviewState, requireReviewGate untouched
- `src/ui/` — no new webviews; consent uses native `showInformationMessage`

## Package Dependencies

| Package | Version pin | Rationale |
|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.29.0` | Verified current production-recommended; v2 is pre-alpha. Includes CVE-2025-66414 (DNS rebinding) mitigation primitives. [VERIFIED: npm view 2026-03-30] |
| `zod` | `^3.25.0` | Required peer of SDK. SDK imports `zod/v4` namespace internally but supports `^3.25`. We use `z` directly in `inputSchema` shapes (Section A.3) |
| `jsonc-parser` | `^3.3.1` | Microsoft's own JSONC parser, used internally by VS Code for settings.json. `modify` + `applyEdits` preserve user comments + sibling entries in `.vscode/mcp.json` |
| `express` | `^5.0.0` | SDK's canonical example uses Express; matches `simpleStreamableHttp.ts` pattern. Express 4.19 also works; pin major 5 (current stable). Adds `@types/express` as devDep |

**No removal of existing deps.**

**Total new bundle size impact:** ~3MB unzipped (`@modelcontextprotocol/sdk` ~2MB, `zod` ~300KB, `jsonc-parser` ~100KB, `express` ~500KB). Acceptable for a VS Code extension.

## Risks + Mitigations

| Threat ID | Title | STRIDE | Mitigation | Verification |
|---|---|---|---|---|
| T-08-01 | Elevation of Privilege — model crafts a tool name that bypasses the runtime gate | Elevation | Layer 1 (TS Reader interface) means the writer-shaped fn signatures literally don't exist on the imported surface. Layer 2 `READ_ONLY_TOOLS.has(name)` runtime gate. registerReadOnlyTool factory throws on construction if name not in set | N-08-01, N-08-02 source-grep + integration test "tools/list returns exactly the 7 expected" |
| T-08-02 | Information Disclosure — MCP server exposes state outside the user's view | I.D. | Server reads only LOCAL state already filtered to the human user. Adapters wrap getters that defensively copy (e.g. PresenceMap.getSnapshot, ChatLog.getRecent slice) — no leak of internal mutable state | Integration test asserts no remote-only state surfaces in tool responses; manual review of each adapter |
| T-08-03 | DoS — model spams tools | D.o.S. | Result-size caps per tool (chat 50, activity 20, deps 1-2 hops). Tool execution time logged to OutputChannel for operator visibility. No rate-limit in v1 (localhost trust boundary). Documented limit in tool descriptions | Manual fuzz test with 100 rapid calls; assert no extension-host hang |
| T-08-04 | Tampering — non-VS-Code process binds the same port | Tampering | `listen(0)` kernel ephemeral port. Port written to `.vscode/mcp.json` AFTER successful bind. Squatter on the port would not be the entry MCP clients connect to (config points at the actual bound port). DNS rebinding protection prevents external Host-header spoofing | N-08-09 source-grep on `enableDnsRebindingProtection`; integration test asserts Host header mismatch is rejected with 421 |
| T-08-05 | Read-only escape — write-shaped tool sneaks into the catalog | Elevation | registerReadOnlyTool is the ONLY way to register a tool in src/mcp/. No direct `server.registerTool` calls allowed (source-grep N-08-10 proposal: grep -c "server.registerTool" src/mcp/ should be 0 outside registry.ts). All 7 tools' names live in the hard-coded READ_ONLY_TOOLS Set; tampering with that set without changing the test list fails the integration "tools/list returns exactly..." assertion | Source-grep + tools/list whitelist assertion |
| T-08-06 | Information Disclosure — Bearer/Auth headers leak into MCP server logs (Phase 7-style log discipline) | I.D. | OutputChannel logger NEVER logs HTTP headers; only logs structured events (server-bound, server-stopped, tool-call-name). Mirrors Phase 7 pino redact discipline conceptually — we just don't log the leaky surface in the first place | Mocha test asserts log lines from a sample tool call contain no `authorization` substring |
| T-08-07 | MCP-client-impersonation — a malicious local process posing as Claude Code reads state | Spoofing | Out of v1 scope per CONTEXT.md. Localhost trust boundary means ANY local process can connect. Documented limitation. Future remote-MCP phase adds OAuth | Documented in README "Security model" section; no v1 test |
| T-08-08 | Dependency-poisoning — typo-squat on `@modelcontextprotocol/sdk` | Tampering | Pin official package by exact org-scoped name. CI `npm audit` + `npm ci --ignore-scripts` (existing repo discipline). Lockfile commit ensures reproducible installs | npm audit clean before phase close |
| T-08-09 | `.vscode/mcp.json` write corrupts user's other MCP server entries | Tampering | `jsonc-parser.modify(['servers', 'versioncon'], ...)` targets specific key. mcpConfigWriter.test.ts has dedicated test "preserves Postgres + GitHub MCP entries on upsert" with sample fixture mcp.json containing other servers | Integration test against fixture mcp.json |
| T-08-10 | Resource URI captured-segment path traversal | Tampering | Resource URI template captures are decoded but used only as in-memory map keys — no fs.read of captured string. Even `../etc/passwd` is just a string key lookup, no filesystem touch | Code review + dedicated test "resource read with traversal-looking key returns not-found, not file content" |
| T-08-11 | Console.* leak in src/mcp/ pollutes user's Developer Tools console | I.D. | N-08-04 source-grep gate forbids console.* in src/mcp/. All logs go through OutputChannel | N-08-04 source-grep test |
| T-08-12 | Stale port in `.vscode/mcp.json` after VS Code crash bypasses deactivate() cleanup | DoS (degraded UX, not security) | On next activation, ALWAYS overwrite the entry. Self-healing | Integration test "second activate with stale entry updates port" |

## Open Questions Remaining (RESOLVED 2026-05-21)

All 4 questions resolved during plan-phase. Recorded for traceability:

1. **VS Code `engines.vscode` bump from `^1.85.0` to `^1.102.0`** — **RESOLVED: defer. Plans keep `engines.vscode` at `^1.85.0`** (08-01 does NOT bump it). Programmatic registration via `lm.registerMcpServerDefinitionProvider` is deferred to a follow-up phase. Phase 8 ships file-based `.vscode/mcp.json` writer only (covers Copilot + Claude Code + Cursor + Codex via shared shape).
2. **`versioncon.mcp.consent` scope (Global vs Workspace)** — **RESOLVED: Global**, matching Phase 7's UriHandler consent UX (locked in CONTEXT D-5). Implemented in 08-05 consent.ts.
3. **A1 confirmation — Claude Code workspace `.mcp.json` parser accepts the same shape as `.vscode/mcp.json`** — **RESOLVED at plan level: 08-05's mcpConfig.ts writes BOTH `.vscode/mcp.json` (Copilot) AND `.mcp.json` (Claude Code) at workspace root with the same shape**. Smoke-test of `claude mcp list` is a manual UAT step deferred to UAT-8-2 in VALIDATION.md.
4. **A4 confirmation — per-call latency of ad-hoc Phase 5 AstFactory.getAdapter + joinImpact on a single requested file** — **RESOLVED: 08-07 includes a perf assertion** (`query_dependencies` <100ms p95 on fixture file in `mcpDependencyReader.test.ts`). If perf fails, hypothetical Phase 8.1 ships a standing index.

## Sources

### Primary (HIGH confidence)

- `npm view @modelcontextprotocol/sdk` (verified version 1.29.0 + dependencies + exports map) — 2026-05-21 — [VERIFIED via Bash]
- `npm view jsonc-parser` (verified version 3.3.1) — 2026-05-21 — [VERIFIED via Bash]
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/README.md — v1.x branch canonical README — fetched 2026-05-21 — [VERIFIED via curl]
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/src/examples/server/simpleStreamableHttp.ts — canonical server example — verbatim code patterns extracted — [VERIFIED via curl]
- https://raw.githubusercontent.com/github/github-mcp-server/main/pkg/github/issues.go — verbatim tool descriptions for github-mcp-server (issue_read, list_issue_types, search_issues, etc.) — [VERIFIED via Bash + curl]
- https://code.visualstudio.com/api/extension-guides/ai/mcp — VS Code MCP developer guide (lm.registerMcpServerDefinitionProvider signature, McpHttpServerDefinition constructor) — [CITED via WebFetch]
- https://code.visualstudio.com/docs/copilot/reference/mcp-configuration — `.vscode/mcp.json` schema reference — [CITED via WebFetch]

### Secondary (MEDIUM confidence)

- https://github.com/advisories/GHSA-w48q-cv73-mx4w — CVE-2025-66414 advisory on MCP SDK DNS rebinding default — [CITED via WebSearch]
- https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1382 — SEP-1382 tool description best practices working group — [CITED via WebFetch]
- https://code.claude.com/docs/en/mcp — Claude Code MCP docs (`.mcp.json` workspace + HTTP transport) — [CITED via WebSearch]
- https://docs.cursor.com/context/model-context-protocol — Cursor MCP docs (`.cursor/mcp.json` workspace + Streamable HTTP) — [CITED via WebSearch]
- https://developers.openai.com/codex/mcp — OpenAI Codex MCP docs (`.codex/config.toml` workspace + HTTP/stdio) — [CITED via WebSearch]
- https://www.kenmuse.com/blog/adding-mcp-server-to-vs-code-extension/ — Ken Muse blog showing McpStdioServerDefinition usage from an extension — [CITED via WebFetch]

### Tertiary (LOW confidence — flagged for verification)

- Claude Code workspace `.mcp.json` exact schema acceptance (A1 in Assumptions Log) — multiple secondary sources agree but no primary doc page extracted in this session

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — verified npm registry, verified v1.x canonical example
- Architecture: HIGH — directly mirrors Phase 7's seam discipline + CONTEXT.md locked decisions
- VS Code MCP API: MEDIUM-HIGH — `lm.registerMcpServerDefinitionProvider` documented and stable (1.102+); recommend deferring its use to a stretch plan
- Tool descriptions: MEDIUM — surveyed 4+ MCP servers + SEP-1382 working group; no universal spec but strong pattern convergence
- Pitfalls: HIGH — CVE-2025-66414 and IPv4/IPv6 binding pitfalls verified against official advisories
- Test strategy: HIGH — pattern lifted directly from SDK's own client/server example pair

**Research date:** 2026-05-21
**Valid until:** 2026-06-21 for SDK API surface (1-month window — SDK is at v1.x stable, low churn risk); 2026-07-01 for VS Code MCP API (engines.vscode 1.102+ should remain available); shorter window (2 weeks) for Claude Code / Cursor / Codex config docs since those tools iterate faster.

## RESEARCH COMPLETE
