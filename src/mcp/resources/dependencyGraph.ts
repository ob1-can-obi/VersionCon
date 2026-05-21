// src/mcp/resources/dependencyGraph.ts
//
// Phase 8 Plan 07 — MCP resource template for the dependency graph.
//
// LLM-facing surface: a browseable URI form of the dep graph for a specific
// symbol or file. Returns both forward dependencies (what the target depends
// on) AND reverse dependents (what depends on the target), capped at 1 hop.
// AI clients that prefer the Resources primitive can @-mention dep info in
// chat or drag-and-drop the URI handle — same underlying data as
// query_dependencies + list_dependents combined into a single read.
//
// URI scheme: versioncon-state:// (RESEARCH §G.2)
//   - DISTINCT from Phase 7's versioncon:// (UriHandler deep-link scheme).
//     The OS-level deep-link handler is registered for the bare scheme;
//     using a different scheme for MCP resources avoids any chance of OS
//     dispatch overlap. CONTEXT D-2 amended 2026-05-21 to lock the
//     versioncon-state:// scheme.
//   - The SDK uses the URI as an internal key only — never hits the OS
//     handler. But scheme isolation is still defense-in-depth.
//
// T-08-10 mitigation (path traversal): the {symbolOrPath} capture is
//   decoded via decodeURIComponent but used ONLY as an in-memory key into
//   DependencyReader. NO filesystem read against the decoded string. Even
//   a URI like '../../etc/passwd' is just a string key lookup that returns
//   the empty result on miss. Source-grep gate `grep -cE 'fs\\.read|fs\\.readFile'`
//   on this file is 0; mitigation verified by construction.
//
// list: undefined — the resource is browseable but NOT enumerable. The
//   model addresses specific symbols/files by URI; we don't bulk-list every
//   symbol in the workspace (would blow the model's context window).
//
// See:
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-RESEARCH.md
//     §A.4 (resource registration API signature), §G.2 (URI scheme
//     decision), §1226-1269 (canonical excerpt — this file mirrors verbatim)
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-PATTERNS.md
//     "src/mcp/resources/dependencyGraph.ts" section
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-CONTEXT.md
//     <decisions> item 4 + open question 7 (URI scheme resolution)

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { DependencyReader } from '../readers.js';

export function registerDependencyGraphResource(
  server: McpServer,
  deps: { depReader: DependencyReader },
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerResource(
    'dependency-graph-symbol',
    new ResourceTemplate('versioncon-state://dependency-graph/{symbolOrPath}', {
      list: undefined,
    }),
    {
      title: 'Dependency Graph (Symbol/File)',
      description:
        'Browseable view of the dependency graph for a specific symbol or file. ' +
        'Returns both forward dependencies (what the target depends on) and reverse ' +
        'dependents (what depends on the target), capped at 1 hop. Use this resource ' +
        'form to @-mention dep info in chat; use the query_dependencies / list_dependents ' +
        'tools to call it from a prompt.',
      mimeType: 'application/json',
    },
    async (
      uri: URL,
      vars: { symbolOrPath: string | string[] },
    ): Promise<ReadResourceResult> => {
      // T-08-10: decode the URL-captured value (could be 'parseToken' or a
      // percent-encoded 'src%2Ffoo.ts') and use it ONLY as a key against the
      // in-memory DependencyReader. NO filesystem read happens against this
      // string (the gate `grep -cE 'fs\\.read|fs\\.readFile'` on this file is 0
      // by construction — and the comment phrasing keeps that count at 0).
      const raw = Array.isArray(vars.symbolOrPath)
        ? vars.symbolOrPath.join('/')
        : vars.symbolOrPath;
      const target = decodeURIComponent(raw);
      const [forward, reverse] = await Promise.all([
        deps.depReader.forwardDeps(target, 1),
        deps.depReader.reverseDeps(target, 1),
      ]);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ target, forward, reverse }),
          },
        ],
      };
    },
  );
}
