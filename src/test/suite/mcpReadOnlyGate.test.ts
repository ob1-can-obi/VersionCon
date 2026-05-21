// src/test/suite/mcpReadOnlyGate.test.ts
//
// Phase 8 Plan 03 — Layer 2 runtime read-only gate.
//
// Asserts:
//   - READ_ONLY_TOOLS contains exactly the 7 expected names (positive)
//   - READ_ONLY_TOOLS contains NO write-shaped names (SC-3 negative)
//   - READ_ONLY_TOOLS is Object.freeze'd
//   - registerReadOnlyTool throws synchronously when name is NOT in the Set
//     (registration-time gate — catches misnaming at module load)
//   - registerReadOnlyTool does NOT throw when name IS in the Set
//   - factory stamps annotations.readOnlyHint:true + openWorldHint:false
//     (Pitfall 6 mitigation — RESEARCH §F)
//   - call-time gate: when the runtime synthetically removes a name from the
//     Set, the wrapped handler returns {isError:true} instead of invoking
//     the handler (belt-and-suspenders defense-in-depth)
//   - N-08-02 source-grep gate: `READ_ONLY_TOOLS\.has` appears >= 1 in src/mcp/
//   - N-08-10 (proposed) source-grep gate: `server.registerTool` outside
//     registry.ts == 0 (all tool registrations MUST go via the factory)
//   - N-08-04 preserved: no `^\s*console\.` in src/mcp/registry.ts
//
// Pattern: PATTERNS.md "mcpReadOnlyGate.test.ts" — mirrors the source-grep
// idiom in src/test/suite/uriHandlerBootstrapToken.test.ts:24-65
// (fs.readFileSync + assert.match + offender-list discipline).

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { READ_ONLY_TOOLS, registerReadOnlyTool } from '../../mcp/registry.js';

const REPO_ROOT = process.cwd();
const MCP_DIR = path.join(REPO_ROOT, 'src', 'mcp');
const REGISTRY_PATH = path.join(MCP_DIR, 'registry.ts');

