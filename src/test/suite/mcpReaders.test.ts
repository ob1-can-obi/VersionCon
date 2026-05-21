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
