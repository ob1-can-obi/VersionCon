import * as fs from 'fs/promises';
import * as path from 'path';
import type { BranchInfo } from '../types/branch.js';

/**
 * Manages multiple branches within .versioncon/branches/.
 *
 * Handles creation, listing, switching, deletion, and migration
 * from the Phase 2 single-branch layout (.versioncon/branch/).
 */
export class BranchManager {
  private readonly branchesDir: string;
  private readonly metadataFile: string;
  private readonly activeBranchFile: string;
  private readonly legacyBranchDir: string;
  private metadata: BranchInfo[] = [];

  constructor(private readonly versionconDir: string) {
    this.branchesDir = path.join(versionconDir, 'branches');
    this.metadataFile = path.join(versionconDir, 'branch-metadata.json');
    this.activeBranchFile = path.join(versionconDir, 'active-branch.txt');
    this.legacyBranchDir = path.join(versionconDir, 'branch');
  }

  /**
   * Initialize branch manager. Migrates legacy layout if needed.
   * Must be called once at startup.
   */
  async initialize(): Promise<void> {
    // Check if migration is needed: legacy dir exists but branches/ doesn't
    const legacyExists = await this.dirExists(this.legacyBranchDir);
    const branchesExists = await this.dirExists(this.branchesDir);

    if (legacyExists && !branchesExists) {
      await this.migrateFromLegacy();
    } else if (!branchesExists) {
      // Fresh install — create branches/main/
      const mainDir = path.join(this.branchesDir, 'main');
      await fs.mkdir(mainDir, { recursive: true });
      this.metadata = [{
        name: 'main',
        createdBy: 'system',
        createdAt: Date.now(),
        locked: false,
      }];
      await this.saveMetadata();
      await fs.writeFile(this.activeBranchFile, 'main');
    } else {
      // Load existing metadata
      await this.loadMetadata();
    }
  }

  /** Get the currently active branch name. */
  async getActiveBranch(): Promise<string> {
    try {
      const name = await fs.readFile(this.activeBranchFile, 'utf-8');
      return name.trim();
    } catch {
      return 'main';
    }
  }

  /** Get the absolute path to the active branch directory. */
  async getActiveBranchDir(): Promise<string> {
    const name = await this.getActiveBranch();
    return path.join(this.branchesDir, name);
  }

  /** List all branches. */
  listBranches(): BranchInfo[] {
    return [...this.metadata];
  }

  /** Create a new branch from a base branch. */
  async createBranch(
    name: string,
    baseBranch: string,
    creatorId: string,
  ): Promise<BranchInfo> {
    // Validate name
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error('Branch name must contain only alphanumeric characters, hyphens, and underscores');
    }

    if (this.metadata.some(b => b.name === name)) {
      throw new Error(`Branch "${name}" already exists`);
    }

    const baseDir = path.join(this.branchesDir, baseBranch);
    if (!await this.dirExists(baseDir)) {
      throw new Error(`Base branch "${baseBranch}" does not exist`);
    }

    // Copy base branch to new branch
    const newDir = path.join(this.branchesDir, name);
    await this.copyDir(baseDir, newDir);

    const info: BranchInfo = {
      name,
      createdBy: creatorId,
      createdAt: Date.now(),
      locked: false,
    };

