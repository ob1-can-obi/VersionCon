import type { TreeNode, StagedFile } from '../types/filesystem.js';
import type { FileSystemLayer } from './FileSystemLayer.js';

/**
 * Manages workspace tree state and the list of files staged for push.
 *
 * The workspace is the user's project root -- they edit files here freely.
 * When a user drags a file from workspace to the branch pane, it is
 * "staged" in memory (an in-memory StagedFile[] array). Phase 3 consumes
 * this list via getStagedFiles() for the actual push flow.
 */
export class WorkspaceState {
  private tree: TreeNode[] = [];
  private staged: StagedFile[] = [];

  constructor(
    private readonly fsLayer: FileSystemLayer,
    private readonly workspaceDir: string,
  ) {}

  /**
   * Rebuild the workspace tree from disk.
   * Staged files are preserved across refresh (they live in memory,
   * not on disk) -- this matches the "tab switch" survival requirement.
   */
  async refresh(): Promise<void> {
    this.tree = await this.fsLayer.buildTreeData(this.workspaceDir);
  }

  /**
   * Return the cached workspace tree. Returns empty array if
   * refresh() has not been called yet.
   */
  getTree(): TreeNode[] {
    return this.tree;
  }

  /**
   * Stage a file for push. Deduplicates by path -- if the file is
   * already staged, the call is a no-op.
   */
  stageFile(relativePath: string): void {
    if (this.staged.some(s => s.path === relativePath)) {
      return; // already staged
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
