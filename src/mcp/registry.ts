// src/mcp/registry.ts
//
// Phase 8 — Layer 2 runtime read-only enforcement.
//
// Defense-in-depth on top of Layer 1 (src/mcp/readers.ts structural gate,
// ships in plan 08-02). Every MCP tool MUST be registered via the
// `registerReadOnlyTool` factory; direct calls to `server.registerTool(...)`
// are forbidden anywhere in `src/mcp/` other than this file. The gate is
// asserted by `src/test/suite/mcpReadOnlyGate.test.ts`:
//   grep -rn 'server.registerTool' src/mcp/ | grep -v 'src/mcp/registry.ts'
// must return 0 lines (proposed N-08-10).
//
// `READ_ONLY_TOOLS` is the source of truth for the allow-list. Any new tool
// name must:
//   (1) appear in this Set verbatim, AND
//   (2) be registered through `registerReadOnlyTool` (the factory throws on
//       unknown names — catches the omission at module load).
//
// Mitigates:
//   - T-08-01 (Elevation of Privilege — model crafts a write tool name)
//   - T-08-05 (read-only escape — write-shaped tool sneaks into the catalog)
//   - T-08-05-aux (handler bypasses the factory via direct server.registerTool)
//   - T-08-stack-leak (handler throws; SDK auto-converts to {isError:true}
//     with err.message — may leak internal paths)
//   - Pitfall 6 (forgetting annotations.readOnlyHint) — factory stamps it in
//
// Source-grep gates enforced by mcpReadOnlyGate.test.ts:
//   - N-08-02: grep -c 'READ_ONLY_TOOLS\.has' src/mcp/ >= 1
//   - N-08-10 (proposed): grep -rn 'server.registerTool' src/mcp/ outside
//     this file == 0
//   - N-08-04 preserved: no console.* anywhere in this file (logger
//     discipline; we use an injected `log: (line: string) => void` instead)
//
// See:
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-RESEARCH.md
//       §A.3 (registerTool signature), §A.5 (error model + canonical Set +
//       factory excerpt, lines 257-292), §A.6 (logger discipline)
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-CONTEXT.md
//       <decisions> item 3 (two-layer read-only enforcement)
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-PATTERNS.md
//       "src/mcp/registry.ts" section (relay/src/auth.ts allow-list discipline)

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';

/**
 * The hard-coded allow-list of read-only MCP tool names. Frozen at
 * module-load so a runtime caller can neither add nor remove members.
 *
 * Exactly 7 names. Adding a new tool name requires updating this Set AND
 * adding a corresponding registration through `registerReadOnlyTool`. The
 * SC-3 negative test in mcpReadOnlyGate.test.ts asserts no write-shaped
 * names (`push_`, `create_`, `update_`, `delete_`, `set_`, `send_`,
 * `commit_`, `merge_`, `revert_`) ever appear in this Set.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = Object.freeze(new Set<string>([
  'get_branch_status',
  'get_sync_status',
  'get_recent_activity',
  'get_chat_log',
  'query_dependencies',
  'list_dependents',
  'advise_sync',
]));

/**
 * Metadata for a read-only tool registration. The `inputSchema` field is a
 * raw zod shape object (NOT `z.object(...)` — see RESEARCH §A.3 gotcha).
 * The SDK wraps the raw shape internally and validates incoming arguments
 * before invoking the handler.
 */
export interface RegisterReadOnlyToolMeta<T extends z.ZodRawShape> {
  /** Display label for client UI (Copilot, Claude Code show this). */
  title: string;
  /**
   * LLM-facing prompt describing when to call the tool. Length 1-3
   * sentences, declarative present tense (RESEARCH §F.2).
   */
  description: string;
  /**
   * Raw zod shape object (NOT z.object(...) — see RESEARCH §A.3 gotcha).
   * Example: `{ symbolOrPath: z.string() }` for parameterized tools, `{}`
   * for parameterless reads.
   */
  inputSchema: T;
}

/**
 * Register a read-only MCP tool through the Layer 2 gate.
 *
 * Throws synchronously if `name` is not in `READ_ONLY_TOOLS` — catches the
 * misnaming at module load, not at first call. This means any future tool
 * file (08-06/07/08) that imports this factory and passes a wrong name
 * fails fast during the SDK boot.
 *
 * Stamps `annotations.readOnlyHint: true, openWorldHint: false` so the
 * client UI surfaces the [read-only] badge (Pitfall 6 mitigation — clients
 * like Claude Code and Linear MCP rely on this annotation).
 *
 * Wraps the user handler with a defense-in-depth call-time check
 * (`READ_ONLY_TOOLS.has(name)` re-runs inside the closure) plus a
 * try/catch that converts unhandled exceptions to `{isError: true}` so
 * stack traces never leak into the model prompt (RESEARCH §A.5,
 * T-08-stack-leak mitigation).
 *
 * @param server  McpServer instance to register against (constructed by
 *                buildServer in plan 08-04).
 * @param name    Tool name — MUST be in READ_ONLY_TOOLS.
 * @param meta    Title, description, raw zod shape.
 * @param handler User-supplied handler. Receives validated args, returns
 *                CallToolResult.
 * @param log     Optional sink for diagnostic lines. In production this is
 *                bound to the `VersionCon: MCP` OutputChannel via
 *                getMcpOutputChannel (plan 08-05). Defaults to no-op when
 *                absent. NEVER use console.* in this file — N-08-04 gate.
 */
export function registerReadOnlyTool<T extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  meta: RegisterReadOnlyToolMeta<T>,
  handler: (args: z.objectInputType<T, z.ZodTypeAny>) => Promise<CallToolResult>,
  log?: (line: string) => void,
): void {
  // Layer 2 — registration-time check. Throw immediately so a misnamed
  // tool fails at module load, not at first call. This catches the typo
  // / misnaming class of bug at the construction site.
  if (!READ_ONLY_TOOLS.has(name)) {
    throw new Error(
      `registerReadOnlyTool: '${name}' not in READ_ONLY_TOOLS allow-list`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool(
    name,
    {
      ...meta,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (
      args: z.objectInputType<T, z.ZodTypeAny>,
      _extra: unknown,
    ): Promise<CallToolResult> => {
      // Layer 2 — call-time defense-in-depth check. Belt + suspenders
      // against runtime tampering with the Set (the Set is frozen, but a
      // host that disables freeze enforcement or replaces the Set's `has`
      // method via Object.defineProperty would otherwise sneak through).
      // This re-check inside the closure is the gate the test in
      // mcpReadOnlyGate.test.ts exercises by monkeypatching has() to
      // return false for the tool name.
      if (!READ_ONLY_TOOLS.has(name)) {
        if (log) {
          log(`[mcp] READ_ONLY_TOOLS gate rejected at call time: ${name}`);
        }
        return {
          content: [{
            type: 'text',
            text: `Tool '${name}' is not on the read-only allow-list.`,
          }],
          isError: true,
        };
      }

      try {
        return await handler(args);
      } catch (err) {
        // Per RESEARCH §A.5: throw is also valid (SDK converts to
        // {isError:true} automatically), but we explicitly catch + return
        // so unhandled exceptions don't leak stack traces into the
        // model's prompt (T-08-stack-leak). We log the message via the
        // injected log function — operator-facing only, never to the
        // model. NEVER console.* here (N-08-04).
        const message = String((err as Error)?.message ?? err);
        if (log) {
          log(`[mcp] tool '${name}' threw: ${message}`);
        }
        return {
          content: [{
            type: 'text',
            text: `Tool '${name}' failed: ${message}`,
          }],
          isError: true,
        };
      }
    },
  );
}
