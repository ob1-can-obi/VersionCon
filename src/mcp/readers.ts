/**
 * Phase 8 — MCP server's Reader interfaces (Layer 1 structural read-only gate).
 *
 * This file is TYPE-ONLY. All imports use `import type`. No runtime code lands
 * here. Every interface exposes ONLY read-shaped methods (get-prefix, list-prefix,
 * query-prefix, forward-prefix, reverse-prefix) — NO writer-shaped methods (set,
 * push, update, delete, commit prefixed). This is the structural contract that
 * prevents the MCP server (src/mcp/) from accidentally calling a state-mutating
 * method on a wrapped service.
 *
 * Source-grep gates enforce the contract at every CI run:
 * - N-08-01: no src/mcp/ file may reference the auth module (denylist gate)
 * - N-08-03: no method name on a Reader interface matches the writer-shape
 *   regex `set[A-Z]|push[A-Z]|update[A-Z]|delete[A-Z]|commit[A-Z]` (followed
 *   by an opening paren — the interface-method declaration shape). The
 *   identifier `PushRecord` appearing in a type position is fine; only
 *   method NAMES are gated.
 * - N-08-04: no console.* in src/mcp/ (this file has zero log statements
 *   by construction — it is pure types).
 *
 * Adapters in src/mcp/adapters/ (one file per Reader, named *ReaderImpl.ts) implement these interfaces by
 * wrapping existing service classes (BranchManager, SyncTracker, PushHistory,
 * ChatLog, SessionHost, AstFactory). Tests inject src/test/suite/fixtures/
 * fakeReaders.ts instead — a deterministic FakeReaders class implementing
 * all six interfaces.
 *
 * See:
 * - .planning/phases/08-ai-agent-api-mcp-integration/08-RESEARCH.md §1070-1103
 *   (interface definitions verbatim)
 * - .planning/phases/08-ai-agent-api-mcp-integration/08-CONTEXT.md
 *   `<decisions>` D-3 (Layer 1 + Layer 2 read-only enforcement)
 * - src/network/Transport.ts (the canonical type-only-module analog)
 */
import type { BranchInfo } from '../types/branch.js';
import type { PushRecord } from '../types/push.js';
import type { ChatRecord, PresenceInfo } from '../types/chat.js';

/**
 * Read-only access to branch metadata.
 *
 * Wrapped by src/mcp/adapters/BranchReaderImpl.ts around the existing
 * BranchManager (src/filesystem/BranchManager.ts:55,71). The BranchManager
 * already returns a fresh array from listBranches(), so the adapter is a
 * pure pass-through.
 */
export interface BranchReader {
  /** The currently-active branch name (e.g. "main"). Async because the source-of-truth lives on disk in active-branch.txt. */
  getActiveBranch(): Promise<string>;
  /** All known branches with full BranchInfo metadata. Returns a fresh array (caller may consume freely). */
  listBranches(): readonly BranchInfo[];
}

/**
 * Read-only access to sync state.
 *
 * Wrapped by src/mcp/adapters/SyncReaderImpl.ts around the existing
 * SyncTracker (src/filesystem/SyncTracker.ts:63,92). Sync state is in-memory
 * and reset on extension-host restart — this Reader surface intentionally
 * mirrors that volatility.
 */
export interface SyncReader {
  /** Workspace-relative paths that have remote pushes the local workspace has not yet pulled. */
  getOutOfSyncPaths(): readonly string[];
  /** ID of the most-recent push observed on the active branch, or null if no pushes have been seen. */
  getLatestPushId(): string | null;
}

/**
 * Read-only access to push history.
 *
 * Wrapped by src/mcp/adapters/ActivityReaderImpl.ts around the existing
 * PushHistory (src/filesystem/PushHistory.ts:42). PushHistory.getRecords()
 * returns NEWEST-FIRST per its JSDoc; the adapter preserves that order.
 */
export interface ActivityReader {
  /** Most-recent N push records, newest-first. Implementations cap negative `limit` to zero (no throw). */
  getRecentPushes(limit: number): readonly PushRecord[];
}

/**
 * Read-only access to the per-branch chat log.
 *
 * Wrapped by src/mcp/adapters/ChatReaderImpl.ts around the existing
 * ChatLog (src/filesystem/ChatLog.ts:106). ChatLog.getRecent(n) returns
 * NEWEST-LAST (chronological order) per its JSDoc — opposite ordering to
 * PushHistory. The adapter preserves that order verbatim.
 */
export interface ChatReader {
  /** Most-recent N chat records, oldest-first (newest-last per ChatLog contract). Implementations cap negative `limit` to zero. */
  getRecent(limit: number): readonly ChatRecord[];
}

/**
 * Read-only access to dependency information.
 *
 * Wrapped by src/mcp/adapters/DependencyReaderImpl.ts. Phase 5 (AST analysis)
 * exposes ANALYSIS-ON-PUSH, not QUERY-ON-DEMAND, so the v1 implementation is
 * ad-hoc per call: detectLanguageFromPath -> getAdapter -> extractReferences
 * on a single file. NO standing index in v1; defer to Phase 8.1 if per-call
 * latency bites (Pitfall 7).
 *
 * For symbol-entry-point inputs (the input is a bare symbol name, not a
 * file path) v1 returns `{ symbols: [], files: [] }` — the standing index
 * required for symbol lookup is deferred. File-path entry-point inputs
 * with a supported language extension flow through the AST adapter.
 *
 * @param target  Either a workspace-relative file path (preferred in v1) or a
 *                symbol name (deferred — returns empty in v1).
 * @param hops    Walk depth. v1 implements 1-hop only; `2` is accepted at the
 *                type level but treated as 1 by current adapters.
 */
export interface DependencyReader {
  /** Symbols + files that `target` references (downstream). v1 is single-file ad-hoc analysis; no throw on unsupported lang / missing file. */
  forwardDeps(target: string, hops: 1 | 2): Promise<{ symbols: string[]; files: string[] }>;
  /** Symbols + files that reference `target` (upstream). v1 returns empty; full coverage deferred to 8.1's standing index. */
  reverseDeps(target: string, hops: 1 | 2): Promise<{ symbols: string[]; files: string[] }>;
}

/**
 * Read-only access to per-member presence + tracked-paths.
 *
 * Wrapped by src/mcp/adapters/PresenceReaderImpl.ts around SessionHost
 * (src/host/SessionHost.ts:2002,2153). The adapter DEFENSIVE-COPIES both
 * return values so callers cannot mutate SessionHost's internal state — see
 * T-08-02 (Information Disclosure of internal mutable state).
 *
 * PresenceInfo lives in src/types/chat.ts (alongside ChatRecord) — NOT in
 * src/types/session.ts. See 08-01-SUMMARY for the type-location finding.
 */
export interface PresenceReader {
  /** Per-member presence snapshot. Defensive-copied by the adapter; mutations do not leak back into the host. */
  getPresenceSnapshot(): readonly PresenceInfo[];
  /** memberId -> workspace-relative tracked paths. Defensive-copied at both Map and array levels. */
  getMemberTracking(): ReadonlyMap<string, readonly string[]>;
}
