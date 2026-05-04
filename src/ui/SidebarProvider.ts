import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ConnectionStatus, SessionRole } from '../types/session.js';

interface SidebarState {
  connectionStatus: ConnectionStatus;
  sessionName: string | null;
  role: SessionRole | null;
  members: Array<{ id: string; displayName: string; role: string; isOnline: boolean }>;
  bandwidthStats: Array<{ memberId: string; rateOutKBps: number; rateInKBps: number }> | null;
  error: string | null;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly extensionUri: vscode.Uri;
  private readonly context: vscode.ExtensionContext;
  private disconnectHandler: (() => void) | null = null;
  private kickHandler: ((memberId: string) => void) | null = null;

  private state: SidebarState = {
    connectionStatus: 'disconnected',
    sessionName: null,
    role: null,
    members: [],
    bandwidthStats: null,
    error: null,
  };

  constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
    this.extensionUri = extensionUri;
    this.context = context;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'src', 'ui', 'webview', 'sidebar'),
      ],
    };

    webviewView.webview.html = this.getWebviewContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: unknown) => {
      this.handleMessage(msg);
    });
  }

  private getWebviewContent(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');

    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'ui', 'webview', 'sidebar', 'sidebar.css'),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'ui', 'webview', 'sidebar', 'sidebar.js'),
    );

    const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;

    const templatePath = path.join(
      this.extensionUri.fsPath, 'src', 'ui', 'webview', 'sidebar', 'sidebar.html',
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
        '  <title>VersionCon</title>',
        '</head>',
        '<body>',
        '  <div id="sidebar-root"></div>',
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
      case 'kick-member': {
        const payload = message.payload as Record<string, unknown> | undefined;
        if (payload && typeof payload.memberId === 'string' && this.state.role === 'host') {
          this.kickHandler?.(payload.memberId);
        }
        break;
      }
      case 'host-session':
        void vscode.commands.executeCommand('versioncon.hostSession');
        break;
      case 'join-session':
        void vscode.commands.executeCommand('versioncon.joinSession');
        break;
      case 'disconnect':
        this.disconnectHandler?.();
        break;
      default:
        break;
    }
  }

  updateState(partial: Partial<SidebarState>): void {
    Object.assign(this.state, partial);
    this.sendStateUpdate();
  }

  onDisconnectRequested(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  onKickRequested(handler: (memberId: string) => void): void {
    this.kickHandler = handler;
  }

  private sendStateUpdate(): void {
    if (this.view) {
      void this.view.webview.postMessage({ type: 'state-update', payload: this.state });
    }
  }
}
