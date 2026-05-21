// src/mcp/adapters/BranchReaderImpl.ts
// Phase 8 — Reader adapter wrapping BranchManager (read-only pass-through).
//
// Pattern: PATTERNS.md "src/mcp/adapters/*ReaderImpl.ts" section. The wrapped
// service (BranchManager) already returns a fresh array from listBranches()
// (BranchManager.ts:71 — `return [...this.metadata];`), so this adapter does
// NOT copy again — the spread there is the defensive boundary.
//
// N-08-01 / N-08-03 / N-08-04 gates: no auth import, no writer-shaped method
// names, no console.*.
import type { BranchReader } from '../readers.js';
import type { BranchManager } from '../../filesystem/BranchManager.js';
import type { BranchInfo } from '../../types/branch.js';

/**
 * Layer-2 (runtime) implementation of {@link BranchReader} backed by the
 * existing BranchManager. Pure pass-through — the BranchManager's own
 * getActiveBranch (async, reads active-branch.txt) and listBranches (sync,
 * returns a defensive-copied array) already satisfy the Reader contract.
 */
export class BranchReaderImpl implements BranchReader {
  constructor(private readonly mgr: BranchManager) {}

  async getActiveBranch(): Promise<string> {
    return this.mgr.getActiveBranch();
  }

  listBranches(): readonly BranchInfo[] {
    return this.mgr.listBranches();
  }
}
