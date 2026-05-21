// src/test/suite/fixtures/fakeReaders.ts
// Phase 8 Wave 0 — shared test fixtures. FakeReaders implements all 6
// Reader interfaces from src/mcp/readers.ts (created in plan 08-02). For
// Wave 0 we declare the shape inline below as `Fake<X>Reader` interfaces;
// 08-02 will replace these inline interfaces with imports from
// '../../../mcp/readers.js' and the class will `implements BranchReader,
// SyncReader, ...` instead of the Fake* prefixed equivalents.
//
// Pattern: PATTERNS.md "fakeReaders.ts" section — mirrors StubCloudTransport
// from sessionClientCloudReconnect.test.ts:32-86 (public test-inspection
// state + canned returns + _set* helper mutators).
//
// Type imports are PURELY `import type` so the fixture file has zero
// runtime import surface beyond Node's built-ins. This mirrors the
// `src/network/Transport.ts` discipline (PATTERNS.md `readers.ts` section).
import type { PushRecord } from '../../../types/push.js';
import type { ChatRecord, PresenceInfo } from '../../../types/chat.js';
import type { BranchInfo } from '../../../types/branch.js';

// --- Wave 0 inline Reader shapes (replaced by 08-02's src/mcp/readers.ts) ---
// Method names must NOT match the writer denylist `set*|push*|update*|delete*|commit*`
// (N-08-03 gate). Allowed verbs: get*, list*, query*, forward*, reverse*.
export interface FakeBranchReader {
  getActiveBranch(): Promise<string>;
  listBranches(): readonly BranchInfo[];
}
export interface FakeSyncReader {
  getOutOfSyncPaths(): readonly string[];
  getLatestPushId(): string | null;
}
export interface FakeActivityReader {
  getRecentPushes(limit: number): readonly PushRecord[];
}
export interface FakeChatReader {
  getRecent(limit: number): readonly ChatRecord[];
}
export interface FakeDependencyReader {
  forwardDeps(target: string, hops: 1 | 2): Promise<{ symbols: string[]; files: string[] }>;
  reverseDeps(target: string, hops: 1 | 2): Promise<{ symbols: string[]; files: string[] }>;
}
export interface FakePresenceReader {
  getPresenceSnapshot(): readonly PresenceInfo[];
  getMemberTracking(): ReadonlyMap<string, readonly string[]>;
}

// --- Deterministic canned data per RESEARCH §H.3 ---

/**
 * Canned PushRecord — full shape per src/types/push.ts:
 *   { id, memberId, memberDisplayName, message, branch, files: PushFileEntry[],
 *     timestamp: number (ms epoch), reverted: boolean }.
 * Timestamps are LITERAL numeric epochs (ms), matching the on-disk shape; the
 * fixture freezes a deterministic value (2026-05-21T12:00:00Z = 1779681600000)
 * so tests asserting timestamp equality see a stable input.
 */
const CANNED_PUSH: PushRecord = {
  id: 'push-fixture-001',
  memberId: 'alice-member-id',
  memberDisplayName: 'Alice',
  message: 'fixture: tweak parseToken',
  branch: 'main',
  files: [
    {
      relativePath: 'src/auth/TokenService.ts',
      status: 'modified',
      addedLines: 2,
      removedLines: 1,
    },
  ],
  timestamp: 1779681600000, // 2026-05-21T12:00:00.000Z
  reverted: false,
};

/**
 * Canned ChatRecord — full shape per src/types/chat.ts:
 *   { id, kind: 'user'|'system', memberId, memberDisplayName, body,
 *     timestamp: number (ms epoch), subKind?, meta? }.
 * `kind: 'user'` so subKind is correctly absent (subKind is only set when
 * kind === 'system' per the chat.ts contract).
 */
const CANNED_CHAT: ChatRecord = {
  id: 'chat-fixture-001',
  kind: 'user',
  memberId: 'alice-member-id',
  memberDisplayName: 'Alice',
  body: 'fixture: hello from FakeReaders',
  timestamp: 1779681600000, // 2026-05-21T12:00:00.000Z
};

/**
 * Canned BranchInfo — full shape per src/types/branch.ts:
 *   { name, createdBy, createdAt, locked, lockedPushers?, requireReview? }.
 */
const CANNED_BRANCHES: BranchInfo[] = [
  {
    name: 'main',
    createdBy: 'alice-member-id',
    createdAt: 1779681600000,
    locked: false,
  },
];

// --- FakeReaders combined class ---
/**
 * Combined fake implementing all 6 Reader interfaces. Used across all Phase 8
 * tests (mcpToolsRead.test.ts, mcpAdviseSync.test.ts, mcpServer.test.ts, etc.)
 * to inject deterministic state without spinning up the full SessionHost +
 * BranchManager + SyncTracker + PushHistory + ChatLog + AstAnalyzer stack.
 *
 * Public state fields are mutable by design — they are the "test inspection +
 * mutation surface" (PATTERNS.md). Tests that need a specific state mutate
 * the fields directly OR via the _set* helpers below. The Reader-interface
 * methods are non-mutating (read-only) so all mutation goes through the
 * _set* helpers, mirroring StubCloudTransport's _injectMessage pattern.
 *
 * Deviation note (08-02): the `implements Fake*` clauses below are
 * transitional. Plan 08-02 ships src/mcp/readers.ts with the canonical
 * Reader interfaces (BranchReader, SyncReader, etc.) and updates this
 * class to `implements BranchReader, SyncReader, ActivityReader,
 * ChatReader, DependencyReader, PresenceReader`. The structural shape is
 * identical between the Fake* and final interfaces by construction (08-02
 * is a no-op rename from this fixture's perspective).
 */
