// src/test/suite/mcpConfigWriter.test.ts
//
// Phase 8 Plan 05 — mcp.json writer tests; T-08-09 (sibling preservation) +
// T-08-07 (no token-shaped fields) + happy paths.
//
// Tests upsertMcpConfig + removeMcpConfig from src/mcp/mcpConfig.ts. The
// critical T-08-09 test (Test 2) pins the user-comment + sibling-entry
// preservation contract: an existing `.vscode/mcp.json` with postgres + github
// entries + JSONC comments must survive byte-identically after the versioncon
// upsert. This is the WHOLE POINT of using jsonc-parser instead of
// JSON.parse/JSON.stringify (the JSON.* path would destroy comments and
// re-serialize formatting).
//
// T-08-07 test (Test 7) pins the no-token-leak contract: the written file must
// contain ZERO matches for headers/Bearer/authorization/token literals. The
// MCP server uses localhost trust boundary so no auth material is ever needed
// in the config — the writer must NEVER emit it.
//
// Pattern: branchManager.test.ts:7-21 (tmpdir setup/teardown + file-shape
// assertions). Source-grep idiom mirrors uriHandlerBootstrapToken.test.ts.

import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { upsertMcpConfig, removeMcpConfig } from '../../mcp/mcpConfig.js';

suite('Phase 8 — mcpConfigWriter', () => {
  let tmpDir: string;

  setup(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `versioncon-mcp-cfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('Test 1: empty file → upsertMcpConfig writes the versioncon entry', async () => {
    await upsertMcpConfig(
      tmpDir,
      '.vscode/mcp.json',
      'versioncon',
      'http://127.0.0.1:5000/mcp',
    );
    const raw = await fs.readFile(path.join(tmpDir, '.vscode', 'mcp.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    assert.deepStrictEqual(parsed, {
      servers: { versioncon: { type: 'http', url: 'http://127.0.0.1:5000/mcp' } },
    });
  });

  test('Test 2 (T-08-09 CRITICAL): existing postgres + github entries preserved byte-identically', async () => {
    const vscodeDir = path.join(tmpDir, '.vscode');
    await fs.mkdir(vscodeDir, { recursive: true });
    const fixture = `{
  // Local Postgres MCP for dev
  "servers": {
    "postgres": {
      "type": "stdio",
      "command": "postgres-mcp",
      "args": ["--db", "dev"]
    },
    "github": {
      "type": "http",
      "url": "http://localhost:7000/github-mcp"
    }
  }
}
`;
    await fs.writeFile(path.join(vscodeDir, 'mcp.json'), fixture, 'utf-8');
    await upsertMcpConfig(
      tmpDir,
      '.vscode/mcp.json',
      'versioncon',
      'http://127.0.0.1:5000/mcp',
    );
    const raw = await fs.readFile(path.join(vscodeDir, 'mcp.json'), 'utf-8');

    // The user's comment should survive (jsonc-parser contract).
    assert.ok(
      raw.includes('// Local Postgres MCP for dev'),
      `T-08-09 comment-preservation failed. Got:\n${raw}`,
    );

    // Parse with the line-comment-stripped raw text for shape assertions.
    const stripped = raw.replace(/\/\/.*$/gm, '');
    const parsed = JSON.parse(stripped);
    assert.deepStrictEqual(
      parsed.servers.postgres,
      {
        type: 'stdio',
        command: 'postgres-mcp',
        args: ['--db', 'dev'],
      },
      'T-08-09 violation: postgres entry mutated',
    );
    assert.deepStrictEqual(
      parsed.servers.github,
      {
        type: 'http',
        url: 'http://localhost:7000/github-mcp',
      },
      'T-08-09 violation: github entry mutated',
    );
    assert.deepStrictEqual(parsed.servers.versioncon, {
      type: 'http',
      url: 'http://127.0.0.1:5000/mcp',
    });
  });

  test('Test 3: stale versioncon entry → updated to new port (Pitfall 3 self-healing)', async () => {
    const vscodeDir = path.join(tmpDir, '.vscode');
    await fs.mkdir(vscodeDir, { recursive: true });
    await fs.writeFile(
      path.join(vscodeDir, 'mcp.json'),
      '{ "servers": { "versioncon": { "type": "http", "url": "http://127.0.0.1:1111/mcp" } } }',
      'utf-8',
    );
    await upsertMcpConfig(
      tmpDir,
      '.vscode/mcp.json',
      'versioncon',
      'http://127.0.0.1:9999/mcp',
    );
    const raw = await fs.readFile(path.join(vscodeDir, 'mcp.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.servers.versioncon.url, 'http://127.0.0.1:9999/mcp');
    assert.strictEqual(parsed.servers.versioncon.type, 'http');
  });

  test('Test 4: parent directory missing → upsertMcpConfig creates it', async () => {
    assert.strictEqual(
      fsSync.existsSync(path.join(tmpDir, '.vscode')),
      false,
      'precondition: .vscode/ must not exist',
    );
    await upsertMcpConfig(
      tmpDir,
      '.vscode/mcp.json',
      'versioncon',
      'http://127.0.0.1:5000/mcp',
    );
    assert.strictEqual(
      fsSync.existsSync(path.join(tmpDir, '.vscode', 'mcp.json')),
      true,
      'upsertMcpConfig must create the .vscode/ parent directory',
    );
  });

  test('Test 5: removeMcpConfig removes ONLY versioncon, leaves siblings', async () => {
    const vscodeDir = path.join(tmpDir, '.vscode');
    await fs.mkdir(vscodeDir, { recursive: true });
    await fs.writeFile(
      path.join(vscodeDir, 'mcp.json'),
      JSON.stringify(
        {
          servers: {
            postgres: { type: 'http', url: 'http://localhost:7000/pg' },
            versioncon: { type: 'http', url: 'http://127.0.0.1:5000/mcp' },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
    await removeMcpConfig(tmpDir, '.vscode/mcp.json', 'versioncon');
    const raw = await fs.readFile(path.join(vscodeDir, 'mcp.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    assert.deepStrictEqual(parsed.servers.postgres, {
      type: 'http',
      url: 'http://localhost:7000/pg',
    });
    assert.strictEqual(
      parsed.servers.versioncon,
      undefined,
      'removeMcpConfig should delete the versioncon entry',
    );
  });

  test('Test 6: removeMcpConfig on missing file is a no-op (no throw)', async () => {
    // No file present at tmpDir/.vscode/mcp.json — should resolve cleanly.
    await removeMcpConfig(tmpDir, '.vscode/mcp.json', 'versioncon');
    // No assertion needed — passing if it didn't throw.
  });

  test('Test 7 (T-08-07): the written entry contains NO headers/Bearer/authorization/token fields', async () => {
    await upsertMcpConfig(
      tmpDir,
      '.vscode/mcp.json',
      'versioncon',
      'http://127.0.0.1:5000/mcp',
    );
    const raw = await fs.readFile(path.join(tmpDir, '.vscode', 'mcp.json'), 'utf-8');
    assert.doesNotMatch(
      raw,
      /\bheaders\b/i,
      `T-08-07: 'headers' field found in mcp.json: ${raw}`,
    );
    assert.doesNotMatch(
      raw,
      /\bBearer\b/,
      `T-08-07: 'Bearer' literal found in mcp.json: ${raw}`,
    );
    assert.doesNotMatch(
      raw,
      /\bauthorization\b/i,
      `T-08-07: 'authorization' literal found: ${raw}`,
    );
    assert.doesNotMatch(
      raw,
      /\btoken\b/i,
      `T-08-07: 'token' literal found: ${raw}`,
    );
  });

  test('Test 8: both config paths (.vscode/mcp.json and .mcp.json) work', async () => {
    await upsertMcpConfig(
      tmpDir,
      '.vscode/mcp.json',
      'versioncon',
      'http://127.0.0.1:5000/mcp',
    );
    await upsertMcpConfig(
      tmpDir,
      '.mcp.json',
      'versioncon',
      'http://127.0.0.1:5000/mcp',
    );
    assert.strictEqual(
      fsSync.existsSync(path.join(tmpDir, '.vscode', 'mcp.json')),
      true,
      '.vscode/mcp.json should exist',
    );
    assert.strictEqual(
      fsSync.existsSync(path.join(tmpDir, '.mcp.json')),
      true,
      '.mcp.json should exist',
    );
    // Both should have the same shape.
    const a = JSON.parse(await fs.readFile(path.join(tmpDir, '.vscode', 'mcp.json'), 'utf-8'));
    const b = JSON.parse(await fs.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
    assert.deepStrictEqual(a, b, 'both config paths should carry identical entries');
  });
});

suite('Phase 8 — mcpConfig.ts source-grep (T-08-07 + Pitfall 4 by construction)', () => {
  const REPO_ROOT = process.cwd();
  const MCP_CONFIG_TS = path.join(REPO_ROOT, 'src', 'mcp', 'mcpConfig.ts');

  test('mcpConfig.ts has no JSON.stringify (Pitfall 4 — must use jsonc-parser)', () => {
    const text = fsSync.readFileSync(MCP_CONFIG_TS, 'utf-8');
    assert.doesNotMatch(
      text,
      /\bJSON\.stringify\b/,
      'mcpConfig.ts must use jsonc-parser.applyEdits, not JSON.stringify (Pitfall 4: JSON.stringify destroys user comments)',
    );
  });

  test('mcpConfig.ts has no headers/Bearer/authorization/token literals (T-08-07)', () => {
    const text = fsSync.readFileSync(MCP_CONFIG_TS, 'utf-8');
    // Strip comments before scanning so the JSDoc-mentioned word "headers"
    // (used to DOCUMENT the prohibition) doesn't trip the gate.
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(
      stripped,
      /['"]headers['"]/,
      'T-08-07: do not write headers field',
    );
    assert.doesNotMatch(stripped, /Bearer/, 'T-08-07: no Bearer literal');
    assert.doesNotMatch(stripped, /authorization/i, 'T-08-07: no authorization literal');
  });

  test('mcpConfig.ts imports jsonc-parser (modify + applyEdits)', () => {
    const text = fsSync.readFileSync(MCP_CONFIG_TS, 'utf-8');
    assert.match(
      text,
      /from\s+['"]jsonc-parser['"]/,
      'mcpConfig.ts must import from jsonc-parser',
    );
    assert.match(text, /\bmodify\b/, 'mcpConfig.ts must use jsonc-parser.modify');
    assert.match(text, /\bapplyEdits\b/, 'mcpConfig.ts must use jsonc-parser.applyEdits');
  });

  test('mcpConfig.ts has no console.* (N-08-04)', () => {
    const text = fsSync.readFileSync(MCP_CONFIG_TS, 'utf-8');
    const offenders = text.split('\n').filter((l) => /^\s*console\./.test(l));
    assert.deepStrictEqual(
      offenders,
      [],
      `N-08-04: console.* in mcpConfig.ts: ${JSON.stringify(offenders)}`,
    );
  });

  test('mcpConfig.ts does not import from src/auth/ (N-08-01)', () => {
    const text = fsSync.readFileSync(MCP_CONFIG_TS, 'utf-8');
    assert.doesNotMatch(
      text,
      /from\s+['"][^'"]*\/auth\//,
      'N-08-01: src/mcp/mcpConfig.ts must NOT import from src/auth/',
    );
  });
});
