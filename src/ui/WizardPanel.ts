import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SessionHost } from '../host/SessionHost.js';
import {
  getLocalIPv4,
  getAllIPv4Addresses,
  findFreePort,
} from '../utils/network.js';
import { generateInviteCode } from '../utils/id.js';
import { SecretStore } from '../storage/SecretStore.js';
import { DiscoveryManager } from '../network/discovery.js';
import type { SessionConfig } from '../types/session.js';

/**
 * Full state of the host setup wizard.
 *
 * All state lives in the extension host (stateless webview architecture).
 * The webview receives a full snapshot on mount and after every mutation.
 */
interface WizardState {
  step: 1 | 2 | 3 | 4; // 4 = "share with team" completion screen
  sessionName: string;
  port: number;
  networkInterface: string;
  availableInterfaces: Array<{ name: string; address: string }>;
  maxPayloadMB: number; // UI shows MB, converts to bytes for SessionConfig
  inviteCode: string;
  hostIp: string;
  isSessionActive: boolean;
  error: string | null;
}

/**
 * Manages the host setup wizard webview panel.
 *
 * Implements the stateless webview pattern:
 * - retainContextWhenHidden = false (no memory retention)
 * - Webview fires 'webview-ready' on mount
 * - Extension host pushes full state snapshot in response
 *
 * On wizard completion:
 * 1. Builds SessionConfig from collected state
 * 2. Creates and starts a SessionHost
 * 3. Stores invite code securely via SecretStore
 * 4. Publishes session via mDNS for LAN discovery
 * 5. Calls onSessionStarted callback (used by Plan 06)
 */
export class WizardPanel {
  static currentPanel: WizardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private state: WizardState;
  private sessionHost: SessionHost | null = null;
  private discoveryManager: DiscoveryManager | null = null;
  private readonly context: vscode.ExtensionContext;
  private readonly onSessionStartedCallback:
    | ((host: SessionHost, sessionName: string) => void)
    | null;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * Show the wizard panel or reveal it if it already exists.
   *
   * @param context - Extension context for resource URIs and secret storage
   * @param onSessionStarted - Callback invoked when a session is successfully started.
   *   Plan 06 uses this to wire sidebar updates.
   */
  static async createOrShow(
    context: vscode.ExtensionContext,
    onSessionStarted?: (host: SessionHost, sessionName: string) => void,
  ): Promise<void> {
    // If the panel already exists, just reveal it
    if (WizardPanel.currentPanel) {
      WizardPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    // Auto-detect network values (D-02)
    const interfaces = getAllIPv4Addresses();
    const primaryIp = getLocalIPv4();
    const freePort = await findFreePort();
    const inviteCode = generateInviteCode();

    // Determine primary interface name
    const primaryInterface =
      interfaces.find((iface) => iface.address === primaryIp)?.name ??
      (interfaces.length > 0 ? interfaces[0].name : 'lo0');

    // Build initial state with auto-detected values
    const initialState: WizardState = {
      step: 1,
      sessionName: '',
      port: freePort,
      networkInterface: primaryInterface,
      availableInterfaces: interfaces,
      maxPayloadMB: 50, // 50 MB default
      inviteCode,
      hostIp: primaryIp,
      isSessionActive: false,
      error: null,
    };

    // Create webview panel
    const panel = vscode.window.createWebviewPanel(
      'versioncon.wizard',
      'VersionCon: Host Session',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: false, // Stateless pattern -- no memory retention
        localResourceRoots: [
          vscode.Uri.joinPath(
            context.extensionUri,
            'src',
            'ui',
            'webview',
            'wizard',
          ),
        ],
      },
    );

    new WizardPanel(panel, context, initialState, onSessionStarted ?? null);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    initialState: WizardState,
    onSessionStarted: ((host: SessionHost, sessionName: string) => void) | null,
  ) {
    this.panel = panel;
    this.context = context;
    this.state = initialState;
    this.onSessionStartedCallback = onSessionStarted;

    WizardPanel.currentPanel = this;

    // Set webview HTML content
    this.panel.webview.html = this.getWebviewContent();

    // Listen for messages from webview
    this.panel.webview.onDidReceiveMessage(
      (msg: unknown) => {
        this.handleMessage(msg);
      },
      null,
      this.disposables,
    );

    // Clean up on panel close
    this.panel.onDidDispose(
      () => {
        this.dispose();
      },
      null,
      this.disposables,
    );
  }

  /**
   * Build the webview HTML content.
   *
   * Reads the wizard.html template and replaces placeholders with:
   * - %%CSP%% -> Content-Security-Policy with nonce
   * - %%NONCE%% -> Cryptographic nonce for script/style tags
   * - %%CSS_URI%% -> Webview URI for wizard.css
   * - %%JS_URI%% -> Webview URI for wizard.js
   */
  private getWebviewContent(): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');

