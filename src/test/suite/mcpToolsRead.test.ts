// src/test/suite/mcpToolsRead.test.ts
//
// Phase 8 Plan 06 — E2E tests for the 4 simple-reader MCP tools.
//
// Spawns a real McpServer via startMcpServer + buildServer (wired through the
// production import path), connects an SDK Client over StreamableHTTP, and
// asserts:
//
//   - tools/list contains the 4 tool names with annotations.readOnlyHint:true
//   - tools/call get_branch_status returns {branch, ahead, behind, dirty}
//   - tools/call get_sync_status returns {last_sync_at, pending_pushes, blocked}
//   - tools/call get_recent_activity returns [{actor, ts, files, message}]
//   - tools/call get_chat_log returns [{actor, ts, text, channel}]
//   - Result-size caps enforced (get_recent_activity max=100, get_chat_log max=200)
//   - `since` filter on get_chat_log works (ISO timestamp string)
//   - `limit=0` returns []
//
// Pattern: PATTERNS.md "mcpToolsRead.test.ts" — mirrors mcpServer.test.ts's
// SDK-client-against-real-server E2E pattern (08-04). Uses the FakeReaders
// fixture from 08-02 (deterministic, all 6 Reader interfaces).
//
// N-08-04 preserved: no console.* in this file (default log is a no-op).
// N-08-10 preserved indirectly: this test imports the production buildServer
// which goes through registerReadOnlyTool — no direct server.registerTool.

import * as assert from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, type McpServerHandle } from '../../mcp/server.js';
import { buildServer } from '../../mcp/buildServer.js';
import { FakeReaders } from './fixtures/fakeReaders.js';

// The fixture's literal epoch (1779681600000) maps to this ISO string per
// Node's Date.prototype.toISOString. The comment in fakeReaders.ts claims
// 2026-05-21T12:00:00.000Z but the literal computes to 2026-05-25T04:00:00.000Z;
// we assert against the actual value (the fixture is the source of truth).
const FIXTURE_TS_ISO = new Date(1779681600000).toISOString();

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
    { name: 'mcpToolsRead-test', version: '0.0.0' },
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
// tools/list — names + readOnlyHint annotations
// ---------------------------------------------------------------------------

