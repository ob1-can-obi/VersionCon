// src/test/suite/mcpServer.test.ts
// Phase 8 Wave 2 — MCP server bootstrap tests.
//
// Coverage:
//   (a) startMcpServer lifecycle: port > 0, URL shape, close()
//   (b) re-allocation after close (RESEARCH §C.2)
//   (c) E2E: SDK Client handshake + tools/list returns [] (Wave-2 baseline)
//   (d) DNS-rebinding rejection: foreign Host header → 4xx (CVE-2025-66414)
//   (e) Source-grep N-08-08: 127.0.0.1 present, 0.0.0.0 absent
//   (f) Source-grep N-08-09: enableDnsRebindingProtection + allowedHosts present
//   (g) Source-grep N-08-04: no console.* in server.ts
//   (h) buildServer DI composer (Task 2)
//   (i) startMcpLifecycle (Task 2)
//
// __dirname at runtime is dist/test/suite/ — three levels up is the repo root.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, type McpServerHandle } from '../../mcp/server.js';
import { buildServer } from '../../mcp/buildServer.js';
import { FakeReaders } from './fixtures/fakeReaders.js';

// Lazy require of vscode so this file can run under both vscode-test (full
// runner) and bare mocha (server-only tests without vscode dep). The
// lifecycle suite is wrapped in a try/catch that converts a missing vscode
// module into a pending suite.
type VsCodeShape = typeof import('vscode');
let vscode: VsCodeShape | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  vscode = require('vscode') as VsCodeShape;
} catch {
  vscode = null;
}
import { startMcpLifecycle, stopMcpLifecycle } from '../../mcp/lifecycle.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SERVER_TS = path.join(REPO_ROOT, 'src', 'mcp', 'server.ts');
const BUILD_TS = path.join(REPO_ROOT, 'src', 'mcp', 'buildServer.ts');
const LIFECYCLE_TS = path.join(REPO_ROOT, 'src', 'mcp', 'lifecycle.ts');

function makeDeps(fr: FakeReaders) {
  return {
    branchReader: fr,
    syncReader: fr,
    activityReader: fr,
    chatReader: fr,
    depReader: fr,
    presenceReader: fr,
  };
}

suite('Phase 8 — startMcpServer lifecycle', () => {
  let handle: McpServerHandle;
  let logs: string[];

  setup(async () => {
    logs = [];
    const fr = new FakeReaders();
    handle = await startMcpServer({
      buildServer: () => buildServer(makeDeps(fr)),
      log: (l) => logs.push(l),
    });
  });

  teardown(async () => {
    await handle.close();
  });

  test('bound port is a positive integer', () => {
    assert.ok(handle.port > 0 && handle.port < 65536, `port=${handle.port}`);
  });

  test('url has shape http://127.0.0.1:<port>/mcp', () => {
    assert.strictEqual(handle.url, `http://127.0.0.1:${handle.port}/mcp`);
  });

  test('log received "listening on" line', () => {
    assert.ok(
      logs.some((l) => l.includes('listening on')),
      `logs: ${JSON.stringify(logs)}`,
    );
  });
});

suite('Phase 8 — startMcpServer re-allocates on restart (no port leak)', () => {
  test('two consecutive starts both succeed; second port is positive', async () => {
    const fr = new FakeReaders();
    const h1 = await startMcpServer({
      buildServer: () => buildServer(makeDeps(fr)),
      log: () => {},
    });
    const port1 = h1.port;
    assert.ok(port1 > 0);
    await h1.close();
    const h2 = await startMcpServer({
      buildServer: () => buildServer(makeDeps(fr)),
      log: () => {},
    });
    try {
      assert.ok(h2.port > 0);
      // We do NOT assert port1 !== h2.port — kernel may reuse the just-freed
      // port. RESEARCH §C.2 says what matters is that re-binding succeeded.
    } finally {
      await h2.close();
    }
  });
});

