/**
 * Phase 6 Wave 2 (Plan 06-03) — ReviewState behavior tests.
 *
 * Pure in-memory class behavior. No vscode APIs, no real ws, no sinon spies.
 * Direct method calls + assertions.
 *
 * Coverage:
 *   - applyStateSync: replaces only the named branch slice; idempotent;
 *     preserves other branches.
 *   - applyOpened: insert + replace-on-id (supersede propagation).
 *   - applyComment: append; no-op on unknown reviewId.
 *   - applyVote: dedupe-by-reviewerMemberId + status transition (the rule
 *     MUST match SessionHost — pinned in source-grep test below).
 *   - applyResolved: closes the review; no-op on unknown id or already
 *     resolved.
 *   - getReview / getReviewByPushId / getReviewsForBranch: defensive deep
 *     copies; correct ordering for getReviewsForBranch.
 *   - getActiveReviewForPush: filters out resolved/abandoned; picks most
 *     recent.
 */
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ReviewState } from '../../state/ReviewState.js';
import type {
  ReviewRequest,
  ReviewComment,
  ReviewVoteRecord,
} from '../../types/review.js';

function makeReview(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    id: 'r-1',
    pushId: 'p-1',
    branch: 'main',
    authorMemberId: 'm-alice',
    authorDisplayName: 'Alice',
    openedAt: 1000,
    status: 'open',
    votes: [],
    comments: [],
    ...overrides,
  };
}

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c-1',
    reviewId: 'r-1',
    authorMemberId: 'm-bob',
    authorDisplayName: 'Bob',
    filePath: 'src/index.ts',
    line: 42,
    body: 'nit: rename',
    createdAt: 2000,
    ...overrides,
  };
}

function makeVote(overrides: Partial<ReviewVoteRecord> = {}): ReviewVoteRecord {
  return {
    reviewerMemberId: 'm-bob',
    reviewerDisplayName: 'Bob',
    vote: 'approved',
    votedAt: 3000,
    ...overrides,
  };
}

