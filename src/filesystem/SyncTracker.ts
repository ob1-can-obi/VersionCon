/**
 * Tracks whether the local workspace is in sync with the latest branch state.
 *
 * The model is intentionally simple — two push IDs:
 *  - latestBranchPushId: the most recent push on the branch the user follows
 *  - lastSyncedPushId:   the push the user has acknowledged via onSync() or onLocalPush()
 *
 * isInSync() returns true when no remote pushes have arrived yet, or when the
 * user has explicitly synced past the latest known push. After a remote push
 * is observed, the tracker is "out of sync" until onSync() is called.
 *
 * This service is in-memory and resets when the extension host restarts;
 * persistence is intentionally out of scope (sync state is meaningful only
 * within a live session — on reconnect the host re-broadcasts the latest
 * push id).
 */
export class SyncTracker {
  private latestBranchPushId: string | null = null;
  private lastSyncedPushId: string | null = null;
  private outOfSyncPaths: Set<string> = new Set();

  /**
   * Record a push that arrived from another member on the branch.
   * Only updates the latest pointer — does NOT mark the workspace as synced.
   */
  onRemotePush(pushId: string): void {
    this.latestBranchPushId = pushId;
  }

  /**
   * Record a push made by the local user. The local user is by definition
   * synced after their own push, so both pointers advance.
   */
  onLocalPush(pushId: string): void {
    this.latestBranchPushId = pushId;
    this.lastSyncedPushId = pushId;
  }

  /**
   * Mark the workspace as synced with the latest known branch push.
   * Called after the user explicitly pulls/syncs.
   */
  onSync(): void {
    this.lastSyncedPushId = this.latestBranchPushId;
    this.outOfSyncPaths.clear();
  }

  /**
   * Returns true when the workspace is in sync with the branch.
   * - true when no pushes have been observed (initial state)
   * - true when the last synced push id matches the latest branch push id
   * - false otherwise
   */
  isInSync(): boolean {
    if (this.latestBranchPushId === null) return true;
    return this.lastSyncedPushId === this.latestBranchPushId;
  }

  /**
   * Returns the most recent push id observed on the branch, or null if
   * no pushes have been seen.
   */
  getLatestPushId(): string | null {
    return this.latestBranchPushId;
  }

  /**
   * Reset all sync state back to initial (isInSync() returns true).
   * Used when switching branches or rejoining a session.
   */
  reset(): void {
    this.latestBranchPushId = null;
    this.lastSyncedPushId = null;
    this.outOfSyncPaths.clear();
  }

  /**
   * Record the relative paths touched by a remote push or revert.
   * Accumulates into the out-of-sync set; duplicates are ignored (Set semantics).
   * Does NOT change pushId pointers — call onRemotePush(pushId) separately.
   */
  recordRemoteFiles(paths: string[]): void {
    for (const p of paths) {
      this.outOfSyncPaths.add(p);
    }
  }

  /**
   * Snapshot of the relative paths currently considered out of sync.
   * Returns a fresh array (callers may mutate it freely).
   */
  getOutOfSyncPaths(): string[] {
    return Array.from(this.outOfSyncPaths);
  }

  /**
   * Remove a single path from the out-of-sync set.
   * Called per-file by versioncon.sync after Take-branch (file pulled) and
   * also after the identical/no-local cases (nothing to lose).
   *
   * NOTE: After Keep-mine on a real conflict, callers do NOT call clearPath
   * — that path stays in the set so the user can still see something to
   * resolve later (PUSH-11).
   */
  clearPath(path: string): void {
    this.outOfSyncPaths.delete(path);
  }
}
