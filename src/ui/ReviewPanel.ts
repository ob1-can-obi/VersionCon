import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ReviewState } from '../state/ReviewState.js';
import type { PushRecord } from '../types/push.js';

/**
 * Phase 6 (Plan 06-04): WebviewPanel singleton scoped to a specific PushRecord.
 *
 * Architecture mirrors ChatPanel (Plan 04-10):
 *  - same CSP shape: default-src 'none'; img-src cspSource data:;
 *    style-src cspSource 'nonce-X'; font-src cspSource; script-src 'nonce-X'
 *  - same nonce pattern (crypto.randomBytes(16).base64)
 *  - same dispose discipline (this.disposables[])
 *  - same fallback HTML for missing dist/ template
 *  - same dist/webview/* asset layout (review/index.html + main.css + main.js
 *    + codicon/codicon.css|ttf copied by esbuild)
 *
 * Lifecycle:
 *  - createOrShow(context, pushId, versionconDir, callbacks):
 *      Opens new panel OR reveals the existing one if scoped to the same
 *      pushId. If a panel exists for a DIFFERENT pushId, it is disposed
 *      first (singleton invariant; one open review at a time).
 *  - refresh(state, push):
 *      Pulls the current review for this.scopedPushId from the supplied
 *      ReviewState + the supplied PushRecord, then posts a {type:'state',
 *      review, push, selfMemberId, hostMemberId} message to the webview.
 *  - dispose():
 *      Removes all listeners, disposes the panel; static currentPanel
 *      cleared.
 *
 * Message routing (webview → extension via callbacks):
 *  - webview-ready          → no-op (the spawning code calls refresh() right
 *                             after construction; this signal exists for
 *                             forward-compat / debug logging)
 *  - open-file-diff         → ReviewPanel calls vscode.commands.executeCommand
 *                             ('vscode.diff', preUri, postUri, title) where
 *                             preUri = .versioncon/push-snapshots/{pushId}/{rel}
 *                             postUri = .versioncon/branches/{branch}/{rel}
 *                             (T-06-04 mitigation: paths constructed from
 *                             host-stamped pushId + PushRecord.files[].relativePath
 *                             — no user-supplied path enters URI construction)
 *  - review-vote-submit     → onVoteRequested callback (defense-in-depth
 *                             shape validation here; host re-validates per
 *                             Plan 06-02 T-06-01)
 *  - review-comment-submit  → onCommentRequested callback (16 KiB body cap,
 *                             line bounds, filePath length sanity check —
 *                             all are defense-in-depth; the host's wire
 *                             handler is the trust authority)
 *  - review-resolve-submit  → onResolveRequested callback
 *
 * Threats mitigated (T-06-* — see 06-04-PLAN.md threat_model):
 *  - T-06-02 (XSS): markdown-it html:false bundled into review/main.js;
 *    CSP script-src 'nonce-X' blocks inline scripts. No remote sources.
 *  - T-06-01 (spoofing): webview-originated wire frames carry EMPTY
 *    reviewerMemberId/displayName; the host (Plan 06-02 OWNER) overrides
 *    unconditionally at relay.
 *  - T-06-04 (path tampering): preFsPath / postFsPath constructed from
 *    host-stamped pushId + PushRecord.files[].relativePath.
 *  - T-06-05 (state replay): ReviewPanel reads from ReviewState which is
 *    fed only by SessionClient's host-ws handler. No peer-to-peer path.
 */
export class ReviewPanel {
  public static currentPanel: ReviewPanel | undefined;

  public readonly scopedPushId: string;
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly versionconDir: string;
  private readonly disposables: vscode.Disposable[] = [];
  /** Set on the first refresh() so openFileDiff can resolve branch dirs. */
  private scopedBranch: string | null = null;

  // Callbacks supplied by extension.ts at createOrShow time.
  private readonly onVoteRequested: (
    reviewId: string,
    vote: 'approved' | 'changes-requested' | 'commented',
  ) => void;
  private readonly onCommentRequested: (
    reviewId: string,
    filePath: string,
    line: number,
    body: string,
  ) => void;
  private readonly onResolveRequested: (
    reviewId: string,
    resolvedReason: 'merged' | 'abandoned',
  ) => void;
  private readonly getSelfMemberId: () => string;
  private readonly getHostMemberId: () => string;