function newServer(): McpServer {
  return new McpServer(
    { name: 'test', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
}

const EXPECTED_TOOLS: readonly string[] = [
  'get_branch_status',
  'get_sync_status',
  'get_recent_activity',
  'get_chat_log',
  'query_dependencies',
  'list_dependents',
  'advise_sync',
];

suite('Phase 8 — READ_ONLY_TOOLS allow-list content', () => {

  test('READ_ONLY_TOOLS has exactly 7 names', () => {
    assert.strictEqual(
      READ_ONLY_TOOLS.size, 7,
      `Expected 7 tools, got ${READ_ONLY_TOOLS.size}: ${[...READ_ONLY_TOOLS].join(',')}`,
    );
  });

  test('READ_ONLY_TOOLS contains every expected name (positive assertion)', () => {
    for (const name of EXPECTED_TOOLS) {
      assert.ok(
        READ_ONLY_TOOLS.has(name),
        `READ_ONLY_TOOLS missing expected name '${name}'`,
      );
    }
  });

  test('READ_ONLY_TOOLS contains NO write-shaped names (SC-3 negative)', () => {
    const writeShapeRegex = /^(push|create|update|delete|set|send|commit|merge|revert)_/i;
    const offenders = [...READ_ONLY_TOOLS].filter((n) => writeShapeRegex.test(n));
    assert.deepStrictEqual(
      offenders, [],
      `SC-3 violation: write-shaped tool names in READ_ONLY_TOOLS: ${JSON.stringify(offenders)}`,
    );
  });

  test('READ_ONLY_TOOLS is frozen (Object.isFrozen === true)', () => {
    assert.strictEqual(
      Object.isFrozen(READ_ONLY_TOOLS), true,
      'READ_ONLY_TOOLS must be Object.freeze()d so it cannot be mutated at runtime',
    );
  });
});

suite('Phase 8 — registerReadOnlyTool factory (registration-time gate)', () => {

  test('throws when name is not in READ_ONLY_TOOLS', () => {
    const server = newServer();
    assert.throws(
      () => registerReadOnlyTool(
        server,
        'not_an_allowed_tool',
        { title: 't', description: 'd', inputSchema: {} },
        async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      ),
      /not in READ_ONLY_TOOLS/,
      'Expected throw with message containing "not in READ_ONLY_TOOLS"',
    );
  });

  test('does NOT throw when name is in READ_ONLY_TOOLS', () => {
    const server = newServer();
    assert.doesNotThrow(() => registerReadOnlyTool(
      server,
      'get_branch_status',
      { title: 'Branch Status', description: 'Returns the branch.', inputSchema: {} },
      async () => ({ content: [{ type: 'text', text: '{}' }] }),
    ));
  });

  test('throws on a name that is a typo of a real tool (catches misnamings)', () => {
    const server = newServer();
    assert.throws(
      () => registerReadOnlyTool(
        server,
        'get_branch_statuses',   // pluralized typo
        { title: 't', description: 'd', inputSchema: {} },
        async () => ({ content: [] }),
      ),
      /not in READ_ONLY_TOOLS/,
      'Factory must reject pluralized/misspelled tool names',
    );
  });

  test('throws on a write-shaped name (catches T-08-05 elevation attempt)', () => {
    const server = newServer();
    assert.throws(
      () => registerReadOnlyTool(
        server,
        'push_change',   // write-shaped name a careless contributor might add
        { title: 'Push', description: 'd', inputSchema: {} },
        async () => ({ content: [] }),
      ),
      /not in READ_ONLY_TOOLS/,
      'Factory must reject write-shaped tool names not in the allow-list',
    );
  });

  test('factory passes annotations.readOnlyHint:true + openWorldHint:false to server.registerTool', () => {
    const server = newServer();
    let captured: { name: string; meta: Record<string, unknown> } | null = null;
    const origRegisterTool = server.registerTool.bind(server);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool = (name: string, meta: Record<string, unknown>, handler: unknown) => {
      captured = { name, meta };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origRegisterTool as any)(name, meta, handler);
    };
    registerReadOnlyTool(
      server,
      'get_sync_status',
      { title: 'Sync', description: 'd', inputSchema: {} },
      async () => ({ content: [] }),
    );
    assert.ok(captured, 'server.registerTool was not called by the factory');
    const meta = (captured as unknown as { name: string; meta: Record<string, unknown> }).meta;
    const annotations = meta.annotations as Record<string, unknown> | undefined;
    assert.ok(annotations, 'factory must stamp annotations object');
    assert.strictEqual(
      annotations.readOnlyHint, true,
      'factory must stamp annotations.readOnlyHint:true (Pitfall 6 mitigation)',
    );
    assert.strictEqual(
      annotations.openWorldHint, false,
      'factory must stamp annotations.openWorldHint:false',
    );
  });
});

suite('Phase 8 — registerReadOnlyTool factory (call-time gate, defense-in-depth)', () => {

  test('wrapped handler returns {isError:true} when name fails .has check at call time', async () => {
    // Plan-checker WARNING 1: the call-time gate must be exercised. We capture
    // the wrapped handler the factory passes to server.registerTool, then
    // synthetically intercept READ_ONLY_TOOLS.has to return false to simulate
    // tampering. The wrapped handler must NOT delegate to the user handler
    // and must return {isError:true} with the standard refusal message.
    const server = newServer();
    let captured: { handler: (args: unknown, extra: unknown) => Promise<unknown> } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool = (
      _name: string,
      _meta: unknown,
      handler: (args: unknown, extra: unknown) => Promise<unknown>,
    ) => {
      captured = { handler };
      return undefined;
    };

    let userHandlerCalled = false;
    registerReadOnlyTool(
      server,
      'get_branch_status',
      { title: 't', description: 'd', inputSchema: {} },
      async () => {
        userHandlerCalled = true;
        return { content: [{ type: 'text', text: 'should-not-run' }] };
      },
    );

    assert.ok(captured, 'factory must have called server.registerTool with wrapped handler');
    const handler = (captured as unknown as { handler: (args: unknown, extra: unknown) => Promise<unknown> }).handler;

    // Simulate tampering by overriding Set.prototype.has for the duration of
    // this test. Object.freeze on the Set instance prevents reassignment of
    // own properties (so we can't `(set as any).has = ...`), but the prototype
    // method is still patchable — exactly the "rare attack where someone
    // swaps the Set's `.has` method" the registry.ts JSDoc documents as the
    // belt-and-suspenders rationale.
    const origHas = Set.prototype.has;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Set.prototype.has = function (this: Set<unknown>, value: unknown): boolean {
      if (this === READ_ONLY_TOOLS && value === 'get_branch_status') return false;
      return origHas.call(this, value);
    };
    let result: { isError?: boolean; content?: Array<{ type: string; text: string }> };
    try {
      result = (await handler({}, {})) as typeof result;
    } finally {
      Set.prototype.has = origHas;
    }

    assert.strictEqual(userHandlerCalled, false,
      'wrapped handler MUST NOT delegate to user handler when .has(name) returns false');
    assert.strictEqual(result.isError, true,
      'wrapped handler MUST return {isError:true} on call-time gate rejection');
    assert.ok(Array.isArray(result.content) && result.content.length >= 1,
      'wrapped handler MUST return content[] with at least one text entry');
    assert.match(
      result.content![0].text,
      /not on the read-only allow-list/,
      'rejection message must say "not on the read-only allow-list"',
    );
  });

  test('wrapped handler converts unhandled exceptions to {isError:true} (no stack-trace leak)', async () => {
    const server = newServer();
    let captured: { handler: (args: unknown, extra: unknown) => Promise<unknown> } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool = (
      _name: string,
      _meta: unknown,
      handler: (args: unknown, extra: unknown) => Promise<unknown>,
    ) => {
      captured = { handler };
      return undefined;
    };

    registerReadOnlyTool(
      server,
      'get_chat_log',
      { title: 't', description: 'd', inputSchema: {} },
      async () => {
        throw new Error('synthetic-test-failure');
      },
    );

    assert.ok(captured, 'factory must have called server.registerTool');
    const handler = (captured as unknown as { handler: (args: unknown, extra: unknown) => Promise<unknown> }).handler;
    const result = (await handler({}, {})) as { isError?: boolean; content?: Array<{ text: string }> };
    assert.strictEqual(result.isError, true,
      'unhandled exception must be converted to {isError:true}');
    assert.match(
      result.content![0].text,
      /synthetic-test-failure/,
      'error message must include the original error string',
    );
    assert.doesNotMatch(
      result.content![0].text,
      /\bat\s+\w+\s*\(/,
      'error message must NOT contain a stack-trace frame (e.g. "at funcName (")',
    );
  });

  test('wrapped handler invokes log function on call-time gate rejection', async () => {
    const server = newServer();
    let captured: { handler: (args: unknown, extra: unknown) => Promise<unknown> } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool = (
      _name: string,
      _meta: unknown,
      handler: (args: unknown, extra: unknown) => Promise<unknown>,
    ) => {
      captured = { handler };
      return undefined;
    };

    const logLines: string[] = [];
    registerReadOnlyTool(
      server,
      'get_recent_activity',
      { title: 't', description: 'd', inputSchema: {} },
      async () => ({ content: [] }),
      (line: string) => { logLines.push(line); },
    );

    assert.ok(captured, 'factory must have called server.registerTool');
    const handler = (captured as unknown as { handler: (args: unknown, extra: unknown) => Promise<unknown> }).handler;

    const origHas = Set.prototype.has;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Set.prototype.has = function (this: Set<unknown>, value: unknown): boolean {
      if (this === READ_ONLY_TOOLS && value === 'get_recent_activity') return false;
      return origHas.call(this, value);
    };
    try {
      await handler({}, {});
    } finally {
      Set.prototype.has = origHas;
    }

    assert.ok(
      logLines.some((l) => /gate rejected at call time/.test(l) && /get_recent_activity/.test(l)),
      `expected log line about gate rejection; got: ${JSON.stringify(logLines)}`,
    );
  });
});

suite('Phase 8 — N-08-02 source-grep: READ_ONLY_TOOLS.has wired in src/mcp/', () => {
  test('grep -c "READ_ONLY_TOOLS\\.has" src/mcp/ returns >= 1', async () => {
    let count = 0;
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
        } else if (e.isFile() && e.name.endsWith('.ts')) {
          const text = await fsAsync.readFile(full, 'utf-8');
          for (const line of text.split('\n')) {
            if (/READ_ONLY_TOOLS\.has/.test(line)) {
              count++;
            }
          }
        }
      }
    }
    await walk(MCP_DIR);
    assert.ok(
      count >= 1,
      `N-08-02 violation: READ_ONLY_TOOLS.has count = ${count}, expected >= 1`,
    );
  });
});

