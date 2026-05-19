import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SessionClient } from '../client/SessionClient.js';
import { SessionHistory } from '../storage/SessionHistory.js';
import { SecretStore } from '../storage/SecretStore.js';
import { DiscoveryManager } from '../network/discovery.js';
import { CloudTransport } from '../network/CloudTransport.js';
import type { SavedSession } from '../types/session.js';
import type { DiscoveredSession } from '../network/discovery.js';

interface JoinState {
  hostIp: string;
  port: string;
  inviteCode: string;
  displayName: string;
  recentSessions: SavedSession[];
  discoveredSessions: DiscoveredSession[];
  isConnecting: boolean;
  error: string | null;
  // Phase 7 (Plan 07-06, per D-09 + UI-SPEC §JoinPanel Connection Method):
  mode: 'lan' | 'cloud';     // default 'lan' — back-compat for existing flow
  relayUrl: string;          // Cloud branch only
  sessionId: string;         // Cloud branch only
}

/**
 * Phase 7 (Plan 07-06): prefill struct passed by VersionConUriHandler when an
 * incoming `vscode://versioncon.versioncon/join?relay=...&session=...&code=...`
 * deep-link is accepted by the user.
 *
 * NOTE: NO `displayName` field — Phase 4.1 invariant ("displayName is always
 * self-attested by the active user"). The joiner must type their displayName
 * in the panel after it opens, even when arriving via deep-link.
 */
export interface JoinPrefill {
  mode: 'cloud';
  relayUrl: string;
  sessionId: string;
  inviteCode: string;
}

export class JoinPanel {
  static currentPanel: JoinPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private state: JoinState;
  private readonly context: vscode.ExtensionContext;
  private readonly sessionHistory: SessionHistory;
  private readonly onConnectedCallback: (client: SessionClient) => void;
  private readonly discoveryManager: DiscoveryManager;
  private readonly secretStore: SecretStore;
  private readonly disposables: vscode.Disposable[] = [];

