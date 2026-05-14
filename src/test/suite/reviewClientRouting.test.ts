/**
 * Phase 6 Wave 2 (Plan 06-03) — SessionClient review wire-routing tests.
 *
 * Mirrors the Plan 04-05 typed-bracket-cast harness pattern: invoke the
 * private `handleMessage` method directly without standing up a real ws.
 * Asserts that each of the 5 new review wire types fires the correct typed
 * SessionEventMap event with the correct payload.
 *
 * SessionClient is a pure wire-to-event forwarder for review-* — identity
 * + timestamps are host-stamped at relay (Plan 06-02 T-06-01 mitigation),
 * so the routing layer does not re-validate.
 */
import * as assert from 'assert';
import { SessionClient } from '../../client/SessionClient.js';
import type {
  ReviewRequest,
  ReviewComment,
  ReviewVoteRecord,
} from '../../types/review.js';

type HandleMessageProbe = {
  handleMessage: (m: unknown, cb: (b: boolean) => void) => void;
};

function makeClient(): SessionClient {
  // hostIp/port unused because we drive handleMessage directly.
  return new SessionClient('127.0.0.1', 9999, 'invite', 'Tester');
}

function probe(client: SessionClient): HandleMessageProbe {
  return client as unknown as HandleMessageProbe;
}

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

suite('Phase 6 Wave 2 — SessionClient review routing (Plan 06-03)', () => {
  test('review-opened wire → review-opened event with review payload', () => {
    const client = makeClient();
    const review = makeReview();
    let received: { review: ReviewRequest } | null = null;
    client.on('review-opened', (data) => {
      received = data;
    });
    probe(client).handleMessage(
      { type: 'review-opened', timestamp: 1000, review },
      () => {},
    );
    assert.deepStrictEqual(received, { review });
  });

  test('review-comment wire → review-comment event with reviewId + comment', () => {
    const client = makeClient();
    const comment = makeComment();
    let received: { reviewId: string; comment: ReviewComment } | null = null;
    client.on('review-comment', (data) => {
      received = data;
    });
    probe(client).handleMessage(
      {
        type: 'review-comment',
        timestamp: 2000,
        reviewId: 'r-1',
        comment,
      },
      () => {},
    );
    assert.deepStrictEqual(received, { reviewId: 'r-1', comment });
  });

  test('review-vote wire → review-vote event with reviewId + vote', () => {
    const client = makeClient();
    const vote = makeVote();
    let received: { reviewId: string; vote: ReviewVoteRecord } | null = null;
    client.on('review-vote', (data) => {
      received = data;
    });
    probe(client).handleMessage(
      {
        type: 'review-vote',
        timestamp: 3000,
        reviewId: 'r-1',
        vote,
      },
      () => {},
    );
    assert.deepStrictEqual(received, { reviewId: 'r-1', vote });
  });

  test('review-vote forwards changes-requested vote verbatim', () => {
    const client = makeClient();
    const vote = makeVote({ vote: 'changes-requested' });
    let received: { reviewId: string; vote: ReviewVoteRecord } | null = null;
    client.on('review-vote', (data) => {
      received = data;
    });
    probe(client).handleMessage(
      {
        type: 'review-vote',
        timestamp: 3500,
        reviewId: 'r-2',
        vote,
      },
      () => {},
    );
    assert.ok(received !== null);
    assert.strictEqual(received!.vote.vote, 'changes-requested');
  });

  test('review-resolved wire → review-resolved event with all 3 fields', () => {
    const client = makeClient();
    let received: {
      reviewId: string;
      resolvedBy: string;
      resolvedReason: 'merged' | 'abandoned';
    } | null = null;
    client.on('review-resolved', (data) => {
      received = data;
    });
    probe(client).handleMessage(
      {
        type: 'review-resolved',
        timestamp: 4000,
        reviewId: 'r-1',
        resolvedBy: 'm-alice',
        resolvedReason: 'merged',
      },
      () => {},
    );
    assert.deepStrictEqual(received, {
      reviewId: 'r-1',
      resolvedBy: 'm-alice',
      resolvedReason: 'merged',
    });
  });

  test('review-resolved with reason=abandoned forwards verbatim', () => {
    const client = makeClient();
    let received: {
      reviewId: string;
      resolvedBy: string;
      resolvedReason: 'merged' | 'abandoned';
    } | null = null;
    client.on('review-resolved', (data) => {
      received = data;
    });
    probe(client).handleMessage(
      {
        type: 'review-resolved',
        timestamp: 4500,
        reviewId: 'r-3',
        resolvedBy: 'm-alice',
        resolvedReason: 'abandoned',
      },
      () => {},
    );
    assert.strictEqual(received!.resolvedReason, 'abandoned');
  });

  test('review-state-sync wire → review-state-sync event with branch + reviews', () => {
    const client = makeClient();
    const r1 = makeReview({ id: 'r-a', pushId: 'p-a' });
    const r2 = makeReview({ id: 'r-b', pushId: 'p-b', openedAt: 5000 });
    let received: { branch: string; reviews: ReviewRequest[] } | null = null;
    client.on('review-state-sync', (data) => {
      received = data;
    });
    probe(client).handleMessage(
      {
        type: 'review-state-sync',
        timestamp: 6000,
        branch: 'main',
        reviews: [r1, r2],
      },
      () => {},
    );
    assert.deepStrictEqual(received, { branch: 'main', reviews: [r1, r2] });
  });

  test('review-state-sync with empty reviews array forwards verbatim', () => {
    const client = makeClient();
    let received: { branch: string; reviews: ReviewRequest[] } | null = null;
    client.on('review-state-sync', (data) => {
      received = data;
    });
    probe(client).handleMessage(
      {
        type: 'review-state-sync',
        timestamp: 6000,
        branch: 'feature-x',
        reviews: [],
      },
      () => {},
    );
    assert.deepStrictEqual(received, { branch: 'feature-x', reviews: [] });
  });

  test('unknown wire type does not throw (regression guard)', () => {
    const client = makeClient();
    assert.doesNotThrow(() => {
      probe(client).handleMessage(
        { type: 'made-up-type', timestamp: 1000 },
        () => {},
      );
    });
  });

  test('existing chat-message routing still emits chat-received (Plan 04-05 regression)', () => {
    const client = makeClient();
    let received: unknown = null;
    client.on('chat-received', (data) => {
      received = data;
    });
    probe(client).handleMessage(
      {
        type: 'chat-message',
        timestamp: 1000,
        recordId: 'r1',
        kind: 'user',
        memberId: 'm1',
        memberDisplayName: 'Alice',
        body: 'hi',
      },
      () => {},
    );
    assert.ok(received !== null, 'chat-received should still fire');
  });

  test('existing presence-update routing still emits presence-update (Plan 04-05 regression)', () => {
    const client = makeClient();
    let received: unknown = null;
    client.on('presence-update', (data) => {
      received = data;
    });
    probe(client).handleMessage(
      {
        type: 'presence-update',
        timestamp: 1234,
        memberId: 'm1',
        displayName: 'Alice',
        branch: 'main',
        activeFilePath: 'src/index.ts',
      },
      () => {},
    );
    assert.ok(received !== null, 'presence-update should still fire');
  });
});
