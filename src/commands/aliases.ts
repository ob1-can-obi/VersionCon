import * as vscode from 'vscode';

/**
 * Phase 4.3 SC-2: 7 git-style aliases that forward to canonical handlers.
 *
 * Pure routing — adding behavior to any of these MUST happen in the canonical
 * command, never here. Each alias is a thin async pass-through that calls
 * vscode.commands.executeCommand on the existing canonical command id, so
 * permission gates, error handling, and UI side-effects all stay in one
 * place (the canonical handler).
 *
 * Mapping (defined by 04.3-01-PLAN.md must_haves):
 *   versioncon.cmd.push     → versioncon.push
 *   versioncon.cmd.pull     → versioncon.sync
 *   versioncon.cmd.checkout → versioncon.switchBranch
 *   versioncon.cmd.branch   → versioncon.createBranch
 *   versioncon.cmd.log      → versioncon.showPushHistory
 *   versioncon.cmd.diff     → versioncon.previewDiff
 *   versioncon.cmd.merge    → versioncon.mergeBranch
 *
 * The `cmd.` infix keeps the alias namespace unambiguous and avoids any
 * collision with the canonical command ids declared in package.json
 * (e.g. `versioncon.push` is the canonical push handler — the alias is
 * `versioncon.cmd.push`).
 */
export function registerGitStyleAliases(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('versioncon.cmd.push', () =>
      vscode.commands.executeCommand('versioncon.push'),
    ),
    vscode.commands.registerCommand('versioncon.cmd.pull', () =>
      vscode.commands.executeCommand('versioncon.sync'),
    ),
    vscode.commands.registerCommand('versioncon.cmd.checkout', () =>
      vscode.commands.executeCommand('versioncon.switchBranch'),
    ),
    vscode.commands.registerCommand('versioncon.cmd.branch', () =>
      vscode.commands.executeCommand('versioncon.createBranch'),
    ),
    vscode.commands.registerCommand('versioncon.cmd.log', () =>
      vscode.commands.executeCommand('versioncon.showPushHistory'),
    ),
    vscode.commands.registerCommand('versioncon.cmd.diff', () =>
      vscode.commands.executeCommand('versioncon.previewDiff'),
    ),
    vscode.commands.registerCommand('versioncon.cmd.merge', () =>
      vscode.commands.executeCommand('versioncon.mergeBranch'),
    ),
  );
}