  static async createOrShow(
    context: vscode.ExtensionContext,
    sessionHistory: SessionHistory,
    onConnected: (client: SessionClient) => void,
  ): Promise<void> {
    if (JoinPanel.currentPanel) {
      JoinPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'versioncon.join',
      'VersionCon: Join Session',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'src', 'ui', 'webview', 'join'),
        ],
      },
    );

    new JoinPanel(panel, context, sessionHistory, onConnected);
  }

  /**
   * Phase 7 (Plan 07-06): entry point used by VersionConUriHandler after a
   * vscode:// deep-link is accepted by the user (T-07-10 confirmation gate
   * lives in extension.ts, not here — by the time this is invoked the user
   * has explicitly clicked "Join" in the confirmation prompt).
   *
   * Opens (or reveals) the JoinPanel and pre-fills the Cloud-branch fields.
   * NEVER pre-fills displayName — Phase 4.1 invariant; user types it in the
   * webview after the panel opens.
   */
  static async openPrefilled(
    context: vscode.ExtensionContext,
    sessionHistory: SessionHistory,
    onConnected: (client: SessionClient) => void,
    prefill: JoinPrefill,
  ): Promise<void> {
    // If a panel is already open: reveal + apply prefill onto its state.
    if (JoinPanel.currentPanel) {
      JoinPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      JoinPanel.currentPanel.applyPrefill(prefill);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'versioncon.join',
      'VersionCon: Join Session',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'src', 'ui', 'webview', 'join'),
        ],
      },
    );

    const instance = new JoinPanel(panel, context, sessionHistory, onConnected);
    instance.applyPrefill(prefill);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    sessionHistory: SessionHistory,
    onConnected: (client: SessionClient) => void,
  ) {
    this.panel = panel;
    this.context = context;
    this.sessionHistory = sessionHistory;
    this.onConnectedCallback = onConnected;
    this.discoveryManager = new DiscoveryManager();
    this.secretStore = new SecretStore(context);

    JoinPanel.currentPanel = this;

    // Build initial state with session history
    this.state = {
      hostIp: '',
      port: '',
      inviteCode: '',
      displayName: '',
      recentSessions: sessionHistory.getHistory(),
      discoveredSessions: [],
      isConnecting: false,
      error: null,
      // Phase 7 (Plan 07-06): default to LAN — back-compat for existing flow.
      mode: 'lan',
      relayUrl: '',
      sessionId: '',
    };

    // Start mDNS browse (non-blocking)
    this.discoveryManager.browseSessions(
      (session) => {
        // Avoid duplicates
        const exists = this.state.discoveredSessions.some(
          (s) => s.host === session.host && s.port === session.port,
        );
        if (!exists) {
          this.state.discoveredSessions.push(session);
          this.sendStateUpdate();
        }
      },
      () => {
        // Browse timeout - no action needed
      },
    );

    this.panel.webview.html = this.getWebviewContent();

    this.panel.webview.onDidReceiveMessage(
      (msg: unknown) => { this.handleMessage(msg); },
      null,
      this.disposables,
    );

    this.panel.onDidDispose(
      () => { this.dispose(); },
      null,
      this.disposables,
    );
  }

  private getWebviewContent(): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');

    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'src', 'ui', 'webview', 'join', 'join.css'),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'src', 'ui', 'webview', 'join', 'join.js'),
    );

    const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;

    const templatePath = path.join(
      this.context.extensionUri.fsPath, 'src', 'ui', 'webview', 'join', 'join.html',
    );

    let html: string;
    try {
      html = fs.readFileSync(templatePath, 'utf-8');
    } catch {
      html = [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '  <meta charset="UTF-8">',
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
        '  <meta http-equiv="Content-Security-Policy" content="%%CSP%%">',
        '  <link href="%%CSS_URI%%" rel="stylesheet">',
        '  <title>VersionCon: Join Session</title>',
        '</head>',
        '<body>',
        '  <div id="join-root"></div>',
        '  <script nonce="%%NONCE%%" src="%%JS_URI%%"></script>',
        '</body>',
        '</html>',
      ].join('\n');
    }

    html = html.replace(/%%CSP%%/g, csp);
    html = html.replace(/%%NONCE%%/g, nonce);
    html = html.replace(/%%CSS_URI%%/g, cssUri.toString());
    html = html.replace(/%%JS_URI%%/g, jsUri.toString());

    return html;
  }

  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const message = msg as Record<string, unknown>;
    const type = message.type;
    if (typeof type !== 'string') return;

    switch (type) {
      case 'webview-ready':
        this.sendStateUpdate();
        break;
      case 'join-connect':
        void this.handleJoinConnect(message.payload as Record<string, unknown>);
        break;
      case 'join-quick-connect':
        void this.handleQuickConnect(message.payload as Record<string, unknown>);
        break;
      case 'join-select-discovered':
        this.handleSelectDiscovered(message.payload as Record<string, unknown>);
        break;
      case 'join-remove-history':
        void this.handleRemoveHistory(message.payload as Record<string, unknown>);
        break;
      case 'join-mode-change': {
        // Phase 7 (Plan 07-06): user toggled the Connection method radio.
        const mode = (message.payload as Record<string, unknown> | undefined)?.mode;
        if (mode === 'lan' || mode === 'cloud') {
          this.state.mode = mode;
          this.state.error = null;  // clear cross-mode validation noise
          this.sendStateUpdate();
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Phase 7 (Plan 07-06): merge a UriHandler-supplied prefill into the current
   * state and re-render. displayName is intentionally NOT included on
   * JoinPrefill so this method cannot leak an attacker-controlled name from
   * the deep-link URI into the user's identity (T-07-10c mitigation).
   */
  private applyPrefill(prefill: JoinPrefill): void {
    this.state.mode = prefill.mode;
    this.state.relayUrl = prefill.relayUrl;
    this.state.sessionId = prefill.sessionId;
    this.state.inviteCode = prefill.inviteCode;
    this.state.error = null;
    this.sendStateUpdate();
  }

  private async handleJoinConnect(payload: Record<string, unknown> | undefined): Promise<void> {
    if (!payload) return;

    const mode = payload.mode === 'cloud' ? 'cloud' : 'lan';
    const inviteCode = typeof payload.inviteCode === 'string' ? payload.inviteCode.trim() : '';
    const displayName = typeof payload.displayName === 'string' ? payload.displayName.trim() : '';

    // Phase 7 (Plan 07-06): dispatch on mode. Cloud branch validates relayUrl
    // + sessionId before constructing a CloudTransport-backed SessionClient.
    if (mode === 'cloud') {
      const relayUrl = typeof payload.relayUrl === 'string' ? payload.relayUrl.trim() : '';
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';

      // Cloud-branch validation (UI-SPEC literals).
      if (!relayUrl.startsWith('wss://')) {
        this.state.error = 'Relay URL must start with wss://.';
        this.sendStateUpdate();
        return;
      }
      if (!sessionId) {
        this.state.error = 'Session ID is required.';
        this.sendStateUpdate();
        return;
      }
      if (!inviteCode) {
        this.state.error = 'Invite code is required.';
        this.sendStateUpdate();
        return;
      }
      if (!displayName) {
        this.state.error = 'Display name is required.';
        this.sendStateUpdate();
        return;
      }

      this.state.isConnecting = true;
      this.state.error = null;
      this.sendStateUpdate();

      try {
        // Token is empty for now — Phase 7 D-06 has the host issue the
        // joiner's JWT in response to the auth-request frame. 07-04's
        // CloudTransport carries the token in the WSS Authorization header
        // for the relay handshake; that wiring lands in a later host-side
        // plan. We currently pass '' and let the relay (when it exists)
        // bounce the connection — the protocol-level auth-request flow
        // remains unchanged.
        const transport = new CloudTransport(relayUrl, sessionId, '');
        // SessionClient.transport seam — host-IP and port are ignored when a
        // cloud transport is injected (07-01 D-05). Pass relayUrl / 0 as
        // structurally-valid placeholders so the typed contract is satisfied.
        const client = new SessionClient(relayUrl, 0, inviteCode, displayName, transport);
        const connected = await client.connect();

        if (connected) {
          const sessionName = client.getSessionInfo()?.name ?? 'Session';
          await this.sessionHistory.addEntry({
            hostIp: relayUrl,
            port: 0,
            sessionName,
            displayName,
          });
          await this.secretStore.storeInviteCode(sessionName, inviteCode);

          this.onConnectedCallback(client);
          this.panel.dispose();
        } else {
          this.state.isConnecting = false;
          this.state.error = 'Authentication failed. Check your invite code.';
          this.sendStateUpdate();
        }
      } catch (err) {
        this.state.isConnecting = false;
        this.state.error = err instanceof Error ? err.message : 'Connection failed.';
        this.sendStateUpdate();
      }
      return;
    }

    // LAN branch — existing behavior preserved verbatim.
    const hostIp = typeof payload.hostIp === 'string' ? payload.hostIp.trim() : '';
    const port = parseInt(String(payload.port), 10);

    // Validate (T-01-16)
    if (!hostIp) {
      this.state.error = 'Host IP is required.';
      this.sendStateUpdate();
      return;
    }
    if (isNaN(port) || port < 1 || port > 65535) {
      this.state.error = 'Port must be between 1 and 65535.';
      this.sendStateUpdate();
      return;
    }
    if (!inviteCode) {
      this.state.error = 'Invite code is required.';
      this.sendStateUpdate();
      return;
    }
    if (!displayName) {
      this.state.error = 'Display name is required.';
      this.sendStateUpdate();
      return;
    }

    this.state.isConnecting = true;
    this.state.error = null;
    this.sendStateUpdate();

    try {
      const client = new SessionClient(hostIp, port, inviteCode, displayName);
      const connected = await client.connect();

      if (connected) {
        // Save to history for quick reconnect (NET-04, D-08)
        const sessionName = client.getSessionInfo()?.name ?? 'Session';
        await this.sessionHistory.addEntry({
          hostIp,
          port,
          sessionName,
          displayName,
        });

        // Store invite code securely for future quick-connect (T-01-11)
        await this.secretStore.storeInviteCode(sessionName, inviteCode);

        this.onConnectedCallback(client);
        this.panel.dispose();
      } else {
        this.state.isConnecting = false;
        this.state.error = 'Authentication failed. Check your invite code.';
        this.sendStateUpdate();
      }
    } catch (err) {
      this.state.isConnecting = false;
      this.state.error = err instanceof Error ? err.message : 'Connection failed.';
      this.sendStateUpdate();
    }
  }

  private async handleQuickConnect(payload: Record<string, unknown> | undefined): Promise<void> {
    if (!payload) return;
    // Pre-fill from saved session and connect
    const hostIp = typeof payload.hostIp === 'string' ? payload.hostIp : '';
    const port = typeof payload.port === 'number' ? payload.port : parseInt(String(payload.port), 10);
    const displayName = typeof payload.displayName === 'string' ? payload.displayName : '';
    const inviteCode = typeof payload.inviteCode === 'string' ? payload.inviteCode.trim() : '';
    const sessionName = typeof payload.sessionName === 'string' ? payload.sessionName : '';

    // If no invite code provided in payload, try SecretStore (T-01-11 compliant)
    let resolvedInviteCode = inviteCode;
    if (!resolvedInviteCode && sessionName) {
      const stored = await this.secretStore.getInviteCode(sessionName);
      if (stored) {
        resolvedInviteCode = stored;
      }
    }

    if (!resolvedInviteCode) {
      // If still no invite code, fill the form fields
      this.state.hostIp = hostIp;
      this.state.port = String(port);
      this.state.displayName = displayName;
      this.state.error = 'Enter the invite code to reconnect.';
      this.sendStateUpdate();
      return;
    }

    await this.handleJoinConnect({ hostIp, port, inviteCode: resolvedInviteCode, displayName });
  }

  private handleSelectDiscovered(payload: Record<string, unknown> | undefined): void {
    if (!payload) return;
    if (typeof payload.host === 'string') {
      this.state.hostIp = payload.host;
    }
    if (typeof payload.port === 'number') {
      this.state.port = String(payload.port);
    }
    this.sendStateUpdate();
  }

  private async handleRemoveHistory(payload: Record<string, unknown> | undefined): Promise<void> {
    if (!payload) return;
    const hostIp = typeof payload.hostIp === 'string' ? payload.hostIp : '';
    const port = typeof payload.port === 'number' ? payload.port : parseInt(String(payload.port), 10);
    if (hostIp && !isNaN(port)) {
      await this.sessionHistory.removeEntry(hostIp, port);
      this.state.recentSessions = this.sessionHistory.getHistory();
      this.sendStateUpdate();
    }
  }

  private sendStateUpdate(): void {
    void this.panel.webview.postMessage({ type: 'state-update', payload: this.state });
  }

  private dispose(): void {
    JoinPanel.currentPanel = undefined;
    this.discoveryManager.dispose();
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
