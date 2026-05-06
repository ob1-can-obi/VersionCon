import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { PushHistory } from './PushHistory.js';
import { DiffService } from './DiffService.js';
import type { PushRecord, PushFileEntry, PushSummary } from '../types/push.js';

/**
 * Orchestrates the push workflow:
 * - Generate diff summary for staged files
 * - Execute push (snapshot + copy + record)
 * - Revert push (full or partial)
 * - Get file diff content for vscode.diff
 */
export class PushService {
  private readonly diffService = new DiffService();

  constructor(
    private readonly history: PushHistory,
    private readonly projectRoot: string,
    private readonly getBranchDir: () => string,
    private readonly getActiveBranchName: () => string,
  ) {}

  /**
   * Generate a push summary for the given staged file paths.
   * Compares workspace version against branch version.
   */
  async generateSummary(stagedPaths: string[]): Promise<PushSummary> {
    const files: PushFileEntry[] = [];
    let totalAdded = 0;
    let totalRemoved = 0;

    for (const relativePath of stagedPaths) {
      const workspacePath = path.join(this.projectRoot, relativePath);
      const branchPath = path.join(this.getBranchDir(), relativePath);

      let workspaceContent = '';
      let branchContent = '';
      let workspaceExists = false;
      let branchExists = false;

      try {
        workspaceContent = await fs.readFile(workspacePath, 'utf-8');
        workspaceExists = true;
      } catch { /* file doesn't exist in workspace */ }

      try {
        branchContent = await fs.readFile(branchPath, 'utf-8');
        branchExists = true;
      } catch { /* file doesn't exist in branch */ }

      const status = this.diffService.determineStatus(branchExists, workspaceExists);
      const { addedLines, removedLines } = this.diffService.computeLineDiff(branchContent, workspaceContent);

      files.push({ relativePath, status, addedLines, removedLines });
      totalAdded += addedLines;
      totalRemoved += removedLines;
    }

    return { files, totalAdded, totalRemoved };
  }

  /**
   * Execute a push: snapshot pre-push content, copy workspace files to branch, record history.
   */
  async executePush(
    message: string,
    stagedPaths: string[],
    memberInfo: { id: string; displayName: string },
  ): Promise<PushRecord> {
    const pushId = crypto.randomBytes(10).toString('hex');
    const branchDir = this.getBranchDir();
    const branchName = this.getActiveBranchName();

    const files: PushFileEntry[] = [];

    for (const relativePath of stagedPaths) {
      const workspacePath = path.join(this.projectRoot, relativePath);
      const branchPath = path.join(branchDir, relativePath);

      let branchContent = '';
      let branchExists = false;
      let workspaceContent = '';
      let workspaceExists = false;

      try {
        branchContent = await fs.readFile(branchPath, 'utf-8');
        branchExists = true;
      } catch { /* new file */ }

      try {
        workspaceContent = await fs.readFile(workspacePath, 'utf-8');
        workspaceExists = true;
      } catch { /* deleted file */ }

      // Snapshot the current branch content (for revert)
      if (branchExists) {
        await this.history.saveSnapshot(pushId, relativePath, branchContent);
      }

      const status = this.diffService.determineStatus(branchExists, workspaceExists);
      const { addedLines, removedLines } = this.diffService.computeLineDiff(branchContent, workspaceContent);

      // Copy workspace file to branch (or delete from branch)
      if (workspaceExists) {
        await fs.mkdir(path.dirname(branchPath), { recursive: true });
        await fs.copyFile(workspacePath, branchPath);
      } else if (branchExists) {
        await fs.unlink(branchPath);
      }

      files.push({ relativePath, status, addedLines, removedLines });
    }

    const record: PushRecord = {
      id: pushId,
      memberId: memberInfo.id,
      memberDisplayName: memberInfo.displayName,
      message,
      branch: branchName,
      files,
      timestamp: Date.now(),
      reverted: false,
    };

    await this.history.addRecord(record);
    return record;
  }

  /**
   * Revert all files from a push (full revert).
   * Restores from snapshots or deletes files that were newly added.
   */
  async revertPush(pushId: string): Promise<void> {
    const record = this.history.getRecord(pushId);
    if (!record) throw new Error(`Push record not found: ${pushId}`);
    if (record.reverted) throw new Error(`Push already reverted: ${pushId}`);

    const branchDir = this.getBranchDir();

    for (const file of record.files) {
      const branchPath = path.join(branchDir, file.relativePath);

      if (file.status === 'added') {
        // File was added — remove it from branch
        try {
          await fs.unlink(branchPath);
        } catch { /* already gone */ }
      } else {
        // File was modified or deleted — restore from snapshot
        const snapshot = await this.history.readSnapshot(pushId, file.relativePath);
        if (snapshot !== null) {
          await fs.mkdir(path.dirname(branchPath), { recursive: true });
          await fs.writeFile(branchPath, snapshot);
        }
      }
    }

    await this.history.markReverted(pushId);
  }

  /**
   * Revert specific files from a push (partial revert).
   */
  async revertFiles(pushId: string, filePaths: string[]): Promise<void> {
    const record = this.history.getRecord(pushId);
    if (!record) throw new Error(`Push record not found: ${pushId}`);

    const branchDir = this.getBranchDir();

    for (const relativePath of filePaths) {
      const file = record.files.find(f => f.relativePath === relativePath);
      if (!file) continue;

      const branchPath = path.join(branchDir, relativePath);

      if (file.status === 'added') {
        try {
          await fs.unlink(branchPath);
        } catch { /* already gone */ }
      } else {
        const snapshot = await this.history.readSnapshot(pushId, relativePath);
        if (snapshot !== null) {
          await fs.mkdir(path.dirname(branchPath), { recursive: true });
          await fs.writeFile(branchPath, snapshot);
        }
      }
    }

    await this.history.markReverted(pushId, filePaths);
  }

  /**
   * Get original and modified content for a file diff view.
   * Returns content strings suitable for vscode.diff command.
   */
  async getFileDiff(relativePath: string): Promise<{ original: string; modified: string }> {
    const branchPath = path.join(this.getBranchDir(), relativePath);
    const workspacePath = path.join(this.projectRoot, relativePath);

    let original = '';
    let modified = '';

    try {
      original = await fs.readFile(branchPath, 'utf-8');
    } catch { /* new file */ }

    try {
      modified = await fs.readFile(workspacePath, 'utf-8');
    } catch { /* deleted file */ }

    return { original, modified };
  }
}
