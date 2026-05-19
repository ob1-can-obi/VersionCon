import * as vscode from 'vscode';
import type { ConnectionStatus } from '../types/session.js';

/**
 * Cloud-mode connection substates (Phase 7, UI-SPEC §StatusBar).
 *
 * Distinct from {@link ConnectionStatus} (the LAN-mode 3-state union) — cloud
 * states live on a separate axis tracked by {@link StatusBarManager.currentCloudState}.
 * The legacy {@link StatusBarManager.setStatus} API is preserved verbatim for LAN
 * mode and is unaware of cloud state.
 *
 * Close-code → state mapping is OWNED BY THE CALLER (CloudTransport, plan 07-04
 * exports `mapCloseCodeToState`). This module only renders.
 */
export type CloudConnectionState = 'connected' | 'relay-unreachable' | 'session-not-found';

/**
 * Tooltip-substitution payload for {@link StatusBarManager.setCloudStatus}.
 *
 * Required fields (sessionId, relayUrl) appear in tooltips for all 3 cloud
 * states. Optional fields fill state-specific placeholders per UI-SPEC §StatusBar:
 *   - sessionName + memberCount → `connected` tooltip
 *   - reconnectAttempt + reconnectInSeconds → `relay-unreachable` tooltip
 *   - sessionId → `session-not-found` tooltip (also rendered)
 */
export interface CloudStatusContext {
  /** Session identifier (e.g. `vc-7f3a92`) — rendered in session-not-found tooltip. */
  sessionId: string;
  /** Relay URL (e.g. `wss://relay.fly.dev`) — rendered in all 3 cloud tooltips. */
  relayUrl: string;
  /** Optional friendly session name (used in `connected` tooltip). */
  sessionName?: string;
  /** Optional member count (used in `connected` tooltip). */
  memberCount?: number;
  /** Optional reconnect attempt number (used in `relay-unreachable` tooltip). */
  reconnectAttempt?: number;
  /** Optional seconds until next reconnect (used in `relay-unreachable` tooltip). */
  reconnectInSeconds?: number;
}

