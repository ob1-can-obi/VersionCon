import { Member, ConnectionStatus, SessionConfig } from './session.js';
import type { PushFileEntry } from './push.js';
import type { BranchInfo } from './branch.js';
import type { ChatRecord, PresenceInfo } from './chat.js';
import type { AffectedSymbol } from '../ast/types.js';
import type {
  ReviewRequest,
  ReviewComment,
  ReviewVoteRecord,
} from './review.js';

// All session lifecycle events
export interface SessionEventMap {
  'session-created': { config: SessionConfig };
  'session-ended': { reason: string };
  'member-joined': { member: Member };
  'member-left': { memberId: string; reason: string };
  'member-kicked': { memberId: string; reason: string };
  'connection-changed': { status: ConnectionStatus; error?: string };
  'auth-failed': { reason: string };
  'invite-code-regenerated': { newCode: string };
  'push-received': { pushId: string; memberId: string; memberDisplayName: string; message: string; branch: string; files: PushFileEntry[] };
  'push-reverted': { pushId: string; memberId: string; memberDisplayName: string; branch: string; files: string[] };
  'branch-created': { branch: BranchInfo };
  'branch-locked': { branchName: string; locked: boolean };
  'permission-changed': { branchName: string; memberId: string; action: 'granted' | 'revoked' };
  // PUSH-09: emitted by SessionClient when a sync-response message arrives
  // from the host carrying the latest known push id. SessionClient does not
  // currently emit this event; the listener in extension.ts is forward-
  // compatible scaffolding for a later plan that wires sync-request/response
  // end-to-end.
  'sync-response': { latestPushId: string | null };
  // Phase 4: Chat + Presence client events. SessionClient routes the matching
  // wire messages into these typed events (Plan 04-05).
  /** Fired when host broadcasts a chat-message — sender is included (no exclude) per RESEARCH Open Q #1. */
  'chat-received': ChatRecord;
  /**
   * Phase 5 SC-5 (Plan 05-05): host broadcasts after AST analysis completes
   * so clients can patch the previously-received `chat-received` record's
   * meta with `affectedSymbols` + `unsupportedLanguages`. Older clients that
   * lack this event silently drop the wire frame at parseMessage — the
   * original chat-message still renders correctly (graceful degradation).
   */
  'chat-message-amend': { recordId: string; affectedSymbols: AffectedSymbol[]; unsupportedLanguages: string[] };
  /** Host ran "Delete entire chat" — clients clear their panel and show a toast. */
  'chat-cleared': { hostMemberId: string; hostDisplayName: string };
  /** Host ran a non-destructive truncation — clients re-render with the trimmed dataset. */
  'chat-truncated': { mode: 'keep-100-and-activity' | 'activity-only'; hostMemberId: string; hostDisplayName: string };
  /** Host sends the last-100 + system-events snapshot to a newly authenticated client. */
  'chat-history': { branch: string; records: ChatRecord[] };
  /** A remote member's active editor or branch changed; client updates the presence tree. */
  'presence-update': PresenceInfo;
  // Phase 6 (Plan 06-03): Inline code review client events. SessionClient
  // routes the matching wire types into these typed events. Payload shapes
  // are identity-mapped from the wire frames Wave 1 declared — no field
  // renames needed.
  /** Author opened a review on a push. */
  'review-opened': { review: ReviewRequest };
  /** Reviewer left a line-level comment on an open review. */
  'review-comment': { reviewId: string; comment: ReviewComment };
  /** Reviewer approved / requested changes / left a commented-only marker. */
  'review-vote': { reviewId: string; vote: ReviewVoteRecord };
  /** Review closed by push author OR admin override. */
  'review-resolved': {
    reviewId: string;
    resolvedBy: string;
    resolvedReason: 'merged' | 'abandoned';
  };
  /** Host → client post-auth replay of all reviews for the active branch. */
  'review-state-sync': { branch: string; reviews: ReviewRequest[] };
}

// Typed event key
export type SessionEvent = keyof SessionEventMap;

// Typed event emitter interface
export interface SessionEventEmitter {
  on<K extends SessionEvent>(event: K, listener: (data: SessionEventMap[K]) => void): void;
  off<K extends SessionEvent>(event: K, listener: (data: SessionEventMap[K]) => void): void;
  emit<K extends SessionEvent>(event: K, data: SessionEventMap[K]): void;
}
