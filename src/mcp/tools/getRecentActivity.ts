// src/mcp/tools/getRecentActivity.ts
//
// Phase 8 Plan 06 — MCP tool: get_recent_activity.
//
// LLM-facing surface: returns recent team push activity. Read-only — wraps
// ActivityReader through the registerReadOnlyTool factory. All registrations
// route through the factory (N-08-10 preserved — no direct SDK calls
// outside registry.ts).
//
// Payload shape (CONTEXT D-2):
//   [{ actor: string, ts: string, files: string[], message: string }]
//
// Result-size cap (T-08-03 DoS mitigation):
//   - Default limit: 20 (matches CONTEXT.md sample default)
//   - Hard cap: 100 (zod max() — rejects out-of-range requests at the
//     transport layer before the handler runs).
//
// Order: newest-first (preserves ActivityReader.getRecentPushes contract).
//
// Field mapping per CONTEXT D-2:
//   - actor    <- record.memberDisplayName
//   - ts       <- record.timestamp (ms epoch) converted to ISO string
//   - files    <- record.files.map(f => f.relativePath) (fresh array)
//   - message  <- record.message

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerReadOnlyTool } from '../registry.js';
import type { ActivityReader } from '../readers.js';

const ACTIVITY_DEFAULT = 20;
const ACTIVITY_MAX = 100; // T-08-03 cap

export function registerGetRecentActivity(
  server: McpServer,
  deps: { activityReader: ActivityReader },
): void {
  registerReadOnlyTool(
    server,
    'get_recent_activity',
    {
      title: 'Recent Activity',
      description:
        'Returns recent team push activity (who pushed, when, which files, optional message). ' +
        'Call this to surface what teammates have changed lately. Defaults to last 20 events; ' +
        'pass `limit` to scope. Read-only.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(0)
          .max(100) // T-08-03 cap — mirrors ACTIVITY_MAX constant; literal kept for source-grep gate.
          .optional()
          .describe(
            `Maximum number of recent push records to return. Default ${ACTIVITY_DEFAULT}; capped at ${ACTIVITY_MAX}.`,
          ),
      },
    },
    async ({ limit }: { limit?: number }): Promise<CallToolResult> => {
      const n = Math.min(limit ?? ACTIVITY_DEFAULT, ACTIVITY_MAX);
      const records = deps.activityReader.getRecentPushes(n);
      const payload = records.map((r): {
        actor: string;
        ts: string;
        files: string[];
        message: string;
      } => ({
        actor: r.memberDisplayName,
        ts: new Date(r.timestamp).toISOString(),
        files: r.files.map((f): string => f.relativePath),
        message: r.message,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    },
  );
}
