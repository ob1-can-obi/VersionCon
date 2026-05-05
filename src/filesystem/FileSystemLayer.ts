import * as fs from 'fs/promises';
import * as path from 'path';
import type { TreeNode } from '../types/filesystem.js';

/**
 * Core file operations for the split-pane drag-and-drop system.
 *
 * - `projectRoot` is the workspace directory (the user's working folder).
 * - `branchDir` is `.versioncon/branch/` where canonical branch files live.
 *
 * All path-accepting methods validate against traversal attacks before
 * performing any filesystem I/O (mitigates T-02-01, T-02-02).
 */
export class FileSystemLayer {
  private readonly normalizedBranchDir: string;
  private readonly normalizedProjectRoot: string;

  constructor(
    private readonly projectRoot: string,
    private readonly branchDir: string,
  ) {
    // Normalize once at construction for consistent comparisons
    this.normalizedBranchDir = path.resolve(branchDir) + path.sep;
    this.normalizedProjectRoot = path.resolve(projectRoot) + path.sep;
  }

  /**
   * Copy a single file from the branch directory into the workspace,
   * creating parent directories as needed (UI-04, UI-06).
   *
   * @param relativePath - path relative to branchDir (e.g. "src/index.ts")
   * @throws Error if the resolved path escapes branchDir (path traversal)
   */
  async copyFileToWorkspace(relativePath: string): Promise<void> {
    this.validateBranchPath(relativePath);

    const srcPath = path.resolve(this.branchDir, relativePath);
    const destPath = path.join(this.projectRoot, relativePath);

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(srcPath, destPath);
  }

  /**
   * Recursively create directory structure from branch into workspace
   * WITHOUT copying any files (UI-05). Only directories are mirrored.
   *
   * @param relativeDirPath - directory path relative to branchDir
   * @throws Error if the resolved path escapes branchDir (path traversal)
   */
  async copyStructureOnly(relativeDirPath: string): Promise<void> {
    this.validateBranchPath(relativeDirPath);

    const srcDir = path.resolve(this.branchDir, relativeDirPath);
    const destDir = path.join(this.projectRoot, relativeDirPath);

    // Create the top-level directory itself
    await fs.mkdir(destDir, { recursive: true });

    // Recurse into subdirectories, skip files
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subPath = path.join(relativeDirPath, entry.name);
        await this.copyStructureOnly(subPath);
      }
    }
  }

  /**
   * Build a TreeNode[] hierarchy from a directory on disk.
   * Directories sort before files; within each group, entries sort alphabetically.
   * Icons are assigned based on file extension (codicon names).
   *
   * @param rootDir - absolute path to scan
   * @returns TreeNode[] suitable for @vscode-elements/elements <vscode-tree>
   */
  async buildTreeData(rootDir: string): Promise<TreeNode[]> {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });

    // Directories first, then files; alphabetical within each group
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) { return -1; }
      if (!a.isDirectory() && b.isDirectory()) { return 1; }
      return a.name.localeCompare(b.name);
    });

    const nodes: TreeNode[] = [];

    for (const entry of sorted) {
      const fullPath = path.join(rootDir, entry.name);
      const relativePath = path.relative(this.projectRoot, fullPath);

      if (entry.isDirectory()) {
        const subItems = await this.buildTreeData(fullPath);
        nodes.push({
          label: entry.name,
          value: relativePath,
          icons: { branch: 'folder', open: 'folder-opened' },
          subItems,
        });
      } else {
        nodes.push({
          label: entry.name,
          value: relativePath,
          icons: { leaf: this.getFileIcon(entry.name) },
        });
      }
    }

    return nodes;
  }

  // ---- Private helpers ----

  /**
   * Validate that a relative path does not escape the branchDir.
   * Resolves the path and checks it starts with the normalized branch root.
   */
  private validateBranchPath(relativePath: string): void {
    const resolved = path.resolve(this.branchDir, relativePath);
    const normalizedResolved = path.resolve(resolved) + path.sep;

    // The resolved path (with trailing sep) must start with the branch root.
    // Also accept an exact match (the branch root directory itself).
    if (
      !normalizedResolved.startsWith(this.normalizedBranchDir) &&
      path.resolve(resolved) !== path.resolve(this.branchDir)
    ) {
      throw new Error(`Path traversal detected: "${relativePath}" resolves outside branch directory`);
    }
  }

  /**
   * Map file extension to a codicon icon name for the tree UI.
   */
  private getFileIcon(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
      case '.ts':
      case '.tsx':
        return 'typescript';
      case '.js':
      case '.jsx':
        return 'javascript';
      case '.json':
        return 'json';
      case '.md':
        return 'markdown';
      case '.html':
        return 'html';
      case '.css':
        return 'css';
      case '.py':
        return 'python';
      case '.java':
        return 'java';
      case '.yml':
      case '.yaml':
        return 'yaml';
      case '.xml':
        return 'xml';
      case '.svg':
        return 'svg';
      case '.png':
      case '.jpg':
      case '.jpeg':
      case '.gif':
        return 'image';
      default:
        return 'file';
    }
  }
}
