/**
 * Phase 4 chat + presence type module.
 *
 * Defines the ChatRecord shape persisted in `.versioncon/branches/<branch>/chat-log.json`
 * and the PresenceInfo shape carried by `presence-update` wire messages and rendered by
 * the presence tree provider. Pure type module — no runtime imports.
 *
 * Server-trust rule: ChatMessage.memberId is host-overridden on relay (see Plan 04-04).
 * This file documents the contract only; enforcement lives in SessionHost.
 */

/** Distinguishes a user-authored chat from a host-generated activity event. */
export type ChatRecordKind = 'user' | 'system';

/** Sub-classification for system events fed into the chat timeline. */
export type SystemEventSubKind = 'push' | 'revert' | 'branch-created';

/**
 * A single record in the per-branch chat log. User messages and system events
 * (push / revert / branch-create) share this shape so the activity timeline and
 * the chat thread can be the same scrollback.
 */
export interface ChatRecord {
  /** uuid (crypto.randomUUID) — sender-generated; host de-duplicates by id on append. */
  id: string;

  /** 'user' for human messages, 'system' for host-emitted activity events. */
  kind: ChatRecordKind;

  /**
   * Sub-classification for system events. Present iff `kind === 'system'`.
   * Per RESEARCH §"Researcher additions": "subKind only set when kind === 'system'".
   */
  subKind?: SystemEventSubKind;

  /**
   * Authenticated sender id (server-set from ws context). The host MUST overwrite
   * any client-supplied value before persisting/broadcasting — clients still need
   * this field for rendering after broadcast (T-04-01-01).
   */
  memberId: string;

  /** Display name resolved from the host's members map at relay time. */
  memberDisplayName: string;

  /** Markdown for user messages; pre-formatted text for system events. */
  body: string;

  /**
   * Host arrival time (ms epoch), NOT client send time. Chat ordering authority
   * is host arrival per RESEARCH §"Envelope rules" item 2.
   */
  timestamp: number;

  /** Optional metadata, populated by the host for system events. */
  meta?: {
    /** Push id for push/revert system events. */
    pushId?: string;
    /** Branch name for system events. */
    branch?: string;
    /** Workspace-relative paths touched by the underlying push/revert. */
    files?: string[];
    /**
     * Computed CLIENT-SIDE — not persisted to chat-log.json. Indicates whether the
     * underlying push affected any file the local user has open. Populated when the
     * client receives the broadcast; absent on the host-stored record.
     */
    affectsLocal?: boolean;
  };
}

/**
 * Per-member presence snapshot rendered by the presence tree provider.
 * Sent over the wire as a `presence-update` message body and accumulated
 * into a `Map<memberId, PresenceInfo>` on host and clients.
 */
export interface PresenceInfo {
  /** Authenticated sender id (server-set from ws context). */
  memberId: string;

  /** Display name resolved from the host's members map. */
  displayName: string;

  /** Branch the member is currently working in. */
  branch: string;

  /**
   * Workspace-relative posix-normalized path. `null` is the explicit "no editor open"
   * state — `null` (not `undefined`) so the value travels through JSON cleanly and
   * matches the wire-format spec.
   */
  activeFilePath: string | null;

  /** Host arrival time of the most recent presence-update for this member. */
  lastUpdated: number;
}
