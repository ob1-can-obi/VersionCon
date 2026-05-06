import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { FileSystemLayer } from '../../filesystem/FileSystemLayer.js';
import { BranchState } from '../../filesystem/BranchState.js';
import { WorkspaceState } from '../../filesystem/WorkspaceState.js';

// UI-04, UI-05, UI-06, UI-08: FileSystemLayer unit tests
suite('FileSystemLayer', () => {
  let tmpDir: string;
  let branchDir: string;
  let projectRoot: string;
  let fsLayer: FileSystemLayer;

  setup(async () => {
    tmpDir = path.join(os.tmpdir(), `versioncon-fs-test-${Date.now()}`);
    branchDir = path.join(tmpDir, '.versioncon', 'branch');
    projectRoot = tmpDir;
    await fs.mkdir(branchDir, { recursive: true });
    fsLayer = new FileSystemLayer(projectRoot, branchDir);
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // UI-04, UI-06: Drag from branch copies file to workspace with parent dirs
  test('copyFileToWorkspace copies a file and creates parent dirs', async () => {
    const srcDir = path.join(branchDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'index.ts'), 'export const main = true;\n');

    await fsLayer.copyFileToWorkspace('src/index.ts');

    const destPath = path.join(projectRoot, 'src', 'index.ts');
    const content = await fs.readFile(destPath, 'utf-8');
    assert.strictEqual(content, 'export const main = true;\n');
  });

  // Security: Path traversal prevention
  test('copyFileToWorkspace throws on path traversal', async () => {
    await assert.rejects(
      () => fsLayer.copyFileToWorkspace('../../../etc/passwd'),
      (err: Error) => {
        assert.ok(err.message.toLowerCase().includes('traversal'));
        return true;
      }
    );
  });

  // UI-05: Folder drag creates structure only (empty dirs)
  test('copyStructureOnly creates nested directories without copying files', async () => {
    const utilsDir = path.join(branchDir, 'src', 'utils');
    await fs.mkdir(utilsDir, { recursive: true });
    await fs.writeFile(path.join(utilsDir, 'helper.ts'), 'export function help() {}\n');

    await fsLayer.copyStructureOnly('src');

    const destUtilsDir = path.join(projectRoot, 'src', 'utils');
    const stat = await fs.stat(destUtilsDir);
    assert.ok(stat.isDirectory(), 'src/utils/ should exist as directory');

    // File should NOT have been copied — structure only
    await assert.rejects(
      () => fs.access(path.join(destUtilsDir, 'helper.ts')),
      'helper.ts should NOT exist in workspace after copyStructureOnly'
    );
  });

  // Security: Path traversal prevention for directory operations
  test('copyStructureOnly throws on path traversal', async () => {
    await assert.rejects(
      () => fsLayer.copyStructureOnly('../../..'),
      (err: Error) => {
        assert.ok(err.message.toLowerCase().includes('traversal'));
        return true;
      }
    );
  });

  // UI-08: Tree data built correctly — dirs first, sorted alpha
  test('buildTreeData returns correct TreeNode structure (dirs first, sorted alpha)', async () => {
    // Create mix of files and directories
    await fs.mkdir(path.join(branchDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(branchDir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(branchDir, 'README.md'), '# Readme');
    await fs.writeFile(path.join(branchDir, 'package.json'), '{}');

    const tree = await fsLayer.buildTreeData(branchDir);

    // Directories should come first
    assert.ok(tree.length >= 4, 'Should have at least 4 entries');
    const dirEntries = tree.filter(n => n.subItems !== undefined);
    const fileEntries = tree.filter(n => n.subItems === undefined);

    // All dirs should appear before all files
    const lastDirIndex = tree.findLastIndex(n => n.subItems !== undefined);
    const firstFileIndex = tree.findIndex(n => n.subItems === undefined);
    if (dirEntries.length > 0 && fileEntries.length > 0) {
      assert.ok(lastDirIndex < firstFileIndex, 'Directories should come before files');
    }

    // Dirs sorted alphabetically
    if (dirEntries.length >= 2) {
      assert.ok(
        dirEntries[0].label.localeCompare(dirEntries[1].label) <= 0,
        'Directories should be sorted alphabetically'
      );
    }

    // Files sorted alphabetically
    if (fileEntries.length >= 2) {
      assert.ok(
        fileEntries[0].label.localeCompare(fileEntries[1].label) <= 0,
        'Files should be sorted alphabetically'
      );
    }
  });

  // UI-08: Correct icons for file types
  test('buildTreeData uses correct icons for file types', async () => {
    await fs.writeFile(path.join(branchDir, 'app.ts'), 'const x = 1;');
    await fs.writeFile(path.join(branchDir, 'config.json'), '{}');

    const tree = await fsLayer.buildTreeData(branchDir);

    const tsNode = tree.find(n => n.label === 'app.ts');
    const jsonNode = tree.find(n => n.label === 'config.json');

    assert.ok(tsNode, 'Should find app.ts node');
    assert.ok(jsonNode, 'Should find config.json node');
    assert.strictEqual(tsNode!.icons?.leaf, 'typescript', 'TS file should have typescript icon');
    assert.strictEqual(jsonNode!.icons?.leaf, 'json', 'JSON file should have json icon');
  });

  // UI-08: Operates on real filesystem (not virtual)
  test('operates on real filesystem (not virtual)', async () => {
    const srcDir = path.join(branchDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'main.ts'), 'console.log("hello");\n');

    await fsLayer.copyFileToWorkspace('src/main.ts');

    // Verify with raw fs.stat — proves it is physically on disk
    const destPath = path.join(projectRoot, 'src', 'main.ts');
    const stat = await fs.stat(destPath);
    assert.ok(stat.isFile(), 'Copied file should physically exist on disk');
    assert.ok(stat.size > 0, 'Copied file should have non-zero size');
  });
});

// FileSystemLayer — new methods for TreeView
suite('FileSystemLayer — TreeView methods', () => {
  let tmpDir: string;
  let branchDir: string;
  let projectRoot: string;
  let fsLayer: FileSystemLayer;

  setup(async () => {
    tmpDir = path.join(os.tmpdir(), `versioncon-fs-tree-test-${Date.now()}`);
    branchDir = path.join(tmpDir, '.versioncon', 'branch');
    projectRoot = tmpDir;
    await fs.mkdir(branchDir, { recursive: true });
    fsLayer = new FileSystemLayer(projectRoot, branchDir);
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('buildFileEntries returns FileEntry hierarchy', async () => {
    await fs.mkdir(path.join(branchDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(branchDir, 'src', 'app.ts'), 'const x = 1;');
    await fs.writeFile(path.join(branchDir, 'README.md'), '# Hello');

    const entries = await fsLayer.buildFileEntries(branchDir, branchDir);

    assert.ok(entries.length >= 2, 'Should have at least 2 entries');
    const srcEntry = entries.find(e => e.name === 'src');
    assert.ok(srcEntry, 'Should have src directory');
    assert.ok(srcEntry!.isDirectory);
    assert.ok(srcEntry!.children && srcEntry!.children.length > 0);

    const readme = entries.find(e => e.name === 'README.md');
    assert.ok(readme, 'Should have README.md');
    assert.ok(!readme!.isDirectory);
  });

  test('copyFileFromWorkspaceToBranch copies file back', async () => {
    // Create a file in workspace (projectRoot)
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'edited.ts'), 'edited content');

    await fsLayer.copyFileFromWorkspaceToBranch('src/edited.ts');

    const content = await fs.readFile(path.join(branchDir, 'src', 'edited.ts'), 'utf-8');
    assert.strictEqual(content, 'edited content');
  });

  test('copyFileFromWorkspaceToBranch throws on path traversal', async () => {
    await assert.rejects(
      () => fsLayer.copyFileFromWorkspaceToBranch('../../../etc/passwd'),
      (err: Error) => {
        assert.ok(err.message.toLowerCase().includes('traversal'));
        return true;
      }
    );
  });

  test('collectFilePaths recursively lists all files', async () => {
    await fs.mkdir(path.join(branchDir, 'src', 'utils'), { recursive: true });
    await fs.writeFile(path.join(branchDir, 'src', 'app.ts'), '');
    await fs.writeFile(path.join(branchDir, 'src', 'utils', 'helper.ts'), '');

    const paths = await fsLayer.collectFilePaths(branchDir, 'src');

    assert.ok(paths.length === 2, 'Should find 2 files');
    assert.ok(paths.some(p => p === path.join('src', 'app.ts')));
    assert.ok(paths.some(p => p === path.join('src', 'utils', 'helper.ts')));
  });

  test('validateWorkspacePath throws on traversal', () => {
    assert.throws(() => fsLayer.validateWorkspacePath('../../../etc/passwd'));
  });

  test('getBranchDir and getProjectRoot return correct paths', () => {
    assert.strictEqual(fsLayer.getBranchDir(), branchDir);
    assert.strictEqual(fsLayer.getProjectRoot(), projectRoot);
  });
});

// UI-02: BranchState — read-only branch tree
suite('BranchState', () => {
  let tmpDir: string;
  let branchDir: string;
  let projectRoot: string;
  let fsLayer: FileSystemLayer;

  setup(async () => {
    tmpDir = path.join(os.tmpdir(), `versioncon-branch-test-${Date.now()}`);
    branchDir = path.join(tmpDir, '.versioncon', 'branch');
    projectRoot = tmpDir;
    await fs.mkdir(branchDir, { recursive: true });
    fsLayer = new FileSystemLayer(projectRoot, branchDir);
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('getTree returns TreeNode array from branch directory', async () => {
    // Create files in branch directory
    await fs.writeFile(path.join(branchDir, 'index.ts'), 'export {};');
    await fs.mkdir(path.join(branchDir, 'lib'), { recursive: true });
    await fs.writeFile(path.join(branchDir, 'lib', 'utils.ts'), 'export {};');

    const branchState = new BranchState(fsLayer, branchDir);
    await branchState.refresh();
    const tree = branchState.getTree();

    assert.ok(Array.isArray(tree), 'getTree() should return an array');
    assert.ok(tree.length > 0, 'Tree should have entries after refresh');
  });
});

// UI-07: WorkspaceState — staged files tracking
suite('WorkspaceState', () => {
  let workspaceState: WorkspaceState;

  setup(() => {
    workspaceState = new WorkspaceState();
  });

  test('stageFile adds file path to staged list', () => {
    workspaceState.stageFile('src/index.ts');
    const staged = workspaceState.getStagedFiles();
    const paths = staged.map(s => s.path);
    assert.ok(paths.includes('src/index.ts'), 'Staged files should include src/index.ts');
  });

  test('unstageFile removes file path from staged list', () => {
    workspaceState.stageFile('src/index.ts');
    workspaceState.unstageFile('src/index.ts');
    const staged = workspaceState.getStagedFiles();
    assert.strictEqual(staged.length, 0, 'Staged list should be empty after unstaging');
  });

  test('getStagedFiles returns all staged paths', () => {
    workspaceState.stageFile('src/a.ts');
    workspaceState.stageFile('src/b.ts');
    workspaceState.stageFile('src/c.ts');
    const staged = workspaceState.getStagedFiles();
    assert.strictEqual(staged.length, 3, 'Should have 3 staged files');
  });
});
