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
  // Phase 7 plan 07-14 — MD-03 Option A closure. The bootstrap JWT
  // extracted from the deep-link's `bt` query param. Empty string when the
  // deep-link omits `bt` (LAN-mode deep-link OR legacy pre-07-13 cloud
  // deep-link). LAN branch NEVER reads this field.
  bootstrapToken: string;
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
  /**
   * Phase 7 gap-closure plan 07-14 (MD-03 Option A). The bootstrap JWT
   * extracted from the deep-link's `bt` query param. Empty string when the
   * deep-link omits `bt` (LAN-mode deep-link OR legacy pre-07-13 cloud
   * deep-link) — in the legacy-cloud case, JoinPanel.handleJoinConnect
   * surfaces an actionable error: "This invite link is incomplete (missing
   * bootstrap token). Ask the host to re-share the link."
   *
   * NEVER logged in plaintext (T-07-20 HIGH mitigation). UriHandler's
   * OutputChannel write uses literal `bt=<redacted>` to redact the value
   * at the log line.
   */
  bootstrapToken: string;
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

  // Phase 7 UAT-3b fix (2026-05-30): deep-link prefill race-condition guard.
  // When openPrefilled creates a NEW panel, the webview HTML loads async —
  // postMessage from a synchronous applyPrefill() races the webview JS's
  // window.addEventListener('message', ...) registration and is silently
  // dropped on Windows. We queue the prefill here and apply it once the
  // webview posts 'webview-ready'. The reveal path (JoinPanel.currentPanel
  // already open) bypasses this — its webview is already listening.
  private pendingPrefill: JoinPrefill | null = null;
  private webviewReady: boolean = false;

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
    // UAT-3b fix (2026-05-30): defer prefill until the webview signals it has
    // registered its message listener. handleMessage('webview-ready') consumes
    // pendingPrefill. Calling applyPrefill synchronously here races the
    // webview JS load on Windows and the postMessage is silently dropped.
    instance.pendingPrefill = prefill;
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
      // Phase 7 plan 07-14 (MD-03): empty by default; UriHandler populates
      // via applyPrefill when the deep-link's `bt` param is present.
      bootstrapToken: '',
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
        // UAT-3b fix (2026-05-30): mark the webview as listening, then either
        // consume the queued deep-link prefill (openPrefilled new-panel path)
        // or fall through to the standard initial state-update (createOrShow
        // path). applyPrefill already calls sendStateUpdate internally so we
        // don't double-send.
        this.webviewReady = true;
        if (this.pendingPrefill) {
          const queued = this.pendingPrefill;
          this.pendingPrefill = null;
          this.applyPrefill(queued);
        } else {
          this.sendStateUpdate();
        }
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
    // UAT-3b fix safety net (2026-05-30): if the webview hasn't signalled
    // readiness yet (edge case — e.g. reveal path invoked before its initial
    // 'webview-ready' fires, or any future caller racing the webview load),
    // queue and bail. handleMessage('webview-ready') will consume.
    if (!this.webviewReady) {
      this.pendingPrefill = prefill;
      return;
    }
    this.state.mode = prefill.mode;
    this.state.relayUrl = prefill.relayUrl;
    this.state.sessionId = prefill.sessionId;
    this.state.inviteCode = prefill.inviteCode;
    // Phase 7 plan 07-14: copy the bootstrap JWT into state. Empty string
    // when the deep-link omits `bt` (LAN mode OR legacy pre-07-13 cloud
    // deep-link).
    this.state.bootstrapToken = prefill.bootstrapToken;
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

      // Phase 7 plan 07-14 (MD-03 Option A closure): a cloud join REQUIRES
      // a bootstrap JWT in state. The JWT is populated by UriHandler from
      // the deep-link's `bt` query param. An empty bootstrapToken in cloud
      // mode means the deep-link is either malformed OR was generated by a
      // pre-07-13 host (no `&bt=` in the share screen). Surface an
      // actionable error so the user knows to ask the host for a fresh
      // link.
      if (this.state.bootstrapToken === '') {
        this.state.error = 'This invite link is incomplete (missing bootstrap token). Ask the host to re-share the link.';
        this.sendStateUpdate();
        return;
      }

      this.state.isConnecting = true;
      this.state.error = null;
      this.sendStateUpdate();

      try {
        // Phase 7 plan 07-14 (MD-03 Option A closure): the bootstrap JWT
        // bridges the chicken-and-egg deadlock. The relay accepts the
        // bootstrap JWT via the existing verifyToken path (no relay-side
        // changes — proven by serverAuthIntegration.test.js test 3).
        // After the host issues a real per-joiner JWT in
        // auth-response.token, SessionClient triggers
        // CloudTransport.swapToken to atomically replace the bootstrap
        // socket with a new socket carrying the real JWT — at which point
        // the relay's SessionRegistry binds the joiner to its real
        // per-joiner sub.
        const transport = new CloudTransport(relayUrl, sessionId, this.state.bootstrapToken);
        // SessionClient.transport seam — host-IP and port are ignored when a
        // cloud transport is injected (07-01 D-05). Pass relayUrl / 0 as
        // structurally-valid placeholders so the typed contract is satisfied.
        const client = new SessionClient(relayUrl, 0, inviteCode, displayName, transport);
        const connected = await client.connect();

        if (connected) {
          const sessionName = client.getSessionInfo()?.name ?? 'Session';
          // Review MD-09: tag cloud history entries with mode discriminator
          // so the recents UI + quick-connect can branch correctly.
          // hostIp/port stay as legacy-shaped placeholders so older readers
          // (pre-MD-09) ignore the entry safely (a LAN quick-connect against
          // wss-shaped hostIp+port=0 still produces an invalid connect attempt,
          // but the new `mode === 'cloud'` discriminator lets new readers
          // skip that path entirely).
          await this.sessionHistory.addEntry({
            hostIp: relayUrl,
            port: 0,
            sessionName,
            displayName,
            mode: 'cloud',
            relayUrl,
            sessionId,
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
        // Save to history for quick reconnect (NET-04, D-08).
        // Review MD-09: tag LAN entries with the `lan` mode discriminator
        // so cloud-mode reader code can distinguish history entries
        // explicitly. Older readers ignore unknown fields safely.
        const sessionName = client.getSessionInfo()?.name ?? 'Session';
        await this.sessionHistory.addEntry({
          hostIp,
          port,
          sessionName,
          displayName,
          mode: 'lan',
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
