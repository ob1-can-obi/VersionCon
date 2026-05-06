import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { BranchPermissions } from '../../filesystem/BranchPermissions.js';

suite('BranchPermissions', () => {
  let tmpDir: string;
  let permissions: BranchPermissions;
  const hostId = 'host-member';
  const memberId = 'regular-member';

  setup(async () => {
    tmpDir = path.join(os.tmpdir(), `versioncon-perms-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    permissions = new BranchPermissions(tmpDir, hostId);
    await permissions.load();
  });

  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --- Branch creation ---

  test('host can always create branches', () => {
    assert.strictEqual(permissions.canCreateBranch(hostId), true);
  });

  test('regular member cannot create branches by default', () => {
    assert.strictEqual(permissions.canCreateBranch(memberId), false);
  });

  test('grantBranchCreation allows member to create branches', async () => {
    await permissions.grantBranchCreation(memberId);
    assert.strictEqual(permissions.canCreateBranch(memberId), true);
  });

  test('revokeBranchCreation removes permission', async () => {
    await permissions.grantBranchCreation(memberId);
    await permissions.revokeBranchCreation(memberId);
    assert.strictEqual(permissions.canCreateBranch(memberId), false);
  });

  // --- Push to branch ---

  test('host can always push to any branch', () => {
    assert.strictEqual(permissions.canPushToBranch(hostId, 'main'), true);
    assert.strictEqual(permissions.canPushToBranch(hostId, 'feature'), true);
  });

  test('members can push to unrestricted branches', () => {
    assert.strictEqual(permissions.canPushToBranch(memberId, 'main'), true);
  });

  test('restrictBranch limits who can push', async () => {
    await permissions.restrictBranch('main', ['allowed-1']);
    assert.strictEqual(permissions.canPushToBranch('allowed-1', 'main'), true);
    assert.strictEqual(permissions.canPushToBranch(memberId, 'main'), false);
    // Host always can
    assert.strictEqual(permissions.canPushToBranch(hostId, 'main'), true);
  });

  test('clearRestrictions removes push limits', async () => {
    await permissions.restrictBranch('main', ['allowed-1']);
    await permissions.clearRestrictions('main');
    assert.strictEqual(permissions.canPushToBranch(memberId, 'main'), true);
  });

  // --- Merge to main ---

  test('anyone can merge with open policy', () => {
    assert.strictEqual(permissions.canMergeToMain(memberId), true);
  });

  test('restricted policy blocks non-host', async () => {
    await permissions.setMergePolicy('restricted');
    assert.strictEqual(permissions.canMergeToMain(memberId), false);
    assert.strictEqual(permissions.canMergeToMain(hostId), true);
  });

  test('limited policy checks allowed list', async () => {
    await permissions.setMergePolicy('limited', [memberId]);
    assert.strictEqual(permissions.canMergeToMain(memberId), true);
    assert.strictEqual(permissions.canMergeToMain('other-member'), false);
  });

  // --- Persistence ---

  test('permissions persist across reload', async () => {
    await permissions.grantBranchCreation(memberId);
    await permissions.setMergePolicy('restricted');

    const p2 = new BranchPermissions(tmpDir, hostId);
    await p2.load();
    assert.strictEqual(p2.canCreateBranch(memberId), true);
    assert.strictEqual(p2.canMergeToMain(memberId), false);
  });

  // --- Access ---

  test('canAccessBranch returns true for all by default', () => {
    assert.strictEqual(permissions.canAccessBranch(memberId, 'main'), true);
    assert.strictEqual(permissions.canAccessBranch(hostId, 'feature'), true);
  });

  // --- getData ---

  test('getData returns current permissions snapshot', () => {
    const data = permissions.getData();
    assert.ok(Array.isArray(data.canCreateBranch));
    assert.strictEqual(data.mergeToMainPolicy, 'open');
  });
});
