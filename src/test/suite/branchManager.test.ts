import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { BranchManager } from '../../filesystem/BranchManager.js';

suite('BranchManager', () => {
  let tmpDir: string;
  let versionconDir: string;
  let manager: BranchManager;

  setup(async () => {
    tmpDir = path.join(os.tmpdir(), `versioncon-branch-mgr-${Date.now()}`);
    versionconDir = path.join(tmpDir, '.versioncon');
    await fs.mkdir(versionconDir, { recursive: true });
    manager = new BranchManager(versionconDir);
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('initialize creates main branch on fresh install', async () => {
    await manager.initialize();
    const branches = manager.listBranches();
    assert.strictEqual(branches.length, 1);
    assert.strictEqual(branches[0].name, 'main');

    const activeBranch = await manager.getActiveBranch();
    assert.strictEqual(activeBranch, 'main');
  });

  test('initialize migrates from legacy branch/ dir', async () => {
    // Create legacy layout
    const legacyDir = path.join(versionconDir, 'branch');
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, 'app.ts'), 'legacy content');

    await manager.initialize();

    // Should have moved to branches/main/
    const branches = manager.listBranches();
    assert.strictEqual(branches.length, 1);
    assert.strictEqual(branches[0].name, 'main');

    // File should exist in new location
    const content = await fs.readFile(
      path.join(versionconDir, 'branches', 'main', 'app.ts'), 'utf-8',
    );
    assert.strictEqual(content, 'legacy content');

    // Legacy dir should no longer exist
    await assert.rejects(() => fs.access(legacyDir));
  });

  test('createBranch copies base branch files', async () => {
    await manager.initialize();

    // Add a file to main
    const mainDir = path.join(versionconDir, 'branches', 'main');
    await fs.writeFile(path.join(mainDir, 'index.ts'), 'main content');

    const info = await manager.createBranch('feature-x', 'main', 'creator-1');
    assert.strictEqual(info.name, 'feature-x');
    assert.strictEqual(info.createdBy, 'creator-1');

    // File should be copied to new branch
    const content = await fs.readFile(
      path.join(versionconDir, 'branches', 'feature-x', 'index.ts'), 'utf-8',
    );
    assert.strictEqual(content, 'main content');
  });

  test('createBranch rejects duplicate name', async () => {
    await manager.initialize();
    await assert.rejects(
      () => manager.createBranch('main', 'main', 'creator'),
      /already exists/,
    );
  });

  test('createBranch rejects invalid name', async () => {
    await manager.initialize();
    await assert.rejects(
      () => manager.createBranch('bad name!', 'main', 'creator'),
      /alphanumeric/,
    );
  });

  test('switchBranch updates active branch', async () => {
    await manager.initialize();
    await manager.createBranch('dev', 'main', 'creator');

    await manager.switchBranch('dev');
    const active = await manager.getActiveBranch();
    assert.strictEqual(active, 'dev');
  });

  test('switchBranch rejects nonexistent branch', async () => {
    await manager.initialize();
    await assert.rejects(
      () => manager.switchBranch('nonexistent'),
      /does not exist/,
    );
  });

  test('deleteBranch removes branch directory and metadata', async () => {
    await manager.initialize();
    await manager.createBranch('temp', 'main', 'creator');
    assert.strictEqual(manager.listBranches().length, 2);

    await manager.deleteBranch('temp');
    assert.strictEqual(manager.listBranches().length, 1);
    assert.strictEqual(manager.listBranches()[0].name, 'main');
  });

  test('deleteBranch rejects main', async () => {
    await manager.initialize();
    await assert.rejects(
      () => manager.deleteBranch('main'),
      /Cannot delete the main branch/,
    );
  });

  test('deleteBranch rejects active branch', async () => {
    await manager.initialize();
    await manager.createBranch('active-test', 'main', 'c');
    await manager.switchBranch('active-test');

    await assert.rejects(
      () => manager.deleteBranch('active-test'),
      /Cannot delete the active branch/,
    );
  });

  test('lockBranch and unlockBranch update metadata', async () => {
    await manager.initialize();
    await manager.lockBranch('main', ['pusher-1']);

    let branch = manager.getBranch('main');
    assert.strictEqual(branch!.locked, true);
    assert.deepStrictEqual(branch!.lockedPushers, ['pusher-1']);

    await manager.unlockBranch('main');
    branch = manager.getBranch('main');
    assert.strictEqual(branch!.locked, false);
    assert.strictEqual(branch!.lockedPushers, undefined);
  });

  test('getActiveBranchDir returns correct path', async () => {
    await manager.initialize();
    const dir = await manager.getActiveBranchDir();
    assert.strictEqual(dir, path.join(versionconDir, 'branches', 'main'));
  });
});
