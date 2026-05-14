/**
 * Phase 6 (Plan 06-03): client-side in-memory cache of every ReviewRequest
 * the host has broadcast or replayed via review-state-sync. Keyed by
 * ReviewRequest.id with a secondary lookup by pushId (used by
 * getActiveReviewForPush — Plan 06-05's mergeBranch gate).
 *
 * Apply mutators mirror the host's status-transition rules from
 * src/host/SessionHost.ts (Plan 06-02 review-vote handler) — the two
 * implementations MUST stay in sync. reviewState.test.ts pins the rule
 * via source-grep so drift in either file breaks the build.
 *
 * Defensive deep copies via JSON round-trip on every getter — mirrors
 * PresenceMap.getSnapshot and ReviewStore.getReview (Plan 04-03 / Plan 06-01
 * STATE.md decisions). Mutating a returned object never corrupts the cache.
 *
 * T-06-05 wire-source trust is NOT enforced here — SessionClient connects
 * only to its single host ws (`this.ws` in SessionClient), so the listener
 * is single-source by construction. ReviewState consumes whatever
 * SessionClient emits.
 */

import type {
  ReviewRequest,
  ReviewComment,
  ReviewVoteRecord,
  ReviewStatus,
} from '../types/review.js';

export class ReviewState {
  private readonly reviewsById: Map<string, ReviewRequest> = new Map();

  /**
   * Replace all cached reviews for a single branch (used on (re)connect
   * replay). Reviews cached on OTHER branches are preserved — the host
   * sends one review-state-sync per active branch at auth time, and the
   * client may have observed reviews on branches it has visited.
   */
  applyStateSync(branch: string, reviews: ReviewRequest[]): void {
    // Drop existing entries for the named branch only.
    for (const [id, r] of [...this.reviewsById]) {
      if (r.branch === branch) this.reviewsById.delete(id);
    }
    // Seed with the host-provided slice (defensive deep copy each).
    for (const r of reviews) {
      this.reviewsById.set(r.id, this.clone(r));
    }
  }

  /**
   * Insert (or replace by id) a ReviewRequest. Replace-on-collision is the
   * supersede semantic — Plan 06-02's host auto-abandons the prior review
   * with status:'abandoned' BEFORE broadcasting the fresh one, but a
   * second review-opened for the same id should still last-write-wins on
   * the client.
   */
  applyOpened(review: ReviewRequest): void {
    this.reviewsById.set(review.id, this.clone(review));
  }

  /**
   * Append a comment to parent.comments[]. No-op if reviewId is unknown —
   * the host may have GC'd a resolved review, or the client may not have
   * seen the parent's review-opened yet (out-of-order arrival is rare but
   * not impossible).
   */
  applyComment(reviewId: string, comment: ReviewComment): void {
    const r = this.reviewsById.get(reviewId);
    if (!r) return;
    this.reviewsById.set(reviewId, {
      ...this.clone(r),
      comments: [...r.comments, this.clone(comment)],
    });
  }

  /**
   * Dedupe votes by reviewerMemberId (latest wins) AND apply status
   * transition. The transition rule MUST match Plan 06-02 host:
   *   - any 'changes-requested' vote → status='changes-requested'
   *   - else any 'approved' vote      → status='approved'
   *   - else ('commented' alone, or no votes) → status='open'
   *
   * Already-resolved/abandoned reviews are immutable — incoming votes on
   * them are ignored (the host should not broadcast such votes anyway).
   */
  applyVote(reviewId: string, vote: ReviewVoteRecord): void {
    const r = this.reviewsById.get(reviewId);
    if (!r) return;
    if (r.status === 'resolved' || r.status === 'abandoned') return;
    const otherVotes = r.votes.filter(
      v => v.reviewerMemberId !== vote.reviewerMemberId,
    );
    const newVotes = [...otherVotes, this.clone(vote)];
    let newStatus: ReviewStatus;
    if (newVotes.some(v => v.vote === 'changes-requested')) {
      newStatus = 'changes-requested';
    } else if (newVotes.some(v => v.vote === 'approved')) {
      newStatus = 'approved';
    } else {
      newStatus = 'open';
    }
    this.reviewsById.set(reviewId, {
      ...this.clone(r),
      votes: newVotes,
      status: newStatus,
    });
  }

  /**
   * Close a review (push author resolves OR admin override). No-op if
   * reviewId unknown or the review is already resolved/abandoned (the host
   * is the trust authority — a second resolve frame is ignored).
   */
  applyResolved(
    reviewId: string,
    resolvedBy: string,
    resolvedReason: 'merged' | 'abandoned',
    resolvedAt: number,
  ): void {
    const r = this.reviewsById.get(reviewId);
    if (!r) return;
    if (r.status === 'resolved' || r.status === 'abandoned') return;
    this.reviewsById.set(reviewId, {
      ...this.clone(r),
      status: 'resolved',
      resolvedBy,
      resolvedReason,
      resolvedAt,
    });
  }

  /** Defensive deep copy. Undefined for unknown id. */
  getReview(id: string): ReviewRequest | undefined {
    const r = this.reviewsById.get(id);
    return r ? this.clone(r) : undefined;
  }

  /** First match by pushId, defensive deep copy. Undefined if none. */
  getReviewByPushId(pushId: string): ReviewRequest | undefined {
    for (const r of this.reviewsById.values()) {
      if (r.pushId === pushId) return this.clone(r);
    }
    return undefined;
  }

  /**
   * Most-recent non-resolved / non-abandoned review for the pushId. Used
   * by Plan 06-05's mergeBranch gate — when set, the gate consults
   * `.status === 'approved'` to permit the merge. Returns undefined when
   * no active review exists for the pushId; the caller decides whether
   * "no review" blocks or unblocks the merge.
   */
  getActiveReviewForPush(pushId: string): ReviewRequest | undefined {
    let best: ReviewRequest | undefined;
    for (const r of this.reviewsById.values()) {
      if (r.pushId !== pushId) continue;
      if (r.status === 'resolved' || r.status === 'abandoned') continue;
      if (!best || r.openedAt > best.openedAt) best = r;
    }
    return best ? this.clone(best) : undefined;
  }

  /**
   * All reviews for a branch, ordered by openedAt desc (newest first).
   * Defensive deep copies. Empty array for unknown branches.
   */
  getReviewsForBranch(branch: string): ReviewRequest[] {
    const out: ReviewRequest[] = [];
    for (const r of this.reviewsById.values()) {
      if (r.branch === branch) out.push(this.clone(r));
    }
    out.sort((a, b) => b.openedAt - a.openedAt);
    return out;
  }

  /** Test-only — reset internal state between cases. */
  _resetForTests(): void {
    this.reviewsById.clear();
  }

  private clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
  }
}
