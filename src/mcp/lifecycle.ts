// src/mcp/lifecycle.ts
//
// Phase 8 Wave 2 — activate-time orchestrator.
//
// Reads `versioncon.mcp.enabled` from VS Code settings; optionally awaits
// `ensureConsent` (08-05 wires it); starts the server via src/mcp/server.ts;
// optionally calls `upsertMcpConfig(port)` to write .vscode/mcp.json (08-05
// wires it). The deactivate dual `stopMcpLifecycle` calls `removeMcpConfig`
// (if provided) before closing the handle.
//
// Wave-2 scope: this file accepts ensureConsent / upsertMcpConfig /
// removeMcpConfig as INJECTED async functions. Plan 08-05 implements them;
// plan 08-09 wires extension.ts to call this with all three injected.
//
// Pattern: PATTERNS.md "src/mcp/lifecycle.ts" section — fire-and-forget
// activate-side helper mirroring src/extension.ts:867-869.
//
// Source-grep gates preserved here:
//   - N-08-04: no console.* — diagnostic output goes through opts.log only
// vscode is required lazily inside startMcpLifecycle so this module can be
// loaded under bare mocha (no extension host) for unit tests that inject the
// `_startMcpServer` test seam. Production callers from extension.ts (08-09)
// run inside the extension host and have vscode resolved by Node's loader.
import type * as vscodeModule from 'vscode';
import {
  startMcpServer,
  type McpServerHandle,
  type StartMcpServerOpts,
} from './server.js';
import { buildServer, type BuildServerDeps } from './buildServer.js';

export interface LifecycleOpts {
  context: vscodeModule.ExtensionContext;
  log: (line: string) => void;
  deps: BuildServerDeps;
  /**
   * 08-05 injection seam — first-run consent prompt. When provided, the
   * lifecycle awaits the result and returns null if `false`. Wave 2 ships
   * with no consent prompt; tests inject as needed.
   */
  ensureConsent?: () => Promise<boolean>;
  /**
   * 08-05 injection seam — write/merge .vscode/mcp.json with the bound port
   * AFTER the server has started successfully. Called once per activation.
   */
  upsertMcpConfig?: (port: number) => Promise<void>;
  /**
   * 08-05 injection seam — remove our entry from .vscode/mcp.json on
   * deactivation. Called once per deactivation by stopMcpLifecycle.
   */
  removeMcpConfig?: () => Promise<void>;
  /**
   * Test seam — override the underlying startMcpServer call. Default is the
   * production server.ts implementation.
   */
  _startMcpServer?: (opts: StartMcpServerOpts) => Promise<McpServerHandle>;
}

/**
 * Start the MCP server lifecycle:
 *   1. Read `versioncon.mcp.enabled` — if false, log and return null.
 *   2. Await `ensureConsent` (if provided) — if false, log and return null.
 *   3. Read `versioncon.mcp.port` (default 0 = ephemeral).
 *   4. Bind the server via src/mcp/server.ts.
 *   5. Call `upsertMcpConfig(handle.port)` if provided (08-05).
 *   6. Log `[mcp] started on <url>` and return the handle.
 */
export async function startMcpLifecycle(
  opts: LifecycleOpts,
): Promise<McpServerHandle | null> {
  // Lazy require so callers in non-extension-host environments (bare mocha
  // unit tests) can stub the test seam and never reach this line.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vscode = require('vscode') as typeof vscodeModule;
  const cfg = vscode.workspace.getConfiguration('versioncon.mcp');
  if (cfg.get<boolean>('enabled') === false) {
    opts.log('[mcp] disabled via versioncon.mcp.enabled=false');
    return null;
  }
  if (opts.ensureConsent) {
    const ok = await opts.ensureConsent();
    if (!ok) {
      opts.log('[mcp] consent declined');
      return null;
    }
  }
  const port = cfg.get<number>('port', 0) ?? 0;
  const starter = opts._startMcpServer ?? startMcpServer;
  const handle = await starter({
    buildServer: () => buildServer(opts.deps),
    log: opts.log,
    port,
  });
  if (opts.upsertMcpConfig) {
    try {
      await opts.upsertMcpConfig(handle.port);
    } catch (err) {
      opts.log(
        `[mcp] upsertMcpConfig failed: ${String(
          (err as Error)?.message ?? err,
        )}`,
      );
    }
  }
  opts.log(`[mcp] started on ${handle.url}`);
  return handle;
}

/**
 * Stop the MCP server lifecycle:
 *   1. Call `removeMcpConfig` (if provided) — best-effort; errors logged.
 *   2. Close the handle (drains transports + closes the HTTP server).
 *   3. Log `[mcp] stopped`.
 */
export async function stopMcpLifecycle(
  handle: McpServerHandle,
  opts?: {
    removeMcpConfig?: () => Promise<void>;
    log?: (line: string) => void;
  },
): Promise<void> {
  if (opts?.removeMcpConfig) {
    try {
      await opts.removeMcpConfig();
    } catch (err) {
      opts.log?.(
        `[mcp] removeMcpConfig failed: ${String(
          (err as Error)?.message ?? err,
        )}`,
      );
    }
  }
  await handle.close();
  opts?.log?.('[mcp] stopped');
}
