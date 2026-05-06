import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { BranchManager } from '../../filesystem/BranchManager.js';
import { FileSystemLayer } from '../../filesystem/FileSystemLayer.js';

/**
 * Integration tests for the file-copy logic of quickMergeFiles (BRANCH-07)
 * and structuredMergeBranch (BRANCH-08).
 *
 * These tests exercise the same primitives the commands use (BranchManager,
 * FileSystemLayer.collectFilePaths, fs.copyFile) without going through the
 * VS Code QuickPick surface, which is host-process-only.
 */
suite('MergeFlow', () => {
  let tmpDir: string;
  let versionconDir: string;
  let branchManager: BranchManager;

  setup(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `versioncon-merge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    versionconDir = path.join(tmpDir, '.versioncon');
    await fs.mkdir(versionconDir, { recursive: true });
    branchManager = new BranchManager(versionconDir);
    await branchManager.initialize();
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // Helper: simulate the file-copy step of quickMergeFiles
  async function copyFiles(
    sourceBranch: string,
    targetBranch: string,
    files: string[],
  ): Promise<void> {
    const sourceDir = path.join(versionconDir, 'branches', sourceBranch);
    const targetDir = path.join(versionconDir, 'branches', targetBranch);
    for (const f of files) {
      const src = path.join(sourceDir, f);
      const dest = path.join(targetDir, f);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }
  }

  test('quick merge copies a single file from source to target', async () => {
    await branchManager.createBranch('feature', 'main', 'tester');
    const featureDir = path.join(versionconDir, 'branches', 'feature');
    await fs.mkdir(path.join(featureDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(featureDir, 'src', 'a.ts'), 'export const a = 1;\n');

    await copyFiles('feature', 'main', ['src/a.ts']);

    const mainContent = await fs.readFile(
      path.join(versionconDir, 'branches', 'main', 'src', 'a.ts'),
      'utf-8',
    );
    assert.strictEqual(mainContent, 'export const a = 1;\n');
  });

  test('quick merge does not copy unselected files', async () => {
    await branchManager.createBranch('feature', 'main', 'tester');
    const featureDir = path.join(versionconDir, 'branches', 'feature');
    await fs.mkdir(featureDir, { recursive: true });
    await fs.writeFile(path.join(featureDir, 'a.ts'), 'A');
    await fs.writeFile(path.join(featureDir, 'b.ts'), 'B');

    await copyFiles('feature', 'main', ['a.ts']);

    const mainDir = path.join(versionconDir, 'branches', 'main');
    const aExists = await fs.stat(path.join(mainDir, 'a.ts')).then(() => true).catch(() => false);
    const bExists = await fs.stat(path.join(mainDir, 'b.ts')).then(() => true).catch(() => false);
    assert.strictEqual(aExists, true, 'a.ts should be copied');
    assert.strictEqual(bExists, false, 'b.ts should NOT be copied');
  });

  test('structured merge walkthrough classifies added vs modified files', async () => {
    await branchManager.createBranch('feature', 'main', 'tester');
    const mainDir = path.join(versionconDir, 'branches', 'main');
    const featureDir = path.join(versionconDir, 'branches', 'feature');
    // main has shared.ts; feature has shared.ts (modified) + new.ts (added)
    await fs.writeFile(path.join(mainDir, 'shared.ts'), 'old\n');
    await fs.writeFile(path.join(featureDir, 'shared.ts'), 'new content here\n');
    await fs.writeFile(path.join(featureDir, 'new.ts'), 'added\n');

    const fsLayer = new FileSystemLayer(tmpDir, mainDir);
    const sourcePaths = await fsLayer.collectFilePaths(featureDir, '');
    const targetPaths = new Set(await fsLayer.collectFilePaths(mainDir, ''));
    const walk: Array<{ path: string; status: 'added' | 'modified' }> = [];
    for (const p of sourcePaths) {
      if (targetPaths.has(p)) {
        const s = await fs.readFile(path.join(featureDir, p), 'utf-8');
        const t = await fs.readFile(path.join(mainDir, p), 'utf-8');
        if (s !== t) walk.push({ path: p, status: 'modified' });
      } else {
        walk.push({ path: p, status: 'added' });
      }
    }

    const sharedEntry = walk.find(w => w.path === 'shared.ts');
    const newEntry = walk.find(w => w.path === 'new.ts');
    assert.ok(sharedEntry, 'shared.ts must appear in walk');
    assert.strictEqual(sharedEntry?.status, 'modified');
    assert.ok(newEntry, 'new.ts must appear in walk');
    assert.strictEqual(newEntry?.status, 'added');
  });

  test('structured merge walkthrough skips identical files', async () => {
    await branchManager.createBranch('feature', 'main', 'tester');
    const mainDir = path.join(versionconDir, 'branches', 'main');
    const featureDir = path.join(versionconDir, 'branches', 'feature');
    await fs.writeFile(path.join(mainDir, 'same.ts'), 'identical\n');
    await fs.writeFile(path.join(featureDir, 'same.ts'), 'identical\n');

    const fsLayer = new FileSystemLayer(tmpDir, mainDir);
    const sourcePaths = await fsLayer.collectFilePaths(featureDir, '');
    const targetPaths = new Set(await fsLayer.collectFilePaths(mainDir, ''));
    let modifiedCount = 0;
    for (const p of sourcePaths) {
      if (targetPaths.has(p)) {
        const s = await fs.readFile(path.join(featureDir, p), 'utf-8');
        const t = await fs.readFile(path.join(mainDir, p), 'utf-8');
        if (s !== t) modifiedCount++;
      }
    }
    assert.strictEqual(modifiedCount, 0);
  });

  test('full structured merge applies every changed file to target', async () => {
    await branchManager.createBranch('feature', 'main', 'tester');
    const mainDir = path.join(versionconDir, 'branches', 'main');
    const featureDir = path.join(versionconDir, 'branches', 'feature');
    await fs.writeFile(path.join(mainDir, 'a.ts'), 'old\n');
    await fs.writeFile(path.join(featureDir, 'a.ts'), 'new\n');
    await fs.writeFile(path.join(featureDir, 'b.ts'), 'added\n');

    // Apply merge: copy every file from feature to main
    const fsLayer = new FileSystemLayer(tmpDir, mainDir);
    const sourcePaths = await fsLayer.collectFilePaths(featureDir, '');
    for (const p of sourcePaths) {
      const src = path.join(featureDir, p);
      const dest = path.join(mainDir, p);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }

    assert.strictEqual(await fs.readFile(path.join(mainDir, 'a.ts'), 'utf-8'), 'new\n');
    assert.strictEqual(await fs.readFile(path.join(mainDir, 'b.ts'), 'utf-8'), 'added\n');
  });
});
