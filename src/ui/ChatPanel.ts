import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { ChatRecord } from '../types/chat.js';

type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

/**
 * Bundle of references the ChatPanel needs from extension.ts to construct a
 * state-update payload + handle webview→extension messages. Wired by
 * extension.ts (Plan 04-10 Task 4) — keeps ChatPanel decoupled from
 * activeClient/activeHost/workspaceState which live at module scope there.
 */
export interface ChatPanelRefs {
  selfId: string;
  selfDisplayName: string;
  branch: string;
  memberCount: number;
  getRecords: () => ChatRecord[];
  getChatHiddenBefore: () => number | null;
  sendChatMessage: (body: string) => void;
  openManageChat: () => void;
  getConnectionStatus: () => ConnectionStatus;
  /**
   * CR-04 (Plan 04-14): Invoked when the panel's view state changes.
   * The boolean argument is `webviewPanel.active`. Receivers typically
   * flip a module-level chatPanelIsActive flag and clear unread counters
   * when active === true. Lifecycle: bound to the panel's own
   * onDidChangeViewState Disposable (in this.disposables), so it
   * auto-disposes on panel close. Callers MUST NOT register their own
   * onDidChangeViewState — that public setter API has been removed.
   */
  onPanelActivated?: (active: boolean) => void;
}

/**
 * The chat WebviewPanel singleton (Plan 04-10).
 *
 * Mirrors src/ui/WizardPanel.ts:
 *  - One panel at a time (`currentPanel` static)
 *  - Stateless webview (`retainContextWhenHidden: false`)
 *  - Webview posts 'webview-ready' on mount; extension responds with full
 *    state-update snapshot (see UI-SPEC §5.3)
 *
 * Strict CSP per UI-SPEC §5.2:
 *   default-src 'none'; img-src cspSource data:; style-src cspSource 'nonce-X';
 *   font-src cspSource; script-src 'nonce-X';
 * No unsafe-inline. markdown-it + highlight.js + codicons are bundled into
 * dist/webview/chat/ — never CDN.
 *
 * postMessage protocol:
 *   webview → ext: webview-ready, send-chat, chat-viewed, manage-chat,
 *                  open-external, copy-code
 *   ext → webview: state-update, chat-message-received, chat-cleared,
 *                  chat-truncated
 *
 * Threats mitigated:
 *  - T-04-10-01 (XSS): markdown-it html: false + CSP nonce
 *  - T-04-10-02 (javascript: URL): all link clicks routed through extension
 *    via open-external; non-http(s) URLs filtered before openExternal call
 *  - T-04-10-06 (DoS via massive paste): 64KB body cap in handleMessage
 *  - T-04-10-08 (open-external): vscode.Uri.parse → vscode.env.openExternal
 */
