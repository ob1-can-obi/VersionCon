// src/test/suite/mcpReadOnlyEnforcementE2E.test.ts
//
// Phase 8 Plan 09 — SC-3 negative-write sweep + runtime gate rejection.
//
// Coverage:
//   (a) tools/list NEVER contains a write-shaped tool name
//       (push_/create_/update_/delete_/set_/send_/commit_/merge_/revert_)
//   (b) tools/list size is EXACTLY 7 (no surprise additions)
//   (c) every registered tool carries readOnlyHint=true + openWorldHint=false
//       (Pitfall 6 — clients like Claude Code and Linear MCP rely on this)
//   (d) READ_ONLY_TOOLS allow-list contains zero write-shaped names
//   (e) registerReadOnlyTool throws synchronously when name not in the Set
//       (registration-time gate from 08-03, re-verified at the E2E boundary)
//   (f) calling a non-registered tool name through tools/call returns
//       isError or rejects (defense-in-depth — the SDK doesn't auto-dispatch
//       arbitrary names)
//
// This file complements mcpReadOnlyGate.test.ts (08-03 — unit-level gate
// tests) by exercising the SAME guarantees through a live SDK client.
import * as assert from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startMcpServer, type McpServerHandle } from '../../mcp/server.js';
import { buildServer } from '../../mcp/buildServer.js';
import { READ_ONLY_TOOLS, registerReadOnlyTool } from '../../mcp/registry.js';
import { FakeReaders } from './fixtures/fakeReaders.js';

const WRITE_SHAPE_REGEX = /^(push|create|update|delete|set|send|commit|merge|revert)_/i;

function makeDeps(fr: FakeReaders): {
  branchReader: FakeReaders;
  syncReader: FakeReaders;
  activityReader: FakeReaders;
  chatReader: FakeReaders;
  depReader: FakeReaders;
  presenceReader: FakeReaders;
} {
  return {
    branchReader: fr,
    syncReader: fr,
    activityReader: fr,
    chatReader: fr,
    depReader: fr,
    presenceReader: fr,
  };
}

// ----------------------------------------------------------------------------
// Live-client negative sweep
// ----------------------------------------------------------------------------
suite('Phase 8 — SC-3 E2E: tools/list never exposes a write tool', () => {
  let handle: McpServerHandle;
  let client: Client;

  setup(async () => {
    const fr = new FakeReaders();
    handle = await startMcpServer({
      buildServer: () => buildServer(makeDeps(fr)),
      log: () => {
        /* swallow */
      },
    });
    client = new Client(
      { name: 'mcpReadOnlyE2E-test', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
  });

  teardown(async () => {
    try {
      await client.close();
    } catch {
      /* noop */
    }
    await handle.close();
  });

  test('SC-3 negative: tools/list contains NO write-shaped names (push_*/create_*/update_*/delete_*/set_*/send_*/commit_*/merge_*/revert_*)', async () => {
    const result = await client.listTools();
    const offenders = result.tools
      .map((t) => t.name)
      .filter((n) => WRITE_SHAPE_REGEX.test(n));
    assert.deepStrictEqual(
      offenders,
      [],
      `SC-3 violation: write-shaped tools in tools/list: ${JSON.stringify(offenders)}`,
    );
  });

  test('SC-3 positive: tools/list size is EXACTLY 7 (no surprise additions)', async () => {
    const result = await client.listTools();
    assert.strictEqual(
      result.tools.length,
      7,
      `Expected 7 tools, got ${result.tools.length}: ${result.tools.map((t) => t.name).join(',')}`,
    );
  });

  test('SC-3: every registered tool has annotations.readOnlyHint=true (Pitfall 6)', async () => {
    const result = await client.listTools();
    for (const t of result.tools) {
      const ann = t.annotations as Record<string, unknown> | undefined;
      assert.strictEqual(
        ann?.readOnlyHint,
        true,
        `Tool '${t.name}' missing annotations.readOnlyHint=true`,
      );
    }
  });

  test('SC-3: every registered tool has annotations.openWorldHint=false', async () => {
    const result = await client.listTools();
    for (const t of result.tools) {
      const ann = t.annotations as Record<string, unknown> | undefined;
      assert.strictEqual(
        ann?.openWorldHint,
        false,
        `Tool '${t.name}' missing annotations.openWorldHint=false`,
      );
    }
  });
});

// ----------------------------------------------------------------------------
// Registry-level + runtime gate
// ----------------------------------------------------------------------------
suite('Phase 8 — SC-3 runtime gate: registerReadOnlyTool rejects unknown names', () => {
  test('READ_ONLY_TOOLS contains zero write-shaped names', () => {
    const offenders = [...READ_ONLY_TOOLS].filter((n) => WRITE_SHAPE_REGEX.test(n));
    assert.deepStrictEqual(
      offenders,
      [],
      `SC-3 violation in READ_ONLY_TOOLS: ${JSON.stringify(offenders)}`,
    );
  });

  test('synthetic write-tool registration throws (registration-time gate)', () => {
    const server = new McpServer(
      { name: 'test', version: '0.0.0' },
      { capabilities: { tools: {} } },
    );
    assert.throws(
      () =>
        registerReadOnlyTool(
          server,
          'push_change_to_main',
          {
            title: 'Bad',
            description: 'should reject',
            inputSchema: {},
          },
          async () => ({ content: [{ type: 'text', text: 'no' }] }),
        ),
      /not in READ_ONLY_TOOLS/,
      'registerReadOnlyTool must throw when name is not in the allow-list',
    );
  });

  test('tools/call against a non-existent name returns isError or rejects (E2E defense-in-depth)', async () => {
    const fr = new FakeReaders();
    const h = await startMcpServer({
      buildServer: () => buildServer(makeDeps(fr)),
      log: () => {
        /* swallow */
      },
    });
    const c = new Client(
      { name: 'mcpReadOnlyE2E-deepDefense', version: '0.0.0' },
      { capabilities: {} },
    );
    await c.connect(new StreamableHTTPClientTransport(new URL(h.url)));
    try {
      // The SDK rejects unknown tool names with a JSON-RPC error response;
      // callTool surfaces this as a thrown Promise rejection. Tolerate
      // EITHER shape (some SDK versions return {isError:true} instead).
      let observedRejection = false;
      let result: unknown = null;
      try {
        result = await c.callTool({
          name: 'push_change_to_main_synthetic',
          arguments: {},
        });
      } catch {
        observedRejection = true;
      }
      const isErrShape =
        result !== null &&
        typeof result === 'object' &&
        (result as { isError?: boolean }).isError === true;
      assert.ok(
        observedRejection || isErrShape,
        `Expected reject OR isError for unknown tool. Got: ${JSON.stringify(result)}`,
      );
    } finally {
      try {
        await c.close();
      } catch {
        /* noop */
      }
      await h.close();
    }
  });

  test('READ_ONLY_TOOLS has exactly 7 entries (regression guard — must match the buildServer registration count)', () => {
    assert.strictEqual(
      READ_ONLY_TOOLS.size,
      7,
      `READ_ONLY_TOOLS size = ${READ_ONLY_TOOLS.size}; expected 7. Names: ${[...READ_ONLY_TOOLS].join(',')}`,
    );
  });
});
