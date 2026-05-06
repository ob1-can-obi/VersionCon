import * as vscode from 'vscode';
import type { BranchInfo } from '../types/branch.js';
import type { BranchManager } from '../filesystem/BranchManager.js';

/**
 * TreeDataProvider listing every branch in the project (BRANCH-03).
 * Each TreeItem represents a branch; clicking does not expand (flat list).
 * Lock state is shown via icon + contextValue so package.json menus can show
 * lock/unlock actions only on the appropriate items.
 */
export class BranchListProvider implements vscode.TreeDataProvider<BranchInfo> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BranchInfo | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private activeBranchName: string | null = null;

  constructor(private readonly branchManager: BranchManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /** Update the cached active branch name (called after switchBranch). */
  setActiveBranchName(name: string): void {
    this.activeBranchName = name;
    this.refresh();
  }

  getTreeItem(element: BranchInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
    item.contextValue = element.locked ? 'branchListItem-locked' : 'branchListItem-unlocked';
    item.iconPath = new vscode.ThemeIcon(element.locked ? 'lock' : 'git-branch');
    if (element.name === this.activeBranchName) {
      item.description = 'active';
    }
    item.tooltip = `Created by ${element.createdBy}\nLocked: ${element.locked}`;
    return item;
  }

  async getChildren(element?: BranchInfo): Promise<BranchInfo[]> {
    if (element) return []; // flat list
    if (this.activeBranchName === null) {
      // Lazy-resolve active branch on first call so callers don't have to
      // wire setActiveBranchName before first render.
      this.activeBranchName = await this.branchManager.getActiveBranch();
    }
    return this.branchManager.listBranches();
  }
}
