// src/mcp/tools/getSyncStatus.ts
//
// Phase 8 Plan 06 — MCP tool: get_sync_status.
//
// LLM-facing surface: returns the last sync timestamp, pending pushes, and
// any files currently blocked from sync. Read-only — wraps SyncReader +
// ActivityReader through the registerReadOnlyTool factory (Layer 2 runtime
// gate from 08-03). All registrations route through the factory (N-08-10
// preserved — no direct SDK calls outside registry.ts).
//
// Payload shape (CONTEXT D-2):
//   { last_sync_at: string | null, pending_pushes: string[], blocked: string[] }
//
// v1 derivation:
//   - `last_sync_at` is the latest PushRecord's timestamp (newest from
//     activityReader.getRecentPushes(1)[0]). Converted from ms epoch to ISO
//     string for LLM-friendliness (matches advise_sync.state.last_sync_at
//     shape in CONTEXT.md). null when no pushes recorded.
//   - `pending_pushes` is the syncReader.getLatestPushId() wrapped in a
//     single-element array (or empty when no pushes). v1 surfaces only the
//     most recent push id; future-phase may broaden to all unpulled push ids.
//   - `blocked` is a fresh defensive copy of syncReader.getOutOfSyncPaths().
//
// See:
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-RESEARCH.md §F.4
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-CONTEXT.md
//     <decisions> item 2 + 6 (Tool surface + advise_sync ISO8601 ts contract)

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerReadOnlyTool } from '../registry.js';
import type { SyncReader, ActivityReader } from '../readers.js';

export function registerGetSyncStatus(
  server: McpServer,
  deps: { syncReader: SyncReader; activityReader: ActivityReader },
): void {
  registerReadOnlyTool(
    server,
    'get_sync_status',
    {
      title: 'Sync Status',
      description:
        'Returns the last sync timestamp, pending pushes, and any files currently blocked from sync. ' +
        'Call this to detect out-of-sync state before recommending push/pull. Read-only.',
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const latestPush = deps.activityReader.getRecentPushes(1)[0];
      const lastPushId = deps.syncReader.getLatestPushId();
      const blocked = [...deps.syncReader.getOutOfSyncPaths()];
      const payload = {
        last_sync_at: latestPush
          ? new Date(latestPush.timestamp).toISOString()
          : null,
        pending_pushes: lastPushId ? [lastPushId] : [],
        blocked,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    },
  );
}
