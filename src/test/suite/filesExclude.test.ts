import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import type * as vscode from 'vscode';

import { ensureVersionconExcluded } from '../../extension.js';

// -----------------------------------------------------------------------------
// Phase 4.3 Wave 1 — files.exclude injection (T-04.3-01 mitigation)
//
// Behavior suite exercises ensureVersionconExcluded directly against a
// tmpdir-backed fake vscode.ExtensionContext. We mock just enough of the
// Memento + ExtensionContext shape that the helper uses; the helper itself
// uses real fs/promises against the temp dir so the merge-write logic is
// exercised end-to-end.
// -----------------------------------------------------------------------------

/**
 * Minimal in-memory Memento implementation matching the surface ensureVersionconExcluded
 * touches: get(key), update(key, value), keys(). All other Memento methods are unused.
 */
class MemoryMemento implements vscode.Memento {
  private readonly store = new Map<string, unknown>();
  keys(): readonly string[] {
    return Array.from(this.store.keys());
  }
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.store.has(key) ? (this.store.get(key) as T) : defaultValue) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
  }
  setKeysForSync(_keys: readonly string[]): void {
    /* not used */
  }
}

/**
 * Build a fake vscode.ExtensionContext exposing only the fields ensureVersionconExcluded
 * reads. We also stub vscode.workspace.workspaceFolders for the duration of the test —
 * the helper resolves the workspace folder via vscode.workspace.workspaceFolders?.[0].
 */
function makeContext(): { context: vscode.ExtensionContext; workspaceState: MemoryMemento } {
  const workspaceState = new MemoryMemento();
  const context = {
    workspaceState,
    // The helper only touches workspaceState — everything else is unused but the
    // type requires the shape, so cast through unknown for the test fake.
  } as unknown as vscode.ExtensionContext;
  return { context, workspaceState };
}

/**
 * Override vscode.workspace.workspaceFolders to point at a single folder rooted
 * at tmpDir. Returns a restore callback that puts the original value back.
 */
function withWorkspaceFolder(tmpDir: string): () => void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vscodeMod = require('vscode') as typeof vscode;
  const original = vscodeMod.workspace.workspaceFolders;
  const fakeFolder: vscode.WorkspaceFolder = {
    uri: vscodeMod.Uri.file(tmpDir),
    name: path.basename(tmpDir),
    index: 0,
  };
  Object.defineProperty(vscodeMod.workspace, 'workspaceFolders', {
    configurable: true,
    get: () => [fakeFolder],
  });
  return () => {
    Object.defineProperty(vscodeMod.workspace, 'workspaceFolders', {
      configurable: true,
      get: () => original,
    });
  };
}

