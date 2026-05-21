// src/test/suite/mcpAdviseSync.test.ts
//
// Phase 8 Plan 08 — E2E + unit tests for the advise_sync composite MCP tool.
//
// advise_sync is the FINAL tool in the Phase-8 catalog (7th of 7). It fans
// into 4 readers (SyncReader + PresenceReader + DependencyReader +
// ActivityReader) and fuses their signals into a calibrated confidence-scored
// prediction list per RESEARCH §I.3:
//
//   0.9 — peer has file open AND user is editing same file (file-edit-overlap)
//   0.7 — peer pushed symbol S, user references S (ast-symbol-overlap)
//   0.6 — peer pushed file F, user has F open dirty (file-edit-overlap)
//   0.5 — user edited symbol S, peer's open file imports S (ast-symbol-overlap)
//   0.2 — behind ≥1 push with no other signal (generic out-of-sync)
//
// Payload shape (CONTEXT D-6 LOCKED):
//   { state: { behind, ahead, dirty, last_sync_at },
//     predicted_conflicts: [{ file, reason, confidence, detail, peer? }] }
//
// Tests cover:
//   (1) Registration — advise_sync appears in tools/list with readOnlyHint=true
//   (2) Final-7-tool whitelist — tools/list sorted equals the canonical list
//   (3) Pure-fn unit tests — fusePredictedConflicts per confidence tier
//   (4) E2E — advise_sync against FakeReaders, including target_files scoping
//   (5) SC-4 evidence — out-of-sync workspace → state.behind > 0 + predictions
//   (6) Latency budget — composite call completes well under 500ms CI bound
//
// Pattern: mirrors mcpToolsRead.test.ts (08-06) and mcpDependencyReader.test.ts (08-07).
// SDK-client-against-real-server E2E via startMcpServer + buildServer.
//
// N-08-04 preserved: no console.* in this file (default log is a no-op).
// N-08-10 preserved indirectly: registration goes through registerReadOnlyTool.

import * as assert from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, type McpServerHandle } from '../../mcp/server.js';
import { buildServer } from '../../mcp/buildServer.js';
import { FakeReaders } from './fixtures/fakeReaders.js';
import { fusePredictedConflicts } from '../../mcp/tools/adviseSync.js';

let handle: McpServerHandle;
let client: Client;
let fr: FakeReaders;

