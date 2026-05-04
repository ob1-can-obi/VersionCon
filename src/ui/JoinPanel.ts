import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SessionClient } from '../client/SessionClient.js';
import { SessionHistory } from '../storage/SessionHistory.js';
import { DiscoveryManager } from '../network/discovery.js';
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
}

export class JoinPanel {
  static currentPanel: JoinPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private state: JoinState;
  private readonly context: vscode.ExtensionContext;
  private readonly sessionHistory: SessionHistory;
  private readonly onConnectedCallback: (client: SessionClient) => void;
  private readonly discoveryManager: DiscoveryManager;
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
      default:
        break;
    }
  }

  private async handleJoinConnect(payload: Record<string, unknown> | undefined): Promise<void> {
    if (!payload) return;

    const hostIp = typeof payload.hostIp === 'string' ? payload.hostIp.trim() : '';
    const port = parseInt(String(payload.port), 10);
    const inviteCode = typeof payload.inviteCode === 'string' ? payload.inviteCode.trim() : '';
    const displayName = typeof payload.displayName === 'string' ? payload.displayName.trim() : '';

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
        await this.sessionHistory.addEntry({
          hostIp,
          port,
          sessionName: client.getSessionInfo()?.name ?? 'Session',
          displayName,
        });

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

    if (!inviteCode) {
      // If no invite code provided, just fill the form fields
      this.state.hostIp = hostIp;
      this.state.port = String(port);
      this.state.displayName = displayName;
      this.state.error = 'Enter the invite code to reconnect.';
      this.sendStateUpdate();
      return;
    }

    await this.handleJoinConnect({ hostIp, port, inviteCode, displayName });
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
