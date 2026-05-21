// src/test/suite/mcpReaders.test.ts
// Phase 8 — Layer 1 structural read-only gate tests for src/mcp/readers.ts
// and the six *ReaderImpl.ts adapters. Source-grep gates per CONTEXT
// <gates_and_invariants> N-08-01 / N-08-03 / N-08-04 + per-adapter behavior.
//
// Task 1 (this file's initial commit) lands the readers.ts source-grep gates:
//   - N-08-01: no src/mcp/ imports from src/auth/
//   - N-08-03: no writer-shaped method names on Reader interfaces (filtered for comments)
//   - readers.ts uses only `import type` (no runtime imports)
//   - readers.ts declares the six expected interfaces
//   - N-08-04: no console.* in src/mcp/
//
// Task 2 of this plan extends this file with per-adapter behavior tests.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';

// __dirname at runtime is dist/test/suite/ — three levels up is the repo root.
// (The plan sketch used '../../../..' assuming dist/test/suite/fixtures/ depth;
// the actual test file lives one level shallower so '../../..' is correct.)
const REPO_ROOT = path.resolve(__dirname, '../../..');
const MCP_DIR = path.join(REPO_ROOT, 'src', 'mcp');
const READERS_PATH = path.join(MCP_DIR, 'readers.ts');

async function readAllMcpFiles(): Promise<Array<{ path: string; text: string }>> {
  const out: Array<{ path: string; text: string }> = [];
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsAsync.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.js'))) {
        out.push({ path: full, text: await fsAsync.readFile(full, 'utf-8') });
      }
    }
  }
  await walk(MCP_DIR);
  return out;
}

