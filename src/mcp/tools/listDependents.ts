// src/mcp/tools/listDependents.ts
//
// Phase 8 Plan 07 — MCP tool: list_dependents.
//
// LLM-facing surface: returns the symbols + files that DEPEND ON the given
// target (file path OR symbol name). Reverse dependency direction — the
// inverse of query_dependencies. Read-only — wraps DependencyReader.reverseDeps
// through the registerReadOnlyTool factory (Layer 2 runtime gate from 08-03).
// All registrations route through the factory (N-08-10 preserved — no direct
// SDK calls outside registry.ts).
//
// Payload shape (CONTEXT D-2):
//   { dependents: { symbols: string[], files: string[] }, hops: 1 | 2 }
//
// v1 reverse-walk limitation (documented in description per critical rules):
//   The production DependencyReaderImpl.reverseDeps from 08-02 returns
//   `{ symbols: [], files: [] }` unconditionally — a full reverse index
//   needs a standing graph (which files import X), deferred to 8.1.
//   FakeReaders has canned reverse fixtures for tests, but in production
//   v1 the tool returns empty for every input. AI agents MUST NOT interpret
//   the empty response as "definitively no callers" — the bounding is a v1
//   limitation, not a graph fact.
//
// See:
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-RESEARCH.md
//     §F.4 (description verbatim), §I (reverse-index deferred to 8.1)
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-02-SUMMARY.md
//     "DependencyReaderImpl v1 Limitations" — reverseDeps always returns empty

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerReadOnlyTool } from '../registry.js';
import type { DependencyReader } from '../readers.js';

export function registerListDependents(
  server: McpServer,
  deps: { depReader: DependencyReader },
): void {
  registerReadOnlyTool(
    server,
    'list_dependents',
    {
      title: 'List Dependents (reverse)',
      description:
        'Returns the symbols and files that DEPEND ON the given target (file path or symbol ' +
        'name). Reverse dependency direction. Default 1 hop. Call this to predict who is ' +
        'affected by changes to a target. NOTE: v1 reverse-walk is bounded by the lack of a ' +
        'standing reverse index; the production reader may return empty for symbols not in ' +
        'the recent-edit window. A full reverse index lands in a future phase. Read-only.',
      inputSchema: {
        target: z
          .string()
          .min(1)
          .describe(
            'Symbol name (e.g. verifyClient) or workspace-relative file path (e.g. src/foo.ts).',
          ),
        hops: z
          .union([z.literal(1), z.literal(2)])
          .optional()
          .describe(
            'Reverse-walk depth. Default 1. v1 production reader treats 2 as 1 (no standing index yet).',
          ),
      },
    },
    async ({
      target,
      hops,
    }: {
      target: string;
      hops?: 1 | 2;
    }): Promise<CallToolResult> => {
      const h: 1 | 2 = hops ?? 1;
      const result = await deps.depReader.reverseDeps(target, h);
      const payload = { dependents: result, hops: h };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    },
  );
}
