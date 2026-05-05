import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { FileSystemLayer } from '../../filesystem/FileSystemLayer.js';
import { BranchState } from '../../filesystem/BranchState.js';
import { WorkspaceState } from '../../filesystem/WorkspaceState.js';

// UI-01, UI-02, UI-03, UI-07: SplitPanePanel integration tests
suite('SplitPanePanel Integration', () => {
  let tmpDir: string;
  let branchDir: string;
  let workspaceDir: string;
  let fsLayer: FileSystemLayer;
  let branchState: BranchState;
  let workspaceState: WorkspaceState;

  setup(async () => {
    tmpDir = path.join(os.tmpdir(), `versioncon-splitpane-test-${Date.now()}`);
    branchDir = path.join(tmpDir, '.versioncon', 'branch');
    workspaceDir = tmpDir;
    await fs.mkdir(branchDir, { recursive: true });
    fsLayer = new FileSystemLayer(workspaceDir, branchDir);
    branchState = new BranchState(fsLayer, branchDir);
    workspaceState = new WorkspaceState(fsLayer, workspaceDir);
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // UI-01: Both panes have tree data after refresh
  test('state snapshot contains both trees after refresh', async () => {
    // Create files in branch
    await fs.writeFile(path.join(branchDir, 'server.ts'), 'export {};');
    // Create files in workspace
    await fs.writeFile(path.join(workspaceDir, 'local.ts'), 'const x = 1;');

    await branchState.refresh();
    await workspaceState.refresh();

    const branchTree = branchState.getTree();
    const workspaceTree = workspaceState.getTree();

    assert.ok(Array.isArray(branchTree), 'Branch tree should be an array');
    assert.ok(Array.isArray(workspaceTree), 'Workspace tree should be an array');
    assert.ok(branchTree.length > 0, 'Branch tree should have entries');
    assert.ok(workspaceTree.length > 0, 'Workspace tree should have entries');
  });

  // UI-04: Drag-to-workspace copies file and updates workspace tree
  test('drag-to-workspace copies file and updates workspace tree', async () => {
    // Create file in branch
    const srcDir = path.join(branchDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'app.ts'), 'export const app = true;\n');

    // Simulate drag-to-workspace
    await fsLayer.copyFileToWorkspace('src/app.ts');

    // Refresh workspace state
    await workspaceState.refresh();
    const tree = workspaceState.getTree();

    // The copied file should appear in workspace tree
    assert.ok(tree.length > 0, 'Workspace tree should have entries after copy');

    // Verify the file physically exists
    const destPath = path.join(workspaceDir, 'src', 'app.ts');
    const stat = await fs.stat(destPath);
    assert.ok(stat.isFile(), 'Copied file should exist in workspace');
  });

  // UI-05: Drag-to-workspace with directory creates structure only
  test('drag-to-workspace with directory creates structure only', async () => {
    // Create nested dir with files in branch
    const nestedDir = path.join(branchDir, 'lib', 'core');
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(path.join(nestedDir, 'engine.ts'), 'export class Engine {}');
    await fs.writeFile(path.join(path.join(branchDir, 'lib')), '');

    // copyStructureOnly should create dirs but not copy files
    await fsLayer.copyStructureOnly('lib');

    const libDir = path.join(workspaceDir, 'lib', 'core');
    const libStat = await fs.stat(libDir);
    assert.ok(libStat.isDirectory(), 'lib/core/ should exist as directory');

    // Files should NOT be copied
    await assert.rejects(
      () => fs.access(path.join(libDir, 'engine.ts')),
      'engine.ts should NOT exist — structure only'
    );
  });

  // UI-07: Drag-to-branch stages file in workspace state
  test('drag-to-branch stages file in workspace state', async () => {
    workspaceState.stageFile('src/main.ts');
    const staged = workspaceState.getStagedFiles();

    assert.ok(staged.length === 1, 'Should have 1 staged file');
    assert.strictEqual(staged[0].path, 'src/main.ts', 'Staged file path should match');
    assert.ok(typeof staged[0].stagedAt === 'number', 'stagedAt should be a timestamp');
  });

  // State persistence: staged files survive refresh
  test('staged files survive state refresh (simulates tab switch)', async () => {
    workspaceState.stageFile('src/a.ts');
    workspaceState.stageFile('src/b.ts');

    // Refresh simulates webview rebuild (tab switch)
    await workspaceState.refresh();

    const staged = workspaceState.getStagedFiles();
    assert.strictEqual(staged.length, 2, 'Staged files should persist across refresh');
    const paths = staged.map(s => s.path);
    assert.ok(paths.includes('src/a.ts'), 'src/a.ts should still be staged');
    assert.ok(paths.includes('src/b.ts'), 'src/b.ts should still be staged');
  });

  // UI-03: External file creation detected after refresh
  test('external file creation detected in workspace tree after refresh', async () => {
    // Create file directly in workspace (simulates VS Code native file creation)
    await fs.writeFile(path.join(workspaceDir, 'newfile.ts'), 'const fresh = true;');

    await workspaceState.refresh();
    const tree = workspaceState.getTree();

    const newFileNode = tree.find(n => n.label === 'newfile.ts');
    assert.ok(newFileNode, 'Externally created file should appear in workspace tree after refresh');
  });

  // UI-02: Branch tree is read-only — BranchState has no mutation methods
  test('branch tree is read-only — BranchState has no mutation methods', () => {
    assert.strictEqual(
      typeof (branchState as any).stageFile,
      'undefined',
      'BranchState should not have a stageFile method'
    );
    assert.strictEqual(
      typeof (branchState as any).copyTo,
      'undefined',
      'BranchState should not have a copyTo method'
    );
  });
});