export class FakeReaders
  implements
    FakeBranchReader,
    FakeSyncReader,
    FakeActivityReader,
    FakeChatReader,
    FakeDependencyReader,
    FakePresenceReader
{
  // Public test-inspection state (mutable by design — see class JSDoc).
  public branch = 'main';
  public ahead = 0;
  public dirtyPaths: string[] = [];
  public latestPushId: string | null = CANNED_PUSH.id;
  public pushes: PushRecord[] = [CANNED_PUSH];
  public chats: ChatRecord[] = [CANNED_CHAT];
  public presence: PresenceInfo[] = [];
  public memberTracking: Map<string, string[]> = new Map();
  public branches: BranchInfo[] = [...CANNED_BRANCHES];

  // Dep-graph fixtures — parseToken depends on AuthHandler; verifyClient
  // depends on parseToken (reverse). These names + edges are the SC-2
  // anchor set used by mcpDependencyReaderE2E tests in later plans.
  public depForward: Record<string, { symbols: string[]; files: string[] }> = {
    parseToken: { symbols: ['verifyClient'], files: ['src/host/AuthHandler.ts'] },
  };
  public depReverse: Record<string, { symbols: string[]; files: string[] }> = {
    verifyClient: { symbols: ['parseToken'], files: ['src/auth/TokenService.ts'] },
    parseToken: { symbols: [], files: ['src/host/AuthHandler.ts'] },
  };

  // ------------------------------------------------------------------------
  // BranchReader
  // ------------------------------------------------------------------------
  async getActiveBranch(): Promise<string> {
    return this.branch;
  }
  listBranches(): readonly BranchInfo[] {
    return this.branches;
  }

  // ------------------------------------------------------------------------
  // SyncReader
  // ------------------------------------------------------------------------
  getOutOfSyncPaths(): readonly string[] {
    return this.dirtyPaths;
  }
  getLatestPushId(): string | null {
    return this.latestPushId;
  }

  // ------------------------------------------------------------------------
  // ActivityReader
  // ------------------------------------------------------------------------
  getRecentPushes(limit: number): readonly PushRecord[] {
    return this.pushes.slice(0, Math.max(0, limit));
  }

  // ------------------------------------------------------------------------
  // ChatReader — newest-last convention matches ChatLog.getRecent(n) semantics
  // ------------------------------------------------------------------------
  getRecent(limit: number): readonly ChatRecord[] {
    return this.chats.slice(-Math.max(0, limit));
  }

  // ------------------------------------------------------------------------
  // DependencyReader
  // ------------------------------------------------------------------------
  async forwardDeps(
    target: string,
    _hops: 1 | 2,
  ): Promise<{ symbols: string[]; files: string[] }> {
    return this.depForward[target] ?? { symbols: [], files: [] };
  }
  async reverseDeps(
    target: string,
    _hops: 1 | 2,
  ): Promise<{ symbols: string[]; files: string[] }> {
    return this.depReverse[target] ?? { symbols: [], files: [] };
  }

  // ------------------------------------------------------------------------
  // PresenceReader
  // ------------------------------------------------------------------------
  getPresenceSnapshot(): readonly PresenceInfo[] {
    return this.presence;
  }
  getMemberTracking(): ReadonlyMap<string, readonly string[]> {
    return this.memberTracking;
  }

  // ------------------------------------------------------------------------
  // Test-inspection mutators (mirror StubCloudTransport._inject* style).
  //
  // These verbs are prefixed `_` to mark them as fixture-only — they have NO
  // analog on the production Reader interfaces (08-02 readers.ts) and they
  // exist solely to let tests synthesize specific in-memory states without
  // re-instantiating the fixture. Tests that need a clean fixture should
  // simply `new FakeReaders()` in setup().
  //
  // N-08-03 source-grep gate note: the underscore prefix puts these names
  // outside the `set*|push*|update*|delete*|commit*` denylist regex (the
  // denylist matches at a word boundary, not after a leading underscore).
  // ------------------------------------------------------------------------
  _setDirtyFiles(paths: string[]): void {
    this.dirtyPaths = [...paths];
  }
  _setBranchAhead(n: number): void {
    this.ahead = n;
  }
  _setLatestPushId(id: string | null): void {
    this.latestPushId = id;
  }
  _setPresenceForFile(
    filePath: string,
    memberId: string,
    displayName = memberId,
  ): void {
    this.presence = [
      {
        memberId,
        displayName,
        branch: this.branch,
        activeFilePath: filePath,
        lastUpdated: 1779681600000,
      },
    ];
    this.memberTracking.set(memberId, [filePath]);
  }
  _setForwardDeps(
    target: string,
    value: { symbols: string[]; files: string[] },
  ): void {
    this.depForward[target] = value;
  }
  _setReverseDeps(
    target: string,
    value: { symbols: string[]; files: string[] },
  ): void {
    this.depReverse[target] = value;
  }
  _addChat(record: ChatRecord): void {
    this.chats.push(record);
  }
  _addPush(record: PushRecord): void {
    this.pushes.unshift(record);
    this.latestPushId = record.id;
  }
}
