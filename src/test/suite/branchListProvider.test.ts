import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { BranchManager } from '../../filesystem/BranchManager.js';
import { BranchListProvider } from '../../ui/BranchListProvider.js';

suite('BranchListProvider', () => {
  let tmpDir: string;
  let versionconDir: string;
  let branchManager: BranchManager;
  let provider: BranchListProvider;

  setup(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `versioncon-branchlist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    versionconDir = path.join(tmpDir, '.versioncon');
    await fs.mkdir(versionconDir, { recursive: true });
    branchManager = new BranchManager(versionconDir);
    await branchManager.initialize();
    provider = new BranchListProvider(branchManager);
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('getChildren returns one TreeItem per branch from listBranches', async () => {
    const children = await provider.getChildren();
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].name, 'main');
  });

  test('each TreeItem label equals the branch name', async () => {
    await branchManager.createBranch('feature-a', 'main', 'tester');
    provider.refresh();
    const children = await provider.getChildren();
    const labels = children.map(b => provider.getTreeItem(b).label);
    assert.ok(labels.includes('main'), 'main label must be present');
    assert.ok(labels.includes('feature-a'), 'feature-a label must be present');
  });

  test('active branch TreeItem has description set to "active"', async () => {
    const children = await provider.getChildren();
    const activeBranch = await branchManager.getActiveBranch();
    const active = children.find(b => b.name === activeBranch);
    assert.ok(active, 'active branch must appear in children');
    const item = provider.getTreeItem(active!);
    assert.strictEqual(item.description, 'active');
  });

  test('locked branches have contextValue branchListItem-locked, unlocked have branchListItem-unlocked', async () => {
    await branchManager.createBranch('locked-branch', 'main', 'tester');
    await branchManager.lockBranch('locked-branch');
    provider.refresh();
    const children = await provider.getChildren();
    const locked = children.find(b => b.name === 'locked-branch');
    const unlocked = children.find(b => b.name === 'main');
    assert.ok(locked, 'locked-branch must be present');
    assert.ok(unlocked, 'main must be present');
    assert.strictEqual(provider.getTreeItem(locked!).contextValue, 'branchListItem-locked');
    assert.strictEqual(provider.getTreeItem(unlocked!).contextValue, 'branchListItem-unlocked');
  });

  test('refresh fires onDidChangeTreeData event', () => {
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.refresh();
    assert.strictEqual(fired, true);
  });

  test('after createBranch + refresh, getChildren includes the new branch', async () => {
    await branchManager.createBranch('feature-x', 'main', 'tester');
    provider.refresh();
    const children = await provider.getChildren();
    const names = children.map(b => b.name);
    assert.ok(names.includes('feature-x'), 'feature-x must appear after refresh');
  });
});