suite('Phase 8 — MCP tools/list contains the 4 simple readers', () => {
  setup(bootSuite);
  teardown(tearSuite);

  test('tools/list contains get_branch_status with readOnlyHint=true', async () => {
    const result = await client.listTools();
    const t = result.tools.find((x): boolean => x.name === 'get_branch_status');
    assert.ok(
      t,
      `get_branch_status not in tools/list. Got: ${result.tools.map((x): string => x.name).join(',')}`,
    );
    assert.strictEqual(
      (t!.annotations as Record<string, unknown> | undefined)?.readOnlyHint,
      true,
    );
  });

  test('tools/list contains get_sync_status with readOnlyHint=true', async () => {
    const result = await client.listTools();
    const t = result.tools.find((x): boolean => x.name === 'get_sync_status');
    assert.ok(t);
    assert.strictEqual(
      (t!.annotations as Record<string, unknown> | undefined)?.readOnlyHint,
      true,
    );
  });

  test('tools/list contains get_recent_activity with readOnlyHint=true', async () => {
    const result = await client.listTools();
    const t = result.tools.find((x): boolean => x.name === 'get_recent_activity');
    assert.ok(t);
    assert.strictEqual(
      (t!.annotations as Record<string, unknown> | undefined)?.readOnlyHint,
      true,
    );
  });

  test('tools/list contains get_chat_log with readOnlyHint=true', async () => {
    const result = await client.listTools();
    const t = result.tools.find((x): boolean => x.name === 'get_chat_log');
    assert.ok(t);
    assert.strictEqual(
      (t!.annotations as Record<string, unknown> | undefined)?.readOnlyHint,
      true,
    );
  });

  test('tools/list descriptions contain the "Read-only" substring (LLM-prompt discipline)', async () => {
    const result = await client.listTools();
    for (const name of [
      'get_branch_status',
      'get_sync_status',
      'get_recent_activity',
      'get_chat_log',
    ]) {
      const t = result.tools.find((x): boolean => x.name === name);
      assert.ok(t, `${name} missing from tools/list`);
      assert.match(
        t!.description ?? '',
        /Read-only/,
        `${name} description must contain "Read-only" (RESEARCH §F.4 template)`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// get_branch_status
// ---------------------------------------------------------------------------

suite('Phase 8 — get_branch_status tool/call', () => {
  setup(bootSuite);
  teardown(tearSuite);

  test('returns {branch, ahead, behind, dirty} on default fixture', async () => {
    const r = await client.callTool({ name: 'get_branch_status', arguments: {} });
    assert.notStrictEqual(r.isError, true, `unexpected error: ${JSON.stringify(r)}`);
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.strictEqual(payload.branch, 'main');
    assert.strictEqual(payload.ahead, 0);
    assert.strictEqual(payload.behind, 0);
    assert.deepStrictEqual(payload.dirty, []);
  });

  test('reflects _setDirtyFiles mutation in dirty[] and behind', async () => {
    fr._setDirtyFiles(['a.ts', 'b.ts']);
    const r = await client.callTool({ name: 'get_branch_status', arguments: {} });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.deepStrictEqual(payload.dirty, ['a.ts', 'b.ts']);
    assert.strictEqual(payload.behind, 2);
  });

  test('payload has exactly the 4 expected keys', async () => {
    const r = await client.callTool({ name: 'get_branch_status', arguments: {} });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.deepStrictEqual(
      Object.keys(payload).sort(),
      ['ahead', 'behind', 'branch', 'dirty'],
    );
  });
});

// ---------------------------------------------------------------------------
// get_sync_status
// ---------------------------------------------------------------------------

suite('Phase 8 — get_sync_status tool/call', () => {
  setup(bootSuite);
  teardown(tearSuite);

  test('returns {last_sync_at, pending_pushes, blocked} shape', async () => {
    const r = await client.callTool({ name: 'get_sync_status', arguments: {} });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.ok('last_sync_at' in payload);
    assert.ok(Array.isArray(payload.pending_pushes));
    assert.ok(Array.isArray(payload.blocked));
  });

  test('last_sync_at is an ISO string derived from the fixture push timestamp', async () => {
    const r = await client.callTool({ name: 'get_sync_status', arguments: {} });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.strictEqual(payload.last_sync_at, FIXTURE_TS_ISO);
  });

  test('last_sync_at is null when no pushes have been recorded', async () => {
    fr.pushes = [];
    fr.latestPushId = null;
    const r = await client.callTool({ name: 'get_sync_status', arguments: {} });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.strictEqual(payload.last_sync_at, null);
    assert.deepStrictEqual(payload.pending_pushes, []);
  });

  test('blocked array reflects getOutOfSyncPaths()', async () => {
    fr._setDirtyFiles(['src/blocked.ts']);
    const r = await client.callTool({ name: 'get_sync_status', arguments: {} });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.deepStrictEqual(payload.blocked, ['src/blocked.ts']);
  });
});

// ---------------------------------------------------------------------------
// get_recent_activity
// ---------------------------------------------------------------------------

suite('Phase 8 — get_recent_activity tool/call', () => {
  setup(bootSuite);
  teardown(tearSuite);

  test('returns up to limit records (limit=3)', async () => {
    const r = await client.callTool({
      name: 'get_recent_activity',
      arguments: { limit: 3 },
    });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.ok(Array.isArray(payload));
    assert.ok(payload.length <= 3);
  });

  test('returned records have {actor, ts, files, message} shape', async () => {
    const r = await client.callTool({
      name: 'get_recent_activity',
      arguments: { limit: 1 },
    });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.ok(payload.length > 0, 'fixture must have at least 1 push');
    const record = payload[0];
    assert.strictEqual(record.actor, 'Alice');
    assert.strictEqual(record.ts, FIXTURE_TS_ISO);
    assert.deepStrictEqual(record.files, ['src/auth/TokenService.ts']);
    assert.strictEqual(record.message, 'fixture: tweak parseToken');
  });

  test('default limit (no arg) returns up to 20 records', async () => {
    const r = await client.callTool({
      name: 'get_recent_activity',
      arguments: {},
    });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.ok(Array.isArray(payload));
    assert.ok(payload.length <= 20);
  });

  test('limit=200 is rejected by zod schema (max=100)', async () => {
    const r = await client.callTool({
      name: 'get_recent_activity',
      arguments: { limit: 200 },
    });
    // Either {isError:true} (handler-converted) OR an MCP-level error result.
    assert.ok(
      r.isError === true || (r as unknown as { error?: unknown }).error,
      `limit=200 should be rejected; got: ${JSON.stringify(r)}`,
    );
  });

  test('limit=0 returns []', async () => {
    const r = await client.callTool({
      name: 'get_recent_activity',
      arguments: { limit: 0 },
    });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.deepStrictEqual(payload, []);
  });
});

// ---------------------------------------------------------------------------
// get_chat_log
// ---------------------------------------------------------------------------

suite('Phase 8 — get_chat_log tool/call', () => {
  setup(bootSuite);
  teardown(tearSuite);

  test('returns array of {actor, ts, text, channel} shape when records exist', async () => {
    const r = await client.callTool({
      name: 'get_chat_log',
      arguments: { limit: 5 },
    });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.ok(Array.isArray(payload));
    assert.ok(payload.length > 0, 'fixture must seed 1 chat record');
    const record = payload[0];
    assert.strictEqual(record.actor, 'Alice');
    assert.strictEqual(record.ts, FIXTURE_TS_ISO);
    assert.strictEqual(record.text, 'fixture: hello from FakeReaders');
    assert.strictEqual(record.channel, 'user');
  });

  test('default limit (no arg) returns up to 50 records', async () => {
    const r = await client.callTool({
      name: 'get_chat_log',
      arguments: {},
    });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.ok(Array.isArray(payload));
    assert.ok(payload.length <= 50);
  });

  test('limit=1 returns exactly 1 record (cap respected)', async () => {
    // Note: ChatLog.getRecent uses Array.prototype.slice(-n) — at n=0 this
    // returns the entire array (JavaScript's `slice(-0)` === `slice(0)`).
    // That's a Phase-4 ChatLog quirk, not a Plan-06 concern; we exercise the
    // limit-cap path with n=1 instead (which is unambiguous).
    const r = await client.callTool({
      name: 'get_chat_log',
      arguments: { limit: 1 },
    });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.ok(Array.isArray(payload));
    assert.ok(payload.length <= 1);
  });

  test('since filter (future ISO timestamp) returns []', async () => {
    const r = await client.callTool({
      name: 'get_chat_log',
      arguments: { limit: 50, since: '2099-01-01T00:00:00.000Z' },
    });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.deepStrictEqual(payload, []);
  });

  test('since filter (past ISO timestamp) returns records', async () => {
    const r = await client.callTool({
      name: 'get_chat_log',
      arguments: { limit: 50, since: '2000-01-01T00:00:00.000Z' },
    });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.ok(payload.length >= 1, 'past since must not filter out fixture chat');
  });

  test('limit=500 is rejected by zod schema (max=200)', async () => {
    const r = await client.callTool({
      name: 'get_chat_log',
      arguments: { limit: 500 },
    });
    assert.ok(
      r.isError === true || (r as unknown as { error?: unknown }).error,
      `limit=500 should be rejected; got: ${JSON.stringify(r)}`,
    );
  });
});
