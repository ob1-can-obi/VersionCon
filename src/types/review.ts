/**
 * Phase 6 inline code review type module.
 *
 * Defines the ReviewRequest shape persisted in
 * `.versioncon/branches/<branch>/reviews/<pushId>.json` and the comment/vote
 * sub-shapes carried by wire frames + ChatRecord meta. Pure type module — no
 * runtime imports.
 *
 * Server-trust rules (mirror Plan 04-04 chat-message policy):
 *   - reviewerMemberId / authorMemberId fields are HOST-OVERRIDDEN at relay
 *     from the ws-authenticated member id. Clients still need the fields for
 *     rendering. Threat T-06-01 (spoofed vote) is closed structurally by the
 *     host overwrite — same posture as T-04-01-01.
 *   - timestamps (openedAt, votedAt, createdAt, resolvedAt) are host-stamped
 *     via createTimestamp() at relay (T-06-05 ordering authority).
 *
 * One ReviewRequest per PushRecord. Re-pushing the same files supersedes the
 * prior request: Wave 2 host handler closes the prior review with
 * status:'abandoned' and opens a fresh one for the new pushId (locked
 * decision from 06-SPEC.md frontmatter).
 */
export type ReviewVote = 'approved' | 'changes-requested' | 'commented';

export type ReviewStatus =
  | 'open'
  | 'approved'
  | 'changes-requested'
  | 'resolved'
  | 'abandoned';

export interface ReviewComment {
  id: string;                    // uuid (crypto.randomUUID)
  reviewId: string;              // ReviewRequest.id this comment belongs to
  authorMemberId: string;        // host-stamped
  authorDisplayName: string;     // host-stamped at relay (from members map)
  filePath: string;              // relative to workspace, posix-normalized
  line: number;                  // 1-based, anchor on POST-push file
  body: string;                  // markdown — rendered by Wave 4 ReviewPanel via markdown-it (Plan 04-10 bundle reuse)
  createdAt: number;             // unix ms — host-stamped
}

export interface ReviewVoteRecord {
  reviewerMemberId: string;      // host-stamped
  reviewerDisplayName: string;   // host-stamped at relay
  vote: ReviewVote;
  votedAt: number;               // unix ms — host-stamped
}

/**
 * Per-push review unit. Authored by the pusher (authorMemberId === push
 * author at open time); votes + comments stream in over the wire and are
 * persisted to `.versioncon/branches/<branch>/reviews/<pushId>.json` on
 * every mutation (whole-file rewrite, mirrors PushHistory).
 */
export interface ReviewRequest {
  id: string;                    // uuid
  pushId: string;                // ties to PushRecord.id (PushHistory)
  branch: string;
  authorMemberId: string;
  authorDisplayName: string;
  openedAt: number;
  status: ReviewStatus;
  votes: ReviewVoteRecord[];     // append-on-vote; LATEST per-reviewer wins (Wave 2 dedupe by reviewerMemberId)
  comments: ReviewComment[];
  resolvedAt?: number;
  resolvedBy?: string;           // memberId who resolved (push author OR admin override)
  resolvedReason?: 'merged' | 'abandoned';
}
