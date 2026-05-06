/** Metadata for a single pushed file. */
export interface PushFileEntry {
  relativePath: string;
  status: 'added' | 'modified' | 'deleted';
  addedLines: number;
  removedLines: number;
}

/** A push record persisted in push-history.json. */
export interface PushRecord {
  id: string;
  memberId: string;
  memberDisplayName: string;
  message: string;
  branch: string;
  files: PushFileEntry[];
  timestamp: number;
  reverted: boolean;
  revertedFiles?: string[];
}

/** Summary computed before executing a push. */
export interface PushSummary {
  files: PushFileEntry[];
  totalAdded: number;
  totalRemoved: number;
}

/** Enhanced push summary with affected team member info (PUSH-03). */
export interface EnhancedPushSummary extends PushSummary {
  affectedMembers: Array<{
    memberId: string;
    displayName: string;
    overlappingFiles: string[];
  }>;
}