async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `vc-test-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function readSettings(tmpDir: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(tmpDir, '.vscode', 'settings.json'), 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

suite('Phase 4.3 Wave 1 — files.exclude injection (T-04.3-01 mitigation)', () => {
  let tmpDir: string;
  let restoreWorkspaceFolders: () => void;

  setup(async () => {
    tmpDir = await makeTempDir();
    restoreWorkspaceFolders = withWorkspaceFolder(tmpDir);
  });

  teardown(async () => {
    restoreWorkspaceFolders();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('Test 4 (SC-1): creates .vscode/settings.json with files.exclude entry on first run', async () => {
    const { context, workspaceState } = makeContext();
    await ensureVersionconExcluded(context);

    const settings = await readSettings(tmpDir);
    const filesExclude = settings['files.exclude'] as Record<string, unknown>;
    assert.ok(filesExclude, 'files.exclude key must be present after first activation');
    assert.strictEqual(
      filesExclude['.versioncon'],
      true,
      'files.exclude[".versioncon"] must equal true so VS Code hides the folder',
    );
    assert.strictEqual(
      workspaceState.get<boolean>('versioncon.filesExcludeInjected'),
      true,
      'workspaceState flag must be set so subsequent activations skip the merge-write',
    );
  });

  test('Test 5 (SC-1, T-04.3-01): merges with existing unrelated keys without clobbering', async () => {
    // Seed an existing settings.json with an unrelated key.
    await fs.mkdir(path.join(tmpDir, '.vscode'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.vscode', 'settings.json'),
      JSON.stringify({ 'editor.fontSize': 14, 'editor.tabSize': 2 }, null, 2),
      'utf-8',
    );

    const { context } = makeContext();
    await ensureVersionconExcluded(context);

    const settings = await readSettings(tmpDir);
    assert.strictEqual(settings['editor.fontSize'], 14, 'editor.fontSize must be preserved');
    assert.strictEqual(settings['editor.tabSize'], 2, 'editor.tabSize must be preserved');
    const filesExclude = settings['files.exclude'] as Record<string, unknown>;
    assert.strictEqual(
      filesExclude['.versioncon'],
      true,
      '.versioncon entry must be merged alongside existing unrelated keys',
    );
  });

  test('Test 6 (SC-1): second run is a no-op (workspaceState flag prevents re-write)', async () => {
    const { context } = makeContext();
    await ensureVersionconExcluded(context);

    // Modify the file between runs — if the second call re-writes, this gets clobbered.
    const settingsPath = path.join(tmpDir, '.vscode', 'settings.json');
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ 'some.key': 'sentinel' }, null, 2),
      'utf-8',
    );

    await ensureVersionconExcluded(context);

    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8')) as Record<string, unknown>;
    assert.strictEqual(
      settings['some.key'],
      'sentinel',
      'second call must NOT touch the file (workspaceState gate)',
    );
    assert.strictEqual(
      settings['files.exclude'],
      undefined,
      'second call must NOT re-add the files.exclude key after a manual edit',
    );
  });

  test('Test 7 (SC-1): respects user-set files.exclude[".versioncon"] = false', async () => {
    // User has explicitly opted out: .versioncon visible.
    await fs.mkdir(path.join(tmpDir, '.vscode'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.vscode', 'settings.json'),
      JSON.stringify({ 'files.exclude': { '.versioncon': false } }, null, 2),
      'utf-8',
    );

    const { context, workspaceState } = makeContext();
    await ensureVersionconExcluded(context);

    const settings = await readSettings(tmpDir);
    const filesExclude = settings['files.exclude'] as Record<string, unknown>;
    assert.strictEqual(
      filesExclude['.versioncon'],
      false,
      'user-set false must be preserved — never coerce to true',
    );
    assert.strictEqual(
      workspaceState.get<boolean>('versioncon.filesExcludeInjected'),
      true,
      'flag must still be set so we do not revisit this decision on next activation',
    );
  });

  test('Test 8 (SC-1): malformed JSON in settings.json is swallowed; helper writes a clean file', async () => {
    await fs.mkdir(path.join(tmpDir, '.vscode'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.vscode', 'settings.json'),
      '{ this is not valid json',
      'utf-8',
    );

    const { context, workspaceState } = makeContext();
    // MUST NOT throw — the helper swallows JSON.parse errors and treats as empty.
    await ensureVersionconExcluded(context);

    const settings = await readSettings(tmpDir);
    const filesExclude = settings['files.exclude'] as Record<string, unknown>;
    assert.strictEqual(
      filesExclude['.versioncon'],
      true,
      'helper must recover from malformed JSON by writing a clean object with the .versioncon entry',
    );
    assert.strictEqual(
      workspaceState.get<boolean>('versioncon.filesExcludeInjected'),
      true,
      'flag must be set after a successful recovery write',
    );
  });
});

// -----------------------------------------------------------------------------
// Phase 4.3 Wave 1 — git-style command aliases (SC-2). Source-grep suite,
// same shape as the Phase 4 UAT 2026-05-11 closure suite in host.test.ts:2521+.
// -----------------------------------------------------------------------------
suite('Phase 4.3 Wave 1 — git-style command aliases (SC-2)', () => {
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  const aliasesPath = path.resolve(process.cwd(), 'src/commands/aliases.ts');
  const extPath = path.resolve(process.cwd(), 'src/extension.ts');

  test('Test 1: package.json declares all 7 alias command ids with correct titles + category', () => {
    const src = fsSync.readFileSync(pkgPath, 'utf-8');
    const expected: Array<{ id: string; title: string }> = [
      { id: 'versioncon.cmd.push', title: 'VersionCon: Push' },
      { id: 'versioncon.cmd.pull', title: 'VersionCon: Pull' },
      { id: 'versioncon.cmd.checkout', title: 'VersionCon: Checkout' },
      { id: 'versioncon.cmd.branch', title: 'VersionCon: Branch' },
      { id: 'versioncon.cmd.log', title: 'VersionCon: Log' },
      { id: 'versioncon.cmd.diff', title: 'VersionCon: Diff' },
      { id: 'versioncon.cmd.merge', title: 'VersionCon: Merge' },
    ];
    for (const { id, title } of expected) {
      // Each command must appear as an object with command + title + category, e.g.
      //   { "command": "versioncon.cmd.push", "title": "VersionCon: Push", "category": "VersionCon" }
      const idPattern = id.replace(/\./g, '\\.');
      const titleEscaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(
        `"command"\\s*:\\s*"${idPattern}"[\\s\\S]{0,200}?"title"\\s*:\\s*"${titleEscaped}"[\\s\\S]{0,200}?"category"\\s*:\\s*"VersionCon"`,
      );
      assert.match(
        src,
        re,
        `package.json must declare ${id} with title "${title}" and category "VersionCon"`,
      );
    }
  });

  test('Test 2: aliases.ts exports registerGitStyleAliases and routes each alias to the correct canonical id', () => {
    const src = fsSync.readFileSync(aliasesPath, 'utf-8');
    assert.match(
      src,
      /export\s+function\s+registerGitStyleAliases\s*\(/,
      'aliases.ts must export a function named registerGitStyleAliases',
    );

    // Each alias must register a command that executeCommands the canonical id.
    const mapping: Array<{ alias: string; canonical: string }> = [
      { alias: 'versioncon.cmd.push', canonical: 'versioncon.push' },
      { alias: 'versioncon.cmd.pull', canonical: 'versioncon.sync' },
      { alias: 'versioncon.cmd.checkout', canonical: 'versioncon.switchBranch' },
      { alias: 'versioncon.cmd.branch', canonical: 'versioncon.createBranch' },
      { alias: 'versioncon.cmd.log', canonical: 'versioncon.showPushHistory' },
      { alias: 'versioncon.cmd.diff', canonical: 'versioncon.previewDiff' },
      { alias: 'versioncon.cmd.merge', canonical: 'versioncon.mergeBranch' },
    ];
    for (const { alias, canonical } of mapping) {
      const aliasEsc = alias.replace(/\./g, '\\.');
      const canonicalEsc = canonical.replace(/\./g, '\\.');
      const re = new RegExp(
        `registerCommand\\(\\s*['"]${aliasEsc}['"]\\s*,\\s*\\(\\)\\s*=>\\s*[\\s\\S]{0,200}?executeCommand\\(\\s*['"]${canonicalEsc}['"]\\s*\\)`,
      );
      assert.match(
        src,
        re,
        `aliases.ts must register ${alias} as a pass-through to ${canonical}`,
      );
    }
  });

  test('Test 3: extension.ts imports registerGitStyleAliases and calls it exactly once inside activate()', () => {
    const src = fsSync.readFileSync(extPath, 'utf-8');
    assert.match(
      src,
      /import\s*\{\s*registerGitStyleAliases\s*\}\s*from\s*['"]\.\/commands\/aliases\.js['"]/,
      'extension.ts must import registerGitStyleAliases from ./commands/aliases.js',
    );

    // Exactly one call site: `registerGitStyleAliases(...)` with parens.
    // (The import line `import { registerGitStyleAliases }` does NOT match
    // this regex because there is no `(` immediately following.)
    const callMatches = src.match(/registerGitStyleAliases\(/g) ?? [];
    assert.strictEqual(
      callMatches.length,
      1,
      `registerGitStyleAliases(...) must be called exactly once in extension.ts; found ${callMatches.length}`,
    );

    // The single invocation must live inside activate(...).
    const activateBlock = src.match(/export function activate\([\s\S]*?\n\}\n/);
    assert.ok(activateBlock, 'activate() function block must be parseable');
    assert.match(
      activateBlock[0],
      /registerGitStyleAliases\(context\)/,
      'registerGitStyleAliases(context) call must live inside activate()',
    );
  });
});
