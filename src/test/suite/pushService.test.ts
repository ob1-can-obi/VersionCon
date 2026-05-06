import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { PushHistory } from '../../filesystem/PushHistory.js';
import { PushService } from '../../filesystem/PushService.js';

suite('PushService', () => {
  let tmpDir: string;
  let projectRoot: string;
  let branchDir: string;
  let versionconDir: string;
  let history: PushHistory;
  let pushService: PushService;

  setup(async () => {
    tmpDir = path.join(os.tmpdir(), `versioncon-push-service-${Date.now()}`);
    projectRoot = tmpDir;
    versionconDir = path.join(tmpDir, '.versioncon');
    branchDir = path.join(versionconDir, 'branches', 'main');

    await fs.mkdir(branchDir, { recursive: true });

    history = new PushHistory(versionconDir);
    await history.load();

    pushService = new PushService(
      history,
      projectRoot,
      () => branchDir,
      () => 'main',
    );
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('generateSummary computes diff for new file', async () => {
    // Create workspace file (no branch version)
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'new.ts'), 'line1\nline2\nline3\n');

    const summary = await pushService.generateSummary(['src/new.ts']);
    assert.strictEqual(summary.files.length, 1);
    assert.strictEqual(summary.files[0].status, 'added');
    assert.strictEqual(summary.files[0].addedLines, 4); // 3 lines + trailing empty
    assert.strictEqual(summary.totalAdded, 4);
  });

  test('generateSummary computes diff for modified file', async () => {
    await fs.mkdir(path.join(branchDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(branchDir, 'src', 'app.ts'), 'line1\nline2\n');

    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'app.ts'), 'line1\nline3\n');

    const summary = await pushService.generateSummary(['src/app.ts']);
    assert.strictEqual(summary.files[0].status, 'modified');
    assert.ok(summary.files[0].addedLines > 0);
    assert.ok(summary.files[0].removedLines > 0);
  });

  test('executePush copies workspace file to branch and records history', async () => {
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'feature.ts'), 'export const x = 1;\n');

    const record = await pushService.executePush('Add feature', ['src/feature.ts'], {
      id: 'member-1',
      displayName: 'Alice',
    });

    assert.strictEqual(record.message, 'Add feature');
    assert.strictEqual(record.files.length, 1);
    assert.strictEqual(record.files[0].status, 'added');

    // Verify file was copied to branch
    const branchContent = await fs.readFile(path.join(branchDir, 'src', 'feature.ts'), 'utf-8');
    assert.strictEqual(branchContent, 'export const x = 1;\n');
  });

  test('executePush snapshots pre-push content for modified file', async () => {
    await fs.mkdir(path.join(branchDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(branchDir, 'src', 'mod.ts'), 'original\n');

    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'mod.ts'), 'modified\n');

    const record = await pushService.executePush('Modify', ['src/mod.ts'], {
      id: 'm1', displayName: 'A',
    });

    // Verify snapshot was saved
    const snapshot = await history.readSnapshot(record.id, 'src/mod.ts');
    assert.strictEqual(snapshot, 'original\n');
  });

  test('revertPush restores files from snapshots', async () => {
    // Setup: original branch file
    await fs.mkdir(path.join(branchDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(branchDir, 'src', 'revert.ts'), 'original\n');

    // Push a modification
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'revert.ts'), 'modified\n');

    const record = await pushService.executePush('Will revert', ['src/revert.ts'], {
      id: 'm1', displayName: 'A',
    });

    // Verify branch has new content
    let content = await fs.readFile(path.join(branchDir, 'src', 'revert.ts'), 'utf-8');
    assert.strictEqual(content, 'modified\n');

    // Revert
    await pushService.revertPush(record.id);

    // Verify branch restored
    content = await fs.readFile(path.join(branchDir, 'src', 'revert.ts'), 'utf-8');
    assert.strictEqual(content, 'original\n');

    // Record marked as reverted
    const updated = history.getRecord(record.id);
    assert.strictEqual(updated!.reverted, true);
  });

  test('revertPush removes added files', async () => {
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'added.ts'), 'new file\n');

    const record = await pushService.executePush('Add', ['src/added.ts'], {
      id: 'm1', displayName: 'A',
    });

    // File should exist in branch
    await fs.access(path.join(branchDir, 'src', 'added.ts'));

    // Revert should remove it
    await pushService.revertPush(record.id);
    await assert.rejects(() => fs.access(path.join(branchDir, 'src', 'added.ts')));
  });

  test('revertFiles performs partial revert', async () => {
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'a.ts'), 'a\n');
    await fs.writeFile(path.join(projectRoot, 'src', 'b.ts'), 'b\n');

    const record = await pushService.executePush('Multi', ['src/a.ts', 'src/b.ts'], {
      id: 'm1', displayName: 'A',
    });

    // Revert only a.ts
    await pushService.revertFiles(record.id, ['src/a.ts']);

    // a.ts should be removed (it was added), b.ts should remain
    await assert.rejects(() => fs.access(path.join(branchDir, 'src', 'a.ts')));
    const bContent = await fs.readFile(path.join(branchDir, 'src', 'b.ts'), 'utf-8');
    assert.strictEqual(bContent, 'b\n');
  });

  test('getFileDiff returns original and modified content', async () => {
    await fs.mkdir(path.join(branchDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(branchDir, 'src', 'diff.ts'), 'branch version\n');

    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'diff.ts'), 'workspace version\n');

    const { original, modified } = await pushService.getFileDiff('src/diff.ts');
    assert.strictEqual(original, 'branch version\n');
    assert.strictEqual(modified, 'workspace version\n');
  });

  // --- PUSH-03: computeAffectedMembers ---

  test('computeAffectedMembers returns empty when no overlap', () => {
    const affected = pushService.computeAffectedMembers(
      ['a.ts'],
      new Map([['m1', ['b.ts']]]),
      new Map([['m1', 'Alice']]),
    );
    assert.strictEqual(affected.length, 0);
  });

  test('computeAffectedMembers reports overlap with displayName + files', () => {
    const affected = pushService.computeAffectedMembers(
      ['a.ts', 'b.ts'],
      new Map([['m1', ['a.ts', 'c.ts']]]),
      new Map([['m1', 'Alice']]),
    );
    assert.strictEqual(affected.length, 1);
    assert.strictEqual(affected[0].memberId, 'm1');
    assert.strictEqual(affected[0].displayName, 'Alice');
    assert.deepStrictEqual(affected[0].overlappingFiles, ['a.ts']);
  });

  test('computeAffectedMembers excludes the pusher', () => {
    const affected = pushService.computeAffectedMembers(
      ['a.ts'],
      new Map([['m1', ['a.ts']], ['me', ['a.ts']]]),
      new Map([['m1', 'Alice'], ['me', 'Me']]),
      'me',
    );
    assert.strictEqual(affected.length, 1);
    assert.strictEqual(affected[0].memberId, 'm1');
  });

  test('computeAffectedMembers reports multiple affected members', () => {
    const affected = pushService.computeAffectedMembers(
      ['a.ts', 'b.ts'],
      new Map([
        ['m1', ['a.ts']],
        ['m2', ['b.ts', 'c.ts']],
        ['m3', ['x.ts']],
      ]),
      new Map([['m1', 'Alice'], ['m2', 'Bob'], ['m3', 'Carol']]),
    );
    assert.strictEqual(affected.length, 2);
    const ids = affected.map(a => a.memberId).sort();
    assert.deepStrictEqual(ids, ['m1', 'm2']);
  });

  test('computeAffectedMembers falls back to "Unknown" displayName when missing', () => {
    const affected = pushService.computeAffectedMembers(
      ['a.ts'],
      new Map([['m1', ['a.ts']]]),
      new Map(), // no name lookup
    );
    assert.strictEqual(affected.length, 1);
    assert.strictEqual(affected[0].displayName, 'Unknown');
  });
});
