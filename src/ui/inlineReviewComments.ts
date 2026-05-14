/**
 * Phase 6 Plan 06-05 — vscode.commentController population for an open
 * ReviewPanel.
 *
 * Architecture:
 *  - extension.ts owns the per-review CommentController lifecycle (constructed
 *    on versioncon.openReview, disposed when the ReviewPanel disposes — wired
 *    via panel.addOwnedDisposable so the cleanup chain is centralized on the
 *    panel).
 *  - This helper consumes an already-constructed CommentController and
 *    populates it with one CommentThread per {filePath}:{line} group from
 *    review.comments. Returns the per-thread disposables so the caller can
 *    GC them on the next refresh (full rebuild is simpler than diff-and-patch
 *    and the per-review count is bounded by host's 500-cap from Plan 06-02).
 *
 * v1 contract:
 *  - Replies on existing threads are routed via thread.canReply = true and
 *    the contributed `versioncon.review.replyToComment` command. The reply's
 *    CommentReply event carries the thread URI + range which extension.ts
 *    maps back to {filePath, line} and forwards through the same wire-frame
 *    path as ReviewPanel.onCommentRequested.
 *  - No gutter "Add comment on this line" affordance on bare lines —
 *    commentingRangeProvider returns []. Users compose new threads via the
 *    ReviewPanel webview's per-file-row composer. Adding a gutter add-comment
 *    surface is a Phase 6.x deliverable.
 *
 * T-06-02 (XSS): comment bodies are wrapped in vscode.MarkdownString;
 * MarkdownString.isTrusted defaults to false so raw HTML in comment.body is
 * escaped by VS Code's comment renderer.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import type { ReviewRequest, ReviewComment } from '../types/review.js';

export type InlineReplyHandler = (
  filePath: string,
  line: number,
  body: string,
) => void;

/**
 * Construct one CommentThread per {filePath}:{line} group in review.comments
 * and attach them to the supplied CommentController. Returns the per-thread
 * disposables; callers add these to the ReviewPanel's disposable chain so
 * the threads are cleaned up when the panel disposes or refreshes.
 *
 * @param controller          The per-review CommentController (already
 *                            constructed by extension.ts).
 * @param review              The current ReviewRequest snapshot.
 * @param branchDir           Absolute path to the active branch directory
 *                            (.versioncon/branches/{branch}) — used to build
 *                            thread URIs via path.join(branchDir, filePath).
 * @param _onReplyRequested   Reply callback wired up by the contributed
 *                            `versioncon.review.replyToComment` command in
 *                            extension.ts. Stored on the controller for now;
 *                            referenced via the underscore-prefix to mark it
 *                            as "consumed by the reply command, not directly
 *                            by this helper". A future revision may attach
 *                            the handler to thread.contextValue once VS Code
 *                            exposes a per-thread reply event.
 */
export function registerInlineCommentsForReview(
  controller: vscode.CommentController,
  review: ReviewRequest,
  branchDir: string,
  _onReplyRequested: InlineReplyHandler,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // v1: no bare-line "Add comment" gutter UI — return [] for all lines.
  // (Existing threads still receive the standard reply affordance because
  // thread.canReply = true; this is independent of commentingRangeProvider.)
  controller.commentingRangeProvider = {
    provideCommentingRanges: () => [],
  };

  // Group review.comments by {filePath}:{line}. Each group becomes one
  // CommentThread with multiple comments sorted by createdAt ascending.
  const groups = new Map<string, ReviewComment[]>();
  for (const c of review.comments) {
    const key = `${c.filePath}::${c.line}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(c);
    } else {
      groups.set(key, [c]);
    }
  }

  for (const [, comments] of groups) {
    const first = comments[0];
    const lineZeroBased = Math.max(0, first.line - 1);
    const uri = vscode.Uri.file(path.join(branchDir, first.filePath));
    const range = new vscode.Range(lineZeroBased, 0, lineZeroBased, 0);

    const sorted = [...comments].sort((a, b) => a.createdAt - b.createdAt);
    const threadComments: vscode.Comment[] = sorted.map(c => ({
      body: new vscode.MarkdownString(c.body),
      mode: vscode.CommentMode.Preview,
      author: { name: c.authorDisplayName },
      contextValue: 'versioncon.review.comment',
    }));

    const thread = controller.createCommentThread(uri, range, threadComments);
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.label = `${threadComments.length} comment${threadComments.length === 1 ? '' : 's'}`;
    disposables.push(thread);
  }

  return disposables;
}
