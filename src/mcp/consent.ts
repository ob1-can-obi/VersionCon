// src/mcp/consent.ts
//
// Phase 8 Plan 05 — first-run consent prompt. Mirrors Phase 7 UriHandler
// T-07-10 pattern (src/extension.ts:301-315) verbatim:
//   - vscode.window.showInformationMessage modal-ish prompt
//   - explicit Allow / Decline buttons (NOT i18n keys — literal strings,
//     testable via source-grep)
//   - ConfigurationTarget.Global persistence (matches Phase 7 UriHandler
//     consent scope per RESEARCH Open Questions item 1)
//
// Decision branches:
//   already-granted (consent === true)   → return true (no prompt)
//   Allow                                  → consent=true Global; return true
//   Decline                                → enabled=false Global; return false
//   dismiss (undefined response)           → enabled=false Global; return false
//
// The dismiss-as-decline policy matches Phase 7 T-07-10's silent-cancellation
// semantics — user inaction is interpreted as decline so activations don't
// loop-prompt the user every restart. The user can re-enable in settings.
//
// N-08-04: no console.* — errors propagate to the lifecycle.ts catch site
// where the OutputChannel log line is emitted.
//
// N-08-01: this module references no auth-layer symbols (consent UX only).

import * as vscode from 'vscode';

/**
 * Literal prompt copy locked by CONTEXT D-5 / RESEARCH §1278. Treated as a
 * source-grep-testable constant — any change here must be reviewed against
 * the literal in the planning artifacts.
 *
 * Concatenated as two string literals so the source-grep gate tests a
 * substring of the literal (not the concatenated runtime value) — this
 * mirrors how Phase 7's T-07-20 redaction literal is grep-tested.
 */
const CONSENT_PROMPT =
  'VersionCon wants to register an MCP server with this workspace so AI agents (Claude Code, ' +
  'Copilot, Cursor) can read your collab state. The server is local-only and read-only. Allow?';

/**
 * Ensure first-run consent for registering the MCP server. Mirrors Phase 7
 * UriHandler T-07-10 confirmation UX.
 *
 * Resolves to `true` iff the user has previously granted consent OR
 * picks `'Allow'` in the modal. Resolves to `false` on Decline OR dismiss;
 * in both cases also flips `versioncon.mcp.enabled` to `false` (Global scope)
 * so we don't loop-prompt on every activation. The user can re-enable in
 * VS Code settings to re-show the prompt on next activation.
 *
 * @returns `true` if consent granted (now or previously); `false` otherwise.
 */
export async function ensureConsent(): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('versioncon.mcp');
  if (cfg.get<boolean>('consent') === true) {
    return true;
  }

  const choice = await vscode.window.showInformationMessage(
    CONSENT_PROMPT,
    { modal: false },
    'Allow',
    'Decline',
  );

  if (choice === 'Allow') {
    await cfg.update('consent', true, vscode.ConfigurationTarget.Global);
    return true;
  }

  // 'Decline' OR undefined (dismissed) — flip enabled=false so we don't
  // re-prompt on every activation. Dismiss == decline per CONTEXT D-5
  // (mirrors Phase 7 T-07-10's silent-cancellation semantics). The user
  // can re-enable in settings.
  await cfg.update('enabled', false, vscode.ConfigurationTarget.Global);
  return false;
}
