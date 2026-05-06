import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { SyncTracker } from '../../filesystem/SyncTracker.js';
import { FileSystemLayer } from '../../filesystem/FileSystemLayer.js';

/**
 * Tests the sync command's partition + decision logic at the unit level.
 * The actual command in extension.ts wires VS Code modals; this test
 * exercises the file-pull and decision branches against real fs ops so
 * a regression in the partition logic is caught here.
 */
suite('SyncCommand', () => {
  let tmpDir: string;
  let projectRoot: string;
  let branchDir: string;
  let tracker: SyncTracker;
  let fsLayer: FileSystemLayer;

  setup(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `versioncon-sync-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    projectRoot = path.join(tmpDir, 'workspace');
    branchDir = path.join(tmpDir, '.versioncon', 'branch');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(branchDir, { recursive: true });
    tracker = new SyncTracker();
    fsLayer = new FileSystemLayer(projectRoot, branchDir);
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('no-local branch — file exists in branch but not in workspace, copyFileToWorkspace pulls it silently', async () => {
    await fs.writeFile(path.join(branchDir, 'a.ts'), 'export const a = 1;\n');
    tracker.recordRemoteFiles(['a.ts']);

    await fsLayer.copyFileToWorkspace('a.ts');
    tracker.clearPath('a.ts');

    const ws = await fs.readFile(path.join(projectRoot, 'a.ts'), 'utf-8');
    assert.strictEqual(ws, 'export const a = 1;\n');
    assert.deepStrictEqual(tracker.getOutOfSyncPaths(), []);
  });

  test('identical branch — workspace and branch bytes match, clearPath alone drains the set', async () => {
    const content = 'export const x = 1;\n';
    await fs.writeFile(path.join(branchDir, 'x.ts'), content);
    await fs.writeFile(path.join(projectRoot, 'x.ts'), content);
    tracker.recordRemoteFiles(['x.ts']);

    const branchBuf = await fs.readFile(path.join(branchDir, 'x.ts'));
    const wsBuf = await fs.readFile(path.join(projectRoot, 'x.ts'));
    assert.strictEqual(branchBuf.equals(wsBuf), true);
    tracker.clearPath('x.ts');
    assert.deepStrictEqual(tracker.getOutOfSyncPaths(), []);
  });

  test('conflict + Take branch — copyFileToWorkspace overwrites local, clearPath drains the set', async () => {
    await fs.writeFile(path.join(branchDir, 'c.ts'), 'BRANCH VERSION\n');
    await fs.writeFile(path.join(projectRoot, 'c.ts'), 'LOCAL VERSION\n');
    tracker.recordRemoteFiles(['c.ts']);

    await fsLayer.copyFileToWorkspace('c.ts');
    tracker.clearPath('c.ts');

    const ws = await fs.readFile(path.join(projectRoot, 'c.ts'), 'utf-8');
    assert.strictEqual(ws, 'BRANCH VERSION\n');
    assert.deepStrictEqual(tracker.getOutOfSyncPaths(), []);
  });

  test('conflict + Keep mine — workspace is unchanged AND path stays in the out-of-sync set', async () => {
    await fs.writeFile(path.join(branchDir, 'k.ts'), 'BRANCH\n');
    await fs.writeFile(path.join(projectRoot, 'k.ts'), 'LOCAL\n');
    tracker.recordRemoteFiles(['k.ts']);

    // Keep mine: do nothing.
    const ws = await fs.readFile(path.join(projectRoot, 'k.ts'), 'utf-8');
    assert.strictEqual(ws, 'LOCAL\n');
    assert.deepStrictEqual(tracker.getOutOfSyncPaths(), ['k.ts']);
  });

  test('mixed run — three files: identical (silent), conflict+Take branch (pulled), conflict+Keep mine (kept)', async () => {
    await fs.writeFile(path.join(branchDir, 'same.ts'), 'SAME\n');
    await fs.writeFile(path.join(projectRoot, 'same.ts'), 'SAME\n');
    await fs.writeFile(path.join(branchDir, 'take.ts'), 'BRANCH-TAKE\n');
    await fs.writeFile(path.join(projectRoot, 'take.ts'), 'LOCAL-TAKE\n');
    await fs.writeFile(path.join(branchDir, 'keep.ts'), 'BRANCH-KEEP\n');
    await fs.writeFile(path.join(projectRoot, 'keep.ts'), 'LOCAL-KEEP\n');
    tracker.onRemotePush('push-1');
    tracker.recordRemoteFiles(['same.ts', 'take.ts', 'keep.ts']);

    // identical -> clearPath
    tracker.clearPath('same.ts');
    // take -> copy + clearPath
    await fsLayer.copyFileToWorkspace('take.ts');
    tracker.clearPath('take.ts');
    // keep -> nothing

    assert.deepStrictEqual(tracker.getOutOfSyncPaths(), ['keep.ts']);
    const takeContent = await fs.readFile(path.join(projectRoot, 'take.ts'), 'utf-8');
    assert.strictEqual(takeContent, 'BRANCH-TAKE\n');
    const keepContent = await fs.readFile(path.join(projectRoot, 'keep.ts'), 'utf-8');
    assert.strictEqual(keepContent, 'LOCAL-KEEP\n');
  });

  test('full drain — clearing every path then onSync clears the set fully and isInSync returns true', async () => {
    tracker.onRemotePush('push-x');
    tracker.recordRemoteFiles(['a.ts', 'b.ts']);
    tracker.clearPath('a.ts');
    tracker.clearPath('b.ts');
    tracker.onSync();
    assert.deepStrictEqual(tracker.getOutOfSyncPaths(), []);
    assert.strictEqual(tracker.isInSync(), true);
  });
});
