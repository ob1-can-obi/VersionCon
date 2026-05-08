import * as vscode from 'vscode';
import * as path from 'path';
import type { PresenceInfo } from '../types/chat.js';
import { PresenceMap } from '../filesystem/PresenceMap.js';

/**
 * TreeDataProvider for the `versioncon.presence` view (sidebar).
 *
 * Wraps a PresenceMap (Plan 04-03). Plan 04-09 calls upsert/removeMember on
 * inbound presence-update / member-left events.
 *
 * Renders per UI-SPEC §2.1:
 *  - icon: $(account)
 *  - label: displayName
 *  - description: basename(activeFilePath) | "(no file)" + " (you)" suffix for self
 *    + "$(git-compare) {branch} · " prefix when info.branch !== currentBranch
 *  - tooltip: "On branch: {branch}\nFile: {fullPath}"
 *  - contextValue: presenceMember-self | presenceMember-other
 *
 * Sort: self first, then alphabetical by displayName (case-insensitive).
 *
 * Mirrors `BranchListProvider`/`ActivityLogProvider` TreeDataProvider shape.
 */
export class PresenceTreeProvider implements vscode.TreeDataProvider<PresenceInfo> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PresenceInfo | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly map = new PresenceMap();
  private selfMemberId: string | null = null;
  private currentBranch: string | null = null;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  // ----- Public mutators -----

  upsert(info: PresenceInfo): void {
    this.map.upsert(info);
    this.refresh();
  }

  removeMember(memberId: string): void {
    this.map.removeMember(memberId);
    this.refresh();
  }

  clear(): void {
    this.map.clear();
    this.refresh();
  }

  setSelfMemberId(id: string | null): void {
    this.selfMemberId = id;
    this.refresh();
  }

  setCurrentBranch(branch: string | null): void {
    this.currentBranch = branch;
    this.refresh();
  }

  // ----- Public reader -----

  /** Defensive copy of all current presence entries (mirrors ChatLog/PresenceMap pattern). */
  getEntries(): PresenceInfo[] {
    return this.map.getSnapshot();
  }

  // ----- TreeDataProvider impl -----

  getTreeItem(element: PresenceInfo): vscode.TreeItem {
    const isSelf = element.memberId === this.selfMemberId;
    const item = new vscode.TreeItem(element.displayName, vscode.TreeItemCollapsibleState.None);
    item.description = this.formatDescription(element, isSelf);
    item.tooltip = `On branch: ${element.branch}\nFile: ${element.activeFilePath ?? '(no file)'}`;
    item.iconPath = new vscode.ThemeIcon('account');
    item.contextValue = isSelf ? 'presenceMember-self' : 'presenceMember-other';
    return item;
  }

  async getChildren(element?: PresenceInfo): Promise<PresenceInfo[]> {
    if (element) return []; // flat list
    const entries = this.getEntries();
    return entries.sort((a, b) => {
      // Self first.
      if (a.memberId === this.selfMemberId) return -1;
      if (b.memberId === this.selfMemberId) return 1;
      // Then alphabetical by displayName (case-insensitive).
      return a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase());
    });
  }

  // ----- Formatting helpers (per UI-SPEC §2.1) -----

  private formatDescription(info: PresenceInfo, isSelf: boolean): string {
    const fileBasename = info.activeFilePath ? path.basename(info.activeFilePath) : '(no file)';
    let desc = fileBasename;
    if (this.currentBranch !== null && info.branch !== this.currentBranch) {
      // Branch divergence indicator (UI-SPEC §2.1) — show divergent branch + file.
      desc = `$(git-compare) ${info.branch} · ${desc}`;
    }
    if (isSelf) desc += ' (you)';
    return desc;
  }
}