suite('Phase 8 — N-08-10 proposed source-grep: no server.registerTool outside registry.ts', () => {
  test('grep -rn "server.registerTool" src/mcp/ has matches ONLY in registry.ts', async () => {
    const offenders: Array<{ file: string; line: string }> = [];
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
        } else if (e.isFile() && e.name.endsWith('.ts') && full !== REGISTRY_PATH) {
          const text = await fsAsync.readFile(full, 'utf-8');
          for (const line of text.split('\n')) {
            const stripped = line.trim();
            // Skip line/block comment lines so a JSDoc reference to the
            // symbol elsewhere doesn't false-positive.
            if (stripped.startsWith('//') || stripped.startsWith('*')) continue;
            if (/server\.registerTool\b/.test(line)) {
              offenders.push({ file: full, line: stripped });
            }
          }
        }
      }
    }
    await walk(MCP_DIR);
    assert.deepStrictEqual(
      offenders, [],
      `N-08-10 violation: server.registerTool outside registry.ts. Offenders: ${JSON.stringify(offenders, null, 2)}`,
    );
  });
});

suite('Phase 8 — N-08-04 preserved: no console.* in src/mcp/registry.ts', () => {
  test('grep "^\\s*console\\." src/mcp/registry.ts returns 0 lines', () => {
    const text = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    const offenders = text.split('\n').filter((l) => /^\s*console\./.test(l));
    assert.deepStrictEqual(
      offenders, [],
      `N-08-04 violation: console.* in registry.ts: ${JSON.stringify(offenders)}`,
    );
  });
});

suite('Phase 8 — registry.ts contract assertions (source-grep)', () => {
  test('registry.ts contains Object.freeze on the Set', () => {
    const text = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    assert.match(
      text, /Object\.freeze\s*\(\s*new\s+Set/,
      'registry.ts must Object.freeze(new Set(...)) for READ_ONLY_TOOLS',
    );
  });

  test('registry.ts contains all 7 expected tool names as string literals', () => {
    const text = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    for (const name of EXPECTED_TOOLS) {
      assert.match(
        text, new RegExp(`['"]${name}['"]`),
        `registry.ts must contain string literal for tool '${name}'`,
      );
    }
  });

  test('registry.ts contains NO write-shaped tool name string literals', () => {
    const text = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    const forbiddenLiterals = /(['"])(push_|create_|update_|delete_|send_|commit_|merge_)\w+\1/g;
    const offenders = text.match(forbiddenLiterals) ?? [];
    assert.deepStrictEqual(
      offenders, [],
      `registry.ts must NOT contain write-shaped tool name literals: ${JSON.stringify(offenders)}`,
    );
  });
});
