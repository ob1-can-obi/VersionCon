import type { PresenceInfo } from '../types/chat.js';

/**
 * In-memory map of memberId -> PresenceInfo.
 *
 * Lifecycle:
 *  - On the HOST: accumulator of all members' active-editor positions. Cleared on
 *    member-left (handled by SessionHost in Plan 04-04). Per CONTEXT decision
 *    "Presence on disconnect".
 *  - On the CLIENT: rendering cache for the PresenceTreeProvider (Plan 04-08).
 *
 * No persistence — purely in-memory. Mirrors src/filesystem/SyncTracker.ts pattern.
 *
 * Per CONTEXT decision "Presence broadcast cadence": entries are written only when
 * a member's onDidChangeActiveTextEditor fires. No periodic heartbeat in v1.
 *
 * Threat model (per 04-03 STRIDE register):
 *  - T-04-03-01 (Spoofing, mitigate): PresenceMap is policy-agnostic — it stores
 *    whatever PresenceInfo callers pass. SessionHost (Plan 04-04) is responsible
 *    for sanitizing memberId from the ws-bound closure variable BEFORE calling
 *    upsert(). Enforcement happens in 04-04, NOT here.
 *  - T-04-03-02 (Information disclosure, accept): activeFilePath is broadcast
 *    intentionally — the feature, not a leak.
 *  - T-04-03-03 (Tampering, mitigate): callers MUST normalize activeFilePath
 *    through path.relative + reject `..` segments BEFORE upsert (Plan 04-06).
 *    PresenceMap stores the already-normalized string verbatim.
 */
export class PresenceMap {
  private readonly entries = new Map<string, PresenceInfo>();

  /**
   * Insert or replace the presence entry for info.memberId.
   * Last write wins — host arrival order is the authoritative tiebreaker.
   *
   * Precondition: caller (SessionHost) has overwritten info.memberId from the
   * ws-authenticated closure value, and info.activeFilePath has been normalized
   * to workspace-relative posix form with no `..` segments. PresenceMap does
   * not validate either; it trusts the caller.
   */
  upsert(info: PresenceInfo): void {
    this.entries.set(info.memberId, info);
  }

  /**
   * Remove the entry for memberId. No-op if not present.
   * Called by SessionHost when a member-left event fires.
   */
  removeMember(memberId: string): void {
    this.entries.delete(memberId);
  }

  /**
   * Returns a defensive copy of all current presence entries.
   * Iteration order is insertion order (Map default). Mutating the returned
   * array does not affect the internal map.
   */
  getSnapshot(): PresenceInfo[] {
    return Array.from(this.entries.values());
  }

  /** Empty the map. Used on session-end / full reset. */
  clear(): void {
    this.entries.clear();
  }

  /** Diagnostic — does the map contain an entry for memberId? */
  has(memberId: string): boolean {
    return this.entries.has(memberId);
  }
}
