import * as vscode from 'vscode';
import type { StagedFile } from '../types/filesystem.js';

/**
 * Per-user "Clear my view" cutoff key. Persisted via VS Code's workspaceState
 * (per-workspace, per-user) so the local user's filter survives reloads
 * without affecting other members.
 */
const CHAT_HIDDEN_BEFORE_KEY = 'versioncon.chatHiddenBefore';

/**
 * Manages the list of files staged for push, plus per-user chat view
 * preferences.
 *
 * Tree rendering has moved to WorkspaceTreeProvider.
 * Phase 4 (Plan 04-10): adds `chatHiddenBefore` — local-only timestamp the
 * chat panel uses to filter out messages older than the user's "Clear my
 * view" action. Persistence is keyed via context.workspaceState so the
 * filter is per-USER, never broadcast.
 */
export class WorkspaceState {
  private staged: StagedFile[] = [];
  private chatHiddenBeforeValue: number | null = null;
  private context: vscode.ExtensionContext | null = null;

  /**
   * Bind a VS Code ExtensionContext so the chat-hidden-before value can be
   * read from / persisted to workspaceState. Must be called once during
   * activate(). Called by extension.ts in the activate() entrypoint.
   *
   * Reading at bind time means any later getChatHiddenBefore() call returns
   * the persisted value without an async hop.
   */
  bindContext(context: vscode.ExtensionContext): void {
    this.context = context;
    this.chatHiddenBeforeValue = context.workspaceState.get<number | null>(
      CHAT_HIDDEN_BEFORE_KEY,
      null,
    );
  }

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

  /**
   * Get the per-user "Clear my view" cutoff timestamp. Returns null when
   * the user has never run the action. Synchronous — value is loaded by
   * bindContext() during activate().
   */
  getChatHiddenBefore(): number | null {
    return this.chatHiddenBeforeValue;
  }

  /**
   * Set the per-user "Clear my view" cutoff timestamp. Persists to
   * VS Code's workspaceState. Pass null to clear the filter.
   *
   * Awaiting the returned promise guarantees the value has been written
   * before the next read.
   */
  async setChatHiddenBefore(timestamp: number | null): Promise<void> {
    this.chatHiddenBeforeValue = timestamp;
    if (this.context) {
      await this.context.workspaceState.update(
        CHAT_HIDDEN_BEFORE_KEY,
        timestamp,
      );
    }
  }
}