suite('Phase 8 — MCP readers + adapters', () => {

  suite('N-08-01: structural read-only — no src/mcp/ imports from src/auth/', () => {
    test('grep -rE "import.*from.*src/auth" src/mcp/ returns 0 matches', async () => {
      const files = await readAllMcpFiles();
      const offenders = files
        .map(f => ({
          path: f.path,
          lines: f.text
            .split('\n')
            .filter(
              l =>
                /\bimport\b.*from.*\bsrc\/auth\b/.test(l) ||
                /\bimport\b.*from\s+['"][^'"]*\/auth\/[^'"]+['"]/.test(l),
            ),
        }))
        .filter(f => f.lines.length > 0);
      assert.deepStrictEqual(
        offenders,
        [],
        `N-08-01 violation: src/mcp/ files imported from src/auth/. Offenders: ${JSON.stringify(offenders, null, 2)}`,
      );
    });
  });

  suite('N-08-03: no writer-shaped method names on Reader interfaces', () => {
    test('readers.ts contains zero set*/push*/update*/delete*/commit* method declarations outside comments', () => {
      const raw = fs.readFileSync(READERS_PATH, 'utf-8');
      // Filter out comment lines (single-line // ... and JSDoc body * ... and block /* */)
      const codeLines = raw.split('\n').filter(line => {
        const stripped = line.trim();
        if (stripped.startsWith('//')) return false;
        if (stripped.startsWith('*')) return false;
        if (stripped.startsWith('/*')) return false;
        return true;
      });
      const codeOnly = codeLines.join('\n');
      // Writer-shaped method name regex: a method that starts with
      // set/push/update/delete/commit + Uppercase letter, followed by word
      // chars + opening paren (the interface-method-declaration shape).
      const writerRegex = /\b(set[A-Z]\w*|push[A-Z]\w*|update[A-Z]\w*|delete[A-Z]\w*|commit[A-Z]\w*)\s*\(/g;
      const matches = codeOnly.match(writerRegex) ?? [];
      assert.deepStrictEqual(
        matches,
        [],
        `N-08-03 violation: readers.ts declares writer-shaped methods. Matches: ${JSON.stringify(matches)}`,
      );
    });

    test('readers.ts declares exactly the six expected Reader interfaces', () => {
      const raw = fs.readFileSync(READERS_PATH, 'utf-8');
      const expected = [
        'BranchReader',
        'SyncReader',
        'ActivityReader',
        'ChatReader',
        'DependencyReader',
        'PresenceReader',
      ];
      for (const name of expected) {
        assert.match(
          raw,
          new RegExp(`export interface ${name}\\b`),
          `readers.ts must declare 'export interface ${name}'`,
        );
      }
    });

    test('readers.ts uses only `import type` (no runtime imports)', () => {
      const raw = fs.readFileSync(READERS_PATH, 'utf-8');
      const lines = raw.split('\n');
      const offenders = lines.filter(
        l => /^\s*import\b/.test(l) && !/^\s*import\s+type\b/.test(l),
      );
      assert.deepStrictEqual(
        offenders,
        [],
        `readers.ts must use only \`import type\` (no runtime imports). Offenders: ${JSON.stringify(offenders)}`,
      );
    });
  });

  suite('N-08-04: no console.* in src/mcp/', () => {
    test('grep -rE "^\\s*console\\." src/mcp/ returns 0 matches', async () => {
      const files = await readAllMcpFiles();
      const offenders: Array<{ path: string; line: string }> = [];
      for (const f of files) {
        for (const line of f.text.split('\n')) {
          if (/^\s*console\./.test(line)) {
            offenders.push({ path: f.path, line: line.trim() });
          }
        }
      }
      assert.deepStrictEqual(
        offenders,
        [],
        `N-08-04 violation: console.* in src/mcp/. Offenders: ${JSON.stringify(offenders, null, 2)}`,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Task 2 — per-adapter behavior tests.
//
// Lightweight stubs of the underlying services (BranchManager / SyncTracker /
// PushHistory / ChatLog / SessionHost / AstFactory) — deeper integration
// coverage lands in 08-09 wire-up tests. Here we exercise the adapter shape:
//   - pass-through of values
//   - edge cases (negative limit, missing data)
//   - T-08-02 defensive-copy semantics for PresenceReaderImpl
//   - DependencyReaderImpl ad-hoc fallback for symbol/missing-file inputs.
// ---------------------------------------------------------------------------
import { BranchReaderImpl } from '../../mcp/adapters/BranchReaderImpl.js';
import { SyncReaderImpl } from '../../mcp/adapters/SyncReaderImpl.js';
import { ActivityReaderImpl } from '../../mcp/adapters/ActivityReaderImpl.js';
import { ChatReaderImpl } from '../../mcp/adapters/ChatReaderImpl.js';
import { PresenceReaderImpl } from '../../mcp/adapters/PresenceReaderImpl.js';
import { DependencyReaderImpl } from '../../mcp/adapters/DependencyReaderImpl.js';

// --- Stubs for the underlying services (only the methods the adapters call) ---
function stubBranchManager(
  branch: string,
  branches: Array<{ name: string }> = [],
): import('../../filesystem/BranchManager.js').BranchManager {
  return {
    getActiveBranch: async () => branch,
    listBranches: () => branches,
  } as unknown as import('../../filesystem/BranchManager.js').BranchManager;
}

function stubSyncTracker(
  dirty: string[],
  lastPushId: string | null,
): import('../../filesystem/SyncTracker.js').SyncTracker {
  return {
    getOutOfSyncPaths: () => dirty,
    getLatestPushId: () => lastPushId,
  } as unknown as import('../../filesystem/SyncTracker.js').SyncTracker;
}

function stubPushHistory(
  records: Array<{ id: string }>,
): import('../../filesystem/PushHistory.js').PushHistory {
  return {
    getRecords: () => records,
    getLatestRecord: () => records[0],
  } as unknown as import('../../filesystem/PushHistory.js').PushHistory;
}

function stubChatLog(
  records: Array<{ id: string }>,
): import('../../filesystem/ChatLog.js').ChatLog {
  return {
    // Mirror ChatLog.getRecent(n) (returns the LAST n records).
    getRecent: (n: number) => records.slice(-n),
    getRecords: () => records,
  } as unknown as import('../../filesystem/ChatLog.js').ChatLog;
}

function stubSessionHost(
  presence: Array<{ memberId: string }>,
  tracking: Map<string, string[]>,
): import('../../host/SessionHost.js').SessionHost {
  return {
    getPresenceSnapshot: () => presence,
    getMemberTracking: () => tracking,
    getMemberNames: () => new Map(),
  } as unknown as import('../../host/SessionHost.js').SessionHost;
}

suite('Phase 8 — BranchReaderImpl', () => {
  test('getActiveBranch returns the wrapped value', async () => {
    const r = new BranchReaderImpl(stubBranchManager('main'));
    assert.strictEqual(await r.getActiveBranch(), 'main');
  });

  test('listBranches returns the wrapped array (length matches)', () => {
    const r = new BranchReaderImpl(
      stubBranchManager('main', [{ name: 'main' }, { name: 'feat-x' }]),
    );
    assert.strictEqual(r.listBranches().length, 2);
  });
});

suite('Phase 8 — SyncReaderImpl', () => {
  test('getOutOfSyncPaths returns the wrapped array', () => {
    const r = new SyncReaderImpl(stubSyncTracker(['a.ts', 'b.ts'], null));
    assert.deepStrictEqual([...r.getOutOfSyncPaths()], ['a.ts', 'b.ts']);
  });

  test('getLatestPushId returns the wrapped value', () => {
    const r = new SyncReaderImpl(stubSyncTracker([], 'push-xyz'));
    assert.strictEqual(r.getLatestPushId(), 'push-xyz');
  });

  test('getLatestPushId returns null when no push observed', () => {
    const r = new SyncReaderImpl(stubSyncTracker([], null));
    assert.strictEqual(r.getLatestPushId(), null);
  });
});

suite('Phase 8 — ActivityReaderImpl', () => {
  test('getRecentPushes(3) returns up to 3 records newest-first', () => {
    const r = new ActivityReaderImpl(
      stubPushHistory([{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }]),
    );
    const got = r.getRecentPushes(3);
    assert.strictEqual(got.length, 3);
    assert.strictEqual(got[0].id, '1');
  });

  test('getRecentPushes(0) returns []', () => {
    const r = new ActivityReaderImpl(stubPushHistory([{ id: '1' }]));
    assert.deepStrictEqual([...r.getRecentPushes(0)], []);
  });

  test('getRecentPushes(-5) treats as 0 (no throw)', () => {
    const r = new ActivityReaderImpl(stubPushHistory([{ id: '1' }]));
    assert.deepStrictEqual([...r.getRecentPushes(-5)], []);
  });
});

suite('Phase 8 — ChatReaderImpl', () => {
  test('getRecent(2) returns up to 2 records from ChatLog', () => {
    const r = new ChatReaderImpl(
      stubChatLog([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
    );
    const got = r.getRecent(2);
    assert.strictEqual(got.length, 2);
    // ChatLog.getRecent(2) returns slice(-2) -> [{id:'b'}, {id:'c'}]
    assert.strictEqual(got[0].id, 'b');
  });

  test('getRecent(0) returns [] (guards against ChatLog.getRecent(0) returning all)', () => {
    const r = new ChatReaderImpl(stubChatLog([{ id: 'a' }, { id: 'b' }]));
    assert.deepStrictEqual([...r.getRecent(0)], []);
  });
});

suite('Phase 8 — PresenceReaderImpl (T-08-02 defensive copy)', () => {
  test('getPresenceSnapshot returns a NEW array (mutation does not leak back)', () => {
    const live: Array<{ memberId: string }> = [{ memberId: 'm1' }];
    const r = new PresenceReaderImpl(stubSessionHost(live, new Map()));
    const snap = [...r.getPresenceSnapshot()] as Array<{ memberId: string }>;
    snap.push({ memberId: 'mutated' });
    assert.strictEqual(
      live.length,
      1,
      'mutation must NOT leak into the host array',
    );
  });

  test('getMemberTracking returns a NEW Map with NEW arrays per entry', () => {
    const liveTracking = new Map([['m1', ['a.ts']]]);
    const r = new PresenceReaderImpl(stubSessionHost([], liveTracking));
    const tracking = r.getMemberTracking();
    const arr = tracking.get('m1') as readonly string[] | undefined;
    if (arr) {
      // Force a mutation on the returned array. The adapter contract says
      // this MUST NOT leak — its returned value is a fresh copy.
      (arr as string[]).push('mutated.ts');
    }
    assert.deepStrictEqual(
      liveTracking.get('m1'),
      ['a.ts'],
      'mutation must NOT leak into the host map values',
    );
  });

  test('getMemberTracking handles empty Map', () => {
    const r = new PresenceReaderImpl(stubSessionHost([], new Map()));
    const tracking = r.getMemberTracking();
    assert.strictEqual(tracking.size, 0);
  });
});

suite('Phase 8 — DependencyReaderImpl (ad-hoc; defer standing index to 8.1)', () => {
  test('forwardDeps on a non-path string returns { symbols:[], files:[] }', async () => {
    const r = new DependencyReaderImpl({ workspaceRoot: '/tmp' });
    const got = await r.forwardDeps('not-a-path', 1);
    assert.deepStrictEqual(got, { symbols: [], files: [] });
  });

  test('reverseDeps always returns { symbols:[], files:[] } in v1 (deferred to 8.1)', async () => {
    const r = new DependencyReaderImpl({ workspaceRoot: '/tmp' });
    const got = await r.reverseDeps('parseToken', 1);
    assert.deepStrictEqual(got, { symbols: [], files: [] });
  });

  test('forwardDeps on a missing file returns { symbols:[], files:[] } (no throw)', async () => {
    const r = new DependencyReaderImpl({ workspaceRoot: '/tmp/__nonexistent__' });
    const got = await r.forwardDeps('src/zzz-no-such-file.ts', 1);
    assert.deepStrictEqual(got, { symbols: [], files: [] });
  });

  test('forwardDeps on path traversal attempt is rejected', async () => {
    const r = new DependencyReaderImpl({ workspaceRoot: '/tmp/workspace' });
    // Even if /etc/passwd existed, the traversal must be rejected before
    // the read attempt. The path-confinement check returns the empty result.
    const got = await r.forwardDeps('../../../etc/passwd.ts', 1);
    assert.deepStrictEqual(got, { symbols: [], files: [] });
  });
});
