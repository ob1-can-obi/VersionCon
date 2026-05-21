// src/test/suite/mcpActivation.test.ts
//
// Phase 8 Plan 09 — Activation E2E + final consolidated N-08-XX source-grep
// sweep.
//
// Two purposes wrapped into one file:
//
//   1) SC-1 end-to-end (AI-01, AI-02): boot an MCP server using the same
//      shape extension.ts wires (buildServer + FakeReaders), connect an
//      MCP SDK client, assert tools/list returns ALL 7 expected names AND
//      every tool carries the readOnlyHint annotation AND the dependency-
//      graph resource is readable.
//
//   2) Final consolidated phase-level source-grep sweep — every N-08-XX
//      invariant from .planning/phases/08-ai-agent-api-mcp-integration/
//      08-CONTEXT.md is reasserted in a single mocha file so a regression
//      in any future plan surfaces here. Plus N-08-10 (proposed): no
//      server.registerTool call outside src/mcp/registry.ts.
//
// Pattern: PATTERNS.md "mcpReadOnlyGate.test.ts" — same fs.readFileSync +
// offender-list discipline as uriHandlerBootstrapToken.test.ts:24-65.
//
// __dirname at runtime is dist/test/suite/ — three levels up is the repo
// root. process.cwd() works too since `npm test` runs at the repo root.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, type McpServerHandle } from '../../mcp/server.js';
import { buildServer } from '../../mcp/buildServer.js';
import { FakeReaders } from './fixtures/fakeReaders.js';

const REPO_ROOT = process.cwd();
const MCP_DIR = path.join(REPO_ROOT, 'src', 'mcp');
const SERVER_TS = path.join(MCP_DIR, 'server.ts');
const READERS_TS = path.join(MCP_DIR, 'readers.ts');
const REGISTRY_TS = path.join(MCP_DIR, 'registry.ts');

const EXPECTED_TOOLS_SORTED: readonly string[] = [
  'advise_sync',
  'get_branch_status',
  'get_chat_log',
  'get_recent_activity',
  'get_sync_status',
  'list_dependents',
  'query_dependencies',
];

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

// Recursive .ts-only directory reader for the source-grep sweep. Mirrors
// the readAll helper landed in mcpReadOnlyGate.test.ts (Plan 08-03) so the
// two source-grep test files stay consistent.
async function readAllTs(
  dir: string,
): Promise<Array<{ readonly path: string; readonly text: string }>> {
  const out: Array<{ readonly path: string; readonly text: string }> = [];
  async function walk(d: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsAsync.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && full.endsWith('.ts')) {
        out.push({ path: full, text: await fsAsync.readFile(full, 'utf-8') });
      }
    }
  }
  await walk(dir);
  return out;
}