    // Construct webview URIs for CSS and JS
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'ui',
        'webview',
        'wizard',
        'wizard.css',
      ),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'ui',
        'webview',
        'wizard',
        'wizard.js',
      ),
    );

    // Content Security Policy: default-src 'none' with nonce for scripts/styles (T-01-13)
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;

    // Read the HTML template and replace placeholders
    const templatePath = path.join(
      this.context.extensionUri.fsPath,
      'src',
      'ui',
      'webview',
      'wizard',
      'wizard.html',
    );

    let html: string;
    try {
      html = fs.readFileSync(templatePath, 'utf-8');
    } catch {
      // Fallback: build HTML inline if template file not found during development
      html = [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '  <meta charset="UTF-8">',
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
        '  <meta http-equiv="Content-Security-Policy" content="%%CSP%%">',
        '  <link href="%%CSS_URI%%" rel="stylesheet">',
        '  <title>VersionCon: Host Session</title>',
        '</head>',
        '<body>',
        '  <div id="wizard-root"></div>',
        '  <script nonce="%%NONCE%%" src="%%JS_URI%%"></script>',
        '</body>',
        '</html>',
      ].join('\n');
    }

    // Replace template placeholders
    html = html.replace(/%%CSP%%/g, csp);
    html = html.replace(/%%NONCE%%/g, nonce);
    html = html.replace(/%%CSS_URI%%/g, cssUri.toString());
    html = html.replace(/%%JS_URI%%/g, jsUri.toString());

    return html;
  }

  /**
   * Handle messages from the webview.
   *
   * T-01-14 mitigation: validates message type and payload shape
   * before processing. Unknown message types are silently ignored.
   */
  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') {
      return;
    }

    const message = msg as Record<string, unknown>;
    const type = message.type;

    if (typeof type !== 'string') {
      return;
    }

    switch (type) {
      case 'webview-ready':
        // Webview mounted -- push full state snapshot (stateless pattern)
        this.sendStateUpdate();
        break;

      case 'wizard-next':
        this.handleWizardNext(message.payload as Record<string, unknown>);
        break;

      case 'wizard-back':
        this.handleWizardBack();
        break;

      case 'wizard-complete':
        void this.handleWizardComplete();
        break;

      case 'copy-to-clipboard':
        this.handleCopyToClipboard(message.payload as Record<string, unknown>);
        break;

      case 'wizard-override-port':
        this.handleOverridePort(message.payload as Record<string, unknown>);
        break;

      case 'wizard-override-interface':
        this.handleOverrideInterface(
          message.payload as Record<string, unknown>,
        );
        break;

      default:
        // T-01-14: unknown message types silently ignored
        break;
    }
  }

  /**
   * Push the full state snapshot to the webview.
   */
  private sendStateUpdate(): void {
    void this.panel.webview.postMessage({
      type: 'state-update',
      payload: this.state,
    });
  }

  /**
   * Handle wizard step advancement with validation.
   */
  private handleWizardNext(payload: Record<string, unknown> | undefined): void {
    if (!payload) {
      return;
    }

    // Clear any previous error
    this.state.error = null;

    switch (this.state.step) {
      case 1: {
        // Validate session name
        const sessionName =
          typeof payload.sessionName === 'string'
            ? payload.sessionName.trim()
            : '';
        if (sessionName.length === 0) {
          this.state.error = 'Session name is required.';
          this.sendStateUpdate();
          return;
        }
        if (sessionName.length > 100) {
          this.state.error =
            'Session name must be 100 characters or fewer.';
          this.sendStateUpdate();
          return;
        }
        this.state.sessionName = sessionName;
        this.state.step = 2;
        break;
      }

      case 2: {
        // Validate network config
        const port =
          typeof payload.port === 'number'
            ? payload.port
            : parseInt(String(payload.port), 10);
        if (isNaN(port) || port < 1024 || port > 65535) {
          this.state.error = 'Port must be between 1024 and 65535.';
          this.sendStateUpdate();
          return;
        }
        this.state.port = port;

        if (typeof payload.networkInterface === 'string') {
          this.state.networkInterface = payload.networkInterface;
          // Update hostIp to match selected interface
          const matchingIface = this.state.availableInterfaces.find(
            (i) => i.name === payload.networkInterface,
          );
          if (matchingIface) {
            this.state.hostIp = matchingIface.address;
          }
        }

        const maxPayloadMB =
          typeof payload.maxPayloadMB === 'number'
            ? payload.maxPayloadMB
            : parseFloat(String(payload.maxPayloadMB));
        if (isNaN(maxPayloadMB) || maxPayloadMB < 1) {
          this.state.error = 'Bandwidth limit must be at least 1 MB.';
          this.sendStateUpdate();
          return;
        }
        this.state.maxPayloadMB = maxPayloadMB;

        this.state.step = 3;
        break;
      }

      case 3:
        // Step 3 uses wizard-complete, not wizard-next
        break;

      default:
        break;
    }

    this.sendStateUpdate();
  }

  /**
   * Handle wizard back navigation.
   */
  private handleWizardBack(): void {
    if (this.state.step > 1 && this.state.step <= 3) {
      this.state.step = (this.state.step - 1) as 1 | 2;
      this.state.error = null;
      this.sendStateUpdate();
    }
  }

  /**
   * Handle wizard completion: create and start a live session.
   *
   * 1. Build SessionConfig from wizard state
   * 2. Create and start SessionHost
   * 3. Store invite code securely
   * 4. Publish session via mDNS
   * 5. Update state to show "share with team" screen
   * 6. Call onSessionStarted callback
   */
  private async handleWizardComplete(): Promise<void> {
    try {
      // Build SessionConfig (convert maxPayloadMB to bytes)
      const config: SessionConfig = {
        sessionName: this.state.sessionName,
        port: this.state.port,
        networkInterface: this.state.networkInterface,
        maxPayloadBytes: this.state.maxPayloadMB * 1024 * 1024,
        inviteCode: this.state.inviteCode,
      };

      // Create and start SessionHost
      const hostDisplayName =
        vscode.workspace
          .getConfiguration('versioncon')
          .get<string>('displayName') ?? 'Host';
      this.sessionHost = new SessionHost(config, hostDisplayName);
      const actualPort = await this.sessionHost.start();

      // Update state to show share screen
      this.state.port = actualPort;
      this.state.step = 4;
      this.state.isSessionActive = true;
      this.state.error = null;

      // Store invite code securely (T-01-11, T-01-12)
      const secretStore = new SecretStore(this.context);
      await secretStore.storeInviteCode(
        this.state.sessionName,
        this.state.inviteCode,
      );

      // Publish session via mDNS for LAN discovery (NET-07)
      this.discoveryManager = new DiscoveryManager();
      this.discoveryManager.publishSession(
        this.state.sessionName,
        actualPort,
      );

      // Push updated state to webview (share screen)
      this.sendStateUpdate();

      // Call the onSessionStarted callback (Plan 06 integration point)
      if (this.onSessionStartedCallback && this.sessionHost) {
        this.onSessionStartedCallback(
          this.sessionHost,
          this.state.sessionName,
        );
      }
    } catch (err) {
      // Session start failed -- show error, do NOT advance step
      this.state.error =
        err instanceof Error
          ? `Failed to start session: ${err.message}`
          : 'Failed to start session.';
      this.sendStateUpdate();
    }
  }

  /**
   * Copy text to clipboard.
   */
  private handleCopyToClipboard(
    payload: Record<string, unknown> | undefined,
  ): void {
    if (payload && typeof payload.text === 'string') {
      void vscode.env.clipboard.writeText(payload.text);
    }
  }

  /**
   * Override port from webview.
   */
  private handleOverridePort(
    payload: Record<string, unknown> | undefined,
  ): void {
    if (!payload) {
      return;
    }
    const port =
      typeof payload.port === 'number'
        ? payload.port
        : parseInt(String(payload.port), 10);
    if (!isNaN(port) && port >= 1024 && port <= 65535) {
      this.state.port = port;
      this.sendStateUpdate();
    }
  }

  /**
   * Override network interface from webview.
   */
  private handleOverrideInterface(
    payload: Record<string, unknown> | undefined,
  ): void {
    if (!payload || typeof payload.networkInterface !== 'string') {
      return;
    }
    this.state.networkInterface = payload.networkInterface;
    const matchingIface = this.state.availableInterfaces.find(
      (i) => i.name === payload.networkInterface,
    );
    if (matchingIface) {
      this.state.hostIp = matchingIface.address;
    }
    this.sendStateUpdate();
  }

  /**
   * Clean up panel resources.
   *
   * NOTE: SessionHost is NOT stopped here -- the session should keep
   * running after the wizard panel is closed. The session lifecycle
   * is managed separately (Plan 06).
   */
  private dispose(): void {
    WizardPanel.currentPanel = undefined;

    this.panel.dispose();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  /** Get the active SessionHost instance (if session has started). */
  get sessionHostInstance(): SessionHost | null {
    return this.sessionHost;
  }

  /** Get the DiscoveryManager instance (if session has started). */
  get discoveryManagerInstance(): DiscoveryManager | null {
    return this.discoveryManager;
  }
}