export class ChatPanel {
  static currentPanel: ChatPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * Show the chat panel or reveal it if already open. ChatPanel is a
   * singleton — second call brings the existing panel forward and refreshes
   * its refs (so the panel always sees the freshest sendChatMessage closure
   * etc., even if the previous session ended).
   */
  static createOrShow(
    context: vscode.ExtensionContext,
    refs: ChatPanelRefs,
  ): void {
    if (ChatPanel.currentPanel) {
      // Refresh refs so the existing panel uses the latest closures
      // (e.g. after a host→client transition the sendChatMessage path differs).
      ChatPanel.currentPanel.refs = refs;
      ChatPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      // Push a fresh state snapshot in case branch / memberCount changed.
      ChatPanel.currentPanel.setHistory(refs.getRecords());
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'versioncon.chatPanel',
      'VersionCon: Chat',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: false,  // Stateless pattern (UI-SPEC §5.3)
        localResourceRoots: [
          // src/ui/webview/chat for development if dist/ misses; dist/
          // is the canonical bundle path.
          vscode.Uri.joinPath(context.extensionUri, 'src', 'ui', 'webview', 'chat'),
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'chat'),
        ],
      },
    );
    ChatPanel.currentPanel = new ChatPanel(panel, context, refs);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private refs: ChatPanelRefs,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getWebviewContent();
    this.panel.webview.onDidReceiveMessage(
      (m: unknown) => this.handleMessage(m),
      null,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // CR-04 (Plan 04-14): Invoke refs.onPanelActivated through the panel's
    // own Disposable (already pushed to this.disposables on the line below).
    // Lifecycle: when the panel disposes, this Disposable disposes with it,
    // and refs.onPanelActivated is no longer reachable. No standalone
    // listener registration outside this constructor is needed.
    this.panel.onDidChangeViewState(
      (e) => {
        this.refs.onPanelActivated?.(e.webviewPanel.active);
      },
      null,
      this.disposables,
    );
  }

  // ----- Public API (consumed by extension.ts) -----

  /**
   * Forward a single chat record to the webview. Called for both host
   * echoes of own messages and remote chat-received events.
   */
  postChatMessage(record: ChatRecord): void {
    void this.panel.webview.postMessage({
      type: 'chat-message-received',
      payload: record,
    });
  }

  /**
   * Replace the webview's history with the supplied record array. Used on
   * the join-replay path (chat-history) and after chat-cleared/truncated
   * when the extension wants to push a fresh snapshot.
   */
  setHistory(records: ChatRecord[]): void {
    void this.panel.webview.postMessage({
      type: 'state-update',
      payload: this.buildState(records),
    });
  }

  /** Inform the webview the host wiped the chat for everyone. */
  notifyChatCleared(hostName: string): void {
    void this.panel.webview.postMessage({
      type: 'chat-cleared',
      payload: { hostName },
    });
  }

  /** Inform the webview the host truncated the chat per the given mode. */
  notifyChatTruncated(
    hostName: string,
    mode: 'keep-100-and-activity' | 'activity-only',
  ): void {
    void this.panel.webview.postMessage({
      type: 'chat-truncated',
      payload: { hostName, mode },
    });
  }

  /**
   * Update the webview's connection-status banner. Implementation pushes a
   * full state-update so the webview's renderHeader + applyConnectionBanner
   * stay in sync with branch / memberCount mutations the caller may have
   * made between status changes.
   */
  setConnectionStatus(_status: ConnectionStatus): void {
    void this.panel.webview.postMessage({
      type: 'state-update',
      payload: this.buildState(),
    });
  }

  /** True iff the panel is currently the active editor tab. */
  isActive(): boolean {
    return this.panel.active;
  }

  dispose(): void {
    ChatPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  // ----- Internal -----

  /**
   * Build the ChatState payload for state-update messages. When `records`
   * is omitted, refs.getRecords() is queried fresh — covers the case where
   * the panel re-sends state on a connection-status change without a
   * caller-supplied record array.
   */
  private buildState(records?: ChatRecord[]) {
    return {
      records: records ?? this.refs.getRecords(),
      selfId: this.refs.selfId,
      branch: this.refs.branch,
      memberCount: this.refs.memberCount,
      chatHiddenBefore: this.refs.getChatHiddenBefore(),
      connectionStatus: this.refs.getConnectionStatus(),
      unread: 0,  // unread count lives at the extension layer; webview
                  // does not need it post-render.
    };
  }

  /**
   * Inbound message dispatcher. Validates message shape (T-01-14 pattern
   * mirrored from WizardPanel) before acting. Unknown types silently
   * ignored — defensive against forward-compat protocol additions.
   */
  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const message = msg as Record<string, unknown>;
    const type = message.type;
    if (typeof type !== 'string') return;

    switch (type) {
      case 'webview-ready':
        // Webview mounted → push the full snapshot (stateless pattern).
        this.setHistory(this.refs.getRecords());
        break;

      case 'send-chat': {
        const payload = message.payload as { body?: unknown } | undefined;
        const body = typeof payload?.body === 'string' ? payload.body : '';
        // T-04-10-06: 64KB cap on outgoing message body. Prevents a single
        // paste from filling the wire / chat-log.json.
        if (body.length > 65536) {
          void vscode.window.showWarningMessage(
            'Message too large (max 64KB).',
          );
          return;
        }
        if (body.trim().length > 0) {
          this.refs.sendChatMessage(body);
        }
        break;
      }

      case 'chat-viewed':
        // Plan 04-09 listens via onDidChangeViewState; this is a redundant
        // signal kept for forward-compat with explicit "I am reading" hints.
        break;

      case 'manage-chat':
        this.refs.openManageChat();
        break;

      case 'open-external': {
        const url = (message.payload as { url?: unknown } | undefined)?.url;
        if (typeof url !== 'string') return;
        // T-04-10-02: filter non-http(s) schemes BEFORE openExternal so a
        // markdown link like `[click](javascript:alert(1))` cannot reach
        // the platform's URI handler.
        try {
          const parsed = vscode.Uri.parse(url, true);
          if (parsed.scheme === 'http' || parsed.scheme === 'https') {
            void vscode.env.openExternal(parsed);
          }
        } catch {
          // Malformed URI — ignore.
        }
        break;
      }

      case 'copy-code': {
        const code = (message.payload as { code?: unknown } | undefined)?.code;
        if (typeof code === 'string') {
          void vscode.env.clipboard.writeText(code);
        }
        break;
      }

      default:
        // Forward-compat: unknown types silently ignored.
        break;
    }
  }

  /**
   * Build the webview HTML. Reads dist/webview/chat/index.html (copied by
   * esbuild's chat-assets onEnd plugin), replaces the 5 placeholders with
   * runtime values + a fresh nonce.
   *
   * Falls back to an inline minimal HTML scaffold if the template is
   * missing — useful during development before the first build, and lets
   * unit tests instantiate ChatPanel without prebuilding.
   */
  private getWebviewContent(): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');

    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri, 'dist', 'webview', 'chat', 'main.css',
      ),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri, 'dist', 'webview', 'chat', 'main.js',
      ),
    );
    const codiconCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri, 'dist', 'webview', 'chat', 'codicon', 'codicon.css',
      ),
    );

    // UI-SPEC §5.2 strict CSP — no unsafe-inline, no remote sources.
    const csp =
      `default-src 'none'; ` +
      `img-src ${webview.cspSource} data:; ` +
      `style-src ${webview.cspSource} 'nonce-${nonce}'; ` +
      `font-src ${webview.cspSource}; ` +
      `script-src 'nonce-${nonce}';`;

    const templatePath = path.join(
      this.context.extensionUri.fsPath,
      'dist', 'webview', 'chat', 'index.html',
    );

    let html: string;
    try {
      html = fs.readFileSync(templatePath, 'utf-8');
    } catch {
      // Fallback inline HTML for dev builds where dist/ is not yet populated.
      html = [
        '<!DOCTYPE html><html lang="en"><head>',
        '<meta charset="UTF-8">',
        '<meta http-equiv="Content-Security-Policy" content="%%CSP%%">',
        '<link href="%%CODICON_CSS_URI%%" rel="stylesheet">',
        '<link href="%%CSS_URI%%" rel="stylesheet">',
        '</head><body>',
        '<div id="chat-root"></div>',
        '<script nonce="%%NONCE%%" src="%%JS_URI%%"></script>',
        '</body></html>',
      ].join('');
    }

    return html
      .replace(/%%CSP%%/g, csp)
      .replace(/%%NONCE%%/g, nonce)
      .replace(/%%CSS_URI%%/g, cssUri.toString())
      .replace(/%%JS_URI%%/g, jsUri.toString())
      .replace(/%%CODICON_CSS_URI%%/g, codiconCssUri.toString());
  }
}
