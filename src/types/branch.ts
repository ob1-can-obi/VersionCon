/** Metadata about a single branch stored in branch-metadata.json. */
export interface BranchInfo {
  name: string;
  createdBy: string;
  createdAt: number;
  locked: boolean;
  lockedPushers?: string[];
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
