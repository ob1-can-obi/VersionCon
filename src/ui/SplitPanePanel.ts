import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { FileSystemLayer } from '../filesystem/FileSystemLayer.js';
import { BranchState } from '../filesystem/BranchState.js';
import { WorkspaceState } from '../filesystem/WorkspaceState.js';
import type {
  SplitPaneState,
  WebviewMessage,
  DragToWorkspacePayload,
  DragToBranchPayload,
} from '../types/filesystem.js';

/**
 * Manages the split-pane webview panel that renders workspace (left)
 * and branch (right) trees with drag-and-drop between them.
 *
 * Implements the stateless webview pattern:
 * - retainContextWhenHidden = false (DOM destroyed on tab switch)
 * - Webview fires 'webview-ready' on mount
 * - Extension host pushes full SplitPaneState snapshot in response
 *
 * All file I/O and state management stays in the extension host.
 * The webview is a pure rendering surface that communicates via postMessage.
 *
 * Single-webview architecture avoids VS Code 1.90+ cross-webview
 * drag-and-drop regression (issue #256444, requirement UI-09).
 */
export class SplitPanePanel {
  static currentPanel: SplitPanePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly fsLayer: FileSystemLayer;
  private readonly branchState: BranchState;
  private readonly workspaceState: WorkspaceState;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * Show the split-pane panel or reveal it if it already exists.
   *
   * @param context - Extension context for resource URIs
   * @param workspaceFolder - The workspace folder to display
   */
  static createOrShow(
    context: vscode.ExtensionContext,
    workspaceFolder: vscode.WorkspaceFolder,
  ): void {
    // If the panel already exists, just reveal it
    if (SplitPanePanel.currentPanel) {
      SplitPanePanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    // Determine branch directory (canonical branch state lives here)
    const branchDir = path.join(
      workspaceFolder.uri.fsPath,
      '.versioncon',
      'branch',
    );

    // Create branch directory if it doesn't exist (first use)
    fs.mkdirSync(branchDir, { recursive: true });

    // Create filesystem layer and state managers
    const fsLayer = new FileSystemLayer(
      workspaceFolder.uri.fsPath,
      branchDir,
    );
    const branchState = new BranchState(fsLayer, branchDir);
    const workspaceState = new WorkspaceState(
      fsLayer,
      workspaceFolder.uri.fsPath,
    );

    // Create webview panel (single panel with CSS split -- UI-09)
    const panel = vscode.window.createWebviewPanel(
      'versioncon.splitPane',
      'VersionCon: Workspace',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: false, // Stateless pattern
        localResourceRoots: [
          vscode.Uri.joinPath(
            context.extensionUri,
            'src',
            'ui',
            'webview',
            'splitpane',
          ),
          vscode.Uri.joinPath(
            context.extensionUri,
            'node_modules',
            '@vscode-elements',
            'elements',
            'dist',
          ),
        ],
      },
    );

    new SplitPanePanel(
      panel,
      context,
      fsLayer,
      branchState,
      workspaceState,
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    fsLayer: FileSystemLayer,
    branchState: BranchState,
    workspaceState: WorkspaceState,
  ) {
    this.panel = panel;
    this.context = context;
    this.fsLayer = fsLayer;
    this.branchState = branchState;
    this.workspaceState = workspaceState;

    SplitPanePanel.currentPanel = this;

    // Set webview HTML content
    this.panel.webview.html = this.getWebviewContent();

    // Listen for messages from webview (T-02-05: validate before processing)
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
   * Reads the splitpane.html template and replaces placeholders with:
   * - %%CSP%% -> Content-Security-Policy with nonce (T-02-06)
   * - %%NONCE%% -> Cryptographic nonce for script tags
   * - %%CSS_URI%% -> Webview URI for splitpane.css
   * - %%JS_URI%% -> Webview URI for splitpane.js
   * - %%ELEMENTS_URI%% -> Webview URI for @vscode-elements bundled.js
   */
  private getWebviewContent(): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');

    // Construct webview URIs for CSS, JS, and @vscode-elements bundle
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'ui',
        'webview',
        'splitpane',
        'splitpane.css',
      ),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'ui',
        'webview',
        'splitpane',
        'splitpane.js',
      ),
    );
    const elementsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'node_modules',
        '@vscode-elements',
        'elements',
        'dist',
        'bundled.js',
      ),
    );

    // Content Security Policy: strict with nonce (T-02-06)
    // - default-src 'none': deny everything by default
    // - style-src: allow VS Code webview styles + nonce
    // - script-src: nonce-only (covers both our script and elements bundle)
    // - font-src: allow VS Code webview fonts (codicons)
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ') + ';';

    // Read the HTML template and replace placeholders
    const templatePath = path.join(
      this.context.extensionUri.fsPath,
      'src',
      'ui',
      'webview',
      'splitpane',
      'splitpane.html',
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
        '  <title>VersionCon: Workspace</title>',
        '</head>',
        '<body>',
        '  <div class="split-container">',
        '    <div class="pane pane-left" id="workspace-pane">',
        '      <div class="pane-header"><span class="pane-title">Workspace</span></div>',
        '      <div class="pane-content"><vscode-tree id="workspace-tree"></vscode-tree></div>',
        '    </div>',
        '    <div class="pane-divider"></div>',
        '    <div class="pane pane-right" id="branch-pane">',
        '      <div class="pane-header"><span class="pane-title">Branch</span><span class="pane-badge read-only">read-only</span></div>',
        '      <div class="pane-content"><vscode-tree id="branch-tree"></vscode-tree></div>',
        '    </div>',
        '  </div>',
        '  <script nonce="%%NONCE%%" src="%%ELEMENTS_URI%%"></script>',
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
    html = html.replace(/%%ELEMENTS_URI%%/g, elementsUri.toString());

    return html;
  }

  /**
   * Handle messages from the webview.
   *
   * T-02-05 mitigation: validates message type is a known string
   * and payload shape matches expected interface before processing.
   * Unknown message types are silently ignored.
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
        void this.refreshAndPushState();
        break;

      case 'drag-to-workspace': {
        // Validate payload shape (T-02-05)
        const payload = message.payload as Record<string, unknown> | undefined;
        if (
          payload &&
          typeof payload.path === 'string' &&
          typeof payload.isDirectory === 'boolean'
        ) {
          void this.handleDragToWorkspace({
            path: payload.path,
            isDirectory: payload.isDirectory,
          });
        }
        break;
      }

      case 'drag-to-branch': {
        // Validate payload shape (T-02-05)
        const payload = message.payload as Record<string, unknown> | undefined;
        if (payload && typeof payload.path === 'string') {
          this.handleDragToBranch({ path: payload.path });
        }
        break;
      }

      default:
        // T-02-05: unknown message types silently ignored
        break;
    }
  }

  /**
   * Handle a drag-to-workspace operation.
   *
   * Copies a file or directory structure from branch to workspace.
   * T-02-07: FileSystemLayer validates paths against traversal attacks.
   */
  private async handleDragToWorkspace(
    payload: DragToWorkspacePayload,
  ): Promise<void> {
    try {
      if (payload.isDirectory) {
        await this.fsLayer.copyStructureOnly(payload.path);
      } else {
        await this.fsLayer.copyFileToWorkspace(payload.path);
      }
      await this.refreshAndPushState();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to copy to workspace';
      void vscode.window.showErrorMessage(
        `VersionCon: ${message}`,
      );
    }
  }

  /**
   * Handle a drag-to-branch operation.
   *
   * Stages a workspace file for push (in-memory tracking only).
   * No filesystem refresh needed -- just the staged list changed.
   */
  private handleDragToBranch(payload: DragToBranchPayload): void {
    this.workspaceState.stageFile(payload.path);
    this.pushState();
  }

  /**
   * Refresh both trees from disk and push the new state to the webview.
   */
  private async refreshAndPushState(): Promise<void> {
    await this.branchState.refresh();
    await this.workspaceState.refresh();
    this.pushState();
  }

  /**
   * Build and push the current SplitPaneState to the webview.
   */
  private pushState(): void {
    const state: SplitPaneState = {
      workspaceTree: this.workspaceState.getTree(),
      branchTree: this.branchState.getTree(),
      stagedFiles: this.workspaceState.getStagedFiles(),
    };

    void this.panel.webview.postMessage({
      type: 'state-update',
      payload: state,
    });
  }

  /**
   * Called by external consumers (e.g., FileSystemWatcher in Plan 03)
   * when files change outside the webview interaction flow.
   */
  onExternalChange(): void {
    void this.refreshAndPushState();
  }

  /**
   * Clean up panel resources.
   */
  private dispose(): void {
    SplitPanePanel.currentPanel = undefined;

    this.panel.dispose();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