    this.metadata.push(info);
    await this.saveMetadata();
    return info;
  }

  /** Switch to a different branch. */
  async switchBranch(name: string): Promise<void> {
    if (!this.metadata.some(b => b.name === name)) {
      throw new Error(`Branch "${name}" does not exist`);
    }
    await fs.writeFile(this.activeBranchFile, name);
  }

  /** Delete a branch (cannot delete the active branch or main). */
  async deleteBranch(name: string): Promise<void> {
    if (name === 'main') {
      throw new Error('Cannot delete the main branch');
    }

    const active = await this.getActiveBranch();
    if (name === active) {
      throw new Error('Cannot delete the active branch. Switch first.');
    }

    const branchDir = path.join(this.branchesDir, name);
    await fs.rm(branchDir, { recursive: true, force: true });
    this.metadata = this.metadata.filter(b => b.name !== name);
    await this.saveMetadata();
  }

  /** Lock a branch (restrict who can push). */
  async lockBranch(name: string, lockedPushers?: string[]): Promise<void> {
    const branch = this.metadata.find(b => b.name === name);
    if (!branch) throw new Error(`Branch "${name}" does not exist`);
    branch.locked = true;
    branch.lockedPushers = lockedPushers;
    await this.saveMetadata();
  }

  /** Unlock a branch. */
  async unlockBranch(name: string): Promise<void> {
    const branch = this.metadata.find(b => b.name === name);
    if (!branch) throw new Error(`Branch "${name}" does not exist`);
    branch.locked = false;
    branch.lockedPushers = undefined;
    await this.saveMetadata();
  }

  /**
   * Phase 6 REVIEW-04 (Plan 06-05): toggle the per-branch requireReview gate.
   *
   * When true, the three merge entry points
   * (versioncon.mergeBranch / quickMergeFiles / structuredMergeBranch) refuse
   * to merge INTO this branch unless the source branch's most-recent push has
   * an approving ReviewRequest (status:'approved'). Admin-toggleable via
   * versioncon.setBranchRequireReview (admin = canCreateBranch === true; the
   * v1 admin proxy per 06-SPEC.md frontmatter line 15).
   *
   * Independent of lockBranch — locked branches restrict WHO can push;
   * requireReview restricts WHAT can merge in. Both gates compose.
   *
   * No wire broadcast on toggle for v1 — the gate is read on the local host
   * process during merge attempts. A future plan can add wire propagation
   * (`branch-require-review-changed`) so peer joiners see the toggle live
   * without a state-sync round-trip.
   */
  async setRequireReview(name: string, requireReview: boolean): Promise<void> {
    const branch = this.metadata.find(b => b.name === name);
    if (!branch) throw new Error(`Branch "${name}" does not exist`);
    branch.requireReview = requireReview;
    await this.saveMetadata();
  }

  /**
   * Phase 6 REVIEW-04 (Plan 06-05): reader for the requireReview flag.
   * Returns false for branches that have never had the flag set (legacy
   * branch-metadata.json without the field) — undefined is treated as false.
   */
  getRequireReview(name: string): boolean {
    return this.metadata.find(b => b.name === name)?.requireReview === true;
  }

  /**
   * Phase 4.3 SC-7: register a branch whose contents were materialized by an
   * external process (e.g. GitBridge.importFromRemote cloning into the dest
   * dir). Does NOT create the dir or copy any contents — caller has already
   * populated it. Adds the BranchInfo to metadata and persists.
   *
   * Throws if:
   *   * `name` fails the git-style validator (alphanumerics, dots, slashes,
   *     dashes, underscores — accepts e.g. `feature/v1.0` which createBranch
   *     would reject under its stricter `[A-Za-z0-9_-]+` rule).
   *   * a branch with the same name already exists in metadata.
   *   * the dir does not exist on disk (caller-must-populate contract).
   *
   * NOTE: createBranch's stricter validator (alphanumerics + underscore +
   * hyphen only) is preserved verbatim — VersionCon-internal branch names
   * stay simple. registerExternalBranch's relaxed validator matches the
   * surface of git branch names we may encounter on a real remote.
   */
  async registerExternalBranch(
    name: string,
    creatorId: string,
  ): Promise<BranchInfo> {
    if (!/^[a-zA-Z0-9._/-]+$/.test(name)) {
      throw new Error(
        'Branch name must contain only alphanumeric characters, dots, hyphens, slashes, and underscores',
      );
    }
    if (this.metadata.some(b => b.name === name)) {
      throw new Error(`Branch "${name}" already exists`);
    }
    const dir = path.join(this.branchesDir, name);
    if (!await this.dirExists(dir)) {
      throw new Error(
        `Branch dir not found on disk: ${dir} — caller must populate before registering`,
      );
    }
    const info: BranchInfo = {
      name,
      createdBy: creatorId,
      createdAt: Date.now(),
      locked: false,
    };
    this.metadata.push(info);
    await this.saveMetadata();
    return info;
  }

  /** Get branch info by name. */
  getBranch(name: string): BranchInfo | undefined {
    return this.metadata.find(b => b.name === name);
  }

  // --- Private helpers ---

  private async migrateFromLegacy(): Promise<void> {
    const mainDir = path.join(this.branchesDir, 'main');
    await fs.mkdir(this.branchesDir, { recursive: true });
    await fs.rename(this.legacyBranchDir, mainDir);

    this.metadata = [{
      name: 'main',
      createdBy: 'system',
      createdAt: Date.now(),
      locked: false,
    }];
    await this.saveMetadata();
    await fs.writeFile(this.activeBranchFile, 'main');
  }

  private async loadMetadata(): Promise<void> {
    try {
      const data = await fs.readFile(this.metadataFile, 'utf-8');
      this.metadata = JSON.parse(data);
    } catch {
      this.metadata = [];
    }
  }

  private async saveMetadata(): Promise<void> {
    await fs.mkdir(path.dirname(this.metadataFile), { recursive: true });
    await fs.writeFile(this.metadataFile, JSON.stringify(this.metadata, null, 2));
  }

  private async dirExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private async copyDir(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await this.copyDir(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }
}
