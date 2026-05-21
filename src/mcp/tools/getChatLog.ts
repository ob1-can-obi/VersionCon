// src/mcp/tools/getChatLog.ts
//
// Phase 8 Plan 06 — MCP tool: get_chat_log.
//
// LLM-facing surface: returns recent in-extension chat messages, including
// user chat AND system events (pushes, branch changes, reviews). Read-only —
// wraps ChatReader through the registerReadOnlyTool factory. All registrations
// route through the factory (N-08-10 preserved — no direct SDK calls
// outside registry.ts).
//
// Payload shape (CONTEXT D-2):
//   [{ actor: string, ts: string, text: string, channel: 'user' | 'system' }]
//
// Result-size cap (T-08-03 DoS mitigation):
//   - Default limit: 50 (matches CONTEXT.md sample default)
//   - Hard cap: 200 (zod max() — rejects out-of-range requests at the
//     transport layer before the handler runs).
//
// `since` filter: optional ISO 8601 timestamp string. When present, records
// with timestamp earlier than `since` are filtered out. Because ChatRecord
// .timestamp is a numeric ms epoch (NOT a string per src/types/chat.ts), we
// convert `since` to ms via Date.parse for the comparison.
//
// Field mapping per CONTEXT D-2:
//   - actor    <- record.memberDisplayName
//   - ts       <- record.timestamp (ms epoch) converted to ISO string
//   - text     <- record.body
//   - channel  <- record.kind ('user' | 'system')

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerReadOnlyTool } from '../registry.js';
import type { ChatReader } from '../readers.js';

const CHAT_DEFAULT = 50;
const CHAT_MAX = 200; // T-08-03 cap

export function registerGetChatLog(
  server: McpServer,
  deps: { chatReader: ChatReader },
): void {
  registerReadOnlyTool(
    server,
    'get_chat_log',
    {
      title: 'Chat Log',
      description:
        'Returns recent in-extension chat messages including user chat and system events ' +
        '(pushes, branch changes, reviews). Call this for team context or to find a referenced ' +
        'past message. Defaults to last 50 messages; pass `limit` or `since` (ISO timestamp). ' +
        'Read-only — does not send chat messages.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(0)
          .max(200) // T-08-03 cap — mirrors CHAT_MAX constant; literal kept for source-grep gate.
          .optional()
          .describe(
            `Maximum number of recent chat records to return. Default ${CHAT_DEFAULT}; capped at ${CHAT_MAX}.`,
          ),
        since: z
          .string()
          .datetime()
          .optional()
          .describe(
            'ISO 8601 timestamp; only records with timestamp >= since are returned.',
          ),
      },
    },
    async ({
      limit,
      since,
    }: {
      limit?: number;
      since?: string;
    }): Promise<CallToolResult> => {
      const n = Math.min(limit ?? CHAT_DEFAULT, CHAT_MAX);
      let records = deps.chatReader.getRecent(n);
      if (since) {
        const sinceMs = Date.parse(since);
        // zod .datetime() validated the format; Date.parse won't return NaN
        // here for well-formed ISO timestamps. Records carry ms epoch numbers
        // (src/types/chat.ts:69) so we compare numerically.
        records = records.filter((r): boolean => r.timestamp >= sinceMs);
      }
      const payload = records.map((r): {
        actor: string;
        ts: string;
        text: string;
        channel: 'user' | 'system';
      } => ({
        actor: r.memberDisplayName,
        ts: new Date(r.timestamp).toISOString(),
        text: r.body,
        channel: r.kind,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    },
  );
}
