import type { StagedFile } from '../types/filesystem.js';

/**
 * Manages the list of files staged for push.
 *
 * Tree rendering has moved to WorkspaceTreeProvider.
 * This class retains only the staging API for Phase 3 push flow.
 */
export class WorkspaceState {
  private staged: StagedFile[] = [];

  /**
   * Stage a file for push. Deduplicates by path — if the file is
   * already staged, the call is a no-op.
   */
  stageFile(relativePath: string): void {
    if (this.staged.some(s => s.path === relativePath)) {
      return;
    }
    this.staged.push({
      path: relativePath,
      stagedAt: Date.now(),
    });
  }

  /**
   * Remove a file from the staged list by path.
   */
  unstageFile(relativePath: string): void {
    this.staged = this.staged.filter(s => s.path !== relativePath);
  }

  /**
   * Return a shallow copy of the staged files array.
   */
  getStagedFiles(): StagedFile[] {
    return [...this.staged];
  }

  /**
   * Clear all staged files (called after a successful push in Phase 3).
   */
  clearStaged(): void {
    this.staged = [];
  }
}
