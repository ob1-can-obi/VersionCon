// src/mcp/tools/getBranchStatus.ts
//
// Phase 8 Plan 06 — MCP tool: get_branch_status.
//
// LLM-facing surface: returns the current branch, ahead/behind counts, and
// the list of dirty (uncommitted) files. Read-only — wraps BranchReader +
// SyncReader through the registerReadOnlyTool factory (Layer 2 runtime gate
// from 08-03). All registrations route through the factory (N-08-10 gate
// preserved — no direct SDK calls outside registry.ts).
//
// Payload shape (CONTEXT D-2):
//   { branch: string, ahead: number, behind: number, dirty: string[] }
//
// v1 implementation notes:
//   - `ahead` is a placeholder 0 — Phase 8 v1 has no local-only push diff to
//     compute commits-ahead-of-team's-view. Future-phase work; the shape is
//     stable so LLM consumers won't break when the value goes positive.
//   - `behind` derives from syncReader.getOutOfSyncPaths().length — number
//     of paths with remote pushes the local workspace has not yet pulled.
//   - `dirty` is a fresh defensive copy of the readonly array (prevents
//     accidental mutation if a future caller does something silly).
//
// See:
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-RESEARCH.md
//     §F.4 (description verbatim), §1186-1224 (canonical excerpt)
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-CONTEXT.md
//     <decisions> item 2 (Tool surface table — payload shapes)

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerReadOnlyTool } from '../registry.js';
import type { BranchReader, SyncReader } from '../readers.js';

export function registerGetBranchStatus(
  server: McpServer,
  deps: { branchReader: BranchReader; syncReader: SyncReader },
): void {
  registerReadOnlyTool(
    server,
    'get_branch_status',
    {
      title: 'Branch Status',
      description:
        "Returns the current VersionCon branch name, commits ahead/behind the team's view, " +
        'and the list of dirty (uncommitted) files. Call this when the user asks about their ' +
        "branch state or before suggesting any sync action. Read-only, scoped to the local user's view.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const branch = await deps.branchReader.getActiveBranch();
      const dirty = deps.syncReader.getOutOfSyncPaths();
      const payload = {
        branch,
        ahead: 0, // v1 placeholder; future-phase: compute from PushHistory delta
        behind: dirty.length,
        dirty: [...dirty],
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    },
  );
}
