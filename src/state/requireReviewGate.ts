/**
 * Phase 6 Plan 06-05 — requireReview merge gate.
 *
 * Pure-function gate consumed by versioncon.mergeBranch + quickMergeFiles +
 * structuredMergeBranch. Returns { allow: true } when the source branch's
 * most-recent push has an approving ReviewRequest, OR when the target branch
 * does NOT require review. Returns { allow: false, reason } otherwise.
 *
 * Extracted to its own module (vs. an inline IIFE-scoped helper in
 * extension.ts) so the three merge entry points share a single source of
 * truth AND so the gate is unit-testable without a VS Code extension host.
 *
 * The gate does NOT mutate state. Callers (the 3 merge handlers in
 * extension.ts) fire the toast + system chat event on block.
 *
 * Trust model: this gate runs in the host process. Joiners attempting a
 * merge route through the host process (Phase 3 quickMergeFiles uses local
 * filesystem ops); the host process IS the gate. Direct OS-level file
 * tampering bypasses the gate — out of scope per 06-SPEC.md T-06-04.
 */
import type { BranchManager } from '../filesystem/BranchManager.js';
import type { PushHistory } from '../filesystem/PushHistory.js';
import type { ReviewState } from './ReviewState.js';

export interface RequireReviewGateDeps {
  branchManager: BranchManager;
  pushHistory: PushHistory;
  reviewState: ReviewState | null;
}

export interface RequireReviewGateResult {
  allow: boolean;
  reason?: string;
}

/**
 * Evaluate the requireReview merge gate.
 *
 * @param sourceBranchName  the branch being merged FROM
 * @param targetBranchName  the branch being merged INTO
 * @param deps              live BranchManager + PushHistory + ReviewState
 */
export async function checkRequireReviewGate(
  sourceBranchName: string,
  targetBranchName: string,
  deps: RequireReviewGateDeps,
): Promise<RequireReviewGateResult> {
  const { branchManager, pushHistory, reviewState } = deps;

  // Fast path: the target does not require review.
  if (!branchManager.getRequireReview(targetBranchName)) {
    return { allow: true };
  }

  // Locate the most-recent push on the SOURCE branch. PushHistory.getRecords()
  // returns newest-first; .find on a branch filter picks the latest.
  const sourceMostRecentPush = pushHistory
    .getRecords()
    .find(r => r.branch === sourceBranchName);

  if (!sourceMostRecentPush) {
    return {
      allow: false,
      reason: `Merge blocked: "${targetBranchName}" requires review, but "${sourceBranchName}" has no pushes to review.`,
    };
  }

  // Read approval status from the in-memory cache. The cache filters
  // resolved+abandoned reviews via getActiveReviewForPush, so a resolved
  // review (admin-override-merged) returns undefined → "no review opened".
  // The v1 contract is explicit: resolved ≠ approved; admin override resolves
  // the review but does NOT auto-approve it (next merge still requires an
  // explicit approve vote).
  const review = reviewState?.getActiveReviewForPush(sourceMostRecentPush.id);
  if (!review || review.status !== 'approved') {
    const statusText = review ? `current status: ${review.status}` : 'no review opened';
    return {
      allow: false,
      reason: `Merge blocked: "${targetBranchName}" requires an approving review of push ${sourceMostRecentPush.id.substring(
        0,
        7,
      )} (${statusText}).`,
    };
  }

  return { allow: true };
}
