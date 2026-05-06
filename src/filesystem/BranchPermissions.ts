import * as fs from 'fs/promises';
import * as path from 'path';
import type { BranchPermissionsData, MergePermissionLevel } from '../types/branch.js';

/**
 * Manages per-branch permissions. Persisted to .versioncon/permissions.json.
 *
 * By default, the host has all permissions. Other members require explicit grants.
 */
export class BranchPermissions {
  private readonly permissionsFile: string;
  private data: BranchPermissionsData = {
    canCreateBranch: [],
    branchRestrictions: {},
    mergeToMainPolicy: 'open',
    mergeToMainAllowed: [],
  };

  constructor(
    private readonly versionconDir: string,
    private readonly hostMemberId: string,
  ) {
    this.permissionsFile = path.join(versionconDir, 'permissions.json');
  }

  /** Load permissions from disk. */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.permissionsFile, 'utf-8');
      this.data = JSON.parse(raw);
    } catch {
      // Defaults
      this.data = {
        canCreateBranch: [],
        branchRestrictions: {},
        mergeToMainPolicy: 'open',
        mergeToMainAllowed: [],
      };
    }
  }

  /** Save permissions to disk. */
  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.permissionsFile), { recursive: true });
    await fs.writeFile(this.permissionsFile, JSON.stringify(this.data, null, 2));
  }

  // --- Branch creation ---

  canCreateBranch(memberId: string): boolean {
    if (memberId === this.hostMemberId) return true;
    return this.data.canCreateBranch.includes(memberId);
  }

  async grantBranchCreation(memberId: string): Promise<void> {
    if (!this.data.canCreateBranch.includes(memberId)) {
      this.data.canCreateBranch.push(memberId);
      await this.save();
    }
  }

  async revokeBranchCreation(memberId: string): Promise<void> {
    this.data.canCreateBranch = this.data.canCreateBranch.filter(id => id !== memberId);
    await this.save();
  }

  // --- Push to branch ---

  canPushToBranch(memberId: string, branchName: string): boolean {
    if (memberId === this.hostMemberId) return true;
    const restrictions = this.data.branchRestrictions[branchName];
    if (!restrictions || restrictions.length === 0) return true; // no restrictions
    return restrictions.includes(memberId);
  }

  async restrictBranch(branchName: string, allowedMembers: string[]): Promise<void> {
    this.data.branchRestrictions[branchName] = allowedMembers;
    await this.save();
  }

  async clearRestrictions(branchName: string): Promise<void> {
    delete this.data.branchRestrictions[branchName];
    await this.save();
  }

  // --- Branch access/visibility ---

  canAccessBranch(memberId: string, _branchName: string): boolean {
    // All branches visible by default — access restrictions can be added later
    if (memberId === this.hostMemberId) return true;
    return true;
  }

  // --- Merge to main ---

  canMergeToMain(memberId: string): boolean {
    if (memberId === this.hostMemberId) return true;
    if (this.data.mergeToMainPolicy === 'open') return true;
    if (this.data.mergeToMainPolicy === 'restricted') return false;
    // 'limited' — check allowed list
    return this.data.mergeToMainAllowed?.includes(memberId) ?? false;
  }

  async setMergePolicy(policy: MergePermissionLevel, allowedMembers?: string[]): Promise<void> {
    this.data.mergeToMainPolicy = policy;
    if (allowedMembers) {
      this.data.mergeToMainAllowed = allowedMembers;
    }
    await this.save();
  }

  /** Get current permissions data (for display). */
  getData(): BranchPermissionsData {
    return { ...this.data };
  }
}
