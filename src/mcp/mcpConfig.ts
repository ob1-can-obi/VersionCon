// src/mcp/mcpConfig.ts
//
// Phase 8 Plan 05 — read-modify-write of `.vscode/mcp.json` and `.mcp.json`
// using jsonc-parser. Preserves user comments AND sibling MCP server entries
// (postgres, github, etc.) — T-08-09 mitigation.
//
// Two callers from lifecycle.ts (08-09 wires this):
//   - upsertMcpConfig(folder, '.vscode/mcp.json', 'versioncon', url)
//   - upsertMcpConfig(folder, '.mcp.json',        'versioncon', url)
// And on deactivate the matching removeMcpConfig pair.
//
// Pattern: PATTERNS.md "src/mcp/mcpConfig.ts" — adapts the
// ensureVersionconExcluded helper (src/extension.ts:371-408) but uses
// jsonc-parser instead of JSON.parse/JSON.stringify (Pitfall 4 — comments
// would be destroyed by naive JSON parse).
//
// SECURITY contract (T-08-07 — by construction):
//   - NEVER writes a HTTP header field
//   - NEVER writes any token / Bearer / authorization material
//   - Localhost trust boundary means HTTP entries need ONLY { type, url }
//
// SECURITY contract (T-08-09 — by construction):
//   - jsonc-parser.modify targets the EXACT JSON path ['servers', serverName]
//   - Sibling entries under 'servers' (postgres, github, ...) are byte-untouched
//   - Top-level keys other than 'servers' are byte-untouched
//   - User JSONC comments are preserved (jsonc-parser contract)
//
// N-08-04: no console.* — errors propagate to callers; the lifecycle.ts
// caller (08-09) handles logging via the injected OutputChannel.
//
// N-08-01: this module references no auth-layer symbols (read-only viewport).

import { modify, applyEdits } from 'jsonc-parser';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Insert-or-update the named MCP server entry in a `.vscode/mcp.json` or
 * workspace-root `.mcp.json` file. Creates the parent directory + file if
 * missing. Preserves user comments + sibling entries via jsonc-parser.
 *
 * Writes only `{ type: 'http', url }`. No HTTP-header fields. No auth
 * material — localhost trust boundary.
 *
 * On Pitfall 3 (stale entry): jsonc-parser.modify on an existing path
 * REPLACES the value at that path, so a versioncon entry with a stale port
 * is self-healed on next call.
 *
 * On directory-missing case: `fs.mkdir(..., { recursive: true })` creates
 * the parent before write.
 *
 * On corrupt-JSONC case: jsonc-parser.modify tolerates malformed input
 * by treating it as the empty doc; the result is effectively a rewrite.
 * Documented behavior — a corrupt mcp.json is rare; a developer can
 * recover from git history if hand-edits are lost.
 *
 * @param workspaceFolder absolute path to the workspace root folder
 * @param configRelPath relative path under the workspace, e.g.
 *   `.vscode/mcp.json` or `.mcp.json`
 * @param serverName the MCP server entry name, e.g. `'versioncon'`
 * @param url the MCP server URL, e.g. `'http://127.0.0.1:53412/mcp'`
 */
export async function upsertMcpConfig(
  workspaceFolder: string,
  configRelPath: string,
  serverName: string,
  url: string,
): Promise<void> {
  const fullPath = path.join(workspaceFolder, configRelPath);
  let raw = '';
  try {
    raw = await fs.readFile(fullPath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    raw = '{}';
  }
  // Empty file or whitespace-only → treat as empty doc.
  if (raw.trim().length === 0) raw = '{}';

  const edits = modify(
    raw,
    ['servers', serverName],
    { type: 'http', url },
    {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    },
  );
  const next = applyEdits(raw, edits);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, next, 'utf-8');
}

/**
 * Remove the named MCP server entry from a `.vscode/mcp.json` or `.mcp.json`
 * file. If the file does not exist, this is a no-op (no throw). Preserves
 * sibling entries (postgres, github, ...) byte-identically.
 *
 * Per RESEARCH §D.3, callers in lifecycle.ts invoke this on deactivate to
 * prevent stale-port entries from haunting the user's mcp.json after the
 * extension shuts down. If the file becomes effectively empty
 * (`{ "servers": {} }`), the file is left alone — the user may have orphan
 * configs unrelated to the versioncon entry.
 *
 * @param workspaceFolder absolute path to the workspace root folder
 * @param configRelPath relative path under the workspace
 * @param serverName the MCP server entry name to remove
 */
export async function removeMcpConfig(
  workspaceFolder: string,
  configRelPath: string,
  serverName: string,
): Promise<void> {
  const fullPath = path.join(workspaceFolder, configRelPath);
  let raw: string;
  try {
    raw = await fs.readFile(fullPath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  // modify with undefined value emits a DELETE edit on the path.
  const edits = modify(raw, ['servers', serverName], undefined, {});
  const next = applyEdits(raw, edits);
  await fs.writeFile(fullPath, next, 'utf-8');
}
