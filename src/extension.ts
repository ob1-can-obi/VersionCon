import * as vscode from 'vscode';

/**
 * Called when the extension is activated.
 * Activation occurs when the sidebar view is opened or a command is invoked.
 */
export function activate(context: vscode.ExtensionContext): void {
  const hostSession = vscode.commands.registerCommand(
    'versioncon.hostSession',
    () => {
      vscode.window.showInformationMessage(
        'Host Session - coming in Plan 04'
      );
    }
  );

  const joinSession = vscode.commands.registerCommand(
    'versioncon.joinSession',
    () => {
      vscode.window.showInformationMessage(
        'Join Session - coming in Plan 05'
      );
    }
  );

  const showSidebar = vscode.commands.registerCommand(
    'versioncon.showSidebar',
    () => {
      vscode.commands.executeCommand('versioncon.sidebar.focus');
    }
  );

  context.subscriptions.push(hostSession, joinSession, showSidebar);
}

/**
 * Called when the extension is deactivated.
 * Cleanup is handled via disposables pushed to context.subscriptions.
 */
export function deactivate(): void {
  // Cleanup handled by disposables
}