async function bootSuite(): Promise<void> {
  fr = new FakeReaders();
  handle = await startMcpServer({
    buildServer: (): ReturnType<typeof buildServer> =>
      buildServer({
        branchReader: fr,
        syncReader: fr,
        activityReader: fr,
        chatReader: fr,
        depReader: fr,
        presenceReader: fr,
      }),
    log: (): void => {
      /* no-op; N-08-04 forbids console here too */
    },
  });
  client = new Client(
    { name: 'mcpAdviseSync-test', version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
}

async function tearSuite(): Promise<void> {
  try {
    await client.close();
  } catch {
    /* ignore */
  }
  await handle.close();
}

// ---------------------------------------------------------------------------
// tools/list — advise_sync registration + final 7-tool whitelist (SC-3 positive)
// ---------------------------------------------------------------------------

suite('Phase 8 — advise_sync registration', () => {
  setup(bootSuite);
  teardown(tearSuite);

  test('tools/list contains advise_sync with readOnlyHint=true', async () => {
    const result = await client.listTools();
    const t = result.tools.find((x): boolean => x.name === 'advise_sync');
    assert.ok(
      t,
      `advise_sync not in tools/list. Got: ${result.tools.map((x): string => x.name).join(',')}`,
    );
    assert.strictEqual(
      (t!.annotations as Record<string, unknown> | undefined)?.readOnlyHint,
      true,
    );
  });

  test('advise_sync description contains "Read-only" substring (RESEARCH §F.3 discipline)', async () => {
    const result = await client.listTools();
    const t = result.tools.find((x): boolean => x.name === 'advise_sync');
    assert.ok(t);
    assert.match(t!.description ?? '', /Read-only/);
  });

  test('tools/list returns EXACTLY the 7 expected tool names (SC-3 positive whitelist)', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t): string => t.name).sort();
    assert.deepStrictEqual(names, [
      'advise_sync',
      'get_branch_status',
      'get_chat_log',
      'get_recent_activity',
      'get_sync_status',
      'list_dependents',
      'query_dependencies',
    ]);
  });

  test('every tool in tools/list has annotations.readOnlyHint=true (Layer 2 stamp)', async () => {
    const result = await client.listTools();
    for (const t of result.tools) {
      assert.strictEqual(
        (t.annotations as Record<string, unknown> | undefined)?.readOnlyHint,
        true,
        `tool ${t.name} missing readOnlyHint=true`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// fusePredictedConflicts — pure-fn unit tests for every confidence tier
// (RESEARCH §I.3 calibration verbatim — no SDK boot required)
// ---------------------------------------------------------------------------

suite('Phase 8 — fusePredictedConflicts pure-fn (RESEARCH §I.3 calibration)', () => {
  test('Tier 0.9: peer has file open AND user editing same file → file-edit-overlap', () => {
    const out = fusePredictedConflicts({
      dirtyFiles: ['src/foo.ts'],
      behind: 1,
      presenceByFile: new Map([
        ['src/foo.ts', { memberId: 'm1', displayName: 'Bob' }],
      ]),
      recentPushedFiles: [],
      userReferences: new Map(),
      peerPushedSymbols: [],
    });
    const hi = out.find((p: { confidence: number }): boolean => p.confidence === 0.9);
    assert.ok(
      hi,
      `Expected a 0.9-confidence prediction. Got: ${JSON.stringify(out)}`,
    );
    assert.strictEqual(hi!.reason, 'file-edit-overlap');
    assert.strictEqual(hi!.file, 'src/foo.ts');
    assert.strictEqual(hi!.peer, 'Bob');
  });

  test('Tier 0.7: peer pushed a symbol the user references → ast-symbol-overlap', () => {
    const out = fusePredictedConflicts({
      dirtyFiles: ['src/foo.ts'],
      behind: 1,
      presenceByFile: new Map(),
      recentPushedFiles: [],
      userReferences: new Map([
        ['src/foo.ts', [{ symbol: 'parseToken', file: '' }]],
      ]),
      peerPushedSymbols: [{ symbol: 'parseToken', actor: 'Alice' }],
    });
    const mid = out.find((p): boolean => p.confidence === 0.7);
    assert.ok(mid, `Expected a 0.7-confidence prediction. Got: ${JSON.stringify(out)}`);
    assert.strictEqual(mid!.reason, 'ast-symbol-overlap');
    assert.strictEqual(mid!.peer, 'Alice');
  });

  test('Tier 0.6: peer pushed a file user has open dirty → file-edit-overlap', () => {
    const out = fusePredictedConflicts({
      dirtyFiles: ['src/foo.ts'],
      behind: 1,
      presenceByFile: new Map(),
      recentPushedFiles: [{ file: 'src/foo.ts', actor: 'Alice' }],
      userReferences: new Map(),
      peerPushedSymbols: [],
    });
    const tier6 = out.find((p): boolean => p.confidence === 0.6);
    assert.ok(tier6, `Expected a 0.6-confidence prediction. Got: ${JSON.stringify(out)}`);
    assert.strictEqual(tier6!.reason, 'file-edit-overlap');
  });

  test("Tier 0.5: user edited symbol S, peer's open file imports S → ast-symbol-overlap", () => {
    const out = fusePredictedConflicts({
      dirtyFiles: ['src/foo.ts'],
      behind: 1,
      presenceByFile: new Map([
        ['src/bar.ts', { memberId: 'm', displayName: 'Bob' }],
      ]),
      recentPushedFiles: [],
      userReferences: new Map([
        ['src/foo.ts', [{ symbol: 'parseToken', file: 'src/bar.ts' }]],
      ]),
      peerPushedSymbols: [],
    });
    const tier5 = out.find((p): boolean => p.confidence === 0.5);
    assert.ok(tier5, `Expected a 0.5-confidence prediction. Got: ${JSON.stringify(out)}`);
    assert.strictEqual(tier5!.reason, 'ast-symbol-overlap');
    assert.strictEqual(tier5!.file, 'src/bar.ts');
  });

  test('Tier 0.2: generic out-of-sync (behind > 0, no other signals) → single low-confidence entry', () => {
    const out = fusePredictedConflicts({
      dirtyFiles: [],
      behind: 3,
      presenceByFile: new Map(),
      recentPushedFiles: [],
      userReferences: new Map(),
      peerPushedSymbols: [],
    });
    assert.strictEqual(out.length, 1, `Expected exactly 1 entry. Got: ${JSON.stringify(out)}`);
    assert.strictEqual(out[0].confidence, 0.2);
  });

  test('In-sync state (behind=0, no signals) returns []', () => {
    const out = fusePredictedConflicts({
      dirtyFiles: [],
      behind: 0,
      presenceByFile: new Map(),
      recentPushedFiles: [],
      userReferences: new Map(),
      peerPushedSymbols: [],
    });
    assert.deepStrictEqual(out, []);
  });

  test('Tier 0.2 SUPPRESSED when higher-confidence signals exist (no noise)', () => {
    // When a 0.9 prediction is present, the 0.2 generic-out-of-sync entry
    // must NOT be added — that's noise. RESEARCH §I.3: "Only add if we have
    // NO other predictions and behind > 0".
    const out = fusePredictedConflicts({
      dirtyFiles: ['src/foo.ts'],
      behind: 5,
      presenceByFile: new Map([
        ['src/foo.ts', { memberId: 'm', displayName: 'Bob' }],
      ]),
      recentPushedFiles: [],
      userReferences: new Map(),
      peerPushedSymbols: [],
    });
    assert.ok(out.some((p): boolean => p.confidence === 0.9));
    assert.ok(
      !out.some((p): boolean => p.confidence === 0.2),
      `0.2 entry must be suppressed when 0.9 is present. Got: ${JSON.stringify(out)}`,
    );
  });

  test('Dedup: multiple signals for the same file+reason+peer collapse to one entry', () => {
    // If a peer is present on a file AND that same file appears in
    // recentPushedFiles by the same peer, the 0.9 and 0.6 entries SHOULD both
    // be emitted (different confidence levels are legitimately distinct
    // signals). Dedup is keyed on file|reason|peer, so a duplicate signal at
    // the SAME tier shouldn't double-add. Exercise the same-tier duplicate.
    const out = fusePredictedConflicts({
      dirtyFiles: ['src/foo.ts', 'src/foo.ts'], // intentional duplicate
      behind: 1,
      presenceByFile: new Map([
        ['src/foo.ts', { memberId: 'm', displayName: 'Bob' }],
      ]),
      recentPushedFiles: [],
      userReferences: new Map(),
      peerPushedSymbols: [],
    });
    const hi = out.filter((p): boolean => p.confidence === 0.9);
    assert.strictEqual(
      hi.length,
      1,
      `Same-tier duplicate should collapse. Got: ${JSON.stringify(out)}`,
    );
  });

  test('memberId fallback: when displayName is undefined, peer field uses memberId', () => {
    const out = fusePredictedConflicts({
      dirtyFiles: ['src/foo.ts'],
      behind: 0,
      presenceByFile: new Map([
        ['src/foo.ts', { memberId: 'bob-uuid' /* no displayName */ }],
      ]),
      recentPushedFiles: [],
      userReferences: new Map(),
      peerPushedSymbols: [],
    });
    const hi = out.find((p): boolean => p.confidence === 0.9);
    assert.ok(hi);
    assert.strictEqual(hi!.peer, 'bob-uuid');
  });

  test('Output entries always carry the {file, reason, confidence, detail} contract fields', () => {
    const out = fusePredictedConflicts({
      dirtyFiles: ['src/foo.ts'],
      behind: 1,
      presenceByFile: new Map([
        ['src/foo.ts', { memberId: 'm', displayName: 'Bob' }],
      ]),
      recentPushedFiles: [],
      userReferences: new Map(),
      peerPushedSymbols: [],
    });
    for (const entry of out) {
      assert.strictEqual(typeof entry.file, 'string');
      assert.ok(['ast-symbol-overlap', 'file-edit-overlap', 'lock-held-by-peer']
        .includes(entry.reason));
      assert.strictEqual(typeof entry.confidence, 'number');
      assert.ok(entry.confidence > 0 && entry.confidence <= 1);
      assert.strictEqual(typeof entry.detail, 'string');
      assert.ok(entry.detail.length > 0, 'detail must be a non-empty human/LLM-readable string');
    }
  });
});

// ---------------------------------------------------------------------------
// E2E — advise_sync over StreamableHTTP against FakeReaders
// ---------------------------------------------------------------------------

suite('Phase 8 — advise_sync E2E against FakeReaders', () => {
  setup(bootSuite);
  teardown(tearSuite);

  test('in-sync workspace (no dirty, no peers) returns empty predicted_conflicts', async () => {
    const r = await client.callTool({ name: 'advise_sync', arguments: {} });
    assert.notStrictEqual(r.isError, true, `unexpected error: ${JSON.stringify(r)}`);
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.ok(Array.isArray(payload.predicted_conflicts));
    // Default fixture: dirty=[], behind=0 (no stale push id mismatch) → empty
    assert.strictEqual(payload.predicted_conflicts.length, 0);
  });

  test('payload shape contains exactly {state, predicted_conflicts} top-level keys (CONTEXT D-6)', async () => {
    const r = await client.callTool({ name: 'advise_sync', arguments: {} });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.deepStrictEqual(
      Object.keys(payload).sort(),
      ['predicted_conflicts', 'state'],
    );
    assert.deepStrictEqual(
      Object.keys(payload.state).sort(),
      ['ahead', 'behind', 'dirty', 'last_sync_at'],
    );
  });

  test('state.dirty reflects syncReader.getOutOfSyncPaths() on the default scope', async () => {
    fr._setDirtyFiles(['src/foo.ts', 'src/bar.ts']);
    const r = await client.callTool({ name: 'advise_sync', arguments: {} });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.deepStrictEqual(payload.state.dirty.sort(), ['src/bar.ts', 'src/foo.ts']);
  });

  test('peer-overlap on dirty file produces a 0.9-confidence prediction', async () => {
    fr._setDirtyFiles(['src/foo.ts']);
    fr._setPresenceForFile('src/foo.ts', 'bob-id', 'Bob');
    const r = await client.callTool({ name: 'advise_sync', arguments: {} });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    const hi = payload.predicted_conflicts.find(
      (p: { confidence: number }): boolean => p.confidence === 0.9,
    );
    assert.ok(
      hi,
      `Expected 0.9 confidence entry. Got: ${JSON.stringify(payload)}`,
    );
    assert.strictEqual(hi.reason, 'file-edit-overlap');
    assert.strictEqual(hi.peer, 'Bob');
  });

  test('target_files=[] returns state-only no predictions (explicit empty scope)', async () => {
    fr._setDirtyFiles(['src/foo.ts']);
    fr._setPresenceForFile('src/foo.ts', 'bob-id', 'Bob');
    const r = await client.callTool({
      name: 'advise_sync',
      arguments: { target_files: [] },
    });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.deepStrictEqual(payload.predicted_conflicts, []);
  });

  test("target_files=['src/foo.ts'] scopes predictions to that path only", async () => {
    fr._setDirtyFiles(['src/foo.ts', 'src/bar.ts']);
    fr._setPresenceForFile('src/foo.ts', 'bob-id', 'Bob');
    // Add a presence overlap on src/bar.ts too — should NOT appear in result.
    fr.presence = [
      ...fr.presence,
      {
        memberId: 'carol-id',
        displayName: 'Carol',
        branch: 'main',
        activeFilePath: 'src/bar.ts',
        lastUpdated: 1779681600000,
      },
    ];
    const r = await client.callTool({
      name: 'advise_sync',
      arguments: { target_files: ['src/foo.ts'] },
    });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    // Every prediction file must be in the scoped set (or be the generic
    // empty-string for 0.2 entries).
    for (const p of payload.predicted_conflicts) {
      if (p.file !== '') {
        assert.strictEqual(
          p.file,
          'src/foo.ts',
          `target_files filter leaked: ${JSON.stringify(p)}`,
        );
      }
    }
  });

  test('state.last_sync_at derives from latest push timestamp (ISO string)', async () => {
    const FIXTURE_TS_ISO = new Date(1779681600000).toISOString();
    const r = await client.callTool({ name: 'advise_sync', arguments: {} });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.strictEqual(payload.state.last_sync_at, FIXTURE_TS_ISO);
  });

  test('state.last_sync_at is null when no pushes recorded', async () => {
    fr.pushes = [];
    fr.latestPushId = null;
    const r = await client.callTool({ name: 'advise_sync', arguments: {} });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.strictEqual(payload.state.last_sync_at, null);
  });
});

// ---------------------------------------------------------------------------
// SC-4 evidence — AI agent identifies out-of-sync workspace + flags conflict
// ---------------------------------------------------------------------------

suite('Phase 8 — SC-4 evidence (AI agent identifies out-of-sync + flags conflict)', () => {
  setup(bootSuite);
  teardown(tearSuite);

  test('SC-4: out-of-sync workspace → state.behind > 0 AND >= 1 predicted_conflicts entry with confidence > 0', async () => {
    // Synthesize the out-of-sync state:
    //   - dirty files exist (user has unsaved work that conflicts with team's view)
    //   - latestPushId no longer matches the head of the activity log (stale)
    //   - peer is present on the same dirty file (drives the high-confidence prediction)
    fr._setDirtyFiles(['src/foo.ts']);
    fr._setLatestPushId('push-stale-old');
    fr._setPresenceForFile('src/foo.ts', 'bob-id', 'Bob');

    const r = await client.callTool({ name: 'advise_sync', arguments: {} });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);

    assert.ok(
      payload.state.behind > 0,
      `SC-4: state.behind > 0. Got: ${JSON.stringify(payload.state)}`,
    );
    assert.ok(
      payload.predicted_conflicts.length > 0,
      `SC-4: at least 1 predicted_conflict expected. Got: ${JSON.stringify(payload.predicted_conflicts)}`,
    );
    const top = payload.predicted_conflicts[0];
    assert.ok(top.confidence > 0, `SC-4: confidence > 0. Got: ${top.confidence}`);
    assert.ok(
      ['ast-symbol-overlap', 'file-edit-overlap', 'lock-held-by-peer'].includes(top.reason),
      `SC-4: reason must be in vocabulary. Got: ${top.reason}`,
    );
  });

  test('SC-4: predicted_conflicts entries carry the {file, reason, confidence, detail} fields per CONTEXT D-6', async () => {
    fr._setDirtyFiles(['src/foo.ts']);
    fr._setPresenceForFile('src/foo.ts', 'bob-id', 'Bob');
    const r = await client.callTool({ name: 'advise_sync', arguments: {} });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    for (const entry of payload.predicted_conflicts) {
      assert.ok('file' in entry);
      assert.ok('reason' in entry);
      assert.ok('confidence' in entry);
      assert.ok('detail' in entry);
      // peer is optional per the type — only required when a peer is involved
    }
  });
});

// ---------------------------------------------------------------------------
// Latency budget — composite call must complete well under 500ms CI bound
// ---------------------------------------------------------------------------

suite('Phase 8 — advise_sync latency budget (<500ms relaxed CI; target <200ms p95)', () => {
  setup(bootSuite);
  teardown(tearSuite);

  test('advise_sync with 3 peers + 5 dirty files completes in <500ms (CI relaxed)', async () => {
    // Stress-shape: 3 peers, 5 dirty files. Per critical rules: "perf test:
    // <200ms p95 production; CI relaxed bound to 500ms".
    fr._setDirtyFiles([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/d.ts',
      'src/e.ts',
    ]);
    fr.presence = [
      {
        memberId: 'p1',
        displayName: 'Bob',
        branch: 'main',
        activeFilePath: 'src/a.ts',
        lastUpdated: 1779681600000,
      },
      {
        memberId: 'p2',
        displayName: 'Carol',
        branch: 'main',
        activeFilePath: 'src/c.ts',
        lastUpdated: 1779681600000,
      },
      {
        memberId: 'p3',
        displayName: 'Dave',
        branch: 'main',
        activeFilePath: 'src/e.ts',
        lastUpdated: 1779681600000,
      },
    ];
    const start = Date.now();
    await client.callTool({ name: 'advise_sync', arguments: {} });
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 500,
      `advise_sync took ${elapsed}ms (budget <500ms; target <200ms p95)`,
    );
  });
});
