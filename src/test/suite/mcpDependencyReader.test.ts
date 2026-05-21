// src/test/suite/mcpDependencyReader.test.ts
//
// Phase 8 Plan 07 — E2E tests for the dependency-graph MCP surface:
//   - tool: query_dependencies (forward walk via DependencyReader.forwardDeps)
//   - tool: list_dependents     (reverse walk via DependencyReader.reverseDeps)
//   - resource: versioncon-state://dependency-graph/{symbolOrPath} (browseable
//     view combining forward + reverse for a single target)
//
// Pattern: PATTERNS.md "mcpDependencyReader.test.ts" — mirrors mcpToolsRead.test.ts's
// SDK-client-against-real-server E2E pattern (08-06). Uses the FakeReaders
// fixture from 08-02 (deterministic, all 6 Reader interfaces).
//
// Three security-load-bearing assertions baked in:
//   1. URI scheme is versioncon-state:// (NOT versioncon:// which is owned by
//      Phase 7's deep-link UriHandler). Source-grep verifies the absent scheme.
//   2. T-08-10 (path traversal): the resource handler decodes the URI capture
//      but uses it ONLY as an in-memory key — no fs.read. The test issues a
//      URI with `../../etc/passwd` and asserts empty arrays + the source-grep
//      gate `grep -cE 'fs\.read|fs\.readFile' src/mcp/resources/dependencyGraph.ts == 0`.
//   3. Latency budget — query_dependencies on the fixture completes in <500ms
//      (CI variance bound; production target <100ms p95 per CONTEXT D-2).
//
// N-08-04 preserved: no console.* in this file (default log is a no-op).
// N-08-10 preserved indirectly: test imports the production buildServer which
// goes through registerReadOnlyTool — no direct server.registerTool from tools.

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, type McpServerHandle } from '../../mcp/server.js';
import { buildServer } from '../../mcp/buildServer.js';
import { FakeReaders } from './fixtures/fakeReaders.js';

// `dist/test/suite/file.js` runtime path -> 3 levels up to repo root
// (matches mcpReaders.test.ts REPO_ROOT discipline from 08-02-SUMMARY).
const REPO_ROOT = path.resolve(__dirname, '../../..');
const RESOURCE_TS = path.join(
  REPO_ROOT,
  'src/mcp/resources/dependencyGraph.ts',
);

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
    { name: 'mcpDependencyReader-test', version: '0.0.0' },
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
// query_dependencies tool — forward direction
// ---------------------------------------------------------------------------