// ----------------------------------------------------------------------------
// SC-1 end-to-end: tools/list + readOnlyHint + dependency-graph resource
// ----------------------------------------------------------------------------
suite('Phase 8 — SC-1 end-to-end (activate writes mcp.json + boots server)', () => {
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
      { name: 'mcpActivation-test', version: '0.0.0' },
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

  test('SC-1: server URL has shape http://127.0.0.1:<port>/mcp (N-08-08 binding)', () => {
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/, `Got: ${handle.url}`);
  });

  test('SC-1: tools/list returns ALL 7 expected tools (AI-01/02/03/04 coverage)', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    assert.deepStrictEqual(
      names,
      [...EXPECTED_TOOLS_SORTED],
      `Phase 8 tools/list mismatch — got ${names.join(',')}`,
    );
  });

  test('SC-1: every tool carries annotations.readOnlyHint=true (Layer 2 stamp)', async () => {
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

  test('SC-1: every tool carries annotations.openWorldHint=false (Pitfall 6)', async () => {
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

  test('SC-1: get_branch_status callable end-to-end and does NOT return isError', async () => {
    const r = await client.callTool({ name: 'get_branch_status', arguments: {} });
    assert.notStrictEqual(r.isError, true, `Got isError=true on get_branch_status: ${JSON.stringify(r)}`);
  });

  test('SC-1: advise_sync callable end-to-end and does NOT return isError (closes SC-4 chain)', async () => {
    const r = await client.callTool({ name: 'advise_sync', arguments: {} });
    assert.notStrictEqual(r.isError, true, `Got isError=true on advise_sync: ${JSON.stringify(r)}`);
  });

  test('SC-1/SC-2: versioncon-state:// dependency-graph resource readable', async () => {
    const r = await client.readResource({
      uri: 'versioncon-state://dependency-graph/parseToken',
    });
    assert.ok(
      Array.isArray(r.contents) && r.contents.length >= 1,
      `Expected contents array length >= 1; got: ${JSON.stringify(r)}`,
    );
  });

  test('SC-1: resources/list contains the dependency-graph resource', async () => {
    const r = await client.listResources();
    const uris = r.resources.map((res) => res.uri);
    const hasDepGraph = uris.some((u) => u.startsWith('versioncon-state://dependency-graph'));
    // Some SDK versions surface resource TEMPLATES rather than concrete URIs
    // — fall back to listResourceTemplates if listResources is empty.
    if (!hasDepGraph) {
      const tmpl = await client.listResourceTemplates();
      const tmplUris = tmpl.resourceTemplates.map((t) => t.uriTemplate);
      const tmplHas = tmplUris.some((u) => u.startsWith('versioncon-state://dependency-graph'));
      assert.ok(
        tmplHas,
        `versioncon-state://dependency-graph missing from resources AND templates. resources=${uris.join(',')} templates=${tmplUris.join(',')}`,
      );
    } else {
      assert.ok(hasDepGraph);
    }
  });
});

// ----------------------------------------------------------------------------
// Final consolidated N-08-XX source-grep sweep
// ----------------------------------------------------------------------------
suite('Phase 8 — final consolidated N-08-XX source-grep sweep', () => {
  test('N-08-01: no src/mcp/ files import from src/auth/ (read-only structural)', async () => {
    const files = await readAllTs(MCP_DIR);
    const offenders: string[] = [];
    for (const f of files) {
      // Strip block + line comments before matching so file-header comments
      // that mention `src/auth/` (e.g. as a forbidden-path note) don't false-
      // positive the gate. The Phase 8 source files DO contain such notes.
      const codeOnly = f.text
        .split('\n')
        .filter((l) => {
          const s = l.trim();
          return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*');
        })
        .join('\n');
      // Match a real import statement that references the auth module path.
      if (/^\s*import[^;]+from\s+['"][^'"]*\/auth\/[^'"]+['"]/m.test(codeOnly)) {
        offenders.push(f.path);
      }
    }
    assert.deepStrictEqual(offenders, [], `N-08-01: ${offenders.join(', ')}`);
  });

  test('N-08-02: READ_ONLY_TOOLS.has appears >= 1 time in src/mcp/', async () => {
    const files = await readAllTs(MCP_DIR);
    let count = 0;
    for (const f of files) {
      for (const line of f.text.split('\n')) {
        if (/READ_ONLY_TOOLS\.has/.test(line)) count++;
      }
    }
    assert.ok(count >= 1, `N-08-02 violation: READ_ONLY_TOOLS.has count = ${count}`);
  });

  test('N-08-03: readers.ts has zero writer-shaped method names (filtered for false positives)', () => {
    const raw = fs.readFileSync(READERS_TS, 'utf-8');
    const codeOnly = raw
      .split('\n')
      .filter((l) => {
        const s = l.trim();
        return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*');
      })
      .join('\n');
    // Match a writer-shaped method DEFINITION (followed by `(`), not a
    // mention in a JSDoc or comment block. Allow `setTimeout` / `setInterval`
    // / `setImmediate` documented exceptions.
    const matches = codeOnly.match(
      /\b(set(?!Timeout|Interval|Immediate)[A-Z]\w*|push[A-Z]\w*|update[A-Z]\w*|delete[A-Z]\w*|commit[A-Z]\w*)\s*\(/g,
    );
    assert.deepStrictEqual(
      matches ?? [],
      [],
      `N-08-03 violation: writer-shaped methods in readers.ts: ${(matches ?? []).join(', ')}`,
    );
  });

  test('N-08-04: zero console.* in src/mcp/ (logger discipline)', async () => {
    const files = await readAllTs(MCP_DIR);
    const offenders: Array<{ path: string; line: string }> = [];
    for (const f of files) {
      for (const line of f.text.split('\n')) {
        if (/^\s*console\./.test(line)) {
          offenders.push({ path: f.path, line: line.trim() });
        }
      }
    }
    assert.deepStrictEqual(offenders, [], `N-08-04 violation: ${JSON.stringify(offenders)}`);
  });

  test('N-08-05: no MCP-prefixed files under src/network/ (Phase 8 did not touch the network module)', () => {
    const networkDir = path.join(REPO_ROOT, 'src', 'network');
    if (!fs.existsSync(networkDir)) {
      return; // src/network/ may not exist on some branches; gate trivially holds.
    }
    const entries = fs.readdirSync(networkDir);
    const offenders = entries.filter((e) => /mcp/i.test(e));
    assert.deepStrictEqual(offenders, [], `N-08-05 violation: MCP-prefixed files in src/network/: ${offenders.join(', ')}`);
  });

  test('N-08-06: no MCP-prefixed files under relay/ (Phase 8 did not touch the relay)', () => {
    const relayDir = path.join(REPO_ROOT, 'relay');
    if (!fs.existsSync(relayDir)) {
      return; // relay/ may not exist on some branches; gate trivially holds.
    }
    const entries = fs.readdirSync(relayDir);
    const offenders = entries.filter((e) => /mcp/i.test(e));
    assert.deepStrictEqual(offenders, [], `N-08-06 violation: MCP-prefixed files in relay/: ${offenders.join(', ')}`);
  });

  test('N-08-08: 127.0.0.1 present + 0.0.0.0 absent in server.ts (localhost-only binding)', () => {
    const text = fs.readFileSync(SERVER_TS, 'utf-8');
    assert.match(text, /127\.0\.0\.1/, 'N-08-08 violation: server.ts missing literal 127.0.0.1');
    assert.doesNotMatch(text, /0\.0\.0\.0/, 'N-08-08 violation: server.ts contains 0.0.0.0 (must never bind all-interfaces)');
  });

  test('N-08-09: enableDnsRebindingProtection:true + allowedHosts in server.ts (CVE-2025-66414)', () => {
    const text = fs.readFileSync(SERVER_TS, 'utf-8');
    assert.match(text, /enableDnsRebindingProtection:\s*true/, 'N-08-09 violation: enableDnsRebindingProtection:true missing');
    assert.match(text, /allowedHosts/, 'N-08-09 violation: allowedHosts missing');
  });

  test('N-08-10 (proposed): no server.registerTool outside src/mcp/registry.ts', async () => {
    const files = await readAllTs(MCP_DIR);
    const offenders: Array<{ path: string; line: string }> = [];
    for (const f of files) {
      if (f.path === REGISTRY_TS) continue;
      for (const line of f.text.split('\n')) {
        const s = line.trim();
        if (s.startsWith('//') || s.startsWith('*')) continue;
        if (/server\.registerTool\b/.test(line)) {
          offenders.push({ path: f.path, line: s });
        }
      }
    }
    assert.deepStrictEqual(offenders, [], `N-08-10 violation: ${JSON.stringify(offenders)}`);
  });

  test('extension.ts wires startMcpLifecycle + stopMcpLifecycle via the barrel (08-09 integration)', () => {
    const extPath = path.join(REPO_ROOT, 'src', 'extension.ts');
    const text = fs.readFileSync(extPath, 'utf-8');
    assert.match(text, /startMcpLifecycle\(/, '08-09: activate must call startMcpLifecycle');
    assert.match(text, /stopMcpLifecycle\(/, '08-09: deactivate must call stopMcpLifecycle');
    assert.match(text, /getMcpOutputChannel/, '08-09: getMcpOutputChannel factory missing');
    assert.match(text, /'VersionCon: MCP'/, "08-09: channel name 'VersionCon: MCP' missing");
    // All 6 adapter classes constructed in extension.ts (real, not via tests):
    for (const cls of [
      'BranchReaderImpl',
      'SyncReaderImpl',
      'ActivityReaderImpl',
      'ChatReaderImpl',
      'DependencyReaderImpl',
      'PresenceReaderImpl',
    ]) {
      assert.match(text, new RegExp(`new ${cls}\\(`), `08-09: missing new ${cls}(...) in extension.ts`);
    }
    // Both mcp.json paths get the dual upsert/remove pair:
    assert.match(text, /\.vscode\/mcp\.json/, "08-09: '.vscode/mcp.json' literal missing");
    assert.match(text, /'\.mcp\.json'|"\.mcp\.json"/, "08-09: '.mcp.json' literal missing");
    // The barrel import is used (single import block):
    assert.match(text, /from\s+['"]\.\/mcp\/index\.js['"]/, '08-09: barrel import from ./mcp/index.js missing');
  });
});
