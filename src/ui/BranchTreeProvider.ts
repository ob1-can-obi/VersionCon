import * as vscode from 'vscode';
import * as path from 'path';
import type { FileEntry } from '../types/filesystem.js';
import type { FileSystemLayer } from '../filesystem/FileSystemLayer.js';

/**
 * TreeDataProvider for browsing branch files (.versioncon/branches/{active}/).
 * Read-only view — clicking a file previews it, inline button adds to workspace.
 * Shows active branch name in view description.
 */
export class BranchTreeProvider implements vscode.TreeDataProvider<FileEntry> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FileEntry | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private entries: FileEntry[] = [];
  private activeBranchName = 'main';
  private branchDirOverride: string | null = null;

  constructor(private readonly fsLayer: FileSystemLayer) {}

  /** Update the branch directory to scan (for multi-branch support). */
  setBranchDir(dir: string): void {
    this.branchDirOverride = dir;
  }

  /** Set the active branch name (shown in view description). */
  setActiveBranchName(name: string): void {
    this.activeBranchName = name;
  }

  /** Get active branch name. */
  getActiveBranchName(): string {
    return this.activeBranchName;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FileEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.name,
      element.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    const branchDir = this.branchDirOverride ?? this.fsLayer.getBranchDir();
    item.resourceUri = vscode.Uri.file(path.join(branchDir, element.relativePath));
    item.contextValue = element.isDirectory ? 'branchFolder' : 'branchFile';

    if (!element.isDirectory) {
      item.command = {
        command: 'versioncon.previewBranchFile',
        title: 'Preview',
        arguments: [element],
      };
    }

    return item;
  }

  async getChildren(element?: FileEntry): Promise<FileEntry[]> {
    if (!element) {
      // Root — scan the branch directory
      try {
        const branchDir = this.branchDirOverride ?? this.fsLayer.getBranchDir();
        this.entries = await this.fsLayer.buildFileEntries(branchDir, branchDir);
      } catch {
        this.entries = [];
      }
      return this.entries;
    }
    return element.children ?? [];
  }
}
