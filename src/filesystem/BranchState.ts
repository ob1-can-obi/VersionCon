import type { TreeNode } from '../types/filesystem.js';
import type { FileSystemLayer } from './FileSystemLayer.js';

/**
 * Manages the read-only branch tree state.
 *
 * Wraps FileSystemLayer.buildTreeData for the branch directory and
 * caches the result. The branch pane is read-only -- BranchState
 * intentionally has NO mutation methods (stageFile, copyTo, etc.).
 */
export class BranchState {
  private tree: TreeNode[] = [];

  constructor(
    private readonly fsLayer: FileSystemLayer,
    private readonly branchDir: string,
  ) {}

  /**
   * Rebuild the tree from the branch directory on disk.
   * Call this after any known mutation to branch files.
   */
  async refresh(): Promise<void> {
    this.tree = await this.fsLayer.buildTreeData(this.branchDir);
  }

  /**
   * Return the cached branch tree. Returns empty array if
   * refresh() has not been called yet.
   */
  getTree(): TreeNode[] {
    return this.tree;
  }
}
