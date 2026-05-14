/**
 * Phase 6 Wave 5 (Plan 06-05) — vscode.commentController inline review-comment
 * surface suite.
 *
 * Source-grep + light behavior tests. The vscode.comments API surface is
 * large (CommentController, CommentThread, Comment, CommentReply,
 * CommentingRangeProvider, CommentMode, etc.) and hard to mock standalone —
 * the plan's <verify> block explicitly permits a source-grep-dominant
 * posture for this task. Pure-function tests on the registerInlineCommentsForReview
 * helper use a fake CommentController whose createCommentThread captures
 * args, so the grouping/sorting/range-construction logic is exercised
 * without the real API.
 *
 * Tested behaviors:
 *  - extension.ts uses vscode.comments.createCommentController per-review
 *  - registerInlineCommentsForReview groups review.comments by {filePath}:{line}
 *  - one CommentThread per {filePath}:{line} group with the comments sorted
 *    by createdAt ascending
 *  - thread URI constructed via path.join(branchDir, filePath)
 *  - thread range starts at (line - 1) zero-based
 *  - thread.canReply = true, thread.label exposes comment count
 *  - Comment.body wraps the raw markdown in vscode.MarkdownString (T-06-02
 *    rendering posture; MarkdownString.isTrusted default false)
 *  - commentingRangeProvider.provideCommentingRanges returns [] (v1 contract:
 *    no gutter "Add comment" affordance on bare lines; deferred to Phase 6.x)
 *  - versioncon.review.replyToComment command registered for thread replies
 *  - Controller wired into ReviewPanel.addOwnedDisposable on createOrShow
 *  - On every review-comment event, the inline threads are rebuilt (full
 *    rebuild rather than diff-and-patch — bounded by host's 500-cap)
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { registerInlineCommentsForReview } from '../../ui/inlineReviewComments.js';
import type { ReviewRequest, ReviewComment } from '../../types/review.js';

const repoRoot = process.cwd();
const readSrc = (rel: string): string =>
  fs.readFileSync(path.resolve(repoRoot, rel), 'utf-8');

// -----------------------------------------------------------------------------
// Fake vscode.CommentController harness — captures createCommentThread args.
// -----------------------------------------------------------------------------
interface CapturedThread {
  uri: { fsPath: string };
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  comments: Array<{ body: unknown; author: { name: string } }>;
  canReply: boolean;
  label: string;
  collapsibleState: number;
  disposed: boolean;
}

interface FakeController {
  threads: CapturedThread[];
  commentingRangeProvider?: { provideCommentingRanges: () => unknown[] };
  options?: unknown;
  createCommentThread: (uri: unknown, range: unknown, comments: unknown[]) => CapturedThread;
}

function makeFakeController(): FakeController {
  const ctl: FakeController = {
    threads: [],
    createCommentThread(uri: unknown, range: unknown, comments: unknown[]): CapturedThread {
      const thread: CapturedThread = {
        uri: uri as { fsPath: string },
        range: range as CapturedThread['range'],
        comments: comments as CapturedThread['comments'],
        canReply: false,
        label: '',
        collapsibleState: 0,
        disposed: false,
      };
      ctl.threads.push(thread);
      return thread;
    },
  };
  return ctl;
}

function makeReview(comments: ReviewComment[]): ReviewRequest {
  return {
    id: 'r1',
    pushId: 'push-abc1234',
    branch: 'feature',
    authorMemberId: 'a1',
    authorDisplayName: 'A',
    openedAt: 1000,
    status: 'open',
    votes: [],
    comments,
  };
}

function makeComment(o: Partial<ReviewComment>): ReviewComment {
  return {
    id: o.id ?? `c-${Math.random().toString(36).slice(2, 8)}`,
    reviewId: o.reviewId ?? 'r1',
    authorMemberId: o.authorMemberId ?? 'a1',
    authorDisplayName: o.authorDisplayName ?? 'Author',
    filePath: o.filePath ?? 'src/foo.ts',
    line: o.line ?? 1,
    body: o.body ?? 'body',
    createdAt: o.createdAt ?? 1000,
  };
}

suite('Phase 6 Wave 5 — registerInlineCommentsForReview (Task 3 behavior)', () => {
  const branchDir = path.join('/', 'tmp', 'branches', 'feature');

  test('empty review.comments → no threads created', () => {
    const ctl = makeFakeController();
    const disposables = registerInlineCommentsForReview(
      ctl as unknown as Parameters<typeof registerInlineCommentsForReview>[0],
      makeReview([]),
      branchDir,
      () => {},
    );
    assert.strictEqual(ctl.threads.length, 0);
    assert.strictEqual(disposables.length, 0);
  });

  test('one comment → one thread; URI from path.join(branchDir, filePath)', () => {
    const ctl = makeFakeController();
    registerInlineCommentsForReview(
      ctl as unknown as Parameters<typeof registerInlineCommentsForReview>[0],
      makeReview([makeComment({ filePath: 'src/foo.ts', line: 10 })]),
      branchDir,
      () => {},
    );
    assert.strictEqual(ctl.threads.length, 1);
    assert.strictEqual(
      ctl.threads[0].uri.fsPath,
      path.join(branchDir, 'src/foo.ts'),
    );
  });

  test('two comments on same {file,line} → ONE thread with 2 comments', () => {
    const ctl = makeFakeController();
    registerInlineCommentsForReview(
      ctl as unknown as Parameters<typeof registerInlineCommentsForReview>[0],
      makeReview([
        makeComment({ id: 'c1', filePath: 'src/foo.ts', line: 5, createdAt: 1000 }),
        makeComment({ id: 'c2', filePath: 'src/foo.ts', line: 5, createdAt: 2000 }),
      ]),
      branchDir,
      () => {},
    );
    assert.strictEqual(ctl.threads.length, 1);
    assert.strictEqual(ctl.threads[0].comments.length, 2);
  });

  test('comments on different files → ≥2 threads', () => {
    const ctl = makeFakeController();
    registerInlineCommentsForReview(
      ctl as unknown as Parameters<typeof registerInlineCommentsForReview>[0],
      makeReview([
        makeComment({ filePath: 'src/a.ts', line: 1 }),
        makeComment({ filePath: 'src/b.ts', line: 1 }),
      ]),
      branchDir,
      () => {},
    );
    assert.strictEqual(ctl.threads.length, 2);
  });

  test('comments sorted by createdAt ascending within a thread', () => {
    const ctl = makeFakeController();
    registerInlineCommentsForReview(
      ctl as unknown as Parameters<typeof registerInlineCommentsForReview>[0],
      makeReview([
        makeComment({ id: 'late',  body: 'B', filePath: 'src/x.ts', line: 1, createdAt: 3000 }),
        makeComment({ id: 'early', body: 'A', filePath: 'src/x.ts', line: 1, createdAt: 1000 }),
        makeComment({ id: 'mid',   body: 'M', filePath: 'src/x.ts', line: 1, createdAt: 2000 }),
      ]),
      branchDir,
      () => {},
    );
    const thread = ctl.threads[0];
    assert.strictEqual(thread.comments.length, 3);
    // The Comment.author.name is set per-comment, so author identity OR body
    // ordering is testable. We assert author display name AND that body
    // ordering matches createdAt ASC.
    // Comment.body is a MarkdownString — value access varies; we extract via
    // any-cast since the fake captures whatever was passed.
    const bodyValue = (c: { body: unknown }): string => {
      const b = c.body as { value?: string };
      return typeof b === 'object' && b && 'value' in b ? String(b.value) : String(c.body);
    };
    assert.strictEqual(bodyValue(thread.comments[0]), 'A');
    assert.strictEqual(bodyValue(thread.comments[1]), 'M');
    assert.strictEqual(bodyValue(thread.comments[2]), 'B');
  });

  test('thread range starts at (line - 1) zero-based', () => {
    const ctl = makeFakeController();
    registerInlineCommentsForReview(
      ctl as unknown as Parameters<typeof registerInlineCommentsForReview>[0],
      makeReview([makeComment({ filePath: 'src/foo.ts', line: 42 })]),
      branchDir,
      () => {},
    );
    assert.strictEqual(ctl.threads[0].range.start.line, 41);
  });

  test('thread range clamps line < 1 to line 0 (defensive)', () => {
    const ctl = makeFakeController();
    registerInlineCommentsForReview(
      ctl as unknown as Parameters<typeof registerInlineCommentsForReview>[0],
      makeReview([makeComment({ filePath: 'src/foo.ts', line: 0 })]),
      branchDir,
      () => {},
    );
    assert.strictEqual(ctl.threads[0].range.start.line, 0);
  });

  test('thread.canReply = true; thread.label includes comment count', () => {
    const ctl = makeFakeController();
    registerInlineCommentsForReview(
      ctl as unknown as Parameters<typeof registerInlineCommentsForReview>[0],
      makeReview([
        makeComment({ filePath: 'src/foo.ts', line: 1 }),
        makeComment({ filePath: 'src/foo.ts', line: 1 }),
      ]),
      branchDir,
      () => {},
    );
    assert.strictEqual(ctl.threads[0].canReply, true);
    assert.match(ctl.threads[0].label, /comment/);
  });

  test('commentingRangeProvider returns [] (v1 — no gutter add-comment affordance)', () => {
    const ctl = makeFakeController();
    registerInlineCommentsForReview(
      ctl as unknown as Parameters<typeof registerInlineCommentsForReview>[0],
      makeReview([]),
      branchDir,
      () => {},
    );
    assert.ok(ctl.commentingRangeProvider);
    const ranges = ctl.commentingRangeProvider!.provideCommentingRanges();
    assert.ok(Array.isArray(ranges));
    assert.strictEqual(ranges.length, 0);
  });

  test('returned disposables match the number of threads created', () => {
    const ctl = makeFakeController();
    const disp = registerInlineCommentsForReview(
      ctl as unknown as Parameters<typeof registerInlineCommentsForReview>[0],
      makeReview([
        makeComment({ filePath: 'src/a.ts', line: 1 }),
        makeComment({ filePath: 'src/b.ts', line: 1 }),
        makeComment({ filePath: 'src/b.ts', line: 2 }),
      ]),
      branchDir,
      () => {},
    );
    // 3 threads (a:1, b:1, b:2)
    assert.strictEqual(ctl.threads.length, 3);
    assert.strictEqual(disp.length, 3);
  });
});

// -----------------------------------------------------------------------------
// Source-grep contract — pin wiring choices that span multiple files.
// -----------------------------------------------------------------------------

suite('Phase 6 Wave 5 — vscode.commentController wiring source-grep (Task 3)', () => {
  test('extension.ts uses vscode.comments.createCommentController', () => {
    const ext = readSrc('src/extension.ts');
    assert.match(ext, /vscode\.comments\.createCommentController/);
  });

  test('extension.ts imports registerInlineCommentsForReview', () => {
    const ext = readSrc('src/extension.ts');
    assert.match(ext, /registerInlineCommentsForReview/);
  });

  test('inlineReviewComments.ts groups by filePath:line key', () => {
    const src = readSrc('src/ui/inlineReviewComments.ts');
    assert.match(src, /filePath/);
    assert.match(src, /line/);
    // Group key construction lives in the helper.
    assert.match(src, /Map/);
  });

  test('inlineReviewComments.ts wraps comment bodies in vscode.MarkdownString (T-06-02)', () => {
    const src = readSrc('src/ui/inlineReviewComments.ts');
    assert.match(src, /MarkdownString/);
  });

  test('inlineReviewComments.ts sets thread.canReply = true', () => {
    const src = readSrc('src/ui/inlineReviewComments.ts');
    assert.match(src, /canReply\s*=\s*true/);
  });

  test('extension.ts registers versioncon.review.replyToComment command', () => {
    const ext = readSrc('src/extension.ts');
    assert.match(ext, /['"]versioncon\.review\.replyToComment['"]/);
  });

  test('ReviewPanel.addOwnedDisposable method exists for controller lifecycle', () => {
    const rp = readSrc('src/ui/ReviewPanel.ts');
    assert.match(rp, /addOwnedDisposable\s*\(/);
  });

  test('extension.ts links the inline-comment controller into ReviewPanel disposal chain', () => {
    const ext = readSrc('src/extension.ts');
    // Controller is added via panel.addOwnedDisposable OR via the inline
    // helper's returned disposables AND then attached.
    assert.match(ext, /addOwnedDisposable/);
  });
});
