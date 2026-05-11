import { Member, SessionConfig } from '../types/session.js';
import type { PushFileEntry } from '../types/push.js';
import type { BranchInfo } from '../types/branch.js';
import type { ChatRecord, SystemEventSubKind } from '../types/chat.js';
import type { AffectedSymbol } from '../ast/types.js';

// --- Message type discriminator ---
export type MessageType =
  | 'auth-request'
  | 'auth-response'
  | 'member-joined'
  | 'member-left'
  | 'member-kicked'
  | 'member-list'
  | 'state-sync'
  | 'kick-member'
  | 'regenerate-invite'
  | 'invite-regenerated'
  | 'heartbeat-ping'
  | 'heartbeat-pong'
  | 'error'
  | 'push-notification'
  | 'push-reverted'
  | 'branch-created'
  | 'branch-locked'
  | 'permission-changed'
  | 'sync-request'
  | 'sync-response'
  | 'tracked-paths-update'
  | 'chat-message'
  | 'chat-message-amend'
  | 'chat-cleared'
  | 'chat-truncated'
  | 'chat-history'
  | 'presence-update';

// --- Base ---
interface BaseMessage {
  type: MessageType;
  timestamp: number;
}

// --- Client -> Host ---
/**
 * Authenticate with a session host.
 *
 * The host validates the inviteCode (constant-time compare) and, when
 * `hostAuthSecret` is present, ALSO validates it against the host's
 * pre-allocated secret to assign role:'host'. The secret is populated ONLY
 * by the host's own loopback SessionClient (Phase 4.1, plan 04.1-03). All
 * remote joiners omit the field and receive role:'member' regardless of
 * timing — closing the "first-authenticated WebSocket wins host role" race
 * surfaced during Phase 4 multi-window UAT.
 *
 * Backwards-compat: pre-Phase-4.1 hosts that don't read this field will
 * silently ignore it; pre-Phase-4.1 clients omit it (undefined = JSON omits
 * the property entirely).
 */
export interface AuthRequest extends BaseMessage {
  type: 'auth-request';
  inviteCode: string;
  displayName: string;
  /**
   * Host-loopback secret. Set ONLY by the host's own loopback SessionClient
   * (the local UI client of the wizard creator). Plan 04.1-02's
   * handleAuthRequest assigns role:'host' iff this matches the host's
   * pre-allocated `hostAuthSecret` AND the requesting connection's
   * `claimedMemberId` matches the pre-allocated `hostMemberId`. Remote
   * clients omit the field and always get role:'member'.
   */
  hostAuthSecret?: string;
}

export interface KickMemberRequest extends BaseMessage {
  type: 'kick-member';
  targetMemberId: string;
}

export interface RegenerateInviteRequest extends BaseMessage {
  type: 'regenerate-invite';
}

// --- Host -> Client ---
export interface AuthResponse extends BaseMessage {
  type: 'auth-response';
  accepted: boolean;
  reason?: string;
  memberId?: string;
  sessionInfo?: {
    name: string;
    memberCount: number;
    hostDisplayName: string;
  };
}

export interface MemberJoined extends BaseMessage {
  type: 'member-joined';
  member: { id: string; displayName: string; role: string; isOnline: boolean; joinedAt: number };
}

export interface MemberLeft extends BaseMessage {
  type: 'member-left';
  memberId: string;
  reason: string;
}

export interface MemberKicked extends BaseMessage {
  type: 'member-kicked';
  reason: string;
}

export interface MemberList extends BaseMessage {
  type: 'member-list';
  members: Array<{ id: string; displayName: string; role: string; isOnline: boolean; joinedAt: number }>;
}

export interface StateSync extends BaseMessage {
  type: 'state-sync';
  sessionName: string;
  hostDisplayName: string;
  members: Array<{ id: string; displayName: string; role: string; isOnline: boolean; joinedAt: number }>;
}

export interface InviteRegenerated extends BaseMessage {
  type: 'invite-regenerated';
  newCode: string;
}

// --- Bidirectional ---
export interface HeartbeatPing extends BaseMessage {
  type: 'heartbeat-ping';
}

export interface HeartbeatPong extends BaseMessage {
  type: 'heartbeat-pong';
}

