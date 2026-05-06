import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { FileSystemLayer } from '../../filesystem/FileSystemLayer.js';
import { BranchTreeProvider } from '../../ui/BranchTreeProvider.js';
import { WorkspaceTreeProvider } from '../../ui/WorkspaceTreeProvider.js';
import { WorkspaceState } from '../../filesystem/WorkspaceState.js';

// BranchTreeProvider tests
suite('BranchTreeProvider', () => {
  let tmpDir: string;
  let branchDir: string;
  let fsLayer: FileSystemLayer;
  let provider: BranchTreeProvider;

  setup(async () => {
    tmpDir = path.join(os.tmpdir(), `versioncon-branch-tree-test-${Date.now()}`);
    branchDir = path.join(tmpDir, '.versioncon', 'branch');
    await fs.mkdir(branchDir, { recursive: true });
    fsLayer = new FileSystemLayer(tmpDir, branchDir);
    provider = new BranchTreeProvider(fsLayer);
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('getChildren returns files from branch directory', async () => {
    await fs.writeFile(path.join(branchDir, 'index.ts'), 'export {};');
    await fs.mkdir(path.join(branchDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(branchDir, 'src', 'app.ts'), 'const x = 1;');

    const rootChildren = await provider.getChildren();

    assert.ok(rootChildren.length >= 2, 'Should have at least 2 entries');
    const dirEntry = rootChildren.find(e => e.name === 'src');
    assert.ok(dirEntry, 'Should have src directory');
    assert.ok(dirEntry!.isDirectory, 'src should be a directory');

    const fileEntry = rootChildren.find(e => e.name === 'index.ts');
    assert.ok(fileEntry, 'Should have index.ts file');
    assert.ok(!fileEntry!.isDirectory, 'index.ts should be a file');
  });

  test('getChildren returns correct hierarchy for nested dirs', async () => {
    await fs.mkdir(path.join(branchDir, 'src', 'utils'), { recursive: true });
    await fs.writeFile(path.join(branchDir, 'src', 'utils', 'helper.ts'), 'export {};');

    const root = await provider.getChildren();
    const srcDir = root.find(e => e.name === 'src');
    assert.ok(srcDir, 'Should have src');

    const srcChildren = await provider.getChildren(srcDir!);
    const utilsDir = srcChildren.find(e => e.name === 'utils');
    assert.ok(utilsDir, 'Should have utils');

    const utilsChildren = await provider.getChildren(utilsDir!);
    const helper = utilsChildren.find(e => e.name === 'helper.ts');
    assert.ok(helper, 'Should have helper.ts');
    assert.strictEqual(helper!.relativePath, path.join('src', 'utils', 'helper.ts'));
  });

  test('getChildren returns empty array for empty branch', async () => {
    const children = await provider.getChildren();
    assert.strictEqual(children.length, 0);
  });
});

// WorkspaceTreeProvider tests
suite('WorkspaceTreeProvider', () => {
  let tmpDir: string;
  let branchDir: string;
  let fsLayer: FileSystemLayer;
  let provider: WorkspaceTreeProvider;

  setup(async () => {
    tmpDir = path.join(os.tmpdir(), `versioncon-workspace-tree-test-${Date.now()}`);
    branchDir = path.join(tmpDir, '.versioncon', 'branch');
    await fs.mkdir(branchDir, { recursive: true });
    fsLayer = new FileSystemLayer(tmpDir, branchDir);
    provider = new WorkspaceTreeProvider(fsLayer);
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('starts empty with no tracked files', () => {
    const children = provider.getChildren();
    assert.strictEqual(children.length, 0);
  });

  test('trackFile adds file and builds hierarchy', () => {
    provider.trackFile('src/utils/helper.ts');

    const root = provider.getChildren();
    assert.strictEqual(root.length, 1);
    assert.strictEqual(root[0].name, 'src');
    assert.ok(root[0].isDirectory);

    const srcChildren = provider.getChildren(root[0]);
    assert.strictEqual(srcChildren.length, 1);
    assert.strictEqual(srcChildren[0].name, 'utils');

    const utilsChildren = provider.getChildren(srcChildren[0]);
    assert.strictEqual(utilsChildren.length, 1);
    assert.strictEqual(utilsChildren[0].name, 'helper.ts');
    assert.ok(!utilsChildren[0].isDirectory);
  });

  test('untrackFile removes file from tree', () => {
    provider.trackFile('src/app.ts');
    provider.untrackFile('src/app.ts');

    const root = provider.getChildren();
    assert.strictEqual(root.length, 0);
  });

  test('trackFiles adds multiple files with shared hierarchy', () => {
    provider.trackFiles(['src/a.ts', 'src/b.ts', 'lib/c.ts']);

    const root = provider.getChildren();
    assert.strictEqual(root.length, 2); // lib, src (sorted)

    const tracked = provider.getTrackedPaths();
    assert.strictEqual(tracked.length, 3);
  });

  test('isTracked returns correct state', () => {
    provider.trackFile('src/app.ts');
    assert.ok(provider.isTracked('src/app.ts'));
    assert.ok(!provider.isTracked('src/other.ts'));
  });

  test('hierarchy sorts directories before files', () => {
    provider.trackFiles(['readme.md', 'src/app.ts']);

    const root = provider.getChildren();
    assert.strictEqual(root[0].name, 'src'); // dir first
    assert.strictEqual(root[1].name, 'readme.md'); // file second
  });
});

// WorkspaceState staging tests (preserved from old tests)
suite('WorkspaceState (staging)', () => {
  let workspaceState: WorkspaceState;

  setup(() => {
    workspaceState = new WorkspaceState();
  });

  test('stageFile adds file path to staged list', () => {
    workspaceState.stageFile('src/index.ts');
    const staged = workspaceState.getStagedFiles();
    const paths = staged.map(s => s.path);
    assert.ok(paths.includes('src/index.ts'));
  });

  test('unstageFile removes file path from staged list', () => {
    workspaceState.stageFile('src/index.ts');
    workspaceState.unstageFile('src/index.ts');
    const staged = workspaceState.getStagedFiles();
    assert.strictEqual(staged.length, 0);
  });

  test('getStagedFiles returns all staged paths', () => {
    workspaceState.stageFile('src/a.ts');
    workspaceState.stageFile('src/b.ts');
    workspaceState.stageFile('src/c.ts');
    const staged = workspaceState.getStagedFiles();
    assert.strictEqual(staged.length, 3);
  });

  test('stageFile deduplicates by path', () => {
    workspaceState.stageFile('src/a.ts');
    workspaceState.stageFile('src/a.ts');
    const staged = workspaceState.getStagedFiles();
    assert.strictEqual(staged.length, 1);
  });

  test('clearStaged removes all staged files', () => {
    workspaceState.stageFile('src/a.ts');
    workspaceState.stageFile('src/b.ts');
    workspaceState.clearStaged();
    assert.strictEqual(workspaceState.getStagedFiles().length, 0);
  });
});
