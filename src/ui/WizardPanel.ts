import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as childProcess from 'child_process';
import { SessionHost } from '../host/SessionHost.js';
import {
  getLocalIPv4,
  getAllIPv4Addresses,
  findFreePort,
} from '../utils/network.js';
import { generateInviteCode } from '../utils/id.js';
import { SecretStore } from '../storage/SecretStore.js';
import { DiscoveryManager } from '../network/discovery.js';
import type { HostIdentity, SessionConfig } from '../types/session.js';

/**
 * Full state of the host setup wizard.
 *
 * All state lives in the extension host (stateless webview architecture).
 * The webview receives a full snapshot on mount and after every mutation.
 */
interface WizardState {
  // Plan 07-05 (Option A): step union widened to insert the LAN/Cloud
  // mode-select step between former step 1 and former step 2. New mapping:
  //   1 = sessionName + displayName        (unchanged from Phase 4.1)
  //   2 = mode-select (LAN | Cloud)        NEW
  //   3 = network config (branches on mode) — port/interface for LAN,
  //       relay URL for Cloud
  //   4 = invite-code reveal               (was step 3)
  //   5 = share screen (LAN or Cloud)      (was step 4)
  step: 1 | 2 | 3 | 4 | 5;
  sessionName: string;
  displayName: string; // Plan 04.1-03 (Defect A closure): host's display name
  port: number;
  networkInterface: string;
  availableInterfaces: Array<{ name: string; address: string }>;
  maxPayloadMB: number; // UI shows MB, converts to bytes for SessionConfig
  inviteCode: string;
  hostIp: string;
  isSessionActive: boolean;
  error: string | null;
  // Plan 07-05 (Wave 2 cloud-mode wizard surface):
  mode: 'lan' | 'cloud'; // default 'lan' — back-compat for LAN flow
  relayUrl: string; // Cloud branch only — host enters the wss:// relay URL
  relayUrlReachable: boolean | null; // null = not tested; true = /healthz ok; false = failed
  relayHealthSessionCount: number | null; // populated from /healthz on success
  sessionId: string; // Cloud share-screen deep-link param. Random 6-byte hex
                     // (review HI-02 — formerly derived from inviteCode, which
                     // let observers recover the invite code from any sessionId
                     // logged by the relay).
  /**
   * Phase 7 gap-closure plan 07-13 (MD-03 Option A). Populated AFTER
   * SessionHostFactory.createCloud resolves; empty string in LAN mode
   * and during the wizard's pre-creation steps. Picked up by wizard.js
   * buildDeepLink (4-arg variant) to append &bt=<URLencoded> to the
   * share-screen deep-link.
   */
  bootstrapToken: string;
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
    | ((host: SessionHost, sessionName: string, hostIdentity: HostIdentity) => void)
    | null;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * Show the wizard panel or reveal it if it already exists.
   *
   * @param context - Extension context for resource URIs and secret storage
   * @param onSessionStarted - Callback invoked when a session is successfully started.
   *   Plan 06 uses this to wire sidebar updates.
   */
  /**
   * Resolve the host's default displayName via a four-step priority chain
   * (Plan 04.1-03 — Defect A closure):
   *   1. `versioncon.displayName` from workspace settings (non-empty after trim)
   *   2. `git config user.name` (best-effort, 1s timeout, silently falls through)
   *   3. `os.userInfo().username`
   *   4. The literal 'Host'
   *
   * Defensive: any thrown error in the git lookup falls through to step 3.
   * The workspace-folder cwd narrows git scope to the user's repo (so a
   * machine-wide git config is honored even when a multi-repo VS Code window
   * is open).
   */
  private static resolveDefaultDisplayName(): string {
    // Step 1: workspace settings
    const fromSettings = vscode.workspace
      .getConfiguration('versioncon')
      .get<string>('displayName');
    if (fromSettings && fromSettings.trim().length > 0) {
      return fromSettings.trim();
    }

    // Step 2: git config user.name
    try {
      const cwd =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const result = childProcess.execFileSync(
        'git',
        ['config', 'user.name'],
        {
          cwd,
          timeout: 1000,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      const trimmed = result.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    } catch {
      // ENOENT (git not installed), timeout, non-zero exit, or non-git
      // workspace — silently fall through.
    }

    // Step 3: OS username
    try {
      const username = os.userInfo().username;
      if (username && username.length > 0) {
        return username;
      }
    } catch {
      // OS userInfo can throw on some sandboxes — fall through.
    }

    // Step 4: literal fallback
    return 'Host';
  }

  static async createOrShow(
    context: vscode.ExtensionContext,
    onSessionStarted?: (host: SessionHost, sessionName: string, hostIdentity: HostIdentity) => void,
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
      displayName: WizardPanel.resolveDefaultDisplayName(),
      port: freePort,
      networkInterface: primaryInterface,
      availableInterfaces: interfaces,
      maxPayloadMB: 50, // 50 MB default
      inviteCode,
      hostIp: primaryIp,
      isSessionActive: false,
      error: null,
      // Plan 07-05 defaults — LAN preserves existing flow byte-for-byte; cloud
      // fields are dormant until the user picks 'cloud' on the mode-select step.
      mode: 'lan',
      relayUrl: '',
      relayUrlReachable: null,
      relayHealthSessionCount: null,
      sessionId: '',
      // Plan 07-13 (MD-03 Option A) default — empty until createCloud
      // resolves and the host's getBootstrapToken() pickup fires below.
      bootstrapToken: '',
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
    onSessionStarted:
      | ((host: SessionHost, sessionName: string, hostIdentity: HostIdentity) => void)
      | null,
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
    // Plan 07-05 wizard relay-test seam (Step 2 "Test connection") fetches the
    // user-supplied https://<relay>/healthz from inside the webview. Without an
    // explicit connect-src directive, `default-src 'none'` blocks the fetch
    // silently, so the Test Connection button always reports "Cannot reach relay"
    // even against a healthy relay. `connect-src https:` allows fetches to any
    // HTTPS host because users can self-host relays anywhere (Fly, AWS, Hetzner,
    // DO — see relay/README.md). Webviews can only initiate outbound requests;
    // they cannot be used as an open redirect, and the destination URL is always
    // user-supplied via the wizard's Relay URL input.
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src https:;`;

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

      // Plan 07-05 — cloud-mode wizard surface message types ------------------
      case 'wizard-set-mode':
        this.handleSetMode(message.payload as Record<string, unknown>);
        break;

      case 'wizard-set-relay-url':
        this.handleSetRelayUrl(message.payload as Record<string, unknown>);
        break;

      case 'wizard-test-connection-result':
        this.handleTestConnectionResult(
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
        // Validate session name (existing — preserved)
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

        // Plan 04.1-03 (Defect A closure): validate display name.
        const displayName =
          typeof payload.displayName === 'string'
            ? payload.displayName.trim()
            : '';
        if (displayName.length === 0) {
          this.state.error = 'Display name is required.';
          this.sendStateUpdate();
          return;
        }
        if (displayName.length > 64) {
          this.state.error =
            'Display name must be 64 characters or fewer.';
          this.sendStateUpdate();
          return;
        }
        // Reject control characters (U+0000-U+001F and U+007F DEL) — they
        // would render as garbage in chat / presence and could be used to
        // craft visually-deceptive names. Same posture as plan 04-13's body
        // validation for chat-message frames.
        if (/[\u0000-\u001F\u007F]/.test(displayName)) {
          this.state.error =
            'Display name cannot contain control characters.';
          this.sendStateUpdate();
          return;
        }

        this.state.sessionName = sessionName;
        this.state.displayName = displayName;

        // Persist to workspace settings so the next session in this workspace
        // pre-fills with the user's prior choice. Workspace scope (NOT global)
        // — different workspaces can have different identities.
        void vscode.workspace
          .getConfiguration('versioncon')
          .update(
            'displayName',
            displayName,
            vscode.ConfigurationTarget.Workspace,
          )
          .then(undefined, () => {
            /* settings update failures are non-fatal */
          });

        this.state.step = 2;
        break;
      }

      case 2: {
        // Plan 07-05 — mode-select step. Validate that payload.mode is one of
        // the two known modes; the radio's change event already eagerly mirrors
        // mode into state via 'wizard-set-mode', so payload.mode here is a
        // defense-in-depth re-validation (the user could in principle click
        // Next without ever triggering the change handler, e.g. via keyboard).
        const mode = payload.mode;
        if (mode !== 'lan' && mode !== 'cloud') {
          this.state.error = 'Please choose a connection mode.';
          this.sendStateUpdate();
          return;
        }
        this.state.mode = mode;
        this.state.step = 3;
        break;
      }

      case 3: {
        // Plan 07-05 — network configuration step, branches on mode.
        if (this.state.mode === 'lan') {
          // LAN branch: preserved verbatim from former case 2 (port + interface
          // + maxPayloadMB).
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
        } else {
          // Cloud branch: relay URL + bandwidth, with wss:// validation and a
          // gate on relayUrlReachable. T-07-01a mitigation (UX defense layer;
          // the security boundary is JWT verification at the relay).
          const relayUrl =
            typeof payload.relayUrl === 'string' ? payload.relayUrl.trim() : '';
          let parsed = false;
          try {
            new URL(relayUrl);
            parsed = true;
          } catch {
            parsed = false;
          }
          if (!relayUrl.startsWith('wss://') || !parsed) {
            this.state.error = 'Must be a wss:// URL';
            this.sendStateUpdate();
            return;
          }
          this.state.relayUrl = relayUrl;

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

          // UI-SPEC §Wizard Step 2 — Continue is disabled until Test connection
          // passes. The webview already disables the button until the result
          // arrives, but defense-in-depth here catches a bypass.
          if (this.state.relayUrlReachable !== true) {
            this.state.error = 'Run Test connection before continuing.';
            this.sendStateUpdate();
            return;
          }
        }

        this.state.step = 4;
        break;
      }

      case 4:
        // Former step 3 (invite-code reveal) — uses wizard-complete, not wizard-next.
        break;

      default:
        break;
    }

    this.sendStateUpdate();
  }

  /**
   * Handle wizard back navigation.
   *
   * Plan 07-05: widened to allow back-nav from step 4 (invite-code reveal)
   * back to step 3 (network config). Step 5 (share screen) intentionally
   * has no back button — the session is live by then.
   */
  private handleWizardBack(): void {
    if (this.state.step > 1 && this.state.step <= 4) {
      this.state.step = (this.state.step - 1) as 1 | 2 | 3 | 4;
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

      // Plan 04.1-03 (Defect A + B closure): pre-allocate the host's identity
      // BEFORE constructing SessionHost. memberId + hostAuthSecret are random
      // UUIDs (122 bits each). The displayName comes from the wizard step 1
      // input (Plan 04.1-03 added that field). The triple is passed to the
      // SessionHost constructor (Plan 04.1-02 widened the signature) AND
      // forwarded to the onSessionStarted callback so extension.ts can mirror
      // memberId for admin gates.
      const hostIdentity: HostIdentity = {
        memberId: crypto.randomUUID(),
        displayName: this.state.displayName,
        hostAuthSecret: crypto.randomUUID(),
      };

      // Review HI-02 — derive sessionId from random bytes, NOT from inviteCode.
      // The pre-fix derivation `'vc-' + inviteCode.toLowerCase()` made the
      // invite code trivially recoverable from any sessionId observation
      // (slice(3).toUpperCase() reverses it). Since the relay logs sessionId
      // by design (it is the routing key, intentionally NOT in the redact
      // set), every log line containing sessionId leaked the invite code.
      // The fix: generate 6 random bytes (48 bits of entropy, well above
      // any per-relay-process collision risk) and prefix with 'vc-'. The
      // sessionId remains shaped like the SESSION_ID_SHAPE regex in
      // relay/src/auth.ts so existing auth tests pass.
      this.state.sessionId = 'vc-' + crypto.randomBytes(6).toString('hex');

      // Plan 07-05b — branch on wizard mode to wire a cloud SessionHost via
      // SessionHostFactory.createCloud(). LAN mode falls through to the
      // byte-identical `new SessionHost(config, hostIdentity)` path. The
      // LAN branch MUST remain unchanged.
      let actualPort: number;
      if (this.state.mode === 'cloud') {
        const { createCloud } = await import('../host/SessionHostFactory.js');
        if (!this.state.relayUrl) {
          throw new Error('Cloud mode requires a relayUrl');
        }
        this.sessionHost = await createCloud({
          config,
          hostIdentity,
          relayUrl: this.state.relayUrl,
          sessionId: this.state.sessionId,
        });
        // Phase 7 gap-closure plan 07-13 (MD-03 Option A): pickup bootstrap JWT
        // from the freshly-created cloud SessionHost. WizardState carries it to
        // the share-screen webview via sendStateUpdate below, which appends it
        // as &bt= to the deep-link. The `?? ''` coalesce defends against the
        // LAN-mode case (getBootstrapToken returns null) — defense-in-depth even
        // though the LAN path doesn't reach this branch.
        const bootstrap = this.sessionHost.getBootstrapToken();
        this.state.bootstrapToken = bootstrap ?? '';
        actualPort = await this.sessionHost.start();
      } else {
        this.sessionHost = new SessionHost(config, hostIdentity);
        actualPort = await this.sessionHost.start();
      }

      // Update state to show share screen
      this.state.port = actualPort;
      this.state.step = 5;
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

      // Call the onSessionStarted callback (Plan 06 integration point).
      // Plan 04.1-03: pass the pre-allocated hostIdentity so extension.ts can
      // store it at module scope (activeHostIdentity) for forward-compat.
      if (this.onSessionStartedCallback && this.sessionHost) {
        this.onSessionStartedCallback(
          this.sessionHost,
          this.state.sessionName,
          hostIdentity,
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
   * Plan 07-05 — mode-select radio change handler.
   *
   * The webview's radio `change` event eagerly mirrors the selection into
   * extension-host state so the Continue button gating on the next step has
   * the right value to read before the user clicks Next. Defense-in-depth:
   * payload.mode is re-validated at the case-2 branch in handleWizardNext.
   */
  private handleSetMode(payload: Record<string, unknown> | undefined): void {
    if (!payload) return;
    const mode = payload.mode;
    if (mode !== 'lan' && mode !== 'cloud') return;
    this.state.mode = mode;
    this.sendStateUpdate();
  }

  /**
   * Plan 07-05 — relay URL `input` event mirror.
   *
   * Editing the URL field invalidates any prior test-connection result so
   * Continue stays disabled until the user re-runs Test connection. The
   * webview also gates the Continue button locally; this is defense-in-depth.
   */
  private handleSetRelayUrl(
    payload: Record<string, unknown> | undefined,
  ): void {
    if (!payload || typeof payload.relayUrl !== 'string') return;
    this.state.relayUrl = payload.relayUrl;
    this.state.relayUrlReachable = null;
    this.state.relayHealthSessionCount = null;
    this.sendStateUpdate();
  }

  /**
   * Plan 07-05 — store the outcome of a Test connection click.
   *
   * The webview performs the fetch (it has DOM access + native fetch); the
   * extension host only stores the boolean + optional sessions count. The
   * stored boolean gates the Continue button on the cloud branch of step 3.
   */
  private handleTestConnectionResult(
    payload: Record<string, unknown> | undefined,
  ): void {
    if (!payload || typeof payload.ok !== 'boolean') return;
    this.state.relayUrlReachable = payload.ok;
    this.state.relayHealthSessionCount =
      typeof payload.sessions === 'number' ? payload.sessions : null;
    this.sendStateUpdate();
  }

  /**
   * Called when the host session ends (either by user disconnect or session-ended event).
   * Disposes the panel so it doesn't show stale "Session Active" state.
   */
  onSessionEnded(): void {
    this.panel.dispose();
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