export interface ErrorMessage extends BaseMessage {
  type: 'error';
  code: string;
  message: string;
}

// --- Phase 3: Push + Branch messages ---

export interface PushNotification extends BaseMessage {
  type: 'push-notification';
  pushId: string;
  memberId: string;
  memberDisplayName: string;
  message: string;
  branch: string;
  files: PushFileEntry[];
}

export interface PushReverted extends BaseMessage {
  type: 'push-reverted';
  pushId: string;
  memberId: string;
  memberDisplayName: string;
  branch: string;
  files: string[];
}

export interface BranchCreated extends BaseMessage {
  type: 'branch-created';
  branch: BranchInfo;
}

export interface BranchLocked extends BaseMessage {
  type: 'branch-locked';
  branchName: string;
  locked: boolean;
}

export interface PermissionChanged extends BaseMessage {
  type: 'permission-changed';
  branchName: string;
  memberId: string;
  action: 'granted' | 'revoked';
}

export interface SyncRequest extends BaseMessage {
  type: 'sync-request';
  branch: string;
}

export interface SyncResponse extends BaseMessage {
  type: 'sync-response';
  branch: string;
  files: PushFileEntry[];
  latestPushId: string | null;
}

/**
 * Member broadcasts the relative paths they are currently tracking in their
 * workspace. Sent on workspace-tracking-changed events. The host accumulates
 * these into a MemberTrackingMap used by PushService.computeAffectedMembers
 * (PUSH-03).
 */
export interface TrackedPathsUpdate extends BaseMessage {
  type: 'tracked-paths-update';
  memberId: string;
  paths: string[];
}

// --- Phase 4: Chat + Presence messages ---

/**
 * Client sends with `kind: 'user'`; host appends to ChatLog with a server-stamped
 * timestamp, then broadcasts to all members (including sender — see RESEARCH Open Q #1).
 *
 * System events (`kind: 'system'`, `subKind` set) are NEVER sent by clients — the host
 * generates them when it relays the underlying `push-notification`/`push-reverted`/
 * `branch-created` event into chat-log.json (Plan 04-04).
 *
 * T-04-01-01: host MUST overwrite `memberId` with the ws-authenticated id before
 * broadcast — clients must not be able to spoof identity (enforced in Plan 04-04).
 * T-04-01-04: host MUST overwrite `timestamp` via createTimestamp() before broadcast —
 * client clocks may drift; host arrival time is the chat-log ordering authority.
 */
export interface ChatMessage extends BaseMessage {
  type: 'chat-message';
  /** uuid generated by sender; host trusts but de-duplicates by id on append. */
  recordId: string;
  kind: 'user' | 'system';
  subKind?: SystemEventSubKind;
  /** Sender id — host overrides with ws-authenticated id before broadcast (T-04-01-01). */
  memberId: string;
  memberDisplayName: string;
  body: string;
  meta?: {
    pushId?: string;
    branch?: string;
    files?: string[];
  };
}

/**
 * Phase 5 Plan 05-05 (SC-5): host broadcasts AFTER the original system-event
 * `chat-message` (push) to amend that record's meta with AST-derived
 * `affectedSymbols` and the list of `unsupportedLanguages` that fell through to
 * file-level fallback (CONF-10). Clients locate the original record by
 * `recordId` and patch its meta in place — no full re-broadcast of the body.
 *
 * Older clients (pre-Phase 5) silently drop the message because the type is
 * absent from their `VALID_TYPES` parse gate. The original `chat-message`
 * still renders correctly on those clients — graceful degradation is the
 * contract.
 *
 * The amend NEVER carries the original message body — only the diff. The
 * client looks up the original by `recordId`.
 */
export interface ChatMessageAmend extends BaseMessage {
  type: 'chat-message-amend';
  /** Must equal the `recordId` of the original chat-message this amend patches. */
  recordId: string;
  /**
   * May be empty array — clients that receive an empty `affectedSymbols`
   * should not render an "affects" suffix. (Empty + non-empty
   * `unsupportedLanguages` is the "Symbol analysis unavailable for…" tooltip
   * case.)
   */
  affectedSymbols: AffectedSymbol[];
  /** List of LanguageIds that fell through to file-level fallback for this push. */
  unsupportedLanguages: string[];
}

