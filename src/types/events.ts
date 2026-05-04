import { Member, ConnectionStatus, SessionConfig } from './session.js';

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
}

// Typed event key
export type SessionEvent = keyof SessionEventMap;

// Typed event emitter interface
export interface SessionEventEmitter {
  on<K extends SessionEvent>(event: K, listener: (data: SessionEventMap[K]) => void): void;
  off<K extends SessionEvent>(event: K, listener: (data: SessionEventMap[K]) => void): void;
  emit<K extends SessionEvent>(event: K, data: SessionEventMap[K]): void;
}