suite('Phase 8 — query_dependencies tool', () => {
  setup(bootSuite);
  teardown(tearSuite);

  test('tools/list contains query_dependencies with readOnlyHint=true', async () => {
    const result = await client.listTools();
    const t = result.tools.find((x): boolean => x.name === 'query_dependencies');
    assert.ok(
      t,
      `query_dependencies not in tools/list. Got: ${result.tools.map((x): string => x.name).join(',')}`,
    );
    assert.strictEqual(
      (t!.annotations as Record<string, unknown> | undefined)?.readOnlyHint,
      true,
    );
  });

  test('description contains "Read-only" substring (RESEARCH §F.4 discipline)', async () => {
    const result = await client.listTools();
    const t = result.tools.find((x): boolean => x.name === 'query_dependencies');
    assert.ok(t);
    assert.match(t!.description ?? '', /Read-only/);
  });

  test('happy path: parseToken → {symbols:["verifyClient"], files:["src/host/AuthHandler.ts"]}', async () => {
    const r = await client.callTool({
      name: 'query_dependencies',
      arguments: { target: 'parseToken' },
    });
    assert.notStrictEqual(
      r.isError,
      true,
      `unexpected error: ${JSON.stringify(r)}`,
    );
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.deepStrictEqual(payload.depends_on.symbols, ['verifyClient']);
    assert.deepStrictEqual(payload.depends_on.files, ['src/host/AuthHandler.ts']);
    assert.strictEqual(payload.hops, 1);
  });

  test('unknown target returns empty arrays (no throw — DependencyReader contract)', async () => {
    const r = await client.callTool({
      name: 'query_dependencies',
      arguments: { target: 'unknown-symbol-xyz' },
    });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.deepStrictEqual(payload.depends_on.symbols, []);
    assert.deepStrictEqual(payload.depends_on.files, []);
    assert.strictEqual(payload.hops, 1);
  });

  test('hops:2 is accepted by zod and echoed in payload', async () => {
    const r = await client.callTool({
      name: 'query_dependencies',
      arguments: { target: 'parseToken', hops: 2 },
    });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.strictEqual(payload.hops, 2);
  });

  test('empty target rejected by zod (.min(1))', async () => {
    const r = await client.callTool({
      name: 'query_dependencies',
      arguments: { target: '' },
    });
    assert.ok(
      r.isError === true || (r as unknown as { error?: unknown }).error,
      `empty target should be rejected. Got: ${JSON.stringify(r)}`,
    );
  });

  test('hops:3 is rejected by zod (union of literal 1/2)', async () => {
    const r = await client.callTool({
      name: 'query_dependencies',
      arguments: { target: 'parseToken', hops: 3 },
    });
    assert.ok(
      r.isError === true || (r as unknown as { error?: unknown }).error,
      `hops=3 should be rejected. Got: ${JSON.stringify(r)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// list_dependents tool — reverse direction
// ---------------------------------------------------------------------------

suite('Phase 8 — list_dependents tool', () => {
  setup(bootSuite);
  teardown(tearSuite);

  test('tools/list contains list_dependents with readOnlyHint=true', async () => {
    const result = await client.listTools();
    const t = result.tools.find((x): boolean => x.name === 'list_dependents');
    assert.ok(t);
    assert.strictEqual(
      (t!.annotations as Record<string, unknown> | undefined)?.readOnlyHint,
      true,
    );
  });

  test('happy path: verifyClient → {symbols:["parseToken"], files:["src/auth/TokenService.ts"]}', async () => {
    const r = await client.callTool({
      name: 'list_dependents',
      arguments: { target: 'verifyClient' },
    });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.deepStrictEqual(payload.dependents.symbols, ['parseToken']);
    assert.deepStrictEqual(payload.dependents.files, ['src/auth/TokenService.ts']);
    assert.strictEqual(payload.hops, 1);
  });

  test('unknown target returns empty arrays', async () => {
    const r = await client.callTool({
      name: 'list_dependents',
      arguments: { target: 'unknown-sym' },
    });
    const content = r.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.deepStrictEqual(payload.dependents.symbols, []);
    assert.deepStrictEqual(payload.dependents.files, []);
  });

  test('description notes the v1 reverseDeps bounding (RESEARCH §I)', async () => {
    // The production DependencyReaderImpl.reverseDeps always returns empty in
    // v1 because the standing reverse index ships in 8.1. The tool description
    // documents this so AI agents don't interpret an empty result as
    // "definitively no callers". FakeReaders has canned data for tests; the
    // production wiring is documented in the description.
    const result = await client.listTools();
    const t = result.tools.find((x): boolean => x.name === 'list_dependents');
    assert.ok(t);
    assert.match(
      t!.description ?? '',
      /v1|reverse|standing index|bounded/i,
      'list_dependents description must document v1 reverse-walk bounding',
    );
  });
});

// ---------------------------------------------------------------------------
// dependency-graph resource (versioncon-state://)
// ---------------------------------------------------------------------------

suite('Phase 8 — dependency-graph resource (versioncon-state://)', () => {
  setup(bootSuite);
  teardown(tearSuite);

  test('resources/read for parseToken returns mimeType application/json + forward+reverse JSON body', async () => {
    const r = await client.readResource({
      uri: 'versioncon-state://dependency-graph/parseToken',
    });
    assert.ok(Array.isArray(r.contents));
    assert.strictEqual(r.contents[0].mimeType, 'application/json');
    const text = (r.contents[0] as unknown as { text: string }).text;
    const payload = JSON.parse(text);
    assert.strictEqual(payload.target, 'parseToken');
    assert.deepStrictEqual(payload.forward.symbols, ['verifyClient']);
    assert.deepStrictEqual(payload.forward.files, ['src/host/AuthHandler.ts']);
    // FakeReaders.depReverse.parseToken = { symbols: [], files: ['src/host/AuthHandler.ts'] }
    assert.deepStrictEqual(payload.reverse.symbols, []);
    assert.deepStrictEqual(payload.reverse.files, ['src/host/AuthHandler.ts']);
  });

  test('resources/read uses uri.href as the contents[0].uri (echoed back)', async () => {
    const r = await client.readResource({
      uri: 'versioncon-state://dependency-graph/parseToken',
    });
    assert.match(
      r.contents[0].uri,
      /^versioncon-state:\/\/dependency-graph\//,
      'resource handler must echo the versioncon-state:// URI',
    );
  });

  test('T-08-10: traversal-looking URI returns empty arrays (no fs.read)', async () => {
    // Percent-encode the path-traversal pattern. ResourceTemplate parser will
    // decode the {symbolOrPath} capture; the handler's decodeURIComponent
    // restores the original string and uses it ONLY as a key lookup against
    // FakeReaders.depForward/depReverse (which have no entry for it). Result:
    // both arrays empty. CRITICAL: no fs read happens against the captured
    // string — verified by source-grep gate below.
    const r = await client.readResource({
      uri:
        'versioncon-state://dependency-graph/' +
        encodeURIComponent('../../etc/passwd'),
    });
    const text = (r.contents[0] as unknown as { text: string }).text;
    const payload = JSON.parse(text);
    assert.strictEqual(payload.target, '../../etc/passwd');
    assert.deepStrictEqual(payload.forward, { symbols: [], files: [] });
    assert.deepStrictEqual(payload.reverse, { symbols: [], files: [] });
  });

  test('T-08-10 source-grep: dependencyGraph.ts has NO fs.read* calls', () => {
    const text = fs.readFileSync(RESOURCE_TS, 'utf-8');
    assert.doesNotMatch(
      text,
      /\bfs\.read\w*/,
      'T-08-10: resource handler must not read from filesystem',
    );
  });

  test('URI scheme uses versioncon-state:// not versioncon:// (CONTEXT D-2 / open-q 7)', () => {
    const text = fs.readFileSync(RESOURCE_TS, 'utf-8');
    assert.match(
      text,
      /versioncon-state:\/\/dependency-graph/,
      'must use versioncon-state:// scheme',
    );
    // Verify the bare versioncon:// scheme (Phase 7 UriHandler scheme) is NOT
    // present as a literal template URI. A simple `versioncon://` substring
    // would match `versioncon-state://`, so we use a negative-lookbehind-ish
    // pattern: require a NON-hyphen character (or start-of-line) directly
    // before `versioncon://` on each line.
    const lines = text.split('\n');
    for (const line of lines) {
      assert.ok(
        !/(^|[^-])versioncon:\/\/dependency-graph/.test(line),
        `Phase-7 versioncon:// scheme appeared in dependencyGraph.ts: "${line.trim()}"`,
      );
    }
  });

  test('resource handler uses decodeURIComponent on the captured value', () => {
    const text = fs.readFileSync(RESOURCE_TS, 'utf-8');
    assert.match(
      text,
      /decodeURIComponent/,
      'resource handler must decodeURIComponent the symbolOrPath capture',
    );
  });
});

// ---------------------------------------------------------------------------
// Latency budget (CONTEXT D-2: <100ms p95 on real workloads;
// <500ms relaxed bound for CI variance on FakeReaders)
// ---------------------------------------------------------------------------

suite('Phase 8 — latency budget (<500ms relaxed CI; target <100ms p95)', () => {
  setup(bootSuite);
  teardown(tearSuite);

  test('query_dependencies on parseToken completes in <500ms on fixture', async () => {
    const start = Date.now();
    await client.callTool({
      name: 'query_dependencies',
      arguments: { target: 'parseToken' },
    });
    const elapsed = Date.now() - start;
    // CONTEXT D-2 targets <100ms p95 on real DependencyReaderImpl; on
    // FakeReaders it should be <10ms but CI variance can spike. Assert
    // <500ms — anything higher signals a serious problem.
    assert.ok(
      elapsed < 500,
      `query_dependencies took ${elapsed}ms (budget <500ms; target <100ms)`,
    );
  });

  test('resources/read on parseToken completes in <500ms on fixture', async () => {
    const start = Date.now();
    await client.readResource({
      uri: 'versioncon-state://dependency-graph/parseToken',
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `resources/read took ${elapsed}ms`);
  });

  test('p95 of 5 query_dependencies trials is <500ms (variance dampening)', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      await client.callTool({
        name: 'query_dependencies',
        arguments: { target: 'parseToken' },
      });
      samples.push(Date.now() - start);
    }
    samples.sort((a, b): number => a - b);
    // p95 of 5 samples = the max (index 4). Looser bound documented above.
    const p95 = samples[4];
    assert.ok(
      p95 < 500,
      `p95 of 5 query_dependencies trials = ${p95}ms (budget <500ms); samples: ${samples.join(',')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// SC-2 evidence: combined surface delivers the full dep-graph view
// ---------------------------------------------------------------------------

suite('Phase 8 — SC-2 evidence (AI agent reads full dep graph)', () => {
  setup(bootSuite);
  teardown(tearSuite);

  test('SC-2: forward + reverse + resource all return data for parseToken (T-08-10 fixture path)', async () => {
    const [fwd, rev, res] = await Promise.all([
      client.callTool({
        name: 'query_dependencies',
        arguments: { target: 'parseToken' },
      }),
      client.callTool({
        name: 'list_dependents',
        arguments: { target: 'parseToken' },
      }),
      client.readResource({
        uri: 'versioncon-state://dependency-graph/parseToken',
      }),
    ]);
    const fwdContent = fwd.content as Array<{ type: string; text: string }>;
    const revContent = rev.content as Array<{ type: string; text: string }>;
    const fwdP = JSON.parse(fwdContent[0].text);
    const revP = JSON.parse(revContent[0].text);
    const resText = (res.contents[0] as unknown as { text: string }).text;
    const resP = JSON.parse(resText);

    // Forward direction has data on parseToken
    assert.ok(
      fwdP.depends_on.symbols.length > 0 || fwdP.depends_on.files.length > 0,
      'SC-2: query_dependencies should return non-empty data on fixture',
    );
    // Reverse direction has data on parseToken (FakeReaders has reverseDeps.parseToken)
    assert.ok(
      revP.dependents.files.length > 0,
      `SC-2: list_dependents on parseToken should return non-empty files; got ${JSON.stringify(revP)}`,
    );
    // Resource exposes both directions in one read
    assert.ok(
      resP.forward.symbols.length > 0 || resP.forward.files.length > 0,
      'SC-2: resource read should expose forward deps',
    );
    assert.strictEqual(resP.target, 'parseToken');
  });

  test('SC-2: an AI agent can correlate the three surfaces by target name', async () => {
    // The three surfaces are addressable by the same `target` string. Verify
    // they all agree on the symbol identity (no normalization drift).
    const target = 'parseToken';
    const fwd = await client.callTool({
      name: 'query_dependencies',
      arguments: { target },
    });
    const res = await client.readResource({
      uri: `versioncon-state://dependency-graph/${target}`,
    });
    const fwdContent = fwd.content as Array<{ type: string; text: string }>;
    const fwdP = JSON.parse(fwdContent[0].text);
    const resText = (res.contents[0] as unknown as { text: string }).text;
    const resP = JSON.parse(resText);

    // The forward slice from the tool MUST equal the forward slice from the resource.
    assert.deepStrictEqual(fwdP.depends_on, resP.forward);
  });
});