/**
 * Broadcast after the host runs "Delete entire chat" (truncate to empty).
 * Receiving clients clear their panel and show a toast (UI-SPEC §7.3).
 * Host-only outbound — clients never send this message.
 */
export interface ChatCleared extends BaseMessage {
  type: 'chat-cleared';
  hostMemberId: string;
  hostDisplayName: string;
}

/**
 * Broadcast after the host runs either non-destructive truncation mode.
 * `mode === 'keep-100-and-activity'` keeps the most recent 100 user messages plus
 * all system events; `mode === 'activity-only'` removes user messages entirely
 * but keeps system events. Clients re-render with the trimmed dataset (host
 * re-sends history immediately after).
 */
export interface ChatTruncated extends BaseMessage {
  type: 'chat-truncated';
  mode: 'keep-100-and-activity' | 'activity-only';
  hostMemberId: string;
  hostDisplayName: string;
}

/**
 * Sent by host to a single newly-authenticated client immediately after `state-sync`
 * (RESEARCH Open Q #2) so the chat panel opens populated. Last 100 user messages
 * plus all system events from the same branch's chat-log.json.
 */
export interface ChatHistory extends BaseMessage {
  type: 'chat-history';
  branch: string;
  /** Chronological, oldest first. */
  records: ChatRecord[];
}

/**
 * Client sends on `vscode.window.onDidChangeActiveTextEditor`. Host updates its
 * presenceMap, then broadcasts to all members EXCEPT the sender (matches the
 * `member-joined` exclude pattern).
 *
 * T-04-01-01: host MUST overwrite `memberId` with the ws-authenticated id before
 * broadcast (enforced in Plan 04-04).
 */
export interface PresenceUpdate extends BaseMessage {
  type: 'presence-update';
  /** Sender id — host overrides with ws-authenticated id before broadcast (T-04-01-01). */
  memberId: string;
  displayName: string;
  branch: string;
  /** Workspace-relative posix path; `null` for "no active editor". */
  activeFilePath: string | null;
}

// --- Discriminated union ---
export type ProtocolMessage =
  | AuthRequest
  | AuthResponse
  | MemberJoined
  | MemberLeft
  | MemberKicked
  | MemberList
  | StateSync
  | KickMemberRequest
  | RegenerateInviteRequest
  | InviteRegenerated
  | HeartbeatPing
  | HeartbeatPong
  | ErrorMessage
  | PushNotification
  | PushReverted
  | BranchCreated
  | BranchLocked
  | PermissionChanged
  | SyncRequest
  | SyncResponse
  | TrackedPathsUpdate
  | ChatMessage
  | ChatMessageAmend
  | ChatCleared
  | ChatTruncated
  | ChatHistory
  | PresenceUpdate;

// --- Helpers ---
const VALID_TYPES: ReadonlySet<string> = new Set<MessageType>([
  'auth-request', 'auth-response', 'member-joined', 'member-left',
  'member-kicked', 'member-list', 'state-sync', 'kick-member',
  'regenerate-invite', 'invite-regenerated',
  'heartbeat-ping', 'heartbeat-pong', 'error',
  'push-notification', 'push-reverted', 'branch-created',
  'branch-locked', 'permission-changed', 'sync-request', 'sync-response',
  'tracked-paths-update',
  'chat-message', 'chat-message-amend',
  'chat-cleared', 'chat-truncated', 'chat-history', 'presence-update',
]);

export function sendMessage(send: (data: string) => void, msg: ProtocolMessage): void {
  send(JSON.stringify(msg));
}

export function parseMessage(data: string): ProtocolMessage | null {
  try {
    const msg = JSON.parse(data);
    if (typeof msg !== 'object' || msg === null) { return null; }
    if (typeof msg.type !== 'string' || !VALID_TYPES.has(msg.type)) { return null; }
    if (typeof msg.timestamp !== 'number') { return null; }
    return msg as ProtocolMessage;
  } catch {
    return null;
  }
}

export function createTimestamp(): number {
  return Date.now();
}