  private constructor(
    context: vscode.ExtensionContext,
    pushId: string,
    versionconDir: string,
    callbacks: ReviewPanelCallbacks,
  ) {
    this.context = context;
    this.scopedPushId = pushId;
    this.versionconDir = versionconDir;
    this.onVoteRequested = callbacks.onVoteRequested;
    this.onCommentRequested = callbacks.onCommentRequested;
    this.onResolveRequested = callbacks.onResolveRequested;
    this.getSelfMemberId = callbacks.getSelfMemberId;
    this.getHostMemberId = callbacks.getHostMemberId;

    this.panel = vscode.window.createWebviewPanel(
      'versioncon.review',
      `Review: ${pushId.substring(0, 7)}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'review'),
        ],
      },
    );

    this.panel.webview.html = this.getWebviewContent();

    this.panel.webview.onDidReceiveMessage(
      (msg) => { void this.handleMessage(msg); },
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /**
   * Open a new ReviewPanel scoped to pushId, OR reveal the existing one if
   * already scoped to the same pushId. Singleton invariant: at most one
   * ReviewPanel exists at a time; switching pushIds disposes the prior
   * panel.
   */
  static createOrShow(
    context: vscode.ExtensionContext,
    pushId: string,
    versionconDir: string,
    callbacks: ReviewPanelCallbacks,
  ): ReviewPanel {
    if (ReviewPanel.currentPanel && ReviewPanel.currentPanel.scopedPushId !== pushId) {
      ReviewPanel.currentPanel.dispose();
    }
    if (!ReviewPanel.currentPanel) {
      ReviewPanel.currentPanel = new ReviewPanel(context, pushId, versionconDir, callbacks);
    } else {
      ReviewPanel.currentPanel.panel.reveal();
    }
    return ReviewPanel.currentPanel;
  }

  /**
   * Stamp the scoped branch — required by openFileDiff to resolve the
   * post-push file location. extension.ts MUST call this before the first
   * refresh().
   */
  setScopedBranch(branch: string): void {
    this.scopedBranch = branch;
  }

  /**
   * Pull the active review for this.scopedPushId from the supplied
   * ReviewState + the supplied PushRecord, then post a {type:'state', ...}
   * snapshot to the webview. Called by extension.ts on every
   * review-opened/comment/vote/resolved/state-sync event that touches a
   * review whose pushId matches scopedPushId.
   */
  refresh(reviewState: ReviewState, push: PushRecord | undefined): void {
    const review = reviewState.getActiveReviewForPush(this.scopedPushId)
      ?? reviewState.getReviewByPushId(this.scopedPushId);
    void this.panel.webview.postMessage({
      type: 'state',
      review: review ?? null,
      push: push ?? null,
      selfMemberId: this.getSelfMemberId(),
      hostMemberId: this.getHostMemberId(),
    });
  }

  /** Inbound webview-message dispatcher. Validates shape before forwarding. */
  private async handleMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    if (typeof m.type !== 'string') return;
    switch (m.type) {
      case 'webview-ready':
        // The spawning code calls refresh() right after construction; nothing
        // to do here. Keep the case so the webview's webview-ready ping
        // doesn't fall into the default branch (forward-compat / debug log).
        break;

      case 'open-file-diff': {
        if (typeof m.filePath !== 'string') return;
        await this.openFileDiff(m.filePath);
        break;
      }

      case 'review-vote-submit': {
        if (typeof m.reviewId !== 'string' || m.reviewId.length === 0) return;
        if (m.vote !== 'approved' && m.vote !== 'changes-requested' && m.vote !== 'commented') return;
        this.onVoteRequested(m.reviewId, m.vote);
        break;
      }

      case 'review-comment-submit': {
        if (typeof m.reviewId !== 'string' || m.reviewId.length === 0) return;
        if (typeof m.filePath !== 'string' || m.filePath.length === 0) return;
        if (typeof m.line !== 'number' || !Number.isInteger(m.line) || m.line < 1) return;
        if (typeof m.body !== 'string' || m.body.length === 0 || m.body.length > 16_384) return;
        this.onCommentRequested(m.reviewId, m.filePath, m.line, m.body);
        break;
      }

      case 'review-resolve-submit': {
        if (typeof m.reviewId !== 'string' || m.reviewId.length === 0) return;
        if (m.resolvedReason !== 'merged' && m.resolvedReason !== 'abandoned') return;
        this.onResolveRequested(m.reviewId, m.resolvedReason);
        break;
      }

      default:
        // Unknown types silently ignored — forward-compat.
        break;
    }
  }

  /**
   * Invoke vscode.diff against (pre-push snapshot ↔ post-push branch content)
   * for the requested file.
   *
   * pre side: .versioncon/push-snapshots/{pushId}/{relativePath} — saved by
   *   PushService at push time (PushHistory pre-push snapshot).
   * post side: .versioncon/branches/{branch}/{relativePath} — current branch
   *   content (the post-push file).
   *
   * If the pre-push snapshot does not exist on disk (newly-added file in
   * this push; PushService skips saveSnapshot when branchExists was false),
   * we fall back to an untitled empty-doc URI so the diff renders "empty vs
   * new file content" — same edge-case handling that versioncon.previewDiff
   * applies.
   */
  private async openFileDiff(relativePath: string): Promise<void> {
    if (!this.scopedBranch) {
      void vscode.window.showWarningMessage(
        'Review state not loaded yet — try again in a moment.',
      );
      return;
    }
    const preFsPath = path.join(
      this.versionconDir, 'push-snapshots', this.scopedPushId, relativePath,
    );
    const postFsPath = path.join(
      this.versionconDir, 'branches', this.scopedBranch, relativePath,
    );
    let preUri: vscode.Uri;
    try {
      await fs.promises.access(preFsPath);
      preUri = vscode.Uri.file(preFsPath);
    } catch {
      // No snapshot = newly-added file in this push. Use an untitled empty
      // URI as the pre side so the diff renders ('' vs new file content).
      preUri = vscode.Uri.parse(`untitled:${relativePath}.empty`);
    }
    const postUri = vscode.Uri.file(postFsPath);
    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        preUri,
        postUri,
        `Review: ${relativePath}`,
      );
    } catch (err) {
      console.error('[ReviewPanel] vscode.diff failed', err);
      void vscode.window.showErrorMessage(
        `Failed to open diff for ${relativePath}.`,
      );
    }
  }

  dispose(): void {
    ReviewPanel.currentPanel = undefined;
    while (this.disposables.length) {
      const d = this.disposables.pop();
      try {
        d?.dispose();
      } catch {
        // ignore
      }
    }
    try {
      this.panel.dispose();
    } catch {
      // already disposed
    }
  }

  /**
   * Phase 6 Plan 06-05: register an external disposable into this panel's
   * cleanup chain. Used by extension.ts to link the per-review
   * vscode.CommentController + its per-thread disposables to the panel's
   * lifecycle, so closing the ReviewPanel automatically tears down the
   * inline comment surface. Mirrors the chat-panel's owned-disposable
   * pattern without exposing the disposables array directly.
   */
  addOwnedDisposable(d: vscode.Disposable): void {
    this.disposables.push(d);
  }

  /**
   * Build the webview HTML. Reads dist/webview/review/index.html (copied by
   * esbuild's review-assets onEnd plugin), replaces the 5 placeholders with
   * runtime values + a fresh nonce.
   *
   * Falls back to an inline minimal HTML scaffold if the template is missing
   * — useful during development before the first build, and lets unit tests
   * instantiate ReviewPanel without prebuilding.
   */
  private getWebviewContent(): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');

    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri, 'dist', 'webview', 'review', 'main.css',
      ),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri, 'dist', 'webview', 'review', 'main.js',
      ),
    );
    const codiconCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri, 'dist', 'webview', 'review', 'codicon', 'codicon.css',
      ),
    );

    // UI-SPEC §5.2 strict CSP — mirror of Plan 04-10 ChatPanel verbatim.
    const csp =
      `default-src 'none'; ` +
      `img-src ${webview.cspSource} data:; ` +
      `style-src ${webview.cspSource} 'nonce-${nonce}'; ` +
      `font-src ${webview.cspSource}; ` +
      `script-src 'nonce-${nonce}';`;

    const templatePath = path.join(
      this.context.extensionUri.fsPath,
      'dist', 'webview', 'review', 'index.html',
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
        '<div id="review-root"></div>',
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

/**
 * Wiring bundle the extension supplies at createOrShow time. Lets the
 * ReviewPanel route webview actions back into the active session without
 * coupling to SessionClient/SessionHost module references directly.
 */
export interface ReviewPanelCallbacks {
  onVoteRequested: (
    reviewId: string,
    vote: 'approved' | 'changes-requested' | 'commented',
  ) => void;
  onCommentRequested: (
    reviewId: string,
    filePath: string,
    line: number,
    body: string,
  ) => void;
  onResolveRequested: (
    reviewId: string,
    resolvedReason: 'merged' | 'abandoned',
  ) => void;
  getSelfMemberId: () => string;
  getHostMemberId: () => string;
}
