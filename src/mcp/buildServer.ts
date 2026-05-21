// src/mcp/buildServer.ts
//
// Phase 8 Wave 2 — DI composer for the MCP server.
//
// Pattern: PATTERNS.md "src/mcp/buildServer.ts" section — mirrors
// src/host/SessionHostFactory.ts (single function, takes injected deps,
// returns a configured controller). Unlike SessionHostFactory which returns
// a bound listening object, buildServer returns ONLY the McpServer — the
// network bind happens in src/mcp/server.ts via opts.buildServer().
//
// Wave-2 baseline: buildServer registers NO tools by default. The optional
// `registerTools` callback lets tests inject registration. Wave-3 plans
// (08-06/07/08) will amend this file to import each tool's register*
// function directly and call them inline; the callback path remains for
// tests.
//
// Source-grep gates preserved here:
//   - N-08-01: no src/auth imports (this file imports only sdk + readers)
//   - N-08-04: no console.* — diagnostic output goes through deps.log only
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  BranchReader,
  SyncReader,
  ActivityReader,
  ChatReader,
  DependencyReader,
  PresenceReader,
} from './readers.js';
import { registerGetBranchStatus } from './tools/getBranchStatus.js';
import { registerGetSyncStatus } from './tools/getSyncStatus.js';
import { registerGetRecentActivity } from './tools/getRecentActivity.js';
import { registerGetChatLog } from './tools/getChatLog.js';

export interface BuildServerDeps {
  branchReader: BranchReader;
  syncReader: SyncReader;
  activityReader: ActivityReader;
  chatReader: ChatReader;
  depReader: DependencyReader;
  presenceReader: PresenceReader;
  log?: (line: string) => void;
  /**
   * Wave-2 only — lets tests register tools. Wave-3 (08-06/07/08) will
   * remove this and inline the register* calls directly. The callback
   * signature stays stable so test code is forward-compatible.
   */
  registerTools?: (server: McpServer, deps: BuildServerDeps) => void;
}

/**
 * Construct a fresh McpServer instance wired to the injected Readers.
 *
 * Called once per MCP session by src/mcp/server.ts's StartMcpServerOpts
 * `buildServer` factory. Each session gets its own McpServer so transport
 * lifecycle and per-session state stay isolated.
 *
 * @param deps Reader bundle + optional registerTools callback.
 * @returns A configured McpServer ready to be `connect()`-ed to a transport.
 */
export function buildServer(deps: BuildServerDeps): McpServer {
  const server = new McpServer(
    {
      name: 'versioncon',
      version: process.env.npm_package_version ?? '0.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );
  // Plan 08-06 — Wave 3 production tool registrations (the 4 simple readers).
  // Each goes through registerReadOnlyTool inside its tool file (Layer 2 gate
  // from 08-03). Plans 08-07 (advise_sync + dep tools) and 08-08 (resources)
  // will append additional inline calls below this block.
  registerGetBranchStatus(server, {
    branchReader: deps.branchReader,
    syncReader: deps.syncReader,
  });
  registerGetSyncStatus(server, {
    syncReader: deps.syncReader,
    activityReader: deps.activityReader,
  });
  registerGetRecentActivity(server, {
    activityReader: deps.activityReader,
  });
  registerGetChatLog(server, {
    chatReader: deps.chatReader,
  });
  // Optional callback retained for tests that want to register additional
  // tools (or override) AFTER the production tools land. Wave-3+ tests can
  // still inject; the production code no longer relies on this seam.
  if (deps.registerTools) {
    deps.registerTools(server, deps);
  }
  return server;
}
