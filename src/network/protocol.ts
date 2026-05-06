import { Member, SessionConfig } from '../types/session.js';
import type { PushFileEntry } from '../types/push.js';
import type { BranchInfo } from '../types/branch.js';

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
  | 'tracked-paths-update';

// --- Base ---
interface BaseMessage {
  type: MessageType;
  timestamp: number;
}

// --- Client -> Host ---
export interface AuthRequest extends BaseMessage {
  type: 'auth-request';
  inviteCode: string;
  displayName: string;
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
  | TrackedPathsUpdate;

// --- Helpers ---
const VALID_TYPES: ReadonlySet<string> = new Set<MessageType>([
  'auth-request', 'auth-response', 'member-joined', 'member-left',
  'member-kicked', 'member-list', 'state-sync', 'kick-member',
  'regenerate-invite', 'invite-regenerated',
  'heartbeat-ping', 'heartbeat-pong', 'error',
  'push-notification', 'push-reverted', 'branch-created',
  'branch-locked', 'permission-changed', 'sync-request', 'sync-response',
  'tracked-paths-update',
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
