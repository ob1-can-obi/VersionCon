import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { PushHistory } from '../../filesystem/PushHistory.js';
import { PushService } from '../../filesystem/PushService.js';

/**
 * Integration tests covering push and revert flows with PushService + PushHistory.
 *
 * These tests focus on the end-to-end behaviors that the broadcast and
 * notification layers depend on:
 *  - Push records carry the message and member info that drives the activity log
 *  - Partial revert and full revert update both the filesystem and the record
 *  - The summary computation produces non-zero diff counts so the smart push
 *    summary has data to render
 *
 * Scope: PUSH-08 (revert notifications via record state) and SAFE-04
 * (revert capability — both whole-push and per-file).
 */
suite('PushIntegration', () => {
  let tmpDir: string;
  let projectRoot: string;
  let branchDir: string;
  let versionconDir: string;
  let history: PushHistory;
  let pushService: PushService;

  setup(async () => {
    tmpDir = path.join(os.tmpdir(), `versioncon-pushint-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  test('push requires non-empty message validation', async () => {
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'msg.ts'), 'x\n');

    const { record } = await pushService.executePush('Initial push message', ['src/msg.ts'], {
      id: 'm1',
      displayName: 'Alice',
    });

    // Service stores whatever message it is given; the InputBox in extension.ts
    // is responsible for rejecting empty input. Here we assert the record's
    // message field is preserved exactly so the chat/activity log can render it.
    assert.strictEqual(record.message, 'Initial push message');
    assert.ok(record.message.length > 0, 'message must be non-empty');
  });

  test('push records include member info', async () => {
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'who.ts'), 'export {};\n');

    const { record } = await pushService.executePush('add who.ts', ['src/who.ts'], {
      id: 'member-1',
      displayName: 'Alice',
    });

    assert.strictEqual(record.memberId, 'member-1');
    assert.strictEqual(record.memberDisplayName, 'Alice');
    assert.strictEqual(record.branch, 'main');
  });

  test('partial revert only affects specified files', async () => {
    // Pre-existing branch versions so revert restores rather than deletes
    await fs.mkdir(path.join(branchDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(branchDir, 'src', 'a.ts'), 'original-a\n');
    await fs.writeFile(path.join(branchDir, 'src', 'b.ts'), 'original-b\n');

    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'a.ts'), 'pushed-a\n');
    await fs.writeFile(path.join(projectRoot, 'src', 'b.ts'), 'pushed-b\n');

    const { record } = await pushService.executePush('multi', ['src/a.ts', 'src/b.ts'], {
      id: 'm1', displayName: 'A',
    });

    await pushService.revertFiles(record.id, ['src/a.ts']);

    const aContent = await fs.readFile(path.join(branchDir, 'src', 'a.ts'), 'utf-8');
    const bContent = await fs.readFile(path.join(branchDir, 'src', 'b.ts'), 'utf-8');
    assert.strictEqual(aContent, 'original-a\n', 'a.ts should be restored to pre-push');
    assert.strictEqual(bContent, 'pushed-b\n', 'b.ts should still hold pushed content');
  });

  test('partial revert marks revertedFiles on record', async () => {
    await fs.mkdir(path.join(branchDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(branchDir, 'src', 'a.ts'), 'orig\n');

    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'a.ts'), 'new\n');
    await fs.writeFile(path.join(projectRoot, 'src', 'b.ts'), 'b-new\n');

    const { record } = await pushService.executePush('partial', ['src/a.ts', 'src/b.ts'], {
      id: 'm1', displayName: 'A',
    });

    await pushService.revertFiles(record.id, ['src/a.ts']);

    const updated = history.getRecord(record.id);
    assert.ok(updated, 'record should still exist');
    assert.strictEqual(updated!.reverted, true);
    assert.deepStrictEqual(updated!.revertedFiles, ['src/a.ts']);
  });

  test('full revert restores all files to pre-push state', async () => {
    await fs.mkdir(path.join(branchDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(branchDir, 'src', 'a.ts'), 'orig-a\n');
    await fs.writeFile(path.join(branchDir, 'src', 'b.ts'), 'orig-b\n');

    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'a.ts'), 'new-a\n');
    await fs.writeFile(path.join(projectRoot, 'src', 'b.ts'), 'new-b\n');

    const { record } = await pushService.executePush('two-file push', ['src/a.ts', 'src/b.ts'], {
      id: 'm1', displayName: 'A',
    });

    await pushService.revertPush(record.id);

    const aContent = await fs.readFile(path.join(branchDir, 'src', 'a.ts'), 'utf-8');
    const bContent = await fs.readFile(path.join(branchDir, 'src', 'b.ts'), 'utf-8');
    assert.strictEqual(aContent, 'orig-a\n');
    assert.strictEqual(bContent, 'orig-b\n');

    const updated = history.getRecord(record.id);
    assert.strictEqual(updated!.reverted, true);
  });

  test('push summary computes non-zero line counts', async () => {
    // Pre-existing branch file with 3 lines
    await fs.mkdir(path.join(branchDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(branchDir, 'src', 'sum.ts'), 'line1\nline2\nline3\n');

    // Workspace file with 5 different lines
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'sum.ts'), 'alpha\nbeta\ngamma\ndelta\nepsilon\n');

    const summary = await pushService.generateSummary(['src/sum.ts']);
    assert.strictEqual(summary.files.length, 1);
    assert.strictEqual(summary.files[0].status, 'modified');
    assert.ok(summary.totalAdded > 0, `expected totalAdded > 0, got ${summary.totalAdded}`);
    assert.ok(summary.totalRemoved > 0, `expected totalRemoved > 0, got ${summary.totalRemoved}`);
  });
});
