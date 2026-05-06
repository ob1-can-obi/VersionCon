import { Member, ConnectionStatus, SessionConfig } from './session.js';
import type { PushFileEntry } from './push.js';
import type { BranchInfo } from './branch.js';

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
}

// Typed event key
export type SessionEvent = keyof SessionEventMap;

// Typed event emitter interface
export interface SessionEventEmitter {
  on<K extends SessionEvent>(event: K, listener: (data: SessionEventMap[K]) => void): void;
  off<K extends SessionEvent>(event: K, listener: (data: SessionEventMap[K]) => void): void;
  emit<K extends SessionEvent>(event: K, data: SessionEventMap[K]): void;
}
