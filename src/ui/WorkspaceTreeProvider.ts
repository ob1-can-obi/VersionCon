import * as vscode from 'vscode';
import * as path from 'path';
import type { FileEntry } from '../types/filesystem.js';
import type { FileSystemLayer } from '../filesystem/FileSystemLayer.js';

/**
 * TreeDataProvider for the selective workspace view.
 * Only shows files the user explicitly added from the branch.
 * Synthesizes a minimal folder hierarchy from tracked file paths.
 * Supports staged-file indicators for the Phase 3 push workflow.
 */
export class WorkspaceTreeProvider implements vscode.TreeDataProvider<FileEntry> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FileEntry | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private trackedPaths = new Set<string>();
  private stagedPaths = new Set<string>();
  private tree: FileEntry[] = [];

  constructor(private readonly fsLayer: FileSystemLayer) {}

  /** Add a file to the workspace view. */
  trackFile(relativePath: string): void {
    this.trackedPaths.add(relativePath);
    this.rebuildTree();
    this._onDidChangeTreeData.fire();
  }

  /** Remove a file from the workspace view. */
  untrackFile(relativePath: string): void {
    this.trackedPaths.delete(relativePath);
    this.stagedPaths.delete(relativePath);
    this.rebuildTree();
    this._onDidChangeTreeData.fire();
  }

  /** Track multiple files at once. */
  trackFiles(paths: string[]): void {
    for (const p of paths) {
      this.trackedPaths.add(p);
    }
    this.rebuildTree();
    this._onDidChangeTreeData.fire();
  }

  /** Check if a path is tracked. */
  isTracked(relativePath: string): boolean {
    return this.trackedPaths.has(relativePath);
  }

  /** Get all tracked paths (for testing). */
  getTrackedPaths(): string[] {
    return [...this.trackedPaths];
  }

  /** Mark a file as staged for push. */
  stageFile(relativePath: string): void {
    this.stagedPaths.add(relativePath);
    this._onDidChangeTreeData.fire();
  }

  /** Unmark a file from staged. */
  unstageFile(relativePath: string): void {
    this.stagedPaths.delete(relativePath);
    this._onDidChangeTreeData.fire();
  }

  /** Check if a file is staged. */
  isStaged(relativePath: string): boolean {
    return this.stagedPaths.has(relativePath);
  }

  /** Get all staged paths. */
  getStagedPaths(): string[] {
    return [...this.stagedPaths];
  }

  /** Clear all staged indicators. */
  clearStaged(): void {
    this.stagedPaths.clear();
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this.rebuildTree();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FileEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.name,
      element.isDirectory
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );

    const projectRoot = this.fsLayer.getProjectRoot();
    item.resourceUri = vscode.Uri.file(path.join(projectRoot, element.relativePath));

    if (element.isDirectory) {
      item.contextValue = 'workspaceFolder';
    } else if (this.stagedPaths.has(element.relativePath)) {
      item.contextValue = 'workspaceFileStaged';
      item.iconPath = new vscode.ThemeIcon('cloud-upload');
    } else {
      item.contextValue = 'workspaceFile';
    }

    if (!element.isDirectory) {
      item.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [vscode.Uri.file(path.join(projectRoot, element.relativePath))],
      };
    }

    return item;
  }

  getChildren(element?: FileEntry): FileEntry[] {
    if (!element) {
      return this.tree;
    }
    return element.children ?? [];
  }

  /**
   * Build a minimal folder hierarchy from the set of tracked file paths.
   * Only creates folder nodes that are needed to reach tracked files.
   */
  private rebuildTree(): void {
    // Build a nested map: each path segment -> children
    const root: Map<string, any> = new Map();

    for (const filePath of this.trackedPaths) {
      const parts = filePath.split(/[/\\]/);
      let current = root;
      for (const part of parts) {
        if (!current.has(part)) {
          current.set(part, new Map());
        }
        current = current.get(part);
      }
    }

    this.tree = this.mapToFileEntries(root, '');
  }

  private mapToFileEntries(map: Map<string, any>, parentPath: string): FileEntry[] {
    const entries: FileEntry[] = [];

    // Sort: directories first, then alphabetical
    const sorted = [...map.entries()].sort(([aName, aChildren], [bName, bChildren]) => {
      const aIsDir = aChildren.size > 0;
      const bIsDir = bChildren.size > 0;
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return aName.localeCompare(bName);
    });

    for (const [name, children] of sorted) {
      const relativePath = parentPath ? `${parentPath}/${name}` : name;
      const isDirectory = children.size > 0;

      entries.push({
        name,
        relativePath,
        isDirectory,
        children: isDirectory ? this.mapToFileEntries(children, relativePath) : undefined,
      });
    }

    return entries;
  }
}
