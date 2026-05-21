// src/mcp/tools/queryDependencies.ts
//
// Phase 8 Plan 07 — MCP tool: query_dependencies.
//
// LLM-facing surface: returns the symbols + files that the given target
// (file path OR symbol name) DEPENDS ON. Forward dependency direction.
// Read-only — wraps DependencyReader.forwardDeps through the
// registerReadOnlyTool factory (Layer 2 runtime gate from 08-03). All
// registrations route through the factory (N-08-10 preserved — no direct
// SDK calls outside registry.ts).
//
// Payload shape (CONTEXT D-2):
//   { depends_on: { symbols: string[], files: string[] }, hops: 1 | 2 }
//
// Hop semantics:
//   - Default 1: direct dependencies only (single AST extraction).
//   - 2 accepted by zod but treated as 1 by the v1 DependencyReaderImpl
//     (single-file ad-hoc analysis; no standing index — see 08-02-SUMMARY
//     "DependencyReaderImpl v1 Limitations"). Higher hops would need the
//     8.1 standing index.
//
// Latency: <100ms p95 on a 1KB fixture per CONTEXT D-2. The factory's
// try/catch wraps the handler so DependencyReaderImpl errors degrade
// gracefully to {isError:true} rather than blowing stack traces into
// the model prompt (T-08-stack-leak preserved).
//
// See:
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-RESEARCH.md
//     §F.4 (description verbatim), §I (latency considerations)
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-CONTEXT.md
//     <decisions> item 4 (dependency-graph query API; 1-hop default)

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerReadOnlyTool } from '../registry.js';
import type { DependencyReader } from '../readers.js';

export function registerQueryDependencies(
  server: McpServer,
  deps: { depReader: DependencyReader },
): void {
  registerReadOnlyTool(
    server,
    'query_dependencies',
    {
      title: 'Query Dependencies (forward)',
      description:
        'Returns the symbols and files that the given target (file path or symbol name) ' +
        'DEPENDS ON. Forward dependency direction. Default 1 hop; pass `hops: 2` for ' +
        'one-level transitive. Read-only.',
      inputSchema: {
        target: z
          .string()
          .min(1)
          .describe(
            'Symbol name (e.g. parseToken) or workspace-relative file path (e.g. src/foo.ts).',
          ),
        hops: z
          .union([z.literal(1), z.literal(2)])
          .optional()
          .describe(
            'Dependency walk depth. Default 1; pass 2 for one-level transitive. v1 production reader treats 2 as 1 (no standing index yet).',
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
      const result = await deps.depReader.forwardDeps(target, h);
      const payload = { depends_on: result, hops: h };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    },
  );
}