suite('Phase 8 — E2E: SDK client handshake + tools/list', () => {
  let handle: McpServerHandle;
  let client: Client;

  setup(async () => {
    const fr = new FakeReaders();
    handle = await startMcpServer({
      buildServer: () => buildServer(makeDeps(fr)),
      log: () => {},
    });
    client = new Client(
      { name: 'test', version: '0.0.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(handle.url));
    await client.connect(transport);
  });

  teardown(async () => {
    try {
      await client.close();
    } catch {
      // noop
    }
    await handle.close();
  });

  test('initialize handshake succeeds (client.connect did not throw)', () => {
    assert.ok(client, 'client constructed');
  });

  test('tools/list reflects Wave-3 surface (4 simple-reader tools registered)', async () => {
    // SDK behavior (mcp.js line 56-67): the ListToolsRequestSchema handler
    // is only installed by registerTool(). Wave 3 (plan 08-06) registered
    // the 4 simple-reader tools through buildServer.ts, so tools/list now
    // returns a populated list. The test asserts the 4 Wave-3 tool names
    // are present — additional names from 08-07 (advise_sync, query_deps,
    // list_dependents) will be appended without breaking this assertion.
    const toolsResult = await client.listTools();
    const names = toolsResult.tools.map((t): string => t.name).sort();
    const expectedWave3 = [
      'get_branch_status',
      'get_chat_log',
      'get_recent_activity',
      'get_sync_status',
    ];
    for (const expected of expectedWave3) {
      assert.ok(
        names.includes(expected),
        `Wave-3 tool '${expected}' missing from tools/list. Got: ${names.join(',')}`,
      );
    }
  });
});

suite('Phase 8 — DNS-rebinding protection (N-08-09 / CVE-2025-66414)', () => {
  let handle: McpServerHandle;

  setup(async () => {
    const fr = new FakeReaders();
    handle = await startMcpServer({
      buildServer: () => buildServer(makeDeps(fr)),
      log: () => {},
    });
  });

  teardown(async () => {
    await handle.close();
  });

  test('POST with foreign Host header is rejected (status 4xx)', async () => {
    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'evil', version: '0.0.0' },
      },
    });
    // Node's fetch (undici) silently overrides the `Host` header on
    // outgoing requests, making it unsuitable for testing the
    // DNS-rebinding gate. Use raw `http.request` which honors the
    // explicit Host header verbatim.
    const status: number = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: handle.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Host': 'evil.example.com',
            'Content-Length': Buffer.byteLength(initBody),
          },
        },
        (res) => {
          // Drain the body so the connection closes cleanly.
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write(initBody);
      req.end();
    });
    // The SDK rejects with a 4xx range status (typically 403 Forbidden via
    // validateRequestHeaders). The test FAILS only if the server returned
    // 2xx (silent acceptance of foreign Host).
    assert.ok(
      status >= 400 && status < 500,
      `DNS-rebinding gate must reject foreign Host header. Got status=${status}`,
    );
  });
});

suite('Phase 8 — N-08-08 source-grep: 127.0.0.1 literal present, 0.0.0.0 absent', () => {
  test('server.ts contains "127.0.0.1" literal', () => {
    const text = fs.readFileSync(SERVER_TS, 'utf-8');
    assert.match(text, /127\.0\.0\.1/, 'N-08-08 violation: 127.0.0.1 not found');
  });
  test('server.ts contains NO "0.0.0.0" literal', () => {
    const text = fs.readFileSync(SERVER_TS, 'utf-8');
    assert.doesNotMatch(text, /0\.0\.0\.0/, 'N-08-08 violation: 0.0.0.0 found');
  });
});

suite('Phase 8 — N-08-09 source-grep: enableDnsRebindingProtection + allowedHosts', () => {
  test('server.ts contains "enableDnsRebindingProtection: true"', () => {
    const text = fs.readFileSync(SERVER_TS, 'utf-8');
    assert.match(
      text,
      /enableDnsRebindingProtection:\s*true/,
      'N-08-09 violation: enableDnsRebindingProtection: true not found',
    );
  });
  test('server.ts contains "allowedHosts"', () => {
    const text = fs.readFileSync(SERVER_TS, 'utf-8');
    assert.match(text, /allowedHosts/, 'N-08-09 violation: allowedHosts not found');
  });
});

suite('Phase 8 — N-08-04 preserved: server.ts/buildServer.ts/lifecycle.ts have no console.*', () => {
  test('server.ts: no console.* lines', () => {
    const text = fs.readFileSync(SERVER_TS, 'utf-8');
    const offenders = text.split('\n').filter((l) => /^\s*console\./.test(l));
    assert.deepStrictEqual(
      offenders,
      [],
      `console.* in server.ts: ${JSON.stringify(offenders)}`,
    );
  });
  test('buildServer.ts: no console.* lines', () => {
    const text = fs.readFileSync(BUILD_TS, 'utf-8');
    const offenders = text.split('\n').filter((l) => /^\s*console\./.test(l));
    assert.deepStrictEqual(offenders, [], `console.* in buildServer.ts: ${JSON.stringify(offenders)}`);
  });
  test('lifecycle.ts: no console.* lines', () => {
    const text = fs.readFileSync(LIFECYCLE_TS, 'utf-8');
    const offenders = text.split('\n').filter((l) => /^\s*console\./.test(l));
    assert.deepStrictEqual(offenders, [], `console.* in lifecycle.ts: ${JSON.stringify(offenders)}`);
  });
});

suite('Phase 8 — buildServer DI composer', () => {
  test('returns an McpServer-like object', () => {
    const fr = new FakeReaders();
    const s = buildServer(makeDeps(fr));
    assert.ok(s, 'buildServer returned a value');
  });

  test('invokes registerTools callback exactly once when provided', () => {
    const fr = new FakeReaders();
    let calls = 0;
    buildServer({
      ...makeDeps(fr),
      registerTools: () => {
        calls++;
      },
    });
    assert.strictEqual(calls, 1, 'registerTools should be invoked exactly once');
  });

  test('passes the McpServer instance + deps to the registerTools callback', () => {
    const fr = new FakeReaders();
    let captured: { server: unknown; deps: unknown } | null = null;
    buildServer({
      ...makeDeps(fr),
      registerTools: (server, deps) => {
        captured = { server, deps };
      },
    });
    assert.ok(captured !== null);
    // Use intermediate variable to keep type narrowing happy.
    const c = captured as unknown as { server: unknown; deps: unknown };
    assert.ok(c.server, 'server passed to callback');
    assert.ok(c.deps, 'deps passed to callback');
  });
});