/**
 * Manages the VS Code status bar item showing connection state.
 *
 * Always visible (per NET-05). Phase 1/3/4 LAN states (per D-10):
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
 *
 * Phase 7 additions (UI-SPEC §StatusBar — 3 cloud states):
 *  - {@link setCloudStatus}: renders one of 3 cloud substates (connected /
 *    relay-unreachable / session-not-found) with byte-identical UI-SPEC text,
 *    theme-aware colors, and substituted tooltips.
 *  - Precedence rules (UI-SPEC §StatusBar):
 *      1. sync warning BEATS every cloud state — setSyncWarning(true) wins
 *      2. cloud-connected LAYERS the unread overlay when unreadCount > 0
 *      3. cloud-relay-unreachable / cloud-session-not-found SUPPRESS the unread
 *         overlay (terminal-like states; mirrors the LAN reconnecting/disconnected
 *         rule that the badge only shows on `connected`)
 *      4. setSyncWarning(false) re-applies the LAST set state — cloud if a cloud
 *         state was active, LAN otherwise (currentCloudState !== null branch)
 *  - {@link setStatus} CLEARS cloud-state memory so callers that explicitly
 *    switch back to LAN don't get cloud re-applied on the next setSyncWarning
 *    toggle.
 *
 * Phase 4.3 LocalChangesStatusBar is a SEPARATE StatusBarItem owned outside this
 * class and is untouched by Phase 7. UI-SPEC §StatusBar precedence rule 3.
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private currentStatus: ConnectionStatus = 'disconnected';
  private currentSessionName: string | undefined;
  /** UI-SPEC §1.4 precedence flag — gates flashNoImpact / unread-overlay re-apply. */
  private syncWarningActive: boolean = false;
  /** Last setUnreadCount(N) value — preserved across status transitions. */
  private unreadCount: number = 0;

  // ----- Phase 7 cloud-state tracking -----

  /**
   * Last cloud state passed to {@link setCloudStatus}, or `null` if the manager
   * is in LAN mode (last call was {@link setStatus}). The setSyncWarning(false)
   * re-apply path branches on this field — cloud state if non-null, LAN otherwise.
   */
  private currentCloudState: CloudConnectionState | null = null;

  /** Last context passed to {@link setCloudStatus}; null when in LAN mode. */
  private currentCloudContext: CloudStatusContext | null = null;

  /** Test-only counter — incremented every time {@link writeText} actually writes. */
  private textAssignmentCount: number = 0;

  /** Idempotency guard — skip the underlying item.text write when unchanged. */
  private lastAppliedText: string = '';

  /** Idempotency guard — skip the underlying item.tooltip write when unchanged. */
  private lastAppliedTooltip: string = '';

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.setStatus('disconnected');
    this.item.show();
  }

  /**
   * Update the status bar to reflect the current LAN connection state.
   *
   * Phase 7: calling this method CLEARS cloud-state memory (currentCloudState +
   * currentCloudContext) — explicit LAN switch is interpreted as "abandon cloud
   * mode," so the next setSyncWarning(false) re-apply path stays on LAN.
   *
   * @param status - One of 'connected', 'reconnecting', or 'disconnected'
   * @param sessionName - Optional session name shown in tooltip when connected
   */
  setStatus(status: ConnectionStatus, sessionName?: string): void {
    // Clear cloud-state memory — caller is explicitly switching back to LAN.
    this.currentCloudState = null;
    this.currentCloudContext = null;

    this.currentStatus = status;
    this.currentSessionName = sessionName;

    let text: string;
    let colorId: string;
    let tooltip: string;
    switch (status) {
      case 'connected':
        text = '$(circle-filled) VersionCon';
        colorId = 'testing.iconPassed';
        tooltip = sessionName
          ? `Connected to ${sessionName}`
          : 'Connected to session';
        break;
      case 'reconnecting':
        text = '$(sync~spin) VersionCon';
        colorId = 'editorWarning.foreground';
        tooltip = 'Reconnecting...';
        break;
      case 'disconnected':
        text = '$(circle-outline) VersionCon';
        colorId = 'disabledForeground';
        tooltip = 'Not connected';
        break;
    }

    // Phase 4: layer the unread badge inline (no separate applyUnreadOverlay
    // call needed — keeps the renderer cohesive and the assignment counter
    // accurate). UI-SPEC §6.2.
    let command = 'versioncon.showSidebar';
    if (this.unreadCount > 0 && !this.syncWarningActive && status === 'connected') {
      text = `${text} $(comment) ${this.unreadCount}`;
      tooltip = `${this.unreadCount} unread message(s) — click to open chat`;
      command = 'versioncon.openChat';
    }

    this.writeText(text);
    this.writeColor(new vscode.ThemeColor(colorId));
    this.writeTooltip(tooltip);
    this.writeCommand(command);
  }

  /**
   * Show or hide a sync warning indicator (PUSH-09, UI-SPEC §1.4).
   *
   * When show=true, replaces the status bar text/color with a warning.
   * When show=false, re-applies whichever state was last active:
   *   - cloud state if {@link currentCloudState} is non-null (cloud user)
   *   - LAN state via {@link setStatus} otherwise
   *
   * Phase 4 (UI-SPEC §1.4): updates `syncWarningActive` so flashNoImpact
   * and the unread badge can defer to the warning's precedence.
   *
   * Phase 7: the re-apply branch on currentCloudState prevents cloud users
   * from being downgraded to `$(circle-filled) VersionCon` after a sync
   * warning clears. UI-SPEC §StatusBar precedence rule 4.
   */
  setSyncWarning(show: boolean): void {
    this.syncWarningActive = show;
    if (show) {
      this.writeText('$(warning) VersionCon — may be out of sync');
      this.writeColor(new vscode.ThemeColor('editorWarning.foreground'));
      this.writeTooltip('Workspace may be out of sync. Run VersionCon: Sync to pull.');
      return;
    }
    // Re-apply path: cloud user → applyCloudStatus; LAN user → setStatus.
    if (this.currentCloudState !== null) {
      this.applyCloudStatus();
    } else {
      this.setStatus(this.currentStatus, this.currentSessionName);
    }
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
    this.writeText(`$(check) VersionCon — no impact (${fileWord})`);
    this.writeColor(new vscode.ThemeColor('testing.iconPassed'));
    this.writeTooltip('Recent push did not affect any of your open files');
    setTimeout(() => {
      // Re-apply whichever state was active before the flash.
      if (this.currentCloudState !== null) {
        this.applyCloudStatus();
      } else {
        this.setStatus(this.currentStatus, this.currentSessionName);
      }
    }, durationMs);
  }

  /**
   * Set the unread chat message count (UI-SPEC §6.2).
   *
   * - n > 0 + connected (LAN or cloud) + no sync warning: append "$(comment) N"
   *   to status text; swap click command to `versioncon.openChat`; tooltip
   *   shows the count.
   * - n === 0: revert by re-applying the active state (LAN setStatus or cloud
   *   applyCloudStatus).
   * - sync warning active: store the count, suppress visual badge; will re-apply
   *   when the warning clears (UI-SPEC §1.4 precedence).
   * - cloud-relay-unreachable / cloud-session-not-found: SUPPRESS the badge —
   *   you cannot read chat while disconnected (UI-SPEC §StatusBar rule 3).
   */
  setUnreadCount(n: number): void {
    this.unreadCount = Math.max(0, n);
    if (this.syncWarningActive) return; // sync warning hides the badge

    // Re-apply the active state so the renderer picks up the new unreadCount
    // and applies its own precedence logic (cloud terminal states suppress;
    // LAN/cloud connected layers).
    if (this.currentCloudState !== null) {
      this.applyCloudStatus();
    } else {
      this.setStatus(this.currentStatus, this.currentSessionName);
    }
  }

  /**
   * Phase 7 — surface the 3 cloud-mode connection substates (UI-SPEC §StatusBar).
   *
   * Renders one of three byte-identical UI-SPEC strings with theme-aware colors:
   *   - `connected`         → `$(cloud) VersionCon — connected`
   *   - `relay-unreachable` → `$(warning) VersionCon — relay unreachable`
   *   - `session-not-found` → `$(error) VersionCon — session not found`
   *
   * Tooltip placeholders ({sessionName}, {relayUrl}, {memberCount},
   * {reconnectAttempt}, {reconnectInSeconds}, {sessionId}) are substituted from
   * the supplied {@link CloudStatusContext}.
   *
   * Precedence (UI-SPEC §StatusBar):
   *   1. sync warning beats cloud — if syncWarningActive, the cloud state is
   *      stored for later re-apply but NOT rendered.
   *   2. cloud-connected + unreadCount > 0 → layers `$(comment) N`.
   *   3. cloud-relay-unreachable / cloud-session-not-found → suppresses unread.
   *
   * Idempotency: a deep-equal repeat call (same state + same context fields)
   * short-circuits at the writeText layer — {@link getTextAssignmentCountForTest}
   * confirms only one underlying item.text write per unique render.
   */
  setCloudStatus(state: CloudConnectionState, context: CloudStatusContext): void {
    this.currentCloudState = state;
    this.currentCloudContext = context;

    // Sync warning takes precedence — store but defer rendering.
    if (this.syncWarningActive) return;

    this.applyCloudStatus();
  }

  /**
   * Internal renderer — applies {@link currentCloudState} + {@link currentCloudContext}
   * to the underlying StatusBarItem, layering the unread overlay if applicable.
   *
   * Caller (setCloudStatus / setSyncWarning(false) / flashNoImpact timer) is
   * responsible for ensuring this is only called when currentCloudState !== null.
   */
  private applyCloudStatus(): void {
    if (this.currentCloudState === null || this.currentCloudContext === null) return;

    let text: string;
    let colorId: string;
    let tooltip: string;
    const ctx = this.currentCloudContext;

    switch (this.currentCloudState) {
      case 'connected':
        // U+2014 em-dash — must match UI-SPEC byte-for-byte.
        text = '$(cloud) VersionCon — connected';
        colorId = 'testing.iconPassed';
        tooltip = `Cloud session: ${ctx.sessionName ?? '—'}\nRelay: ${ctx.relayUrl}\nMembers: ${ctx.memberCount ?? 1}`;
        break;
      case 'relay-unreachable':
        text = '$(warning) VersionCon — relay unreachable';
        colorId = 'editorWarning.foreground';
        // U+2026 ellipsis, U+221E infinity — literal Unicode per UI-SPEC.
        tooltip = `Lost connection to relay ${ctx.relayUrl}.\nReconnecting in ${ctx.reconnectInSeconds ?? 0}s… (attempt ${ctx.reconnectAttempt ?? 1} of ∞)`;
        break;
      case 'session-not-found':
        text = '$(error) VersionCon — session not found';
        colorId = 'errorForeground';
        tooltip = `Session ${ctx.sessionId} not found on relay ${ctx.relayUrl}.\nThe host may have ended the session. Click to leave.`;
        break;
    }

    // Cloud-connected layers the unread overlay; the two terminal states
    // SUPPRESS it (UI-SPEC §StatusBar precedence rule 3 — mirrors LAN
    // reconnecting/disconnected behavior).
    let command = 'versioncon.showSidebar';
    if (this.currentCloudState === 'connected' && this.unreadCount > 0 && !this.syncWarningActive) {
      text = `${text} $(comment) ${this.unreadCount}`;
      tooltip = `${this.unreadCount} unread message(s) — click to open chat`;
      command = 'versioncon.openChat';
    }

    this.writeText(text);
    this.writeColor(new vscode.ThemeColor(colorId));
    this.writeTooltip(tooltip);
    this.writeCommand(command);
  }

  // ----- Idempotent write helpers -----

  /**
   * Writes to {@link item.text} only when the new value differs from
   * {@link lastAppliedText}. Increments {@link textAssignmentCount} on every
   * actual write — drives the {@link getTextAssignmentCountForTest} test helper
   * for idempotency assertions.
   */
  private writeText(text: string): void {
    if (this.lastAppliedText === text) return;
    this.item.text = text;
    this.lastAppliedText = text;
    this.textAssignmentCount++;
  }

  /**
   * Writes to {@link item.tooltip} only when the new value differs. Tooltip
   * writes are NOT counted by textAssignmentCount — the idempotency contract
   * pinned by test 15 is specifically about the text layer.
   */
  private writeTooltip(tooltip: string): void {
    if (this.lastAppliedTooltip === tooltip) return;
    this.item.tooltip = tooltip;
    this.lastAppliedTooltip = tooltip;
  }

  /** Writes to {@link item.color}. ThemeColor identity check would require a deep
   * compare; the underlying VS Code field write is cheap, so we just write. */
  private writeColor(color: vscode.ThemeColor): void {
    this.item.color = color;
  }

  /** Writes to {@link item.command}. Cheap write, no guard. */
  private writeCommand(cmd: string): void {
    this.item.command = cmd;
  }

  // ----- Test helpers (Phase 4 + Phase 7 unit tests) -----

  /** Test-only: read raw item text for assertion. */
  getItemTextForTest(): string {
    return this.item.text;
  }

  /** Test-only: read raw item command id for assertion. */
  getItemCommandForTest(): string | vscode.Command | undefined {
    return this.item.command;
  }

  /** Test-only (Phase 7): read item.color's ThemeColor id, or undefined. */
  getItemColorIdForTest(): string | undefined {
    const c = this.item.color;
    if (c && typeof c === 'object' && 'id' in c) {
      return (c as { id: string }).id;
    }
    return undefined;
  }

  /** Test-only (Phase 7): read item.tooltip as a string, or undefined if non-string. */
  getItemTooltipForTest(): string | undefined {
    const t = this.item.tooltip;
    return typeof t === 'string' ? t : undefined;
  }

  /** Test-only (Phase 7): count of underlying item.text assignments since construction. */
  getTextAssignmentCountForTest(): number {
    return this.textAssignmentCount;
  }

  dispose(): void {
    this.item.dispose();
  }
}
