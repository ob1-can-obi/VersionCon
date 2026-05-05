import * as vscode from 'vscode';
import type { ConnectionStatus } from '../types/session.js';

/**
 * Manages the VS Code status bar item showing connection state.
 *
 * Always visible (per NET-05). Displays three states per D-10:
 * - Connected: green circle, session name tooltip
 * - Reconnecting: yellow spinning sync icon
 * - Disconnected: gray outline circle
 *
 * Clicking the status bar item reveals the sidebar (versioncon.showSidebar).
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.setStatus('disconnected');
    this.item.show();
  }

  /**
   * Update the status bar to reflect the current connection state.
   * @param status - One of 'connected', 'reconnecting', or 'disconnected'
   * @param sessionName - Optional session name shown in tooltip when connected
   */
  setStatus(status: ConnectionStatus, sessionName?: string): void {
    switch (status) {
      case 'connected':
        this.item.text = '$(circle-filled) VersionCon';
        this.item.color = new vscode.ThemeColor('testing.iconPassed');
        this.item.tooltip = sessionName
          ? `Connected to ${sessionName}`
          : 'Connected to session';
        break;

      case 'reconnecting':
        this.item.text = '$(sync~spin) VersionCon';
        this.item.color = new vscode.ThemeColor('editorWarning.foreground');
        this.item.tooltip = 'Reconnecting...';
        break;

      case 'disconnected':
        this.item.text = '$(circle-outline) VersionCon';
        this.item.color = new vscode.ThemeColor('disabledForeground');
        this.item.tooltip = 'Not connected';
        break;
    }

    this.item.command = 'versioncon.showSidebar';
  }

  dispose(): void {
    this.item.dispose();
  }
}
