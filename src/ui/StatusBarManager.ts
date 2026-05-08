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
 *
 * Phase 4 additions (UI-SPEC §1.4 / §2.5 / §6.2):
 *  - {@link flashNoImpact}: 5s green status flash when a remote push touched no
 *    locally-open file (CONF-08).
 *  - {@link setUnreadCount}: appends `$(comment) N` to connected status when N>0
 *    and swaps the click command to `versioncon.openChat`.
 *  - syncWarningActive precedence: sync warning beats both new methods. While
 *    syncWarningActive is true, flashNoImpact returns early and setUnreadCount
 *    only stores the count (re-applies when warning clears).
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private currentStatus: ConnectionStatus = 'disconnected';
  private currentSessionName: string | undefined;
  /** UI-SPEC §1.4 precedence flag — gates flashNoImpact / unread-overlay re-apply. */
  private syncWarningActive: boolean = false;
  /** Last setUnreadCount(N) value — preserved across status transitions. */
  private unreadCount: number = 0;

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
    this.currentStatus = status;
    this.currentSessionName = sessionName;
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

    // Phase 4: re-apply unread badge if non-zero AND not in sync-warning mode.
    // applyUnreadOverlay only mutates `item` (no recursion via setStatus).
    if (this.unreadCount > 0 && !this.syncWarningActive && status === 'connected') {
      this.applyUnreadOverlay();
    }
  }

  /**
   * Show or hide a sync warning indicator (PUSH-09).
   * When show=true, replaces the status bar text/color with a warning.
   * When show=false, re-applies the current connection status so the
   * warning text disappears immediately (used after a successful Sync).
   *
   * Phase 4 (UI-SPEC §1.4): updates `syncWarningActive` so flashNoImpact
   * and the unread badge can defer to the warning's precedence.
   */
  setSyncWarning(show: boolean): void {
    this.syncWarningActive = show;
    if (show) {
      this.item.text = '$(warning) VersionCon — may be out of sync';
      this.item.color = new vscode.ThemeColor('editorWarning.foreground');
      this.item.tooltip = 'Workspace may be out of sync. Run VersionCon: Sync to pull.';
      return;
    }
    this.setStatus(this.currentStatus, this.currentSessionName);
  }

  /**
   * Flash a green "no impact" status for `durationMs` (default 5000ms),
   * then revert to the current connection status (CONF-08, UI-SPEC §6.2).
   *
   * Per UI-SPEC §1.4: gated by `syncWarningActive` — sync warning beats flash.
   * Pluralization: N === 1 renders "1 file unaffected"; otherwise "N file(s) unaffected".
   */
  flashNoImpact(unaffectedCount: number, durationMs: number = 5000): void {
    if (this.syncWarningActive) return; // sync warning beats flash
    const fileWord = unaffectedCount === 1
      ? '1 file unaffected'
      : `${unaffectedCount} file(s) unaffected`;
    this.item.text = `$(check) VersionCon — no impact (${fileWord})`;
    this.item.color = new vscode.ThemeColor('testing.iconPassed');
    this.item.tooltip = 'Recent push did not affect any of your open files';
    setTimeout(() => {
      // Re-applying setStatus restores both text/color AND the unread badge if any.
      this.setStatus(this.currentStatus, this.currentSessionName);
    }, durationMs);
  }

  /**
   * Set the unread chat message count (UI-SPEC §6.2).
   *
   * - n > 0 + connected + no sync warning: append "$(comment) N" to status text;
   *   swap click command to `versioncon.openChat`; tooltip shows the count.
   * - n === 0: revert via setStatus(currentStatus, currentSessionName).
   * - sync warning active: store the count, suppress visual badge; will re-apply
   *   when the warning clears (UI-SPEC §1.4 precedence).
   */
  setUnreadCount(n: number): void {
    this.unreadCount = Math.max(0, n);
    if (this.syncWarningActive) return; // sync warning hides the badge
    if (this.unreadCount > 0 && this.currentStatus === 'connected') {
      this.applyUnreadOverlay();
    } else {
      // Revert to clean status (also handles disconnect / reconnecting cases).
      this.setStatus(this.currentStatus, this.currentSessionName);
    }
  }

  /**
   * Internal helper — applies "$(circle-filled) VersionCon $(comment) N" + openChat command.
   * Mutates `item` directly without recursing back through setStatus.
   */
  private applyUnreadOverlay(): void {
    this.item.text = `$(circle-filled) VersionCon $(comment) ${this.unreadCount}`;
    this.item.tooltip = `${this.unreadCount} unread message(s) — click to open chat`;
    this.item.command = 'versioncon.openChat';
  }

  // ----- Test helpers (Phase 4 unit tests) -----

  /** Test-only: read raw item text for assertion. */
  getItemTextForTest(): string {
    return this.item.text;
  }

  /** Test-only: read raw item command id for assertion. */
  getItemCommandForTest(): string | vscode.Command | undefined {
    return this.item.command;
  }

  dispose(): void {
    this.item.dispose();
  }
}