// Lifecycle suite — requires the `vscode` module. When running under bare
// mocha (no extension host) the suite is replaced with a single pending test.
(vscode ? suite : suite.skip)('Phase 8 — startMcpLifecycle reads versioncon.mcp.enabled', () => {
  test('returns null when versioncon.mcp.enabled=false', async () => {
    const v = vscode!;
    const cfg = v.workspace.getConfiguration('versioncon.mcp');
    const prior = cfg.get<boolean>('enabled');
    await cfg.update('enabled', false, v.ConfigurationTarget.Global);
    try {
      const logs: string[] = [];
      const fr = new FakeReaders();
      const handle = await startMcpLifecycle({
        context: { subscriptions: [] } as unknown as import('vscode').ExtensionContext,
        log: (l) => logs.push(l),
        deps: makeDeps(fr),
      });
      assert.strictEqual(handle, null);
      assert.ok(
        logs.some((l) => l.includes('disabled')),
        `logs: ${JSON.stringify(logs)}`,
      );
    } finally {
      await cfg.update('enabled', prior, v.ConfigurationTarget.Global);
    }
  });

  test('starts server when enabled=true and no ensureConsent (Wave-2 path)', async () => {
    const v = vscode!;
    const cfg = v.workspace.getConfiguration('versioncon.mcp');
    const prior = cfg.get<boolean>('enabled');
    await cfg.update('enabled', true, v.ConfigurationTarget.Global);
    const logs: string[] = [];
    const fr = new FakeReaders();
    const handle = await startMcpLifecycle({
      context: { subscriptions: [] } as unknown as import('vscode').ExtensionContext,
      log: (l) => logs.push(l),
      deps: makeDeps(fr),
    });
    try {
      assert.ok(handle, 'lifecycle returned a handle');
      assert.ok(handle!.port > 0);
      assert.ok(
        logs.some((l) => l.includes('started on')),
        `logs: ${JSON.stringify(logs)}`,
      );
    } finally {
      if (handle) await stopMcpLifecycle(handle, { log: () => {} });
      await cfg.update('enabled', prior, v.ConfigurationTarget.Global);
    }
  });

  test('returns null when ensureConsent returns false', async () => {
    const v = vscode!;
    const cfg = v.workspace.getConfiguration('versioncon.mcp');
    const prior = cfg.get<boolean>('enabled');
    await cfg.update('enabled', true, v.ConfigurationTarget.Global);
    try {
      const logs: string[] = [];
      const fr = new FakeReaders();
      const handle = await startMcpLifecycle({
        context: { subscriptions: [] } as unknown as import('vscode').ExtensionContext,
        log: (l) => logs.push(l),
        deps: makeDeps(fr),
        ensureConsent: async () => false,
      });
      assert.strictEqual(handle, null);
      assert.ok(
        logs.some((l) => l.includes('consent declined')),
        `logs: ${JSON.stringify(logs)}`,
      );
    } finally {
      await cfg.update('enabled', prior, v.ConfigurationTarget.Global);
    }
  });

  test('calls upsertMcpConfig with the bound port after start', async () => {
    const v = vscode!;
    const cfg = v.workspace.getConfiguration('versioncon.mcp');
    const prior = cfg.get<boolean>('enabled');
    await cfg.update('enabled', true, v.ConfigurationTarget.Global);
    let capturedPort: number | null = null;
    const fr = new FakeReaders();
    const handle = await startMcpLifecycle({
      context: { subscriptions: [] } as unknown as import('vscode').ExtensionContext,
      log: () => {},
      deps: makeDeps(fr),
      upsertMcpConfig: async (p) => {
        capturedPort = p;
      },
    });
    try {
      assert.ok(handle);
      assert.strictEqual(capturedPort, handle!.port);
    } finally {
      if (handle) await stopMcpLifecycle(handle, { log: () => {} });
      await cfg.update('enabled', prior, v.ConfigurationTarget.Global);
    }
  });

  test('stopMcpLifecycle calls removeMcpConfig before closing handle', async () => {
    const v = vscode!;
    const cfg = v.workspace.getConfiguration('versioncon.mcp');
    const prior = cfg.get<boolean>('enabled');
    await cfg.update('enabled', true, v.ConfigurationTarget.Global);
    const fr = new FakeReaders();
    const handle = await startMcpLifecycle({
      context: { subscriptions: [] } as unknown as import('vscode').ExtensionContext,
      log: () => {},
      deps: makeDeps(fr),
    });
    try {
      assert.ok(handle);
      let removeCalled = false;
      await stopMcpLifecycle(handle!, {
        removeMcpConfig: async () => {
          removeCalled = true;
        },
        log: () => {},
      });
      assert.strictEqual(removeCalled, true, 'removeMcpConfig should be invoked');
    } finally {
      await cfg.update('enabled', prior, v.ConfigurationTarget.Global);
    }
  });
});