suite('Phase 6 Wave 2 — ReviewState (Plan 06-03)', () => {
  test('new ReviewState is empty', () => {
    const s = new ReviewState();
    assert.strictEqual(s.getReview('anything'), undefined);
    assert.deepStrictEqual(s.getReviewsForBranch('main'), []);
  });

  test('applyOpened inserts a new ReviewRequest by id', () => {
    const s = new ReviewState();
    const r = makeReview();
    s.applyOpened(r);
    assert.deepStrictEqual(s.getReview('r-1'), r);
  });

  test('applyOpened with same id replaces (supersede propagation)', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview({ id: 'r-1', authorDisplayName: 'Alice' }));
    s.applyOpened(makeReview({ id: 'r-1', authorDisplayName: 'AliceV2' }));
    const r = s.getReview('r-1');
    assert.strictEqual(r?.authorDisplayName, 'AliceV2');
  });

  test('applyStateSync replaces all reviews on the named branch', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview({ id: 'r-1', branch: 'main' }));
    s.applyOpened(makeReview({ id: 'r-2', branch: 'main' }));
    s.applyStateSync('main', [makeReview({ id: 'r-3', branch: 'main' })]);
    assert.strictEqual(s.getReview('r-1'), undefined);
    assert.strictEqual(s.getReview('r-2'), undefined);
    assert.ok(s.getReview('r-3') !== undefined);
  });

  test('applyStateSync does NOT touch reviews on other branches', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview({ id: 'r-feat', branch: 'feature-x' }));
    s.applyStateSync('main', [makeReview({ id: 'r-main', branch: 'main' })]);
    assert.ok(s.getReview('r-feat') !== undefined, 'feature-x should survive');
    assert.ok(s.getReview('r-main') !== undefined, 'main should be seeded');
  });

  test('applyStateSync is idempotent on replay (same reviews seed twice OK)', () => {
    const s = new ReviewState();
    const r = makeReview({ id: 'r-1', branch: 'main' });
    s.applyStateSync('main', [r]);
    s.applyStateSync('main', [r]);
    assert.deepStrictEqual(s.getReview('r-1'), r);
  });

  test('applyComment appends to parent.comments[]', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview());
    s.applyComment('r-1', makeComment({ id: 'c-1' }));
    s.applyComment('r-1', makeComment({ id: 'c-2', body: 'second' }));
    const r = s.getReview('r-1')!;
    assert.strictEqual(r.comments.length, 2);
    assert.strictEqual(r.comments[0].id, 'c-1');
    assert.strictEqual(r.comments[1].id, 'c-2');
  });

  test('applyComment is a no-op for unknown reviewId', () => {
    const s = new ReviewState();
    assert.doesNotThrow(() => s.applyComment('does-not-exist', makeComment()));
    assert.strictEqual(s.getReview('does-not-exist'), undefined);
  });

  test('applyVote dedupes by reviewerMemberId (latest wins)', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview());
    s.applyVote('r-1', makeVote({ reviewerMemberId: 'm-bob', vote: 'approved', votedAt: 100 }));
    s.applyVote('r-1', makeVote({ reviewerMemberId: 'm-bob', vote: 'changes-requested', votedAt: 200 }));
    const r = s.getReview('r-1')!;
    assert.strictEqual(r.votes.length, 1, 'duplicate reviewer collapsed');
    assert.strictEqual(r.votes[0].vote, 'changes-requested');
  });

  test('applyVote keeps distinct reviewerMemberIds as separate entries', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview());
    s.applyVote('r-1', makeVote({ reviewerMemberId: 'm-bob', vote: 'approved' }));
    s.applyVote('r-1', makeVote({ reviewerMemberId: 'm-carol', vote: 'approved' }));
    const r = s.getReview('r-1')!;
    assert.strictEqual(r.votes.length, 2);
  });

  test('applyVote status transition: any changes-requested → status=changes-requested', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview());
    s.applyVote('r-1', makeVote({ reviewerMemberId: 'm-bob', vote: 'approved' }));
    s.applyVote('r-1', makeVote({ reviewerMemberId: 'm-carol', vote: 'changes-requested' }));
    assert.strictEqual(s.getReview('r-1')?.status, 'changes-requested');
  });

  test('applyVote status transition: only approveds present → status=approved', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview());
    s.applyVote('r-1', makeVote({ reviewerMemberId: 'm-bob', vote: 'approved' }));
    s.applyVote('r-1', makeVote({ reviewerMemberId: 'm-carol', vote: 'approved' }));
    assert.strictEqual(s.getReview('r-1')?.status, 'approved');
  });

  test('applyVote status transition: only commented → status=open', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview());
    s.applyVote('r-1', makeVote({ reviewerMemberId: 'm-bob', vote: 'commented' }));
    assert.strictEqual(s.getReview('r-1')?.status, 'open');
  });

  test('applyVote re-vote from changes-requested → approved transitions back to approved', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview());
    s.applyVote('r-1', makeVote({ reviewerMemberId: 'm-bob', vote: 'changes-requested', votedAt: 100 }));
    assert.strictEqual(s.getReview('r-1')?.status, 'changes-requested');
    s.applyVote('r-1', makeVote({ reviewerMemberId: 'm-bob', vote: 'approved', votedAt: 200 }));
    assert.strictEqual(s.getReview('r-1')?.status, 'approved');
  });

  test('applyVote on unknown reviewId is a no-op (no throw)', () => {
    const s = new ReviewState();
    assert.doesNotThrow(() => s.applyVote('nope', makeVote()));
  });

  test('applyResolved sets status, resolvedBy, resolvedReason, resolvedAt', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview());
    s.applyResolved('r-1', 'm-alice', 'merged', 9999);
    const r = s.getReview('r-1')!;
    assert.strictEqual(r.status, 'resolved');
    assert.strictEqual(r.resolvedBy, 'm-alice');
    assert.strictEqual(r.resolvedReason, 'merged');
    assert.strictEqual(r.resolvedAt, 9999);
  });

  test('applyResolved is a no-op for unknown reviewId', () => {
    const s = new ReviewState();
    assert.doesNotThrow(() =>
      s.applyResolved('nope', 'm-alice', 'merged', 0),
    );
  });

  test('getReview returns a defensive deep copy (mutation does not leak)', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview());
    const out = s.getReview('r-1')!;
    out.status = 'abandoned';
    out.comments.push(makeComment({ id: 'evil' }));
    const fresh = s.getReview('r-1')!;
    assert.strictEqual(fresh.status, 'open');
    assert.strictEqual(fresh.comments.length, 0);
  });

  test('getReviewByPushId finds match + defensive copy', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview({ id: 'r-1', pushId: 'p-abc' }));
    const r = s.getReviewByPushId('p-abc');
    assert.strictEqual(r?.id, 'r-1');
    // mutate and verify cache unaffected
    r!.status = 'abandoned';
    assert.strictEqual(s.getReviewByPushId('p-abc')?.status, 'open');
  });

  test('getReviewByPushId returns undefined for unknown pushId', () => {
    const s = new ReviewState();
    assert.strictEqual(s.getReviewByPushId('nope'), undefined);
  });

  test('getActiveReviewForPush ignores resolved + abandoned, returns most recent', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview({ id: 'r-old', pushId: 'p-1', openedAt: 100 }));
    s.applyOpened(makeReview({ id: 'r-new', pushId: 'p-1', openedAt: 500 }));
    s.applyResolved('r-old', 'm-alice', 'abandoned', 200);
    const active = s.getActiveReviewForPush('p-1');
    assert.strictEqual(active?.id, 'r-new');
  });

  test('getActiveReviewForPush returns undefined when all reviews resolved', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview({ id: 'r-1', pushId: 'p-1', openedAt: 100 }));
    s.applyResolved('r-1', 'm-alice', 'merged', 200);
    assert.strictEqual(s.getActiveReviewForPush('p-1'), undefined);
  });

  test('getActiveReviewForPush returns undefined for unknown pushId', () => {
    const s = new ReviewState();
    assert.strictEqual(s.getActiveReviewForPush('nope'), undefined);
  });

  test('getReviewsForBranch returns reviews ordered by openedAt desc', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview({ id: 'r-1', openedAt: 100 }));
    s.applyOpened(makeReview({ id: 'r-2', openedAt: 500 }));
    s.applyOpened(makeReview({ id: 'r-3', openedAt: 300 }));
    const ordered = s.getReviewsForBranch('main').map(r => r.id);
    assert.deepStrictEqual(ordered, ['r-2', 'r-3', 'r-1']);
  });

  test('getReviewsForBranch returns [] for unknown branch', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview({ branch: 'main' }));
    assert.deepStrictEqual(s.getReviewsForBranch('nope'), []);
  });

  test('getReviewsForBranch returns defensive copies', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview({ id: 'r-1' }));
    const out = s.getReviewsForBranch('main');
    out[0].status = 'abandoned';
    assert.strictEqual(s.getReview('r-1')?.status, 'open');
  });

  test('applyComment defensive-copies the inbound comment (caller mutation does not leak)', () => {
    const s = new ReviewState();
    s.applyOpened(makeReview());
    const c = makeComment({ id: 'c-1', body: 'orig' });
    s.applyComment('r-1', c);
    c.body = 'mutated';
    assert.strictEqual(s.getReview('r-1')?.comments[0].body, 'orig');
  });

  test('status transition rule matches SessionHost (DRY guard)', () => {
    // The transition rule appears as 3 ordered checks: 'changes-requested'
    // dominates → 'approved' → 'open'. Pin the relative order in BOTH
    // source files. If either changes the rule without the other, the
    // mismatching file breaks this test (mismatched copies of the rule
    // are a correctness bug — host and client view of status diverges).
    const repoRoot = process.cwd();
    const reviewState = fs.readFileSync(
      path.resolve(repoRoot, 'src/state/ReviewState.ts'),
      'utf-8',
    );
    const sessionHost = fs.readFileSync(
      path.resolve(repoRoot, 'src/host/SessionHost.ts'),
      'utf-8',
    );
    const order = /v\.vote === 'changes-requested'[\s\S]{0,400}?v\.vote === 'approved'/;
    assert.match(
      reviewState,
      order,
      'ReviewState transition rule order mismatch — must be changes-requested → approved → open',
    );
    assert.match(
      sessionHost,
      order,
      'SessionHost transition rule order mismatch — drift between host + client',
    );
  });
});
