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
   * Execute a push: snapshot pre-push content, copy workspace files to branch,
   * record history.
   *
   * Phase 5 Plan 05-05 (SC-2 + analyzer wiring): returns BOTH the PushRecord
   * AND a `prePostByFile` map that surfaces the per-file pre/post content the
   * loop already reads. The caller (extension.ts push handler) passes the map
   * to `SessionHost.broadcastPush` so the host's AST analyzer can run without
   * re-reading the branch snapshot we just wrote. Existing callers that don't
   * need the map can destructure `{ record }` and ignore the rest — the
   * v1 PushRecord shape is unchanged.
   *
   * `preContent === null` means the file did not exist in the branch before
   * the push (newly-added file). `postContent === null` means the file does
   * not exist in the workspace (deleted file). Both null is a no-op
   * theoretical edge — the loop will not be entered for an empty stagedPaths.
   */
  async executePush(
    message: string,
    stagedPaths: string[],
    memberInfo: { id: string; displayName: string },
  ): Promise<{
    record: PushRecord;
    prePostByFile: Map<string, { preContent: string | null; postContent: string | null }>;
  }> {
    const pushId = crypto.randomBytes(10).toString('hex');
    const branchDir = this.getBranchDir();
    const branchName = this.getActiveBranchName();

    const files: PushFileEntry[] = [];
    const prePostByFile = new Map<string, { preContent: string | null; postContent: string | null }>();

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

      // Phase 5 Plan 05-05: surface pre/post content so the analyzer caller
      // (SessionHost.broadcastPush via extension.ts) doesn't have to re-read
      // the branch snapshot we just persisted. null = "did not exist".
      prePostByFile.set(relativePath, {
        preContent: branchExists ? branchContent : null,
        postContent: workspaceExists ? workspaceContent : null,
      });
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
    return { record, prePostByFile };
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
   * Compute which team members might be affected by a push.
   *
   * Uses file-level overlap between staged paths and each member's tracked
   * files (from WorkspaceTreeProvider.getTrackedPaths(), accumulated in
   * SessionHost.memberTracking via tracked-paths-update messages). Full
   * dependency-level impact (function calls, imports) is deferred to Phase 5;
   * this implements the PUSH-03 file-level layer.
   *
   * @param stagedPaths Relative paths being pushed.
   * @param memberTracking memberId -> tracked relative paths (from SessionHost.getMemberTracking()).
   * @param memberNames memberId -> display name (from SessionHost.getMemberNames()).
   * @param excludeMemberId The pusher's memberId -- do not list themselves as affected.
   * @returns Array of affected members with their overlapping files.
   */
  computeAffectedMembers(
    stagedPaths: string[],
    memberTracking: Map<string, string[]>,
    memberNames: Map<string, string>,
    excludeMemberId?: string,
  ): Array<{ memberId: string; displayName: string; overlappingFiles: string[] }> {
    const affected: Array<{ memberId: string; displayName: string; overlappingFiles: string[] }> = [];
    const stagedSet = new Set(stagedPaths);
    for (const [memberId, trackedPaths] of memberTracking) {
      if (memberId === excludeMemberId) continue;
      const overlap = trackedPaths.filter(p => stagedSet.has(p));
      if (overlap.length > 0) {
        affected.push({
          memberId,
          displayName: memberNames.get(memberId) ?? 'Unknown',
          overlappingFiles: overlap,
        });
      }
    }
    return affected;
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
