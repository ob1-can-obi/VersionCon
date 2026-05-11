/** Metadata about a single branch stored in branch-metadata.json. */
export interface BranchInfo {
  name: string;
  createdBy: string;
  createdAt: number;
  locked: boolean;
  lockedPushers?: string[];
  /**
   * Phase 6 REVIEW-04 (Plan 06-01): when true, versioncon.mergeBranch refuses
   * to merge INTO this branch unless the source branch's most-recent push
   * has a ReviewRequest in status:'approved'. Admin-toggleable via
   * versioncon.setBranchRequireReview (Plan 06-05). Absent = false (no gate).
   */
  requireReview?: boolean;
}

/** Merge permission strictness levels. */
export type MergePermissionLevel = 'open' | 'limited' | 'restricted';

/** Persisted permission model for branches (permissions.json). */
export interface BranchPermissionsData {
  canCreateBranch: string[];
  branchRestrictions: Record<string, string[]>;
  mergeToMainPolicy: MergePermissionLevel;
  mergeToMainAllowed?: string[];
}
